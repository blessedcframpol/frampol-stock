/**
 * Shared helpers for harness verify scripts that call apply_stock_movement
 * inside one outer transaction.
 */

/**
 * Drop ON COMMIT DROP temp table left by apply_stock_movement.
 * Uses a SAVEPOINT so a permission error (e.g. under SET LOCAL ROLE authenticated)
 * cannot abort the outer harness transaction.
 */
export async function dropMovementPrev(db) {
  const sp = `sp_drop_prev_${Math.random().toString(36).slice(2, 10)}`
  await db.query(`SAVEPOINT ${sp}`)
  try {
    await db.query(`DROP TABLE IF EXISTS _movement_prev`)
    await db.query(`RELEASE SAVEPOINT ${sp}`)
  } catch {
    await db.query(`ROLLBACK TO SAVEPOINT ${sp}`)
  }
}

/**
 * Stamp transaction created_at so reverse_restore_plan strict `<` ordering works
 * when now() is frozen for the harness transaction.
 * @param {import('pg').Client} db
 * @param {{ tick: number, baseIso?: string }} clock
 * @param {...string} txnIds
 */
export async function stampTxn(db, clock, ...txnIds) {
  const base = Date.parse(clock.baseIso || "2026-10-02T00:00:00.000Z")
  for (const txnId of txnIds) {
    clock.tick += 1
    const at = new Date(base + clock.tick).toISOString()
    await db.query(`UPDATE public.transactions SET created_at = $2::timestamptz WHERE id = $1`, [
      txnId,
      at,
    ])
  }
}

/** Make restore win over reverse when both used the same frozen now(). */
export async function bumpRestoreClock(db, batchId) {
  await db.query(
    `UPDATE public.batch_restores
     SET restored_at = restored_at + interval '1 millisecond'
     WHERE ctid = (
       SELECT ctid FROM public.batch_restores
       WHERE batch_id = $1
       ORDER BY restored_at DESC
       LIMIT 1
     )`,
    [batchId],
  )
}

export async function setJwt(db, userId) {
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
  await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ])
}
