"""Port of backend/src/AgentTeam/Services/PlaybookNodeRunner.php (244 lines).

Server-side entry point for running one Playbook-bound workflow node:
parses the node's playbook document, wires up the Playbook library
(analyzer -> run state -> native tools -> gates -> action space ->
interpreter) exactly the way PlaybookController.validate() wires the
analyzer/loader pair for registration-time validation, and runs a single
leg to completion.

CONTROLLER RULING: every real collaborator (contexts Db, MCP executor, LLM
closure, gate bridge) is built by an overridable factory callable so
PlaybookNodeRunnerTest can run entirely against fakes + an in-memory sqlite3
Db — never MySQL, never a live provider. Production call sites
(WorkflowController.runPlaybookNode) simply omit the factories and get the
real implementations below.
"""
from __future__ import annotations

import json
import re
from typing import Callable, Optional

from app.playbook.adapters.loader_mcp_executor import LoaderMcpExecutor
from app.playbook.adapters.skill_bridge_gate_bridge import SkillBridgeGateBridge
from app.playbook.adapters.workflow_llm_client import WorkflowLlmClient
from app.playbook.gate_manager import GateManager
from app.playbook.playbook_action_space import PlaybookActionSpace
from app.playbook.playbook_analyzer import PlaybookAnalyzer
from app.playbook.playbook_document import PlaybookDocument
from app.playbook.playbook_interpreter import PlaybookInterpreter
from app.playbook.playbook_native_tools import PlaybookNativeTools
from app.playbook.playbook_run_state import PlaybookRunState
from app.playbook.playbook_transcript import PlaybookTranscript
from app.support.phpcompat import php_coalesce as _coalesce, php_empty, php_strval, php_trim, ucfirst

_GATE_TITLES = {
    'approval': 'Approval requested', 'form': 'Form request', 'handoff': 'Handed off to a human',
    'await_message': 'Waiting for the requester', 'wait': 'Waiting',
}
_GATE_TOOLS = ('request_approval', 'trigger_form', 'prompt_handoff', 'await_message', 'wait_until')


def _str(v) -> str:
    """PHP: is_scalar($v) || $v === null ? trim((string)$v) : json_encode($v, JSON_UNESCAPED_UNICODE)."""
    if v is None or isinstance(v, (bool, int, float, str)):
        return php_trim(php_strval(v))
    return json.dumps(v, ensure_ascii=False, separators=(',', ':')).replace('/', '\\/')




class PlaybookNodeRunner:
    def __init__(
        self,
        config: dict,
        llmFactory: Optional[Callable[[dict], Callable]] = None,
        mcpFactory: Optional[Callable] = None,
        bridgeFactory: Optional[Callable] = None,
        pdoFactory: Optional[Callable] = None,
    ):
        self.config = config
        self.llmFactory = llmFactory
        self.mcpFactory = mcpFactory
        self.bridgeFactory = bridgeFactory
        self.pdoFactory = pdoFactory

    def run(self, userId: int, nodeConfig: dict, requestText: str, emit: Callable[[dict], None]) -> dict:
        """@return {output: str, run_id: int, status: str}"""
        # PHP sets default_socket_timeout / mysqlnd.net_read_timeout to 30s here
        # (playbook legs are long-lived and a dead connection with no read
        # timeout hangs the SSE request forever). uvicorn/pymysql have no
        # equivalent global ini switch — Db.connect already sets a connect
        # timeout; a read-timeout equivalent is out of scope for this port.

        doc = self._parseDocument(nodeConfig.get('playbook'))

        # Node-level write authorization: markdown playbooks have no way to
        # set policy.writes_enabled, so the node config carries an explicit
        # toggle (checkbox in the editor). JSON documents keep their own
        # policy unless the toggle is set.
        if not php_empty(nodeConfig.get('writes_enabled')):
            arr = doc.toArray()
            policy = dict(arr.get('policy') or {})
            policy['writes_enabled'] = True
            arr['policy'] = policy
            doc = PlaybookDocument.fromArray(arr)

        pdo = self.pdoFactory() if self.pdoFactory is not None else self._defaultPdo()
        mcp = self.mcpFactory(pdo, userId) if self.mcpFactory is not None else self._defaultMcp(pdo, userId)

        # Bound agent.* targets have no real invocation path yet (see
        # PlaybookActionSpace's constructor comment), so there is no need to
        # resolve available agent names here — every agent.* binding is
        # treated as unbound regardless of what we pass.
        analysis = PlaybookAnalyzer().analyze(doc, list(mcp.availableTools().keys()), [])
        if analysis['errors']:
            raise RuntimeError('Playbook has unresolved bindings: ' + '; '.join(analysis['errors']))

        # Capture every event so the node's OUTPUT can mirror the run overlay
        # (tools, messages, gates, result) — the next node needs the story,
        # not just the interpreter's last sentence.
        events: list = []
        emitInner = emit

        def _emit(ev: dict) -> None:
            events.append(ev)
            emitInner(ev)

        from app.agent_team.services.workflow_run_log import WorkflowRunLog

        transcript = PlaybookTranscript(WorkflowRunLog.defaultDir(self.config))
        state = PlaybookRunState(pdo, transcript)
        # Fresh-connection factory for post-gate reconnects (see GateManager).
        state.setReconnector(lambda: self.pdoFactory() if self.pdoFactory is not None else self._defaultPdo())

        requester = self._buildRequester(pdo, userId)
        runId = state.createRun(userId, doc, requester, {})

        native = PlaybookNativeTools(state)
        bridge = self.bridgeFactory(_emit) if self.bridgeFactory is not None else SkillBridgeGateBridge(_emit)
        gates = GateManager(state, bridge)

        space = PlaybookActionSpace(analysis['actions'], native, mcp, state, doc.policy, gates)

        # PlaybookInterpreter's llm parameter is a plain callable; the default
        # WorkflowLlmClient is an invokable object, which already satisfies
        # that contract directly (llmFactory overrides — see
        # PlaybookNodeRunnerTest — already return real callables).
        llm = self.llmFactory(nodeConfig) if self.llmFactory is not None else WorkflowLlmClient(nodeConfig, self.config, pdo)

        interpreter = PlaybookInterpreter(space, state, transcript, llm, 40, _emit)

        result = interpreter.runLeg(runId, 0, doc, {}, requester, requestText)

        output = self.renderTranscript(doc.title, events, php_strval(result.get('output')) if result.get('output') is not None else '', runId, php_strval(result['status']))

        return {'output': output, 'run_id': runId, 'status': php_strval(result['status'])}

    @staticmethod
    def renderTranscript(title: str, events: list, finalOutput: str, runId: Optional[int], status: str) -> str:
        """The node's output text: a Markdown transcript mirroring the run
        overlay — chronological tool calls with checkmarks, the playbook's
        messages (sensitive ones redacted), human gates with their decision,
        then the final result and status. Twin of workflow-editor.js
        _pbTranscriptText. PHP 141-192."""
        lines: list = []
        pendingTools: dict = {}  # name => index in lines

        for ev in events:
            type_ = php_strval(ev.get('type')) if ev.get('type') is not None else ''
            if type_ == 'tool_call':
                name = php_strval(ev.get('name')) if ev.get('name') is not None else 'tool'
                if name in _GATE_TOOLS:
                    continue  # rendered via gate_request + decision
                lines.append(f'- 🔧 {name} …')
                pendingTools[name] = len(lines) - 1
            elif type_ == 'tool_result':
                name = php_strval(ev.get('name')) if ev.get('name') is not None else 'tool'
                res = ev.get('result') if isinstance(ev.get('result'), dict) else {}
                if name in _GATE_TOOLS:
                    # GateManager stores the whole answer under 'decision'
                    # ({tool_call_id, decision, comment, actor}); unwrap it.
                    d = _coalesce(res.get('decision'), res.get('status'), '')
                    if isinstance(d, dict):
                        res = {**res, **d}
                        d = _coalesce(d.get('decision'), d.get('status'), d.get('outcome'), 'answered')
                    decision = _str(d)
                    comment = _str(res.get('comment') if res.get('comment') is not None else '')
                    if decision != '':
                        lines.append(f'  → {decision}' + (f' ({comment})' if comment != '' else ''))
                    continue
                ok = res.get('ok', True) is not False
                mark = '✓' if ok else '✗'
                if name in pendingTools:
                    idx = pendingTools[name]
                    lines[idx] = f'- 🔧 {name} {mark}' + ((' — ' + _str(res.get('error'))) if (not ok and not php_empty(res.get('error'))) else '')
                    del pendingTools[name]
                else:
                    lines.append(f'- 🔧 {name} {mark}')
            elif type_ == 'message':
                text = '(message redacted)' if not php_empty(ev.get('sensitive')) else php_trim(php_strval(ev.get('text')) if ev.get('text') is not None else '')
                if text != '':
                    lines.append('- 💬 Playbook:\n' + re.sub(r'^', '  ', text, flags=re.MULTILINE))
            elif type_ == 'gate_request':
                kind = php_strval(ev.get('kind')) if ev.get('kind') is not None else 'gate'
                p = ev.get('payload') if isinstance(ev.get('payload'), dict) else {}
                what = _str(_coalesce(
                    p.get('question'),
                    p.get('prompt'),
                    _str(p.get('team_or_person') if p.get('team_or_person') is not None else '')
                    # PHP `isset($p['reason'])` -- False for an explicit
                    # JSON null, same as Python `is not None` (D1).
                    + (' — ' + _str(p.get('reason')) if p.get('reason') is not None else ''),
                ))
                lines.append('- ✋ ' + _GATE_TITLES.get(kind, ucfirst(kind)) + (f': {what}' if what != '' else ''))

        head = f'# Playbook: {title}' + (f' (run {runId} — {status})' if runId is not None else f' ({status})')
        out = head + '\n\n## Timeline\n' + ('\n'.join(lines) if lines else '- (no steps recorded)')
        final = php_trim(finalOutput)
        if final != '':
            out += '\n\n## Result\n' + final
        return out + f'\n\n[playbook run {runId}: {status}]'

    def _buildRequester(self, pdo, userId: int) -> dict:
        """Enrich the requester the interpreter sees (REQUESTER: block of the
        system prompt) with email/name from the users table, falling back to
        id-only when the row (or the table itself, e.g. a test's minimal
        sqlite fixture) isn't available — the interpreter must still run.
        PHP 200-220."""
        requester: dict = {'id': php_strval(userId)}
        try:
            row = pdo.fetch_one('SELECT email, first_name, last_name FROM users WHERE id = ? LIMIT 1', [userId])
            if row:
                if row.get('email'):
                    requester['email'] = row['email']
                name = php_trim((row.get('first_name') or '') + ' ' + (row.get('last_name') or ''))
                if name != '':
                    requester['name'] = name
        except Exception:
            pass  # users table unavailable (different DB, or a minimal test fixture) — id-only.
        return requester

    def _parseDocument(self, playbook) -> PlaybookDocument:
        if isinstance(playbook, str):
            return PlaybookDocument.fromConsoleText(playbook)
        if isinstance(playbook, dict):
            return PlaybookDocument.fromArray(playbook)
        raise RuntimeError('nodeConfig.playbook (object or string) is required.')

    def _defaultPdo(self):
        from app.agent_team.services.session_search_service import SessionSearchService
        return SessionSearchService.connectFromConfig(self.config)

    def _defaultMcp(self, pdo, userId: int):
        from app.services.mcp_tools_loader import MCPToolsLoader
        loader = MCPToolsLoader(pdo)
        loader.loadToolsForUser(php_strval(userId))
        return LoaderMcpExecutor(loader)
