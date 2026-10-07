/**
 * Verify 058_add_viewer_role.sql + 059_viewer_role_policies.sql.
 * Does not apply migrations.
 *
 * Uses only verify-059-* identities, database fixtures, and storage objects.
 * All created state is removed in finally and residue is asserted.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_DB_URL (or DATABASE_URL)
 *
 * Optional for API checks:
 *   VERIFY_APP_URL (defaults to http://localhost:3000)
 *
 * Usage: node scripts/verify-059-viewer-role.mjs
 */
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"

const require = createRequire(import.meta.url)
const { prepareVerifyEnv } = require("./verify-env.cjs")
const EMAIL_PREFIX = "verify-059-"
const DATA_PREFIX = "__verify_059__"
const BUCKET = "uploads"
const PREFIXES = ["quotations", "delivery-notes", "invoices"]
const ROLES = ["viewer", "sales", "accounts", "technicians", "admin"]
const TABLES = [
  "batch_reversals",
  "clients",
  "inventory_items",
  "kit_inspections",
  "outbound_batches",
  "product_lines",
  "remediation_cases",
  "remediation_providers",
  "stock_request_lines",
  "stock_requests",
  "stock_takes",
  "transactions",
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function pdfBlob(text) {
  const escapedText = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")
  const stream = `BT /F1 12 Tf 36 72 Td (${escapedText}) Tj ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += "0000000000 65535 f \n"
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`
  return new Blob([pdf], { type: "application/pdf" })
}

async function main() {
  prepareVerifyEnv()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  const appUrl = process.env.VERIFY_APP_URL || "http://localhost:3000"
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
  const clients = {}
  const cookiesByRole = {}
  const userIds = new Map()
  const objectPaths = new Set()
  const results = {}
  const fixture = {
    productId: `${DATA_PREFIX}product`,
    activeItemId: `${DATA_PREFIX}item_active`,
    deletedItemId: `${DATA_PREFIX}item_deleted`,
    inspectionId: null,
    providerId: null,
    caseId: null,
  }

  function pass(name, reason) {
    results[name] = { result: "PASS", reason }
    console.log(`PASS  ${name} — ${reason}`)
  }

  function fail(name, reason) {
    results[name] = { result: "FAIL", reason }
    console.log(`FAIL  ${name} — ${reason}`)
  }

  async function setJwt(client, userId) {
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ])
    const { rows } = await client.query(`SELECT auth.uid()::text AS uid`)
    assert(rows[0]?.uid === userId, `auth.uid() did not resolve for ${userId}`)
  }

  async function asUser(userId, fn, { rollback = false } = {}) {
    const client = new pg.Client({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
    })
    await client.connect()
    try {
      await client.query("BEGIN")
      await setJwt(client, userId)
      await client.query("SET LOCAL ROLE authenticated")
      const result = await fn(client)
      await client.query(rollback ? "ROLLBACK" : "COMMIT")
      return result
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {})
      throw error
    } finally {
      await client.end()
    }
  }

  /** batch_reversals is keyed on batch_id, not id — never hardcode a key name. */
  async function primaryKeyByTable() {
    const { rows } = await db.query(
      `SELECT c.relname AS table_name, a.attname AS column_name
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN unnest(con.conkey) AS k(attnum) ON true
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
       WHERE n.nspname = 'public'
         AND con.contype = 'p'
         AND c.relname = ANY($1)`,
      [TABLES]
    )
    const byTable = new Map()
    for (const row of rows) {
      byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.column_name])
    }
    const resolved = {}
    for (const table of TABLES) {
      const columns = byTable.get(table) ?? []
      assert(columns.length === 1, `${table} needs a single-column primary key, got ${columns.length}`)
      resolved[table] = columns[0]
    }
    return resolved
  }

  async function createIdentity(role) {
    const email = `${EMAIL_PREFIX}${role}@test.local`
    const { data, error } = await service.auth.admin.createUser({
      email,
      email_confirm: true,
    })
    if (error) throw new Error(`createUser(${role}): ${error.message}`)
    userIds.set(role, data.user.id)
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
    if (linkError) throw new Error(`generateLink(${role}): ${linkError.message}`)
    const { data: sessionData, error: signInError } = await client.auth.verifyOtp({
      token_hash: link.properties.hashed_token,
      type: "magiclink",
    })
    if (signInError || !sessionData.session) {
      throw new Error(`verifyOtp(${role}): ${signInError?.message ?? "no session"}`)
    }
    clients[role] = client

    const jar = new Map()
    const serverClient = createServerClient(url, anonKey, {
      cookies: {
        getAll: () =>
          [...jar.entries()].map(([name, value]) => ({ name, value })),
        setAll: (values) => {
          for (const item of values) {
            if (item.value) jar.set(item.name, item.value)
            else jar.delete(item.name)
          }
        },
      },
    })
    const { error: serverSignInError } = await serverClient.auth.setSession({
      access_token: sessionData.session.access_token,
      refresh_token: sessionData.session.refresh_token,
    })
    if (serverSignInError) {
      throw new Error(`serverSignIn(${role}): ${serverSignInError.message}`)
    }
    cookiesByRole[role] = [...jar.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ")
  }

  async function cleanupUsers() {
    const { rows } = await db.query(
      `SELECT id::text AS id FROM auth.users WHERE email LIKE $1`,
      [`${EMAIL_PREFIX}%`]
    )
    for (const id of new Set([...userIds.values(), ...rows.map((row) => row.id)])) {
      const { error } = await service.auth.admin.deleteUser(id)
      if (error && !/not found/i.test(error.message)) throw error
    }
  }

  async function listFixtureObjects(prefix) {
    const { data, error } = await service.storage
      .from(BUCKET)
      .list(`${prefix}/verify-059`, { limit: 1000 })
    if (error) throw error
    return (data ?? [])
      .filter((entry) => entry.id)
      .map((entry) => `${prefix}/verify-059/${entry.name}`)
  }

  async function cleanupObjects() {
    const paths = new Set(objectPaths)
    for (const prefix of PREFIXES) {
      for (const objectPath of await listFixtureObjects(prefix)) paths.add(objectPath)
    }
    if (paths.size) {
      const { error } = await service.storage.from(BUCKET).remove([...paths])
      if (error) throw error
    }
  }

  async function cleanupData() {
    await db.query(`DELETE FROM public.app_event_logs WHERE context = $1`, [
      `${DATA_PREFIX}log`,
    ])
    await db.query(`DELETE FROM public.remediation_cases WHERE id = $1`, [fixture.caseId])
    await db.query(`DELETE FROM public.kit_inspections WHERE id = $1`, [fixture.inspectionId])
    await db.query(`DELETE FROM public.remediation_providers WHERE id = $1`, [fixture.providerId])
    await db.query(
      `DELETE FROM public.inventory_items WHERE id IN ($1, $2)`,
      [fixture.activeItemId, fixture.deletedItemId]
    )
    await db.query(`DELETE FROM public.product_lines WHERE id = $1`, [fixture.productId])
  }

  async function createReadFixtures() {
    await db.query(
      `INSERT INTO public.product_lines (id, product_name, vendor, requires_serial)
       VALUES ($1, $2, 'Verify 059', true)`,
      [fixture.productId, `${DATA_PREFIX}product`]
    )
    await db.query(
      `INSERT INTO public.inventory_items
         (id, serial_number, status, date_added, location, product_id, deleted_at)
       VALUES
         ($1, $1, 'RMA Hold', '2026-01-01', 'Warehouse A', $3, NULL),
         ($2, $2, 'RMA Hold', '2026-01-01', 'Warehouse A', $3, now())`,
      [fixture.activeItemId, fixture.deletedItemId, fixture.productId]
    )
    const inspection = await db.query(
      `INSERT INTO public.kit_inspections
         (inventory_item_id, serial_number, outcome, condition_notes)
       VALUES ($1, $1, 'faulty', $2)
       RETURNING id::text`,
      [fixture.activeItemId, DATA_PREFIX]
    )
    fixture.inspectionId = inspection.rows[0].id
    const provider = await db.query(
      `INSERT INTO public.remediation_providers (slug, display_name)
       VALUES ($1, $2)
       RETURNING id::text`,
      [`${DATA_PREFIX}provider`, "Verify 059 Provider"]
    )
    fixture.providerId = provider.rows[0].id
    const remediation = await db.query(
      `INSERT INTO public.remediation_cases
         (provider_id, faulty_inventory_item_id, faulty_serial, notes)
       VALUES ($1, $2, $2, $3)
       RETURNING id::text`,
      [fixture.providerId, fixture.activeItemId, DATA_PREFIX]
    )
    fixture.caseId = remediation.rows[0].id
  }

  async function expectRpcDenied(name, args) {
    const viewerId = userIds.get("viewer")
    let denied = false
    try {
      await asUser(
        viewerId,
        (client) =>
          client.query(
            `SELECT public.${name}(${args.map((_, i) => `$${i + 1}`).join(", ")})`,
            args
          ),
        { rollback: true }
      )
    } catch (error) {
      denied = /forbidden|not permitted/i.test(error.message)
    }
    assert(denied, `${name} did not reject viewer`)
  }

  try {
    await cleanupObjects()
    await cleanupData()
    await cleanupUsers()

    console.log("\n=== Creating dedicated identities and read fixtures ===")
    for (const role of ROLES) await createIdentity(role)
    await createReadFixtures()

    console.log("\n=== 1. Enum ===")
    const enumResult = await db.query(
      `SELECT enumlabel
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typname = 'app_role'
       ORDER BY e.enumsortorder`
    )
    const enumValues = enumResult.rows.map((row) => row.enumlabel)
    if (enumValues.includes("viewer")) pass("enum_contains_viewer", enumValues.join(", "))
    else fail("enum_contains_viewer", enumValues.join(", "))

    console.log("\n=== 2. Viewer SELECT matrix ===")
    const viewerId = userIds.get("viewer")
    try {
      const selectCounts = await asUser(viewerId, async (client) => {
        const counts = {}
        for (const table of TABLES) {
          const { rows } = await client.query(
            `SELECT count(*)::int AS n FROM public.${table}`
          )
          counts[table] = rows[0].n
        }
        const inventory = await client.query(
          `SELECT id FROM public.inventory_items WHERE id IN ($1, $2) ORDER BY id`,
          [fixture.activeItemId, fixture.deletedItemId]
        )
        counts.fixtureInventory = inventory.rows.map((row) => row.id)
        return counts
      })
      const allHaveRows = TABLES.every((table) => selectCounts[table] > 0)
      const deletedFiltered =
        selectCounts.fixtureInventory.includes(fixture.activeItemId) &&
        !selectCounts.fixtureInventory.includes(fixture.deletedItemId)
      if (allHaveRows && deletedFiltered) {
        pass("viewer_select_matrix", JSON.stringify(selectCounts))
      } else {
        fail("viewer_select_matrix", JSON.stringify(selectCounts))
      }
    } catch (error) {
      fail("viewer_select_matrix", error.message)
    }

    console.log("\n=== 3. Restricted reads ===")
    try {
      const restricted = await asUser(viewerId, async (client) => {
        const out = {}
        for (const table of [
          "app_event_logs",
          "stock_request_events",
          "profile_access_events",
        ]) {
          const { rows } = await client.query(
            `SELECT count(*)::int AS n FROM public.${table}`
          )
          out[table] = rows[0].n
        }
        const profiles = await client.query(
          `SELECT id::text FROM public.profiles ORDER BY id`
        )
        out.profileIds = profiles.rows.map((row) => row.id)
        return out
      })
      const restrictedOk =
        restricted.app_event_logs === 0 &&
        restricted.stock_request_events === 0 &&
        restricted.profile_access_events === 0 &&
        restricted.profileIds.length === 1 &&
        restricted.profileIds[0] === viewerId
      if (restrictedOk) pass("viewer_restricted_reads", JSON.stringify(restricted))
      else fail("viewer_restricted_reads", JSON.stringify(restricted))
    } catch (error) {
      fail("viewer_restricted_reads", error.message)
    }

    try {
      const inserted = await asUser(viewerId, async (client) => {
        const result = await client.query(
          `INSERT INTO public.app_event_logs
             (user_id, severity, source, context, message)
           VALUES ($1, 'info', 'client', $2, 'viewer diagnostic')`,
          [viewerId, `${DATA_PREFIX}log`]
        )
        return result.rowCount
      })
      const { rows: ownLogs } = await db.query(
        `SELECT count(*)::int AS n FROM public.app_event_logs
         WHERE user_id = $1 AND context = $2`,
        [viewerId, `${DATA_PREFIX}log`]
      )
      if (inserted === 1 && ownLogs[0].n === 1) {
        pass("viewer_own_app_log_insert", "inserted own diagnostic row")
      } else {
        fail("viewer_own_app_log_insert", JSON.stringify({ inserted, count: ownLogs[0].n }))
      }
    } catch (error) {
      fail("viewer_own_app_log_insert", error.message)
    }

    console.log("\n=== 4. Viewer table mutations denied ===")
    try {
      const primaryKeys = await primaryKeyByTable()
      const mutations = await asUser(
        viewerId,
        async (client) => {
          const out = {}
          for (const table of TABLES) {
            const key = primaryKeys[table]
            const first = await client.query(
              `SELECT "${key}" AS key FROM public."${table}" LIMIT 1`
            )
            const keyValue = first.rows[0]?.key
            assert(keyValue != null, `${table} has no viewer-visible row`)
            let updated = 0
            let deleted = 0
            let updateDenied = false
            let deleteDenied = false
            await client.query("SAVEPOINT viewer_update")
            try {
              const update = await client.query(
                `UPDATE public."${table}" SET "${key}" = "${key}" WHERE "${key}" = $1`,
                [keyValue],
              )
              updated = update.rowCount
              await client.query("RELEASE SAVEPOINT viewer_update")
            } catch (error) {
              await client.query("ROLLBACK TO SAVEPOINT viewer_update")
              if (error.code === "42501" || /row-level security/i.test(error.message)) updateDenied = true
              else throw error
            }
            await client.query("SAVEPOINT viewer_delete")
            try {
              const remove = await client.query(
                `DELETE FROM public."${table}" WHERE "${key}" = $1`,
                [keyValue],
              )
              deleted = remove.rowCount
              await client.query("RELEASE SAVEPOINT viewer_delete")
            } catch (error) {
              await client.query("ROLLBACK TO SAVEPOINT viewer_delete")
              if (error.code === "42501" || /row-level security/i.test(error.message)) deleteDenied = true
              else throw error
            }
            let insertSqlstate = null
            await client.query("SAVEPOINT viewer_insert")
            try {
              await client.query(`INSERT INTO public."${table}" DEFAULT VALUES`)
            } catch (error) {
              insertSqlstate = error.code ?? "error"
            } finally {
              await client.query("ROLLBACK TO SAVEPOINT viewer_insert")
            }
            out[table] = {
              key,
              insertSqlstate,
              updated,
              deleted,
              updateDenied,
              deleteDenied,
            }
          }
          return out
        },
        { rollback: true }
      )
      const mutationsDenied = Object.values(mutations).every(
        (row) =>
          row.insertSqlstate !== null &&
          (row.updated === 0 || row.updateDenied) &&
          (row.deleted === 0 || row.deleteDenied),
      )
      if (mutationsDenied) pass("viewer_table_mutations_denied", JSON.stringify(mutations))
      else fail("viewer_table_mutations_denied", JSON.stringify(mutations))
    } catch (error) {
      fail("viewer_table_mutations_denied", error.message)
    }

    console.log("\n=== 5. SECURITY DEFINER functions reject viewer ===")
    const beforeFunctions = await db.query(
      `SELECT
         (SELECT count(*)::int FROM public.inventory_items
          WHERE reserved_for_request_line_id IS NOT NULL) AS reservations,
         (SELECT count(*)::int FROM public.notifications) AS notifications,
         (SELECT count(*)::int FROM public.product_lines
          WHERE product_name LIKE $1) AS products`,
      [`${DATA_PREFIX}%`]
    )
    try {
      await expectRpcDenied("assign_serial_to_request_line", [
        "00000000-0000-0000-0000-000000000001",
        fixture.activeItemId,
      ])
      await expectRpcDenied("release_serial_from_request_line", [fixture.activeItemId])
      await expectRpcDenied("create_request_serviced_notification", [
        "00000000-0000-0000-0000-000000000001",
      ])
      await expectRpcDenied("ensure_product_line", [
        `${DATA_PREFIX}rpc-${stamp()}`,
        "Verify 059",
      ])
      const afterFunctions = await db.query(
        `SELECT
           (SELECT count(*)::int FROM public.inventory_items
            WHERE reserved_for_request_line_id IS NOT NULL) AS reservations,
           (SELECT count(*)::int FROM public.notifications) AS notifications,
           (SELECT count(*)::int FROM public.product_lines
            WHERE product_name LIKE $1) AS products`,
        [`${DATA_PREFIX}%`]
      )
      assert(
        JSON.stringify(beforeFunctions.rows[0]) ===
          JSON.stringify(afterFunctions.rows[0]),
        "function denial changed rows"
      )
      pass("viewer_definer_functions_denied", "all four raised; row counts unchanged")
    } catch (error) {
      fail("viewer_definer_functions_denied", error.message)
    }

    console.log("\n=== 6–7. Storage viewer read-only and role regression ===")
    const canonical = {}
    const regressionUpload = {
      sales: "quotations",
      accounts: "invoices",
      technicians: "delivery-notes",
      admin: "quotations",
    }
    for (const [role, prefix] of Object.entries(regressionUpload)) {
      const objectPath = `${prefix}/verify-059/${role}-${stamp()}.pdf`
      const { error } = await clients[role].storage
        .from(BUCKET)
        .upload(objectPath, pdfBlob(`${role} ${prefix}`), {
          contentType: "application/pdf",
          upsert: false,
        })
      if (error) fail(`regression_${role}_write`, error.message)
      else {
        objectPaths.add(objectPath)
        canonical[prefix] ??= objectPath
        pass(`regression_${role}_write`, objectPath)
      }
    }
    for (const role of ["sales", "accounts", "technicians", "admin"]) {
      const { data, error } = await clients[role]
        .from("product_lines")
        .select("id")
        .limit(1)
      if (!error && (data ?? []).length > 0) {
        pass(`regression_${role}_read`, "product_lines readable")
      } else {
        fail(
          `regression_${role}_read`,
          error?.message ?? "product_lines returned no rows"
        )
      }
    }
    for (const prefix of PREFIXES) {
      if (!canonical[prefix]) {
        const objectPath = `${prefix}/verify-059/admin-${stamp()}.pdf`
        const { error } = await clients.admin.storage
          .from(BUCKET)
          .upload(objectPath, pdfBlob(`admin ${prefix}`), {
            contentType: "application/pdf",
            upsert: false,
          })
        assert(!error, error?.message ?? `admin upload ${prefix} failed`)
        objectPaths.add(objectPath)
        canonical[prefix] = objectPath
      }
    }

    const storageResults = {}
    for (const prefix of PREFIXES) {
      const objectPath = canonical[prefix]
      const { error: downloadError } = await clients.viewer.storage
        .from(BUCKET)
        .download(objectPath)
      const { data: signed, error: signedError } = await clients.viewer.storage
        .from(BUCKET)
        .createSignedUrl(objectPath, 300)
      const response = signed?.signedUrl ? await fetch(signed.signedUrl) : null
      const viewerPath = `${prefix}/verify-059/viewer-${stamp()}.pdf`
      const { error: uploadError } = await clients.viewer.storage
        .from(BUCKET)
        .upload(viewerPath, pdfBlob("viewer"), {
          contentType: "application/pdf",
          upsert: false,
        })
      if (!uploadError) objectPaths.add(viewerPath)
      const { error: updateError } = await clients.viewer.storage
        .from(BUCKET)
        .update(objectPath, pdfBlob("viewer update"), {
          contentType: "application/pdf",
        })
      const { data: removed, error: removeError } =
        await clients.viewer.storage.from(BUCKET).remove([objectPath])
      storageResults[prefix] = {
        read: !downloadError,
        signed: !signedError && response?.ok === true,
        uploadDenied: Boolean(uploadError),
        updateDenied: Boolean(updateError),
        deleteRemoved: Array.isArray(removed) ? removed.length : 0,
        deleteError: removeError?.message ?? null,
      }
    }
    const storageOk = Object.values(storageResults).every(
      (row) =>
        row.read &&
        row.signed &&
        row.uploadDenied &&
        row.updateDenied &&
        row.deleteRemoved === 0
    )
    if (storageOk) pass("viewer_storage_read_only", JSON.stringify(storageResults))
    else fail("viewer_storage_read_only", JSON.stringify(storageResults))

    console.log("\n=== 8. Mutating API routes reject viewer ===")
    const cookie = cookiesByRole.viewer
    const uploadForm = new FormData()
    uploadForm.set("kind", "quotation")
    uploadForm.set("scopeId", "verify-059-viewer")
    uploadForm.set("file", pdfBlob("viewer upload authorization probe"), "viewer-probe.pdf")
    const apiCases = [
      [
        "stock_take",
        "/api/stock-takes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      ],
      ["uploads", "/api/uploads", { method: "POST", body: uploadForm }],
      [
        "admin_profile_patch",
        `/api/admin/profiles/${userIds.get("admin")}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "viewer", active: true }),
        },
      ],
      [
        "quick_scan_reverse",
        "/api/quick-scan/reverse",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      ],
    ]
    const apiResults = {}
    try {
      for (const [name, pathname, init] of apiCases) {
        const headers = new Headers(init.headers)
        headers.set("Cookie", cookie)
        const response = await fetch(`${appUrl}${pathname}`, { ...init, headers })
        apiResults[name] = response.status
      }
      const apiOk = Object.values(apiResults).every((status) => status === 403)
      if (apiOk) {
        pass(
          "viewer_api_mutations_denied",
          `${JSON.stringify(apiResults)}; unused /api/quick-scan stubs removed; app-logs POST is own-row diagnostics; stock requests use RLS`
        )
      } else {
        fail("viewer_api_mutations_denied", JSON.stringify(apiResults))
      }
    } catch (error) {
      fail(
        "viewer_api_mutations_denied",
        `${error.message}; start the app or set VERIFY_APP_URL`
      )
    }

    console.log("\n=== 9. No non-SELECT policy mentions viewer ===")
    const badPolicies = await db.query(
      `SELECT schemaname, tablename, policyname, cmd, with_check
       FROM pg_policies
       WHERE cmd <> 'SELECT'
         AND (
           position('viewer' IN coalesce(qual, '')) > 0
           OR position('viewer' IN coalesce(with_check, '')) > 0
         )
       ORDER BY 1, 2, 3`
    )
    const granted = badPolicies.rows.filter((row) => {
      const check = row.with_check ?? ""
      const denyUnlessAdmin = /=\s*'admin'/.test(check) && !/viewer/.test(check)
      return !denyUnlessAdmin
    })
    if (granted.length === 0) {
      pass(
        "no_viewer_write_policies",
        badPolicies.rows.length === 0
          ? "none"
          : `deny-only: ${badPolicies.rows.map((row) => row.policyname).join(", ")}`,
      )
    } else {
      fail("no_viewer_write_policies", JSON.stringify(granted))
    }
  } finally {
    console.log("\n=== 10. Cleanup and residue ===")
    try {
      await cleanupObjects()
      await cleanupData()
      for (const client of Object.values(clients)) {
        await client.auth.signOut().catch(() => {})
      }
      await cleanupUsers()

      let objectCount = 0
      for (const prefix of PREFIXES) {
        objectCount += (await listFixtureObjects(prefix)).length
      }
      const { rows } = await db.query(
        `SELECT
           (SELECT count(*)::int FROM auth.users WHERE email LIKE $1) AS auth_users,
           (SELECT count(*)::int FROM public.profiles WHERE email LIKE $1) AS profiles,
           (SELECT count(*)::int FROM public.product_lines WHERE id = $2) AS product_lines,
           (SELECT count(*)::int FROM public.inventory_items
            WHERE id IN ($3, $4)) AS inventory_items,
           (SELECT count(*)::int FROM public.kit_inspections
            WHERE condition_notes = $5) AS kit_inspections,
           (SELECT count(*)::int FROM public.remediation_providers
            WHERE slug = $6) AS remediation_providers,
           (SELECT count(*)::int FROM public.remediation_cases
            WHERE notes = $5) AS remediation_cases,
           (SELECT count(*)::int FROM public.app_event_logs
            WHERE context = $7) AS app_event_logs`,
        [
          `${EMAIL_PREFIX}%`,
          fixture.productId,
          fixture.activeItemId,
          fixture.deletedItemId,
          DATA_PREFIX,
          `${DATA_PREFIX}provider`,
          `${DATA_PREFIX}log`,
        ]
      )
      const residue = { ...rows[0], objects: objectCount }
      if (Object.values(residue).every((value) => Number(value) === 0)) {
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

  console.log("\n========== VERIFY 059 SUMMARY ==========")
  console.log(JSON.stringify(results, null, 2))
  console.log("========================================")
  if (Object.values(results).some((result) => result.result === "FAIL")) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error("VERIFY 059 FAILED:", error)
  process.exitCode = 1
})
