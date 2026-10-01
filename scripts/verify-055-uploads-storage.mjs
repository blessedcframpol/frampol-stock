/**
 * Verify 055_lock_down_uploads_storage.sql. Does not apply SQL.
 *
 * Uses only verify-055-* identities and objects and removes them in finally.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_DB_URL (or DATABASE_URL)
 *
 * Usage: node scripts/verify-055-uploads-storage.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { createClient } from "@supabase/supabase-js"

const require = createRequire(import.meta.url)
const BUCKET = "uploads"
const EMAIL_PREFIX = "verify-055-"
const PREFIXES = ["quotations", "delivery-notes", "invoices"]
const EXPECTED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]
const MAX_BYTES = 10 * 1024 * 1024
const ROLES = ["admin", "sales", "accounts", "technicians"]
const CAN_INSERT = {
  admin: new Set(PREFIXES),
  sales: new Set(["quotations"]),
  accounts: new Set(["invoices"]),
  technicians: new Set(["quotations", "delivery-notes"]),
}

function loadEnvLocal() {
  const envPath = path.join(process.cwd(), ".env.local")
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    const key = match[1]
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function pdfBlob(text = "verify-055") {
  return new Blob([`%PDF-1.4\n${text}\n%%EOF\n`], {
    type: "application/pdf",
  })
}

async function main() {
  loadEnvLocal()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  assert(url, "Missing NEXT_PUBLIC_SUPABASE_URL")
  assert(anonKey, "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY")
  assert(serviceKey, "Missing SUPABASE_SERVICE_ROLE_KEY")
  assert(dbUrl, "Missing SUPABASE_DB_URL or DATABASE_URL")

  const pg = require("pg")
  const db = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  })
  await db.connect()

  const service = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const anon = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const results = {}
  const userIds = []
  const clients = {}
  const objectPaths = new Set()

  function pass(name, reason) {
    results[name] = { result: "PASS", reason }
    console.log(`PASS  ${name} — ${reason}`)
  }

  function fail(name, reason) {
    results[name] = { result: "FAIL", reason }
    console.log(`FAIL  ${name} — ${reason}`)
  }

  async function deleteFixtureUsers() {
    const { rows } = await db.query(
      `SELECT id::text AS id FROM public.profiles WHERE email LIKE $1`,
      [`${EMAIL_PREFIX}%`]
    )
    for (const row of rows) {
      const { error } = await service.auth.admin.deleteUser(row.id)
      if (error && !/not found/i.test(error.message)) {
        throw new Error(`deleteUser(${row.id}): ${error.message}`)
      }
    }
  }

  async function listFixtureObjects(prefix) {
    const { data, error } = await service.storage
      .from(BUCKET)
      .list(`${prefix}/verify-055`, { limit: 1000 })
    if (error) throw error
    return (data ?? [])
      .filter((entry) => entry.id)
      .map((entry) => `${prefix}/verify-055/${entry.name}`)
  }

  async function cleanupObjects() {
    const paths = new Set(objectPaths)
    for (const prefix of PREFIXES) {
      for (const objectPath of await listFixtureObjects(prefix)) paths.add(objectPath)
    }
    if (paths.size > 0) {
      const { error } = await service.storage.from(BUCKET).remove([...paths])
      if (error) throw error
    }
  }

  async function createUser(role) {
    const email = `${EMAIL_PREFIX}${role}@test.local`
    const { data, error } = await service.auth.admin.createUser({
      email,
      email_confirm: true,
    })
    if (error) throw new Error(`createUser(${email}): ${error.message}`)
    userIds.push(data.user.id)
    await db.query(
      `UPDATE public.profiles
       SET role = $2::public.app_role, active = true
       WHERE id = $1`,
      [data.user.id, role]
    )

    const client = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: link, error: linkError } = await service.auth.admin.generateLink({
      type: "magiclink",
      email,
    })
    if (linkError) throw new Error(`generateLink(${email}): ${linkError.message}`)
    const { data: sessionData, error: signInError } = await client.auth.verifyOtp({
      token_hash: link.properties.hashed_token,
      type: "magiclink",
    })
    if (signInError || !sessionData.session) {
      throw new Error(`verifyOtp(${email}): ${signInError?.message ?? "no session"}`)
    }
    clients[role] = client
  }

  async function upload(client, objectPath, text) {
    return client.storage.from(BUCKET).upload(objectPath, pdfBlob(text), {
      contentType: "application/pdf",
      upsert: false,
    })
  }

  try {
    verification: {
    await cleanupObjects()
    await deleteFixtureUsers()

    console.log("\n=== 1. Bucket configuration ===")
    const { rows: bucketRows } = await db.query(
      `SELECT public, file_size_limit, allowed_mime_types
       FROM storage.buckets
       WHERE id = 'uploads'`
    )
    const bucket = bucketRows[0]
    const mimeTypes = [...(bucket?.allowed_mime_types ?? [])].sort()
    const expectedMimeTypes = [...EXPECTED_MIME_TYPES].sort()
    const bucketOk =
      bucket?.public === false &&
      Number(bucket.file_size_limit) === MAX_BYTES &&
      JSON.stringify(mimeTypes) === JSON.stringify(expectedMimeTypes)
    if (!bucketOk) {
      fail("bucket_private_and_limited", JSON.stringify(bucket ?? null))
      break verification
    }
    pass(
      "bucket_private_and_limited",
      `private; ${bucket.file_size_limit} bytes; ${mimeTypes.join(", ")}`
    )

    console.log("\n=== Creating dedicated identities ===")
    for (const role of ROLES) await createUser(role)

    console.log("\n=== 2–3. Anon denial and role insert matrix ===")
    const canonical = {}
    for (const prefix of PREFIXES) {
      const adminPath = `${prefix}/verify-055/admin-${stamp()}.pdf`
      const { error } = await upload(clients.admin, adminPath, `admin ${prefix}`)
      if (error) {
        fail(`admin_upload_${prefix}`, error.message)
      } else {
        objectPaths.add(adminPath)
        canonical[prefix] = adminPath
        pass(`admin_upload_${prefix}`, adminPath)
      }
    }

    for (const prefix of PREFIXES) {
      const anonPath = `${prefix}/verify-055/anon-${stamp()}.pdf`
      const { error: uploadError } = await upload(anon, anonPath, `anon ${prefix}`)
      if (!uploadError) objectPaths.add(anonPath)
      const { data: listData, error: listError } = await anon.storage
        .from(BUCKET)
        .list(`${prefix}/verify-055`, { limit: 100 })
      const { error: downloadError } = await anon.storage
        .from(BUCKET)
        .download(canonical[prefix])
      const listDenied = Boolean(listError) || (listData ?? []).length === 0
      if (uploadError && listDenied && downloadError) {
        pass(`anon_denied_${prefix}`, "upload/download denied; list disclosed no objects")
      } else {
        fail(
          `anon_denied_${prefix}`,
          JSON.stringify({
            uploadError: uploadError?.message ?? null,
            listError: listError?.message ?? null,
            listed: (listData ?? []).length,
            downloadError: downloadError?.message ?? null,
          })
        )
      }
    }

    for (const role of ROLES) {
      for (const prefix of PREFIXES) {
        if (role === "admin") continue
        const objectPath = `${prefix}/verify-055/${role}-${stamp()}.pdf`
        const { error } = await upload(clients[role], objectPath, `${role} ${prefix}`)
        const shouldAllow = CAN_INSERT[role].has(prefix)
        if (!error) objectPaths.add(objectPath)
        if ((shouldAllow && !error) || (!shouldAllow && error)) {
          pass(
            `${role}_upload_${prefix}`,
            shouldAllow ? "allowed" : `denied: ${error.message}`
          )
        } else {
          fail(
            `${role}_upload_${prefix}`,
            shouldAllow ? error?.message ?? "unexpected failure" : "unexpectedly allowed"
          )
        }
      }
    }

    console.log("\n=== 4. Staff reads, signed URL, private public endpoint ===")
    for (const role of ROLES) {
      for (const prefix of PREFIXES) {
        const { error } = await clients[role].storage
          .from(BUCKET)
          .download(canonical[prefix])
        if (error) fail(`${role}_read_${prefix}`, error.message || JSON.stringify(error))
        else pass(`${role}_read_${prefix}`, "download allowed")
      }
    }

    const signedPath = canonical.quotations
    const { data: signed, error: signedError } = await clients.sales.storage
      .from(BUCKET)
      .createSignedUrl(signedPath, 300)
    const signedResponse = signed?.signedUrl ? await fetch(signed.signedUrl) : null
    if (!signedError && signedResponse?.ok) {
      pass("signed_url_download", `HTTP ${signedResponse.status}`)
    } else {
      fail(
        "signed_url_download",
        signedError?.message ?? `HTTP ${signedResponse?.status ?? "no URL"}`
      )
    }

    const encodedPath = signedPath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")
    const publicResponse = await fetch(
      `${url}/storage/v1/object/public/${BUCKET}/${encodedPath}`
    )
    if (publicResponse.status === 400 || publicResponse.status === 403) {
      pass("public_url_denied", `HTTP ${publicResponse.status}`)
    } else {
      fail("public_url_denied", `expected 400/403, got HTTP ${publicResponse.status}`)
    }

    console.log("\n=== 5. Object UPDATE/DELETE admin-only ===")
    const mutablePath = `${PREFIXES[0]}/verify-055/mutable-${stamp()}.pdf`
    const { error: mutableUploadError } = await upload(
      clients.admin,
      mutablePath,
      "mutable original"
    )
    assert(!mutableUploadError, mutableUploadError?.message ?? "mutable upload failed")
    objectPaths.add(mutablePath)

    function removedCount(data) {
      return Array.isArray(data) ? data.length : 0
    }

    for (const role of ["sales", "accounts", "technicians"]) {
      const { error: nonAdminUpdateError } = await clients[role].storage
        .from(BUCKET)
        .update(mutablePath, pdfBlob(`${role} update`), {
          contentType: "application/pdf",
        })
      const { data: nonAdminDeleted, error: nonAdminDeleteError } =
        await clients[role].storage.from(BUCKET).remove([mutablePath])
      const deleted = removedCount(nonAdminDeleted)
      if (nonAdminUpdateError && !nonAdminDeleteError && deleted === 0) {
        pass(`${role}_mutation_denied`, "UPDATE denied; DELETE removed 0 objects")
      } else {
        fail(
          `${role}_mutation_denied`,
          `update=${nonAdminUpdateError?.message ?? "allowed"}; delete=${
            nonAdminDeleteError?.message ?? `removed ${deleted}`
          }`
        )
      }
    }

    const { error: stillThereError } = await clients.admin.storage
      .from(BUCKET)
      .download(mutablePath)
    if (stillThereError) {
      fail("non_admin_delete_left_object", stillThereError.message)
    } else {
      pass("non_admin_delete_left_object", "object still present after non-admin DELETE")
    }

    const { error: adminUpdateError } = await clients.admin.storage
      .from(BUCKET)
      .update(mutablePath, pdfBlob("admin update"), {
        contentType: "application/pdf",
      })
    const { data: adminDeleted, error: adminDeleteError } = await clients.admin.storage
      .from(BUCKET)
      .remove([mutablePath])
    const adminRemoved = removedCount(adminDeleted)
    if (!adminUpdateError && !adminDeleteError && adminRemoved > 0) {
      objectPaths.delete(mutablePath)
      pass("admin_mutation_allowed", `admin UPDATE succeeded; DELETE removed ${adminRemoved}`)
    } else {
      fail(
        "admin_mutation_allowed",
        `update=${adminUpdateError?.message ?? "ok"}; delete=${
          adminDeleteError?.message ?? `removed ${adminRemoved}`
        }`
      )
    }

    console.log("\n=== 6. No uploads-bucket anon policies ===")
    const { rows: anonPolicies } = await db.query(`
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'storage'
        AND tablename = 'objects'
        AND 'anon' = ANY(roles)
        AND (
          COALESCE(qual, '') LIKE '%uploads%'
          OR COALESCE(with_check, '') LIKE '%uploads%'
        )
    `)
    if (anonPolicies.length === 0) pass("no_anon_policies", "none")
    else fail("no_anon_policies", JSON.stringify(anonPolicies))
    }
  } finally {
    console.log("\n=== 7. Cleanup and residue assertion ===")
    try {
      await cleanupObjects()
      for (const client of Object.values(clients)) {
        await client.auth.signOut().catch(() => {})
      }
      for (const userId of [...new Set(userIds)]) {
        const { error } = await service.auth.admin.deleteUser(userId)
        if (error && !/not found/i.test(error.message)) {
          throw new Error(`deleteUser(${userId}): ${error.message}`)
        }
      }
      await deleteFixtureUsers()

      let objectCount = 0
      for (const prefix of PREFIXES) {
        objectCount += (await listFixtureObjects(prefix)).length
      }
      const { rows: profiles } = await db.query(
        `SELECT count(*)::int AS n FROM public.profiles WHERE email LIKE $1`,
        [`${EMAIL_PREFIX}%`]
      )
      let authCount = 0
      for (const userId of [...new Set(userIds)]) {
        const { data } = await service.auth.admin.getUserById(userId)
        if (data.user) authCount += 1
      }
      const residue = {
        objects: objectCount,
        profiles: profiles[0].n,
        auth_users: authCount,
      }
      if (Object.values(residue).every((count) => count === 0)) {
        pass("zero_residue", JSON.stringify(residue))
      } else {
        fail("zero_residue", JSON.stringify(residue))
      }
    } catch (error) {
      fail("zero_residue", error.message)
    } finally {
      await db.end().catch(() => {})
    }
  }

  console.log("\n========== VERIFY 055 SUMMARY ==========")
  console.log(JSON.stringify(results, null, 2))
  console.log("========================================")
  if (Object.values(results).some((result) => result.result === "FAIL")) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
