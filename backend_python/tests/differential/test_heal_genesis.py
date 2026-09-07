"""PHP-vs-Python differential: HealController + GenesisController.

`createProposal` has NO live differential per the task brief (it drives a real
LLM reflection call) — it is covered unit-only in tests/unit/test_heal_genesis.py
with a monkeypatched ChatController.agent.

Ordering: `both()` (tests/differential/conftest.py) always calls PHP before
Python, so any of PHP's own on-demand table/column DDL lands first.

Brief-vs-PHP note: the task brief describes `/heal/record` as "validation-only
... no rows written", but `HealController::record()` (PHP 92-113) has NO
ownership/validation gate at all — with an empty body `actual_usd` defaults to
0 and the handler always reaches its `INSERT ... ON DUPLICATE KEY UPDATE
spent_usd = spent_usd + 0` upsert. That is value-idempotent (adds 0) but can
still CREATE a fresh `heal_spend` row for (user, day, kind='heal') where none
existed. `GenesisController::record()` differs: `promotionBelongsToUser()`
runs BEFORE any write and an empty body's `promotion_id` defaults to 0, which
is unconditionally false there — so `/genesis/record` truly never reaches its
transaction and needs no cleanup. Per constraints.md ("PHP-first ... keep
PHP"), the heal case below is made self-cleaning via a snapshot/restore
fixture around the live `heal_spend` row instead of skipping the write.
"""
import pytest

from tests.differential.conftest import DIFF_USER_ID, same

pytestmark = pytest.mark.differential

_HEAL_SPEND_COLUMNS = 'user_id, day, kind, spent_usd'
_HEAL_SPEND_TODAY_SQL = (
    f'SELECT {_HEAL_SPEND_COLUMNS} FROM heal_spend WHERE user_id = ? AND day = CURDATE() AND kind = ?'
)


@pytest.fixture
def heal_spend_today_restored(config):
    """Snapshot today's (user 3, kind='heal') heal_spend row before the test,
    restore it byte-for-byte after — deleting it if the test's POST /heal/record
    created it fresh, or writing the snapshotted spent_usd back if it already
    existed — then assert the table is exactly as found (constraints.md:
    mutation cases "must leave the DB as they found it for user 3")."""
    from app.db import open_primary
    db = open_primary(config)
    before = db.fetch_all(_HEAL_SPEND_TODAY_SQL, [DIFF_USER_ID, 'heal'])
    try:
        yield
    finally:
        if not before:
            db.execute('DELETE FROM heal_spend WHERE user_id = ? AND day = CURDATE() AND kind = ?',
                       [DIFF_USER_ID, 'heal'])
        else:
            for r in before:
                db.execute('UPDATE heal_spend SET spent_usd = ? WHERE user_id = ? AND day = ? AND kind = ?',
                           [r['spent_usd'], r['user_id'], r['day'], r['kind']])
        after = db.fetch_all(_HEAL_SPEND_TODAY_SQL, [DIFF_USER_ID, 'heal'])
        db.close()
        assert after == before, (before, after)


def test_heal_status_authorize_and_record_parity(both, heal_spend_today_restored):
    same(*both('GET', '/api/v1/heal/status'))
    same(*both('POST', '/api/v1/heal/authorize', json={'estimate_usd': 0.01}))

    # See the module docstring: record() is gate-less, so this always upserts
    # today's heal_spend row for kind='heal' (adding 0 for an empty body).
    # Confirm the observable effect is a true no-op on each backend (the
    # `heal_spend_today_restored` fixture cleans up the underlying row/value
    # afterward and asserts the table matches its pre-test snapshot).
    before_php, before_py = both('GET', '/api/v1/heal/status')
    same(*both('POST', '/api/v1/heal/record', json={}))
    after_php, after_py = both('GET', '/api/v1/heal/status')
    assert before_php.json() == after_php.json(), (before_php.text, after_php.text)
    assert before_py.json() == after_py.json(), (before_py.text, after_py.text)


def test_genesis_promotions_authorize_dismiss_and_record_parity(both):
    same(*both('GET', '/api/v1/genesis/promotions'))
    same(*both('POST', '/api/v1/genesis/authorize', json={'promotion_id': 999999999, 'estimate_usd': 0.01}))
    same(*both('POST', '/api/v1/genesis/promotions/999999999/dismiss'))

    # record() checks promotionBelongsToUser() BEFORE any write; an empty
    # body defaults promotion_id to 0, and promotionBelongsToUser(id<=0, ...)
    # is unconditionally false — so this 404s with zero DB writes on either
    # backend (no before/after check needed, unlike heal/record above).
    same(*both('POST', '/api/v1/genesis/record', json={}))
