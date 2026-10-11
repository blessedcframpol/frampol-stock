/**
 * AU1 — audit coverage, actor from DEFINER RPCs, hash chain, digest/weekly, schema exclusion.
 *
 *   node scripts/rehearse-migration.mjs supabase/migrations/20261011122815_au1_audit_trail.sql scripts/verify-084-au1-audit-trail.mjs
 *   node scripts/verify-084-au1-audit-trail.mjs
 */
import { withHarness } from "./verify-harness.mjs"
import { setJwt } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3084"

export const MARKERS = [
  {
    label: "clients",
    sql: `SELECT count(*)::int AS n FROM public.clients WHERE id LIKE $1`,
    params: [`CLT-${PREFIX}%`],
  },
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-084-%@test.local'`,
    params: [],
  },
  {
    label: "notifications",
    sql: `SELECT count(*)::int AS n FROM public.notifications WHERE type LIKE 'audit_%' AND title LIKE $1`,
    params: [`%${PREFIX}%`],
  },
]

export async function runChecks(ctx) {
  const db = ctx.db
  const pass = ctx.pass
  const fail = ctx.fail

  const adminId = await ctx.createFixtureUser("admin", "harness-084-admin@test.local")
  const viewerId = await ctx.createFixtureUser("viewer", "harness-084-viewer@test.local")
  await db.query(
    `UPDATE public.profiles
     SET display_name = CASE id WHEN $1 THEN 'H3084 Admin' ELSE 'H3084 Viewer' END
     WHERE id IN ($1, $2)`,
    [adminId, viewerId]
  )

  // Seed recipient to the fixture admin so digest/weekly notify inside the txn.
  await db.query(
    `UPDATE public.app_settings
     SET audit_report_recipients = ARRAY['harness-084-admin@test.local']
     WHERE id IS TRUE`
  )

  // --- Coverage: every public table audited or excluded ---
  {
    const missing = await db.query(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND NOT EXISTS (
          SELECT 1 FROM public.audit_trigger_exclusions e WHERE e.table_name = c.relname
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_trigger t
          JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgrelid = c.oid AND NOT t.tgisinternal AND p.proname = 'audit_capture'
        )
      ORDER BY 1
    `)
    if (missing.rowCount === 0) pass("coverage_all_tables", "every public table audited or excluded")
    else fail("coverage_all_tables", missing.rows.map((r) => r.relname).join(", "))
  }

  // --- Actor from SECURITY DEFINER probe + reject_request path via client update already proven;
  //     call set_request_invoice / issue path: mutate product_lines via DEFINER-style probe ---
  {
    await setJwt(db, adminId)
    const clientId = `CLT-${PREFIX}-actor`
    await db.query(
      `INSERT INTO public.clients (id, name, company, email) VALUES ($1, $2, $3, $4)`,
      [clientId, "H3084 Actor", "H3084", "h3084-actor@test.local"]
    )
    await db.query(`RESET ROLE`)
    await db.query(`
      CREATE OR REPLACE FUNCTION public._h3084_definer_touch(p_id text)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
      BEGIN
        UPDATE public.clients SET company = company || '-x' WHERE id = p_id;
      END;
      $fn$;
    `)
    await setJwt(db, adminId)
    await db.query(`SELECT public._h3084_definer_touch($1)`, [clientId])
    const actors = await db.query(
      `SELECT actor, action FROM public.audit_log WHERE row_id = $1 ORDER BY seq`,
      [clientId]
    )
    const ok = actors.rows.length >= 2 && actors.rows.every((r) => r.actor === adminId)
    if (ok) pass("actor_from_definer", JSON.stringify(actors.rows))
    else fail("actor_from_definer", JSON.stringify(actors.rows))
    await db.query(`RESET ROLE`)
    await db.query(`DROP FUNCTION IF EXISTS public._h3084_definer_touch(text)`)
  }

  // --- Maintenance actor naming (migration owner: no app JWT) ---
  {
    await db.query(`RESET ROLE`)
    await db.query(`SELECT set_config('request.jwt.claim.sub', '', true)`)
    await db.query(`SELECT set_config('request.jwt.claims', '', true)`)
    await db.query(`SELECT set_config('app.audit_source', 'maintenance', true)`)
    await db.query(`SELECT set_config('app.audit_actor', 'admin:Joshua Goredema', true)`)
    const clientId = `CLT-${PREFIX}-maint`
    await db.query(
      `INSERT INTO public.clients (id, name, company, email) VALUES ($1, $2, $3, $4)`,
      [clientId, "H3084 Maint", "H3084", "h3084-maint@test.local"]
    )
    const row = await db.query(
      `SELECT actor, source FROM public.audit_log WHERE row_id = $1 ORDER BY seq DESC LIMIT 1`,
      [clientId]
    )
    if (row.rows[0]?.source === "maintenance" && row.rows[0]?.actor === "admin:Joshua Goredema") {
      pass("maintenance_actor", JSON.stringify(row.rows[0]))
    } else {
      fail("maintenance_actor", JSON.stringify(row.rows[0]))
    }
    await db.query(`SELECT set_config('app.audit_source', '', true)`)
    await db.query(`SELECT set_config('app.audit_actor', '', true)`)
  }

  // --- AU1b: authenticated admin cannot spoof maintenance actor ---
  {
    await setJwt(db, adminId)
    await db.query(`SELECT set_config('app.audit_source', 'maintenance', true)`)
    await db.query(`SELECT set_config('app.audit_actor', 'spoofed-not-real', true)`)
    const clientId = `CLT-${PREFIX}-spoof`
    await db.query(
      `INSERT INTO public.clients (id, name, company, email) VALUES ($1, $2, $3, $4)`,
      [clientId, "H3084 Spoof", "H3084", "h3084-spoof@test.local"]
    )
    const row = await db.query(
      `SELECT actor, source FROM public.audit_log WHERE row_id = $1 ORDER BY seq DESC LIMIT 1`,
      [clientId]
    )
    const ok =
      row.rows[0]?.actor === adminId &&
      row.rows[0]?.source !== "maintenance" &&
      row.rows[0]?.actor !== "spoofed-not-real"
    if (ok) pass("actor_spoof_blocked", JSON.stringify(row.rows[0]))
    else fail("actor_spoof_blocked", JSON.stringify(row.rows[0]))
    await db.query(`SELECT set_config('app.audit_source', '', true)`)
    await db.query(`SELECT set_config('app.audit_actor', '', true)`)
    await db.query(`SELECT set_config('request.jwt.claim.sub', '', true)`)
    await db.query(`SELECT set_config('request.jwt.claims', '', true)`)
  }

  // --- AU1b: record_sign_in writes one sign_in row for auth.uid() ---
  {
    await setJwt(db, adminId)
    const id = await db.query(
      `SELECT public.record_sign_in($1, $2) AS id`,
      ["203.0.113.10", "H3084-TestAgent"]
    )
    const row = await db.query(
      `SELECT action, actor, source, table_name, changed
       FROM public.audit_log WHERE id = $1`,
      [id.rows[0].id]
    )
    const r = row.rows[0]
    if (
      r?.action === "sign_in" &&
      r?.actor === adminId &&
      r?.source === "sign_in" &&
      r?.table_name === "auth" &&
      r?.changed?.ip === "203.0.113.10"
    ) {
      pass("record_sign_in", JSON.stringify(r))
    } else {
      fail("record_sign_in", JSON.stringify(r))
    }
    const listed = await db.query(
      `SELECT public.auth_sign_ins_read($1, NULL, NULL) AS v`,
      ["H3084 Admin"]
    )
    const hits = (listed.rows[0].v || []).filter((x) => x.actor_id === adminId)
    if (hits.length >= 1) pass("sign_in_in_person_view", `n=${hits.length}`)
    else fail("sign_in_in_person_view", JSON.stringify(listed.rows[0].v))
    await db.query(`SELECT set_config('request.jwt.claim.sub', '', true)`)
    await db.query(`SELECT set_config('request.jwt.claims', '', true)`)
  }

  // --- Chain ok, then tamper caught (savepoint restores the chain) ---
  {
    const intact = await db.query(`SELECT * FROM public.verify_audit_chain()`)
    if (intact.rowCount === 0) pass("chain_intact", "no broken links")
    else fail("chain_intact", JSON.stringify(intact.rows))

    const target = await db.query(`SELECT seq FROM public.audit_log ORDER BY seq DESC LIMIT 1`)
    const seq = target.rows[0]?.seq
    await db.query(`SAVEPOINT au1_before_tamper`)
    await db.query(`ALTER TABLE public.audit_log DISABLE TRIGGER tr_audit_log_append_only`)
    await db.query(`UPDATE public.audit_log SET changed = '{"tamper":[null,"x"]}'::jsonb WHERE seq = $1`, [
      seq,
    ])
    await db.query(`ALTER TABLE public.audit_log ENABLE TRIGGER tr_audit_log_append_only`)

    const broken = await db.query(`SELECT * FROM public.verify_audit_chain()`)
    if (broken.rowCount === 1 && Number(broken.rows[0].broken_seq) === Number(seq)) {
      pass("tamper_detected", JSON.stringify(broken.rows[0]))
    } else {
      fail("tamper_detected", JSON.stringify(broken.rows))
    }

    await db.query(`ROLLBACK TO SAVEPOINT au1_before_tamper`)
    const again = await db.query(`SELECT * FROM public.verify_audit_chain()`)
    if (again.rowCount === 0) pass("chain_restored", "savepoint restored chain")
    else fail("chain_restored", JSON.stringify(again.rows))
  }

  // --- Digest + weekly on fixed dates ---
  {
    const asOf = "2026-10-10T16:05:00+00" // 18:05 Harare on 10 Oct
    const digest = await db.query(`SELECT public.write_audit_daily_digest($1::timestamptz) AS v`, [asOf])
    const day = digest.rows[0]?.v?.day
    const sealed = await db.query(`SELECT last_seq, row_count FROM public.audit_daily_digest WHERE day = $1::date`, [
      day,
    ])
    if (sealed.rowCount === 1) pass("daily_digest", JSON.stringify({ day, ...sealed.rows[0], result: digest.rows[0].v }))
    else fail("daily_digest", JSON.stringify(digest.rows[0]))

    const note = await db.query(
      `SELECT count(*)::int AS n FROM public.notifications
       WHERE user_id = $1 AND type = 'audit_daily_digest'`,
      [adminId]
    )
    if (note.rows[0].n >= 1) pass("daily_digest_notify", `n=${note.rows[0].n}`)
    else fail("daily_digest_notify", "no notification")

    // Monday 12 Oct 2026 06:05 UTC = 08:05 Harare
    const weekly = await db.query(
      `SELECT public.notify_audit_weekly_exceptions($1::timestamptz) AS v`,
      ["2026-10-12T06:05:00+00"]
    )
    const wnote = await db.query(
      `SELECT count(*)::int AS n FROM public.notifications
       WHERE user_id = $1 AND type = 'audit_weekly_exceptions'`,
      [adminId]
    )
    if (wnote.rows[0].n >= 1 && weekly.rows[0]?.v) {
      pass("weekly_exceptions", JSON.stringify(weekly.rows[0].v))
    } else {
      fail("weekly_exceptions", JSON.stringify({ weekly: weekly.rows[0], n: wnote.rows[0].n }))
    }
  }

  // --- Schema-rules style: unaudited test table fails the coverage query ---
  {
    await db.query(`CREATE TABLE public._au1_unauth_test (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`)
    const missing = await db.query(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND NOT EXISTS (
          SELECT 1 FROM public.audit_trigger_exclusions e WHERE e.table_name = c.relname
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_trigger t
          JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgrelid = c.oid AND NOT t.tgisinternal AND p.proname = 'audit_capture'
        )
      ORDER BY 1
    `)
    const hit = missing.rows.some((r) => r.relname === "_au1_unauth_test")
    if (hit) pass("unaudited_table_detected", "_au1_unauth_test")
    else fail("unaudited_table_detected", missing.rows.map((r) => r.relname).join(", "))
    await db.query(`DROP TABLE public._au1_unauth_test`)
  }

  // --- Read gates ---
  {
    await setJwt(db, viewerId)
    const read = await db.query(
      `SELECT jsonb_array_length(public.audit_log_read(NULL, NULL, NULL, NULL, NULL, NULL)) AS n`
    )
    if (Number(read.rows[0].n) >= 0) pass("viewer_can_read_audit", `n=${read.rows[0].n}`)
    else fail("viewer_can_read_audit", "failed")

    const signs = await db.query(`SELECT public.auth_sign_ins_read(NULL, NULL, NULL) AS v`)
    const signRows = signs.rows[0].v
    if (Array.isArray(signRows) && signRows.some((r) => r.action === "sign_in")) {
      pass("sign_ins_read", `n=${signRows.length}`)
    } else {
      fail("sign_ins_read", JSON.stringify(signRows))
    }

    await setJwt(db, adminId)
    const ex = await db.query(`SELECT public.audit_exceptions_read($1::date, $2::date) AS v`, [
      "2026-10-01",
      "2026-10-11",
    ])
    if (Array.isArray(ex.rows[0].v)) pass("exceptions_read", `n=${ex.rows[0].v.length}`)
    else fail("exceptions_read", JSON.stringify(ex.rows[0]))
  }
}

const isMain = process.argv[1] && process.argv[1].includes("verify-084-au1-audit-trail")
if (isMain) {
  await withHarness({ markers: MARKERS, timeoutMs: 300_000, label: "084-au1" }, runChecks)
}
