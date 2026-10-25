/**
 * PHP-vs-TS differential: HealController + GenesisController — twin of
 * backend_python/tests/differential/test_heal_genesis.py.
 *
 * `createProposal` has NO live differential (it drives a real LLM reflection call); it is covered
 * unit-only.
 *
 * Ordering: `both()` always calls PHP before TS, so PHP's own on-demand table/column DDL lands first.
 *
 * `HealController::record()` (PHP 92-113) has NO ownership/validation gate: with an empty body
 * `actual_usd` defaults to 0 and the handler always reaches its `INSERT ... ON DUPLICATE KEY UPDATE
 * spent_usd = spent_usd + 0` upsert. Value-idempotent, but it can CREATE a fresh `heal_spend` row
 * for (user, day, kind='heal'). `GenesisController::record()` runs `promotionBelongsToUser()` BEFORE
 * any write, and an empty body's promotion_id defaults to 0 (always false), so `/genesis/record`
 * never writes. The heal case is made self-cleaning via a snapshot/restore of today's row.
 *
 * WRITES: test_heal_status_authorize_and_record_parity (the heal_spend upsert, restored after).
 * test_genesis_promotions_authorize_dismiss_and_record_parity writes nothing (non-existent ids).
 */
import { dtest, DIFF_USER_ID, same, assert } from './harness';

const HEAL_SPEND_TODAY_SQL = 'SELECT user_id, day, kind, spent_usd FROM heal_spend WHERE user_id = ? AND day = CURDATE() AND kind = ?';

dtest.write('test_heal_status_authorize_and_record_parity', async (hx) => {
  const db = hx.primaryDb;
  // Fixture `heal_spend_today_restored`: snapshot, restore byte-for-byte, assert as found.
  const before = await db.fetchAll(HEAL_SPEND_TODAY_SQL, [DIFF_USER_ID, 'heal']);
  try {
    same(...(await hx.both('GET', '/api/v1/heal/status')));
    same(...(await hx.both('POST', '/api/v1/heal/authorize', { json: { estimate_usd: 0.01 } })));

    // record() is gate-less, so this always upserts today's heal_spend row (adding 0 for an empty
    // body). The observable effect must be a true no-op on each backend.
    const [beforePhp, beforeTs] = await hx.both('GET', '/api/v1/heal/status');
    same(...(await hx.both('POST', '/api/v1/heal/record', { json: {} })));
    const [afterPhp, afterTs] = await hx.both('GET', '/api/v1/heal/status');
    assert.deepStrictEqual(afterPhp.json(), beforePhp.json());
    assert.deepStrictEqual(afterTs.json(), beforeTs.json());
  } finally {
    if (!before.length) {
      await db.execute('DELETE FROM heal_spend WHERE user_id = ? AND day = CURDATE() AND kind = ?', [DIFF_USER_ID, 'heal']);
    } else {
      for (const r of before) {
        await db.execute('UPDATE heal_spend SET spent_usd = ? WHERE user_id = ? AND day = ? AND kind = ?', [r.spent_usd, r.user_id, r.day, r.kind]);
      }
    }
    const after = await db.fetchAll(HEAL_SPEND_TODAY_SQL, [DIFF_USER_ID, 'heal']);
    assert.deepStrictEqual(after, before);
  }
});

dtest('test_genesis_promotions_authorize_dismiss_and_record_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/genesis/promotions')));
  same(...(await hx.both('POST', '/api/v1/genesis/authorize', { json: { promotion_id: 999999999, estimate_usd: 0.01 } })));
  same(...(await hx.both('POST', '/api/v1/genesis/promotions/999999999/dismiss')));
  // promotionBelongsToUser(0, ...) is false BEFORE any write: a 404 with zero DB writes.
  same(...(await hx.both('POST', '/api/v1/genesis/record', { json: {} })));
});
