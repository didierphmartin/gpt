import json

from app.agent_team.services.execution_trace_store import ExecutionTraceStore


class Db:
    def __init__(self, rows=None, show=True): self.calls = []; self.rows = rows or []; self.show = show; self.last_id = 41
    def fetch_all(self, sql, params=None):
        self.calls.append((' '.join(sql.split()), params))
        if 'SHOW TABLES' in sql: return [{'t': 'execution_traces'}] if self.show else []
        return self.rows
    def fetch_one(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return None
    def fetch_column(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return []
    def execute(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); return 1
    def insert(self, sql, params=None): self.calls.append((' '.join(sql.split()), params)); self.last_id += 1; return self.last_id


BASE = {'run_id': 'r1', 'ts': '2026-09-07 10:00:00', 'env': 'chat', 'invocation_mode': 'forced', 'workflow_id': None, 'node_id': None,
        'provider': 'claude', 'model': 'm', 'skill_dir': 'docx', 'script': 'create.py', 'argv': ['a'], 'input_snapshot': {'q': 1},
        'skill_exit_code': 0, 'skill_stdout': 'ok', 'skill_log_messages': None, 'output_files': ['/o.docx'], 'final_text': 'done',
        'success': True, 'loop_detected': False, 'tokens_in': 10, 'tokens_out': 5}


def test_insert_sql_columns_payload_and_coercion():
    db = Db(); store = ExecutionTraceStore(db)
    assert store.insert(dict(BASE)) == 42
    sql, params = [c for c in db.calls if c[0].startswith('INSERT')][0]
    assert sql.startswith('INSERT INTO `execution_traces` (`run_id`, `ts`, `env`, `invocation_mode`, `workflow_id`, `node_id`, `provider`, `skill_dir`, `success`, `error_class`, `error_text`, `outcome_quality`, `tokens_in`, `tokens_out`, `cost_usd`, `payload`) VALUES (:run_id, :ts,')
    assert params[':success'] == 1 and params[':skill_dir'] == 'docx' and params[':error_class'] == store.classify(dict(BASE))
    payload = json.loads(params[':payload'])
    assert list(payload) == ['model', 'latency_ms', 'script', 'argv', 'input_snapshot', 'tool_calls', 'skill_exit_code', 'skill_stdout', 'skill_log_messages', 'output_files', 'final_text', 'rounds', 'round_limit_hit', 'loop_detected']
    assert payload['argv'] == ['a'] and payload['round_limit_hit'] is False and payload['tool_calls'] == []


def test_insert_failure_returns_none_and_missing_table_is_not_created():
    class Boom(Db):
        def insert(self, sql, params=None): raise RuntimeError('db down')
    assert ExecutionTraceStore(Boom()).insert(dict(BASE)) is None
    db = Db(show=False); ExecutionTraceStore(db).ensureTable()
    assert not any(c[0].startswith('CREATE') for c in db.calls)          # no runtime DDL (ruled)


def test_classify_php_branches():
    s = ExecutionTraceStore(Db())
    # ok: success, exit 0, no signals -> PHP ExecutionTraceStore.php:195 `return 'ok';`
    ok = dict(BASE)
    assert s.classify(ok) == 'ok'
    # b_skill_script: nonzero exit code -> PHP:178-180
    skill_err = dict(BASE, success=False, skill_exit_code=1, error_text='Traceback: boom')
    assert s.classify(skill_err) == 'b_skill_script'
    # e_transient_external: rate-limit / provider-outage signal in error_text -> PHP:170-172
    transient = dict(BASE, success=False, skill_exit_code=None, error_text='429 rate limit exceeded')
    assert s.classify(transient) == 'e_transient_external'
    # d_foundation_code: plumbing bug signal -> PHP:174-176
    foundation = dict(BASE, success=False, skill_exit_code=None, error_text='Fatal error: call to undefined function')
    assert s.classify(foundation) == 'd_foundation_code'
    # c_workflow_config: failed inside a workflow node, no other signal matched -> PHP:188-191
    workflow_cfg = dict(BASE, success=False, skill_exit_code=None, error_text='', env='workflow')
    assert s.classify(workflow_cfg) == 'c_workflow_config'
    # a_skill_prompt: generic failure outside a workflow env -> PHP:192-194
    generic_fail = dict(BASE, success=False, skill_exit_code=None, error_text='', env='chat')
    assert s.classify(generic_fail) == 'a_skill_prompt'
    # a_skill_prompt: "successful" but misbehaving (loop detected) -> PHP:182-187
    loop = dict(BASE, success=True, skill_exit_code=0, loop_detected=True)
    assert s.classify(loop) == 'a_skill_prompt'
    assert s.classify(skill_err) != s.classify(ok)


def test_outcome_quality_php_branches():
    s = ExecutionTraceStore(Db())
    # good: success, exit 0/None -> PHP:212-214
    ok = dict(BASE)
    assert s.outcomeQuality(ok, s.classify(ok)) == 'good'
    # failed: not success -> PHP:202-204
    failed = dict(BASE, success=False)
    assert s.outcomeQuality(failed, s.classify(failed)) == 'failed'
    # degraded: loop/round-limit/apology or class a_skill_prompt -> PHP:208-210
    degraded = dict(BASE, success=True, loop_detected=True)
    assert s.outcomeQuality(degraded, s.classify(degraded)) == 'degraded'
    # unknown: success, nonzero exit, no loop/apology, class not a_skill_prompt -> PHP:211,215
    unknown = dict(BASE, success=True, skill_exit_code=7, loop_detected=False)
    assert s.outcomeQuality(unknown, 'b_skill_script') == 'unknown'
    assert s.outcomeQuality(ok, s.classify(ok)) != s.outcomeQuality(failed, s.classify(failed))
