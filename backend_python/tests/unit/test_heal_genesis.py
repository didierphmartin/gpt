"""HealController + GenesisController + GenesisProposer unit tests —
PHP-truth strings and byte-identical (whitespace-normalized) SQL.

PHP sources:
  backend/src/Controllers/HealController.php (20-206)
  backend/src/Controllers/GenesisController.php (20-507)
  backend/src/Services/GenesisProposer.php (1-131)

The GenesisController.decide() matrix below ports every case from
backend/tests/Unit/GenesisDecideTest.php verbatim (same mode/estimate/
remaining/ceiling/bornThisWeek/weeklyMax/approved inputs, same expected
allowed/requires_approval/reason). The GenesisProposer cases below port
backend/tests/Unit/GenesisProposerTest.php's parseProposal/prompt-builder
tests verbatim EXCEPT the three `buildWorkflowPrompt` cases — that method
does not exist in current GenesisProposer.php (131 lines; only
buildConversationPrompt/buildPromptLibraryPrompt/parseProposal). See the
concern note at the top of app/services/genesis_proposer.py.

HealController has no PHP unit-test oracle file (none found under
tests/Unit/*Heal*), so its decide()/authorize()/record()/status() cases below
are derived directly from the PHP source's branches.
"""
from starlette.datastructures import Headers

from app.controllers.genesis_controller import GenesisController
from app.controllers.heal_controller import HealController
from app.services.genesis_proposer import GenesisProposer
from app.support.http import Ctx


class FakeDb:
    """Records every statement so the tests can assert SQL byte-for-byte
    (mirrors tests/unit/test_settings_controller.py's FakeDb)."""

    def __init__(self, one=None, all_=None, column=None, rowcount=1, insert_id=1,
                 tables=('heal_spend', 'skill_promotions'), columns=True):
        self.one = list(one or [])
        self.all_ = list(all_ or [])
        self.column = list(column or [])
        self.rowcount = rowcount
        self.insert_id = insert_id
        self.tables = set(tables)
        self.columns = columns
        self.calls = []
        self.began = 0
        self.committed = 0
        self.rolledback = 0

    def _presence(self, sql):
        if sql.startswith('SHOW TABLES LIKE '):
            name = sql.split("'")[1]
            return [{'x': name}] if name in self.tables else []
        if sql.startswith('SHOW COLUMNS FROM '):
            return [{'Field': sql.split("'")[1]}] if self.columns else []
        return None

    def fetch_all(self, sql, params=None):
        p = self._presence(sql)
        if p is not None:
            return p
        self.calls.append((sql, params))
        return self.all_.pop(0) if self.all_ else []

    def fetch_one(self, sql, params=None):
        self.calls.append((sql, params))
        return self.one.pop(0) if self.one else None

    def fetch_column(self, sql, params=None):
        self.calls.append((sql, params))
        return self.column.pop(0) if self.column else []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        return self.rowcount

    def insert(self, sql, params=None):
        self.calls.append((sql, params))
        return self.insert_id

    def begin(self):
        self.began += 1

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolledback += 1


class ExplodingDb(FakeDb):
    def execute(self, sql, params=None):
        raise RuntimeError('boom')


def ctx(body=None, user_id=3, query=None):
    return Ctx(method='POST', uri='/', headers=Headers({}), query=query or {},
               body=body if body is not None else {}, raw_body='', params={},
               user_id=user_id, authenticated=True, remote_addr='')


# ══════════════════════════════════════════════════════════════════════════
# HealController
# ══════════════════════════════════════════════════════════════════════════

def test_heal_decide_matrix():
    c = HealController(FakeDb(), {})
    assert c.decide('off', 0.10, 3.0, 1.0) == {'allowed': False, 'requires_approval': False, 'reason': 'mode_off'}
    assert c.decide('auto', 2.0, 1.0, 5.0) == {'allowed': False, 'requires_approval': False, 'reason': 'over_budget'}
    assert c.decide('ask', 0.10, 3.0, 1.0) == {'allowed': True, 'requires_approval': True, 'reason': 'ask'}
    assert c.decide('auto', 2.0, 3.0, 1.0) == {'allowed': False, 'requires_approval': True, 'reason': 'over_ceiling'}
    assert c.decide('auto', 0.50, 3.0, 1.0) == {'allowed': True, 'requires_approval': False, 'reason': 'auto'}


def test_heal_authorize_requires_auth():
    c = HealController(FakeDb(), {})
    assert c.authorize(ctx(user_id=0)) == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_heal_authorize_ask_mode_full_shape():
    db = FakeDb(one=[{'heal_mode': 'ask', 'heal_daily_budget_usd': '5.00', 'heal_per_heal_ceiling_usd': '1.00'}],
                column=[['0.5000']])
    c = HealController(db, {})
    r = c.authorize(ctx({'estimate_usd': 0.2, 'skill_dir': 'foo'}))
    assert r == {
        'success': True, 'mode': 'ask', 'skill_dir': 'foo', 'estimate_usd': 0.2,
        'spent_today_usd': 0.5, 'budget_usd': 5.0, 'remaining_usd': 4.5, 'ceiling_usd': 1.0,
        'allowed': True, 'requires_approval': True, 'reason': 'ask', 'status_code': 200,
    }


def test_heal_authorize_defaults_when_columns_absent():
    # heal_config's SELECT throws (columns not created yet) -> defaults (mode off = safe)
    class NoUsersColsDb(FakeDb):
        def fetch_one(self, sql, params=None):
            raise RuntimeError('unknown column')
    db = NoUsersColsDb(column=[['0.0000']])
    c = HealController(db, {})
    r = c.authorize(ctx({'estimate_usd': 1.0}))
    assert r['mode'] == 'off'
    assert r['allowed'] is False
    assert r['reason'] == 'mode_off'


def test_heal_record_inserts_kind_scoped_sql_when_column_present():
    db = FakeDb(column=[['1.0000']])
    c = HealController(db, {})
    r = c.record(ctx({'actual_usd': 0.4}))
    assert r == {'success': True, 'spent_today_usd': 1.0, 'status_code': 200}
    sql, params = db.calls[0]
    assert sql == ("INSERT INTO heal_spend (user_id, day, kind, spent_usd) VALUES (:u, CURDATE(), 'heal', :s)"
                   " ON DUPLICATE KEY UPDATE spent_usd = spent_usd + :s2")
    assert params == {':u': 3, ':s': 0.4, ':s2': 0.4}


def test_heal_record_falls_back_to_legacy_sql_when_kind_column_absent():
    db = FakeDb(columns=False, column=[['0.4000']])
    c = HealController(db, {})
    r = c.record(ctx({'actual_usd': 0.4}))
    assert r == {'success': True, 'spent_today_usd': 0.4, 'status_code': 200}
    sql, params = db.calls[0]
    assert sql == ('INSERT INTO heal_spend (user_id, day, spent_usd) VALUES (:u, CURDATE(), :s)'
                   ' ON DUPLICATE KEY UPDATE spent_usd = spent_usd + :s2')
    assert params == {':u': 3, ':s': 0.4, ':s2': 0.4}


def test_heal_record_requires_auth():
    c = HealController(FakeDb(), {})
    assert c.record(ctx(user_id=0)) == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_heal_record_failure_returns_500():
    c = HealController(ExplodingDb(), {})
    r = c.record(ctx({'actual_usd': 1}))
    assert r == {'success': False, 'error': 'record failed', 'status_code': 500}


def test_heal_status_shape():
    db = FakeDb(one=[{'heal_mode': 'auto', 'heal_daily_budget_usd': '5.00', 'heal_per_heal_ceiling_usd': '1.00'}],
                column=[['2.0000']])
    c = HealController(db, {})
    r = c.status(ctx(user_id=3))
    assert r == {'success': True, 'mode': 'auto', 'budget_usd': 5.0, 'ceiling_usd': 1.0,
                 'spent_today_usd': 2.0, 'remaining_usd': 3.0, 'status_code': 200}


def test_heal_status_requires_auth():
    c = HealController(FakeDb(), {})
    assert c.status(ctx(user_id=0)) == {'success': False, 'error': 'Authentication required', 'status_code': 401}


# ─── php_round regression (Phase 7 final-review wave, B1) — half away from
# zero, not Python's round-half-to-even. `php -r 'echo round(2.67895, 4);'`
# -> 2.679; Python's builtin round(2.67895, 4) -> 2.6789.

def test_heal_authorize_rounding_half_away_from_zero():
    db = FakeDb(one=[{'heal_mode': 'ask', 'heal_daily_budget_usd': '5.00', 'heal_per_heal_ceiling_usd': '1.00'}],
                column=[['0.0000']])
    c = HealController(db, {})
    r = c.authorize(ctx({'estimate_usd': 2.67895, 'skill_dir': 'foo'}))
    assert r['estimate_usd'] == 2.679


def test_heal_record_rounding_half_away_from_zero():
    db = FakeDb(column=[['2.67895']])
    c = HealController(db, {})
    r = c.record(ctx({'actual_usd': 0.1}))
    assert r['spent_today_usd'] == 2.679


def test_heal_status_rounding_half_away_from_zero():
    db = FakeDb(one=[{'heal_mode': 'auto', 'heal_daily_budget_usd': '5.00', 'heal_per_heal_ceiling_usd': '1.00'}],
                column=[['2.67895']])
    c = HealController(db, {})
    r = c.status(ctx(user_id=3))
    assert r['spent_today_usd'] == 2.679


# ══════════════════════════════════════════════════════════════════════════
# GenesisController.decide() — ported verbatim from GenesisDecideTest.php
# ══════════════════════════════════════════════════════════════════════════

def _gate():
    # decide() is pure — no DB needed. Constructor accepts db=None for tests
    # (precedent: `new GenesisController(null)` in the PHP oracle).
    return GenesisController(None)


def test_genesis_off_mode_never_allows():
    d = _gate().decide('off', 0.10, 3.0, 1.5, 0, 2, True)
    assert d['allowed'] is False
    assert d['reason'] == 'mode_off'


def test_genesis_suggest_mode_never_builds():
    d = _gate().decide('suggest', 0.10, 3.0, 1.5, 0, 2, True)
    assert d['allowed'] is False
    assert d['reason'] == 'suggest_only'


def test_genesis_over_budget_blocks():
    d = _gate().decide('auto', 2.0, 1.0, 5.0, 0, 2, False)
    assert d['allowed'] is False
    assert d['reason'] == 'over_budget'


def test_genesis_weekly_throttle_blocks():
    d = _gate().decide('auto', 0.10, 3.0, 1.5, 2, 2, False)
    assert d['allowed'] is False
    assert d['reason'] == 'weekly_throttle'


def test_genesis_ask_requires_approval():
    d = _gate().decide('ask', 0.10, 3.0, 1.5, 0, 2, False)
    assert d['allowed'] is False
    assert d['requires_approval'] is True
    assert d['reason'] == 'ask'


def test_genesis_ask_with_approval_allows():
    d = _gate().decide('ask', 0.10, 3.0, 1.5, 0, 2, True)
    assert d['allowed'] is True
    assert d['reason'] == 'ask_approved'


def test_genesis_auto_over_ceiling_requires_approval():
    d = _gate().decide('auto', 2.0, 3.0, 1.5, 0, 2, False)
    assert d['allowed'] is False
    assert d['requires_approval'] is True
    assert d['reason'] == 'over_ceiling'


def test_genesis_auto_under_ceiling_allows():
    d = _gate().decide('auto', 0.50, 3.0, 1.5, 1, 2, False)
    assert d['allowed'] is True
    assert d['requires_approval'] is False
    assert d['reason'] == 'auto'


# ══════════════════════════════════════════════════════════════════════════
# GenesisController — listPromotions / authorize / record / dismiss
# ══════════════════════════════════════════════════════════════════════════

def test_genesis_list_promotions_requires_auth():
    c = GenesisController(FakeDb(), {})
    assert c.listPromotions(ctx(user_id=0)) == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_genesis_list_promotions_sql_without_status():
    db = FakeDb(all_=[[]])
    c = GenesisController(db, {})
    c.listPromotions(ctx(user_id=3, query={}))
    sql, params = db.calls[0]
    assert sql == 'SELECT * FROM skill_promotions WHERE user_id = :u ORDER BY created_at DESC LIMIT 100'
    assert params == {':u': 3}


def test_genesis_list_promotions_sql_with_status():
    db = FakeDb(all_=[[]])
    c = GenesisController(db, {})
    c.listPromotions(ctx(user_id=3, query={'status': 'proposed'}))
    sql, params = db.calls[0]
    assert sql == 'SELECT * FROM skill_promotions WHERE user_id = :u AND status = :s ORDER BY created_at DESC LIMIT 100'
    assert params == {':u': 3, ':s': 'proposed'}


def test_genesis_list_promotions_decodes_eval_queries_and_parameter_schema():
    row = {'id': 5, 'eval_queries': '[{"query":"x","should_trigger":true}]',
           'parameter_schema': '{"topic":{"type":"string"}}'}
    db = FakeDb(all_=[[row]])
    c = GenesisController(db, {})
    r = c.listPromotions(ctx(user_id=3))
    p = r['promotions'][0]
    assert p['eval_queries'] == [{'query': 'x', 'should_trigger': True}]
    assert p['parameter_schema'] == {'topic': {'type': 'string'}}


def test_genesis_list_promotions_empty_eval_queries_and_null_schema():
    row = {'id': 5, 'eval_queries': '[]', 'parameter_schema': None}
    db = FakeDb(all_=[[row]])
    c = GenesisController(db, {})
    r = c.listPromotions(ctx(user_id=3))
    p = r['promotions'][0]
    assert p['eval_queries'] == []
    assert p['parameter_schema'] is None


def test_genesis_authorize_requires_auth():
    c = GenesisController(FakeDb(), {})
    assert c.authorize(ctx(user_id=0)) == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_genesis_authorize_promotion_not_found():
    db = FakeDb(one=[None])
    c = GenesisController(db, {})
    r = c.authorize(ctx({'promotion_id': 1, 'estimate_usd': 0.1}))
    assert r == {'success': False, 'error': 'Promotion not found', 'status_code': 404}


def test_genesis_authorize_already_decided():
    db = FakeDb(one=[{'x': 1}], column=[['born']])
    c = GenesisController(db, {})
    r = c.authorize(ctx({'promotion_id': 1, 'estimate_usd': 0.1}))
    assert r == {'success': False, 'error': 'Promotion already decided', 'status_code': 409}


def test_genesis_authorize_allows_and_updates_status_to_approved():
    db = FakeDb(
        one=[{'x': 1}, {'genesis_mode': 'auto', 'genesis_daily_budget_usd': '3.00',
                         'genesis_per_skill_ceiling_usd': '1.50', 'genesis_max_skills_per_week': 2,
                         'genesis_reflection_provider': 'kimi'}],
        column=[['proposed'], ['0.5000'], ['0']],
    )
    c = GenesisController(db, {})
    r = c.authorize(ctx({'promotion_id': 7, 'estimate_usd': 0.2}))
    assert r['allowed'] is True
    assert r['reason'] == 'auto'
    assert r['born_this_week'] == 0
    assert r['weekly_max'] == 2
    sql, params = db.calls[-1]
    assert sql == "UPDATE skill_promotions SET status = 'approved' WHERE id = ? AND user_id = ?"
    assert params == [7, 3]


def test_genesis_authorize_does_not_update_when_not_allowed():
    db = FakeDb(
        one=[{'x': 1}, {'genesis_mode': 'off', 'genesis_daily_budget_usd': '3.00',
                         'genesis_per_skill_ceiling_usd': '1.50', 'genesis_max_skills_per_week': 2,
                         'genesis_reflection_provider': 'kimi'}],
        column=[['proposed'], ['0.0000'], ['0']],
    )
    c = GenesisController(db, {})
    r = c.authorize(ctx({'promotion_id': 7, 'estimate_usd': 0.2}))
    assert r['allowed'] is False
    assert r['reason'] == 'mode_off'
    assert not any('UPDATE' in (sql or '') for sql, _ in db.calls)


def test_genesis_record_requires_auth():
    c = GenesisController(FakeDb(), {})
    assert c.record(ctx(user_id=0)) == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_genesis_record_promotion_not_found():
    db = FakeDb(one=[None])
    c = GenesisController(db, {})
    r = c.record(ctx({'promotion_id': 1}))
    assert r == {'success': False, 'error': 'Promotion not found', 'status_code': 404}


def test_genesis_record_transaction_sql_and_params_born_outcome():
    db = FakeDb(one=[{'x': 1}], column=[['0.9000']])
    c = GenesisController(db, {})
    r = c.record(ctx({'promotion_id': 9, 'actual_usd': 0.5, 'outcome': 'born', 'skill_dir': 'my-skill'}))
    assert r == {'success': True, 'spent_today_usd': 0.9, 'status_code': 200}
    assert (db.began, db.committed, db.rolledback) == (1, 1, 0)
    update_sql, update_params = db.calls[1]
    assert update_sql == ('UPDATE skill_promotions SET status = :st, born_skill_dir = :dir, decided_at = NOW()'
                           ' WHERE id = :id AND user_id = :u')
    assert update_params == {':st': 'born', ':dir': 'my-skill', ':id': 9, ':u': 3}
    insert_sql, insert_params = db.calls[2]
    assert insert_sql == ("INSERT INTO heal_spend (user_id, day, kind, spent_usd) VALUES (:u, CURDATE(), 'genesis', :s)"
                           ' ON DUPLICATE KEY UPDATE spent_usd = spent_usd + :s2')
    assert insert_params == {':u': 3, ':s': 0.5, ':s2': 0.5}


def test_genesis_record_non_born_outcome_nulls_skill_dir_and_defaults_invalid_outcome_to_failed():
    db = FakeDb(one=[{'x': 1}], column=[['0.0000']])
    c = GenesisController(db, {})
    c.record(ctx({'promotion_id': 9, 'actual_usd': 0.1, 'outcome': 'bogus', 'skill_dir': 'ignored'}))
    _, params = db.calls[1]
    assert params[':st'] == 'failed'
    assert params[':dir'] is None


def test_genesis_authorize_rounding_half_away_from_zero():
    # php_round regression (Phase 7 final-review wave, B1) — half away from
    # zero: `php -r 'echo round(2.67895, 4);'` -> 2.679; Python's builtin
    # round(2.67895, 4) -> 2.6789.
    db = FakeDb(
        one=[{'x': 1}, {'genesis_mode': 'off', 'genesis_daily_budget_usd': '3.00',
                         'genesis_per_skill_ceiling_usd': '1.50', 'genesis_max_skills_per_week': 2,
                         'genesis_reflection_provider': 'kimi'}],
        column=[['proposed'], ['0.0000'], ['0']],
    )
    c = GenesisController(db, {})
    r = c.authorize(ctx({'promotion_id': 7, 'estimate_usd': 2.67895}))
    assert r['estimate_usd'] == 2.679


def test_genesis_record_rounding_half_away_from_zero():
    db = FakeDb(one=[{'x': 1}], column=[['2.67895']])
    c = GenesisController(db, {})
    r = c.record(ctx({'promotion_id': 9, 'actual_usd': 0.1}))
    assert r['spent_today_usd'] == 2.679


def test_genesis_record_failure_rolls_back():
    db = ExplodingDb(one=[{'x': 1}])
    c = GenesisController(db, {})
    r = c.record(ctx({'promotion_id': 1, 'actual_usd': 1}))
    assert r == {'success': False, 'error': 'record failed', 'status_code': 500}
    assert db.rolledback == 1


def test_genesis_dismiss_requires_auth():
    c = GenesisController(FakeDb(), {})
    assert c.dismiss(ctx(user_id=0), 1) == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_genesis_dismiss_not_found():
    db = FakeDb(rowcount=0)
    c = GenesisController(db, {})
    r = c.dismiss(ctx(user_id=3), 999999999)
    assert r == {'success': False, 'error': 'Promotion not found', 'status_code': 404}


def test_genesis_dismiss_success():
    db = FakeDb(rowcount=1)
    c = GenesisController(db, {})
    r = c.dismiss(ctx(user_id=3), 5)
    assert r == {'success': True, 'status_code': 200}
    sql, params = db.calls[-1]
    assert sql == "UPDATE skill_promotions SET status = 'dismissed', decided_at = NOW() WHERE id = ? AND user_id = ?"
    assert params == [5, 3]


# ══════════════════════════════════════════════════════════════════════════
# GenesisController.createProposal — validation + fake-proposer happy path
# ══════════════════════════════════════════════════════════════════════════

def test_genesis_create_proposal_requires_auth():
    c = GenesisController(FakeDb(), {})
    assert c.createProposal(ctx(user_id=0)) == {'success': False, 'error': 'Authentication required', 'status_code': 401}


def test_genesis_create_proposal_invalid_source():
    c = GenesisController(FakeDb(), {})
    r = c.createProposal(ctx({'source': 'bogus'}))
    assert r == {'success': False, 'error': "source must be 'conversation', 'workflow' or 'prompt'", 'status_code': 400}


def test_genesis_create_proposal_context_not_found():
    db = FakeDb(column=[[]])
    c = GenesisController(db, {})
    r = c.createProposal(ctx({'source': 'conversation', 'context_id': 5}))
    assert r == {'success': False, 'error': 'Context not found', 'status_code': 404}


def test_genesis_create_proposal_context_no_messages():
    db = FakeDb(column=[['{"messages": []}']])
    c = GenesisController(db, {})
    r = c.createProposal(ctx({'source': 'conversation', 'context_id': 5}))
    assert r == {'success': False, 'error': 'Context has no messages', 'status_code': 400}


def test_genesis_create_proposal_conversation_happy_path_with_fake_reflection(monkeypatch):
    llm_json = ('{"skill_name":"newsletter-composer","description":"WHEN asked DO compose",'
                '"eval_queries":[{"query":"q","should_trigger":true}],"merge_target":null,'
                '"rationale":"seen often"}')

    def fake_agent(self, request):
        assert request['body']['provider'] == 'kimi'
        return {'success': True, 'response': llm_json}

    monkeypatch.setattr('app.controllers.chat_controller.ChatController.agent', fake_agent)

    db = FakeDb(column=[['{"messages": [{"role":"user","content":"hi"}]}']], insert_id=42)
    c = GenesisController(db, {})
    r = c.createProposal(ctx({'source': 'conversation', 'context_id': 5, 'catalog': []}))
    assert r['success'] is True
    assert r['promotion']['id'] == 42
    assert r['promotion']['skill_name'] == 'newsletter-composer'
    assert r['promotion']['class'] == 1
    assert r['promotion']['source_ref'] == 'context:5'
    assert r['promotion']['merge_target'] is None
    assert r['promotion']['is_merge'] is False
    insert_sql, insert_params = db.calls[-1]
    assert insert_sql.startswith('INSERT INTO skill_promotions')
    assert insert_params[':name'] == 'newsletter-composer'
    assert insert_params[':params'] is None
    assert insert_params[':evals'] == '[{"query":"q","should_trigger":true}]'


def test_genesis_create_proposal_reflection_call_failure(monkeypatch):
    def fake_agent(self, request):
        return {'success': False, 'error': 'provider down'}

    monkeypatch.setattr('app.controllers.chat_controller.ChatController.agent', fake_agent)
    db = FakeDb(column=[['{"messages": [{"role":"user","content":"hi"}]}']])
    c = GenesisController(db, {})
    r = c.createProposal(ctx({'source': 'conversation', 'context_id': 5}))
    assert r == {'success': False, 'error': 'Reflection call failed: provider down', 'status_code': 502}


def test_genesis_create_proposal_no_procedure_found(monkeypatch):
    def fake_agent(self, request):
        return {'success': True, 'response': '{"skill_name": null}'}

    monkeypatch.setattr('app.controllers.chat_controller.ChatController.agent', fake_agent)
    db = FakeDb(column=[['{"messages": [{"role":"user","content":"hi"}]}']])
    c = GenesisController(db, {})
    r = c.createProposal(ctx({'source': 'conversation', 'context_id': 5}))
    assert r == {'success': True, 'promotion': None,
                 'message': 'No repeatable procedure found in this material.', 'status_code': 200}


def test_genesis_create_proposal_prompt_not_found():
    db = FakeDb(one=[None])
    c = GenesisController(db, {})
    r = c.createProposal(ctx({'source': 'prompt', 'prompt_id': 1}))
    assert r == {'success': False, 'error': 'Prompt not found', 'status_code': 404}


def test_genesis_create_proposal_prompt_empty_content():
    db = FakeDb(one=[{'id': 1, 'name': 'n', 'content': '   '}])
    c = GenesisController(db, {})
    r = c.createProposal(ctx({'source': 'prompt', 'prompt_id': 1}))
    assert r == {'success': False, 'error': 'Prompt has no content', 'status_code': 400}


def test_genesis_create_proposal_workflow_not_found():
    db = FakeDb(one=[None])
    c = GenesisController(db, {})
    r = c.createProposal(ctx({'source': 'workflow', 'workflow_id': 1}))
    assert r == {'success': False, 'error': 'Workflow not found', 'status_code': 404}


def test_genesis_create_proposal_workflow_is_deterministic_no_llm_call(monkeypatch):
    # Prove the workflow path never touches ChatController — patch agent() to
    # blow up so any accidental call fails the test loudly.
    def boom(self, request):
        raise AssertionError('workflow promotions must not call the LLM')
    monkeypatch.setattr('app.controllers.chat_controller.ChatController.agent', boom)

    wf_row = {'id': 7, 'name': 'Newsletter Pipeline', 'description': None, 'steps': '[]'}
    node_rows = [
        {'workflow_id': 7, 'node_type': 'agent', 'config': '{"agent_name":"Researcher"}'},
        {'workflow_id': 7, 'node_type': 'agent', 'config': '{"agent_name":"Writer"}'},
    ]
    db = FakeDb(one=[wf_row], all_=[node_rows], insert_id=11)
    c = GenesisController(db, {})
    r = c.createProposal(ctx({'source': 'workflow', 'workflow_id': 7}))
    assert r['success'] is True
    assert r['promotion']['id'] == 11
    assert r['promotion']['skill_name'] == 'newsletter-pipeline'
    assert r['promotion']['class'] == 2
    assert r['promotion']['source_ref'] == 'workflow:7'
    assert 'Researcher' in r['promotion']['description']
    assert 'Writer' in r['promotion']['description']
    assert r['promotion']['rationale'] == 'Manual workflow promotion — structure is explicit, no reflection needed.'


def test_genesis_create_proposal_workflow_name_nbsp_survives_trim(monkeypatch):
    # PHP trim() strips only " \t\n\r\0\x0B" — NBSP (U+00A0) is NOT in that
    # charlist and survives. Python's str.strip() DOES treat NBSP as
    # whitespace and would silently remove it — this pins php_trim(), not
    # .strip(), as the site that reads wf['name'].
    def boom(self, request):
        raise AssertionError('workflow promotions must not call the LLM')
    monkeypatch.setattr('app.controllers.chat_controller.ChatController.agent', boom)

    nbsp_name = '\xa0Newsletter Pipeline\xa0'
    wf_row = {'id': 7, 'name': nbsp_name, 'description': None, 'steps': '[]'}
    db = FakeDb(one=[wf_row], all_=[[]], insert_id=12)
    c = GenesisController(db, {})
    r = c.createProposal(ctx({'source': 'workflow', 'workflow_id': 7}))
    assert r['success'] is True
    # No description on the row -> the deterministic default embeds wfName
    # verbatim (after trim, before the slug regex strips it for skill_name).
    assert f"Runs the '{nbsp_name}' agent workflow" in r['promotion']['description']
    assert '\xa0' in r['promotion']['description']


# ══════════════════════════════════════════════════════════════════════════
# GenesisProposer — ported from GenesisProposerTest.php (buildWorkflowPrompt
# cases omitted; see concern note in app/services/genesis_proposer.py)
# ══════════════════════════════════════════════════════════════════════════

def test_parse_proposal_extracts_first_json_object():
    text = ('Here is my proposal:\n{"skill_name":"Competitor Price Scan!",'
            '"description":"WHEN asked to scan competitor prices DO fetch, extract, chart",'
            '"eval_queries":[{"query":"scan competitor prices","should_trigger":true}],'
            '"merge_target":null,"rationale":"seen 3 times"}\nHope this helps.')
    p = GenesisProposer.parseProposal(text)
    assert p is not None
    assert p['skill_name'] == 'competitor-price-scan'
    assert len(p['eval_queries']) == 1
    assert p['eval_queries'][0]['should_trigger'] is True
    assert p['merge_target'] is None


def test_parse_proposal_rejects_missing_fields():
    assert GenesisProposer.parseProposal('{"description":"no name"}') is None
    assert GenesisProposer.parseProposal('not json at all') is None


def test_parse_proposal_drops_malformed_eval_queries():
    text = ('{"skill_name":"x-y","description":"d","eval_queries":'
            '[{"query":"good","should_trigger":true},{"bad":"row"},{"query":"neg","should_trigger":false}]}')
    p = GenesisProposer.parseProposal(text)
    assert len(p['eval_queries']) == 2


def test_parse_proposal_accepts_merge_shape():
    text = ('{"skill_name":null,"merge_target":"medium-format",'
            '"description":"WHEN asked to convert to Medium DO transform",'
            '"eval_queries":[{"query":"convert to medium","should_trigger":true}]}')
    p = GenesisProposer.parseProposal(text)
    assert p is not None
    assert p['is_merge'] is True
    assert p['skill_name'] == 'medium-format'
    assert p['merge_target'] == 'medium-format'


def test_parse_proposal_still_rejects_when_both_names_empty():
    assert GenesisProposer.parseProposal('{"skill_name":null,"merge_target":null,"description":"d"}') is None


def test_conversation_prompt_contains_transcript_and_catalog():
    prompt = GenesisProposer.buildConversationPrompt(
        [{'role': 'user', 'content': 'make me a newsletter about AI'},
         {'role': 'assistant', 'content': 'Here is your newsletter…'}],
        [{'name': 'composed-newsletter', 'description': 'WHEN asked for a newsletter…'}],
    )
    assert 'make me a newsletter about AI' in prompt
    assert 'composed-newsletter' in prompt
    assert 'merge_target' in prompt


def test_output_contract_forbids_demand_judgment():
    prompt = GenesisProposer.buildConversationPrompt([{'role': 'user', 'content': 'make me a skill'}], [])
    assert 'demand is already established' in prompt


def test_prompt_library_prompt_contains_prompt_and_contract():
    prompt = GenesisProposer.buildPromptLibraryPrompt(
        'Weekly crypto digest',
        "Summarize this week's top crypto news as a 5-bullet digest with prices in EUR",
        [{'name': 'composed-newsletter', 'description': 'WHEN asked for a newsletter…'}],
    )
    assert 'Weekly crypto digest' in prompt
    assert '5-bullet digest' in prompt
    assert 'composed-newsletter' in prompt
    assert 'demand is already established' in prompt
    assert 'merge_target' in prompt
