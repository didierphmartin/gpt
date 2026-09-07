"""PHP-vs-Python differential: HealController + GenesisController.

`createProposal` has NO live differential per the task brief (it drives a real
LLM reflection call) — it is covered unit-only in tests/unit/test_heal_genesis.py
with a monkeypatched ChatController.agent.

Ordering: `both()` (tests/differential/conftest.py) always calls PHP before
Python, so any of PHP's own on-demand table/column DDL lands first.
"""
import pytest

from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_heal_status_authorize_and_record_parity(both):
    same(*both('GET', '/api/v1/heal/status'))
    same(*both('POST', '/api/v1/heal/authorize', json={'estimate_usd': 0.01}))

    # record() has no ownership/validation gate — with an empty body
    # actual_usd defaults to 0, so it always reaches the upsert (adding 0 to
    # today's heal_spend row for kind='heal'). Assert it's a true no-op by
    # comparing /heal/status before vs after, on each backend independently
    # (constraints.md: mutation cases "must leave the DB as they found it").
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
