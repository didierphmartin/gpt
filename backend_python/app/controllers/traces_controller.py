"""Port of Controllers/TracesController.php.

TracesController — records chat-path execution traces (Phase 0 self-healing).

The workflow path captures traces server-side (the bridge holds the skill
result), but in CHAT the skill runs client-side and its result lives in the
browser. So chat.js posts one trace here after each skill run. The server
still owns classification + outcome labelling (ExecutionTraceStore).

Route: POST /api/v1/traces
Spec:  docs/specs/2026-06-13-phase0-trace-store.md
"""
from __future__ import annotations

from app.agent_team.services.execution_trace_store import ExecutionTraceStore
from app.support.phpcompat import php_date, php_empty, php_intval, php_strval


class TracesController:
    def __init__(self, db, config=None):
        self.db = db

    def create(self, request) -> dict:
        userId = request.get('user_id') if request.get('user_id') is not None else 0
        if php_empty(userId):
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        b = request.get('body')
        if b is None:
            b = {}
        if not isinstance(b, dict) or php_empty(b.get('skill_dir')):
            return {'success': False, 'error': 'Missing skill_dir', 'status_code': 400}

        # Only the two chat-origin modes are accepted here; default to discovery.
        mode = b.get('invocation_mode') if b.get('invocation_mode') in ('auto_discovery', 'forced') else 'auto_discovery'

        store = ExecutionTraceStore(self.db)
        id_ = store.insert({
            'run_id': php_strval(b['run_id']) if 'run_id' in b and b['run_id'] is not None else '',
            'ts': php_date('Y-m-d H:i:s'),
            'env': 'chat',
            'invocation_mode': mode,
            'workflow_id': None,
            'node_id': None,
            'provider': b.get('provider'),
            'model': b.get('model'),
            'skill_dir': php_strval(b['skill_dir']),
            'script': b.get('script'),
            'argv': b.get('argv') if b.get('argv') is not None else [],
            'input_snapshot': b.get('input'),
            'skill_exit_code': php_intval(b['exit_code']) if 'exit_code' in b and b['exit_code'] is not None else None,
            'skill_stdout': b.get('stdout'),
            'skill_log_messages': b.get('log_messages'),
            'output_files': b['output_files'] if isinstance(b.get('output_files'), (list, dict)) else [],
            'final_text': b.get('final_text'),
            'success': not php_empty(b.get('success')),
            'loop_detected': not php_empty(b.get('loop_detected')),
            'tokens_in': php_intval(b.get('tokens_in') if b.get('tokens_in') is not None else 0),
            'tokens_out': php_intval(b.get('tokens_out') if b.get('tokens_out') is not None else 0),
        })

        return {'success': id_ is not None, 'id': id_}

    def diagnose(self, request) -> dict:
        """GET /api/v1/traces/diagnosis?days=30
        Read-only diagnosis of recent traces: per-skill verdict (which layer/loop
        should fix it) + heal-cost estimate. No LLM calls.
        """
        userId = request.get('user_id') if request.get('user_id') is not None else 0
        if php_empty(userId):
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        query = request.get('query') or {}
        days = php_intval(query.get('days') if query.get('days') is not None else 30)
        days = max(1, min(365, days))

        store = ExecutionTraceStore(self.db)
        return {'success': True, 'diagnosis': store.diagnose(days)}
