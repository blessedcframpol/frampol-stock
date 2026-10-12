/**
 * FB1 — problem reports: create (every role), screenshot privacy, resolve notifies reporter.
 *
 *   node scripts/rehearse-migration.mjs supabase/migrations/20261012063732_fb1_problem_reports.sql scripts/verify-086-fb1-problem-reports.mjs
 *   node scripts/verify-086-fb1-problem-reports.mjs
 */
import { withHarness } from "./verify-harness.mjs"
import { setJwt } from "./verify-harness-fixtures.mjs"

const PREFIX = "H3086"

export const MARKERS = [
  {
    label: "users",
    sql: `SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'harness-086-%@test.local'`,
  },
  {
    label: "reports",
    sql: `SELECT CASE
            WHEN to_regclass('public.problem_reports') IS NULL THEN 0
            ELSE (
              SELECT count(*)::int FROM public.problem_reports WHERE what_happened LIKE $1
            )
          END AS n`,
    params: [`${PREFIX}%`],
  },
  {
    label: "notifications",
    sql: `SELECT count(*)::int AS n FROM public.notifications
          WHERE (type IN ('problem_report', 'problem_report_resolved'))
            AND (title LIKE $1 OR body LIKE $1)`,
    params: [`%${PREFIX}%`],
  },
]

export async function runChecks(ctx) {
  const db = ctx.db
  const pass = ctx.pass
  const fail = ctx.fail
  const raises = ctx.raises
  const asUser = ctx.asUser

  const blessed = await ctx.createFixtureUser("admin", "harness-086-blessed@test.local")
  await db.query(
    `UPDATE public.profiles
     SET email = 'harness-086-blessed@test.local', display_name = 'H3086 Blessed'
     WHERE id = $1`,
    [blessed]
  )
  await db.query(
    `UPDATE public.app_settings
     SET problem_report_recipients = ARRAY['harness-086-blessed@test.local']
     WHERE id IS TRUE`
  )

  const roles = ["admin", "sales", "accounts", "technicians", "viewer"]
  const created = []

  for (const role of roles) {
    const uid = await ctx.createFixtureUser(role, `harness-086-${role}@test.local`)
    const shot =
      role === "sales"
        ? `problem-reports/${uid}/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png`
        : null
    const v = await asUser(uid, async () => {
      const row = await db.query(
        `SELECT public.submit_problem_report(
           $1, $2, $3, $4, $5, $6, $7::jsonb
         ) AS v`,
        [
          `${PREFIX} ${role} broken button`,
          role === "viewer" ? "Expected it to work" : null,
          shot,
          `https://app.example/requests?role=${role}`,
          "Mozilla/5.0 H3086",
          "390x844",
          JSON.stringify({ request_number: "REQ-26-0001", kit_serial: "SL-H3086" }),
        ]
      )
      return row.rows[0].v
    })
    if (v?.report_number && /^PR-\d{2}-\d{4,}$/.test(v.report_number)) {
      pass(`create_${role}`, v.report_number)
    } else {
      fail(`create_${role}`, JSON.stringify(v))
    }
    created.push({ role, uid, id: v.id, number: v.report_number, shot })
  }

  {
    const sales = created.find((c) => c.role === "sales")
    const notes = await db.query(
      `SELECT user_id, metadata->>'href' AS href
       FROM public.notifications
       WHERE type = 'problem_report'
         AND metadata->>'problem_report_id' = $1`,
      [sales.id]
    )
    const blessedGot = notes.rows.some((r) => r.user_id === blessed)
    const hrefOk = notes.rows.every((r) => String(r.href || "").startsWith("/problems/"))
    if (blessedGot && hrefOk && notes.rowCount >= 1) {
      pass("recipient_notify", `n=${notes.rowCount}`)
    } else {
      fail("recipient_notify", JSON.stringify(notes.rows))
    }
  }

  {
    const sales = created.find((c) => c.role === "sales")
    const tech = created.find((c) => c.role === "technicians")
    const stored = await db.query(
      `SELECT screenshot_path FROM public.problem_reports WHERE id = $1`,
      [sales.id]
    )
    const path = stored.rows[0]?.screenshot_path
    if (path && path.startsWith(`problem-reports/${sales.uid}/`) && !/^https?:/i.test(path)) {
      pass("screenshot_path_private", path)
    } else {
      fail("screenshot_path_private", JSON.stringify(stored.rows[0]))
    }

    const otherN = await asUser(tech.uid, async () => {
      const peek = await db.query(
        `SELECT count(*)::int AS n FROM public.problem_reports WHERE id = $1`,
        [sales.id]
      )
      return peek.rows[0].n
    })
    if (otherN === 0) pass("rls_other_user_blocked", "0 rows")
    else fail("rls_other_user_blocked", String(otherN))

    const adminN = await asUser(blessed, async () => {
      const peek = await db.query(
        `SELECT count(*)::int AS n FROM public.problem_reports WHERE id = $1`,
        [sales.id]
      )
      return peek.rows[0].n
    })
    if (adminN === 1) pass("rls_admin_can_read", "1")
    else fail("rls_admin_can_read", String(adminN))
  }

  {
    const sales = created.find((c) => c.role === "sales")
    const tech = created.find((c) => c.role === "technicians")
    const err = await asUser(sales.uid, () =>
      raises(
        `SELECT public.submit_problem_report(
           $1, NULL, $2, 'https://app.example/x', NULL, NULL, '{}'::jsonb
         )`,
        [
          `${PREFIX} bad path`,
          `problem-reports/${tech.uid}/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png`,
        ],
        "private folder"
      )
    )
    if (!err) pass("reject_foreign_screenshot", "refused")
    else fail("reject_foreign_screenshot", err)
  }

  {
    const sales = created.find((c) => c.role === "sales")
    await asUser(blessed, async () => {
      await db.query(
        `SELECT public.update_problem_report_status(
           $1::uuid, 'resolved'::public.problem_report_status, $2
         )`,
        [sales.id, `${PREFIX} fixed the button`]
      )
    })
    const notes = await db.query(
      `SELECT user_id, type, metadata->>'href' AS href, body
       FROM public.notifications
       WHERE type = 'problem_report_resolved'
         AND metadata->>'problem_report_id' = $1`,
      [sales.id]
    )
    const ok =
      notes.rowCount === 1 &&
      notes.rows[0].user_id === sales.uid &&
      String(notes.rows[0].href).startsWith("/problems/") &&
      String(notes.rows[0].body).includes(PREFIX)
    if (ok) pass("resolve_notifies_reporter", notes.rows[0].href)
    else fail("resolve_notifies_reporter", JSON.stringify(notes.rows))

    const err = await asUser(sales.uid, () =>
      raises(
        `SELECT public.update_problem_report_status(
           $1::uuid, 'open'::public.problem_report_status, NULL
         )`,
        [sales.id],
        "admin only"
      )
    )
    if (!err) pass("non_admin_status_refused", "refused")
    else fail("non_admin_status_refused", err)
  }

  {
    const bucket = await db.query(
      `SELECT public AS is_public FROM storage.buckets WHERE id = 'uploads'`
    )
    if (bucket.rows[0]?.is_public === false) pass("uploads_bucket_private", "false")
    else fail("uploads_bucket_private", JSON.stringify(bucket.rows[0]))
  }

  await db.query(`SELECT set_config('request.jwt.claim.sub', '', true)`)
  await db.query(`SELECT set_config('request.jwt.claims', '', true)`)
}

const isMain = process.argv[1] && process.argv[1].includes("verify-086-fb1-problem-reports")
if (isMain) {
  await withHarness({ markers: MARKERS, timeoutMs: 300_000, label: "086-fb1" }, runChecks)
}
