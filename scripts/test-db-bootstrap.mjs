/**
 * Post-schema bootstrap for the TEST database after clone + refresh:
 * - sync table grants from production
 * - revoke anon function execute
 * - seed auth.users for copied profiles
 * - ensure private uploads bucket + no anon storage policies
 * - tighten audit_log grants
 * - apply NC1 migration if trigger missing
 *
 *   node --require ./scripts/dev/tls-classic.cjs scripts/test-db-bootstrap.mjs
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createRequire } from "module"
import { spawnSync } from "child_process"

const require = createRequire(import.meta.url)
const { Client } = require("pg")
const { loadVerifyEnv, resolveHarnessDbUrl, PRODUCTION_SUPABASE_REF } = require("./verify-env.cjs")

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

loadVerifyEnv({ production: false })
const { dbUrl, production, ref } = resolveHarnessDbUrl(false)
if (production || ref === PRODUCTION_SUPABASE_REF) {
  throw new Error("test-db-bootstrap refuses production")
}

function run(script) {
  console.log(`\n→ ${script}`)
  const r = spawnSync(
    process.execPath,
    ["--require", "./scripts/dev/tls-classic.cjs", script],
    { cwd: root, stdio: "inherit", env: process.env },
  )
  if (r.status !== 0) throw new Error(`${script} exited ${r.status}`)
}

run("scripts/test-db-sync-grants.mjs")

const db = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
await db.connect()
try {
  console.log("\n→ revoke anon EXECUTE + seed auth.users + storage + audit_log grants")
  await db.query(`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
      LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
      END LOOP;
    END $$;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;
  `)

  const missing = await db.query(`
    SELECT p.id, p.email FROM public.profiles p
    LEFT JOIN auth.users u ON u.id = p.id WHERE u.id IS NULL
  `)
  for (const row of missing.rows) {
    await db.query(
      `
      INSERT INTO auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at
      ) VALUES (
        '00000000-0000-0000-0000-000000000000',
        $1, 'authenticated', 'authenticated', $2,
        crypt('harness-not-for-login', gen_salt('bf')),
        now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
        now(), now()
      ) ON CONFLICT (id) DO NOTHING
    `,
      [row.id, row.email || `${row.id}@example.test`],
    )
  }
  console.log(`  seeded ${missing.rows.length} auth.users`)

  await db.query(`
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('uploads', 'uploads', false)
    ON CONFLICT (id) DO UPDATE SET public = false
  `)
  for (const name of ["Allow anon read uploads", "Allow anon upload"]) {
    await db.query(`DROP POLICY IF EXISTS "${name}" ON storage.objects`)
  }

  await db.query(`
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.audit_log FROM service_role;
    GRANT SELECT ON TABLE public.audit_log TO service_role;
    REVOKE ALL ON TABLE public.audit_log FROM authenticated, anon, PUBLIC;
    -- Ensure RLS blocks table-level writes for authenticated (read via audit_log_read only).
    ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.audit_log FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "audit_log_no_direct_write" ON public.audit_log;
    DROP POLICY IF EXISTS "audit_log_deny_authenticated_write" ON public.audit_log;
  `)
  // No authenticated INSERT/UPDATE/DELETE policy → writes denied under FORCE RLS.
  // Keep any existing SELECT-via-function paths; do not grant table SELECT to authenticated.

  const trg = await db.query(`
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relname='clients' AND t.tgname = 'tr_clients_nc1_validate'
  `)
  if (trg.rows.length === 0) {
    const sql = fs.readFileSync(
      path.join(root, "supabase/migrations/20261015120000_nc1_client_complete.sql"),
      "utf8",
    )
    console.log("  applying NC1 migration…")
    await db.query(sql)
  } else {
    console.log("  NC1 trigger already present")
  }
} finally {
  await db.end()
}

console.log(`\ntest-db-bootstrap complete for ${ref}`)
