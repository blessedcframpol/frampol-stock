/**
 * NT3 — push_subscriptions RLS, profile prefs RPC, trigger soft-fail, pg_net.
 *
 *   node --require ./scripts/dev/tls-classic.cjs scripts/verify-100-nt3-web-push.mjs
 */
import { runVerifyCli } from "./verify-harness.mjs"

const NOTES = "harness-100-nt3"
const EMAIL = "harness-100-"

export const MARKERS = [
  {
    label: "push_subscriptions",
    sql: `SELECT count(*)::int AS n FROM public.push_subscriptions WHERE endpoint LIKE $1`,
    params: [`%${NOTES}%`],
  },
  {
    label: "notifications",
    sql: `SELECT count(*)::int AS n FROM public.notifications WHERE title LIKE $1 OR body LIKE $1`,
    params: [`%${NOTES}%`],
  },
]

export async function runChecks(ctx) {
  const { db, pass, fail, asUser } = ctx
  await db.query(`SET LOCAL statement_timeout = '120s'`)

  const table = await db.query(`SELECT to_regclass('public.push_subscriptions') IS NOT NULL AS ok`)
  if (!table.rows[0]?.ok) {
    fail("table", "push_subscriptions missing")
    return
  }
  pass("table")

  const ext = await db.query(`SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_net') AS ok`)
  if (ext.rows[0]?.ok) pass("pg_net")
  else fail("pg_net", "extension missing")

  const excl = await db.query(
    `SELECT reason FROM public.audit_trigger_exclusions WHERE table_name = 'push_subscriptions'`,
  )
  if (excl.rowCount === 1) pass("audit_exclusion", excl.rows[0].reason.slice(0, 48))
  else fail("audit_exclusion", "missing")

  const cols = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles'
       AND column_name LIKE 'desktop_push_%'
     ORDER BY 1`,
  )
  if (cols.rowCount >= 4) pass("profile_prefs_columns", String(cols.rowCount))
  else fail("profile_prefs_columns", `got ${cols.rowCount}`)

  const userId = await ctx.createFixtureUser("sales", `${EMAIL}sales@test.local`)
  const otherId = await ctx.createFixtureUser("admin", `${EMAIL}admin@test.local`)

  await asUser(userId, async () => {
    await db.query(`SELECT public.update_my_desktop_push_prefs(true, true, false, true)`)
  })
  const prefs = await db.query(
    `SELECT desktop_push_enabled, desktop_push_reminders FROM public.profiles WHERE id = $1`,
    [userId],
  )
  if (prefs.rows[0]?.desktop_push_enabled === true && prefs.rows[0]?.desktop_push_reminders === false) {
    pass("prefs_rpc")
  } else fail("prefs_rpc", JSON.stringify(prefs.rows[0]))

  const endpoint = `https://example.test/push/${NOTES}/${userId}`
  await asUser(userId, async () => {
    await db.query(
      `INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, 'p256dh-test', 'auth-test', 'harness')`,
      [userId, endpoint],
    )
  })

  const own = await asUser(userId, async () => {
    const r = await db.query(`SELECT count(*)::int AS n FROM public.push_subscriptions WHERE endpoint = $1`, [
      endpoint,
    ])
    return r.rows[0]?.n
  })
  if (own === 1) pass("rls_own_select")
  else fail("rls_own_select", String(own))

  const otherSee = await asUser(otherId, async () => {
    const r = await db.query(`SELECT count(*)::int AS n FROM public.push_subscriptions WHERE endpoint = $1`, [
      endpoint,
    ])
    return r.rows[0]?.n
  })
  if (otherSee === 0) pass("rls_other_blocked")
  else fail("rls_other_blocked", String(otherSee))

  // Trigger must not fail insert even with bad/missing vault (already soft).
  const before = await db.query(`SELECT count(*)::int AS n FROM public.notifications`)
  await db.query(
    `INSERT INTO public.notifications (user_id, type, title, body, metadata)
     VALUES ($1, 'request_submitted', $2, $2, jsonb_build_object('request_number', 'REQ-H100', 'request_id', gen_random_uuid()::text))`,
    [userId, NOTES],
  )
  const after = await db.query(`SELECT count(*)::int AS n FROM public.notifications`)
  if ((after.rows[0]?.n ?? 0) > (before.rows[0]?.n ?? 0)) pass("trigger_insert_ok")
  else fail("trigger_insert_ok", "notification not inserted")

  const trg = await db.query(
    `SELECT 1 FROM pg_trigger WHERE tgname = 'notifications_enqueue_web_push_trg' AND NOT tgisinternal`,
  )
  if (trg.rowCount === 1) pass("trigger_exists")
  else fail("trigger_exists", "missing")
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("verify-100-nt3-web-push.mjs")
if (isMain) {
  runVerifyCli({ markers: MARKERS, timeoutMs: 180_000, label: "100-nt3" }, runChecks)
}
