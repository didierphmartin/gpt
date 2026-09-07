"""Port of backend/src/Playbook/PlaybookActionSpace.php (307 lines).

Whitelisted tool surface the LLM sees for one playbook run: native tools
plus a definition per bound/unbound analyzer action, with dispatch, a
replay guard for MCP calls, and a write-policy gate.
"""
from __future__ import annotations

import re
from typing import Optional

from app.playbook.gate_manager import GateManager
from app.support.phpcompat import php_trim
from app.support.phpjson import dumps as _json_dumps

# Fail-closed write classification: a tool is a WRITE unless its name part
# is recognizably read-only. New/unrecognized tool names (e.g. a target
# added to an MCP server we don't know about, like okta.deactivate_user)
# are therefore blocked under writes_enabled=false rather than allowed
# through by default.
# A tool is read-classified when its name starts with a read verb, or with
# one namespace token followed by a read verb (aws's iam_list_*). 'lookup'
# added after okta.lookup_users was blocked as a write in live run 38.
_READ_VERB_PATTERN = re.compile(r'^(?:[a-z0-9]+_)?(get|list|search|read|find|describe|verify|check|lookup)(_|$)', re.IGNORECASE)

_UNBOUND_DESCRIPTION = 'NOT AVAILABLE — calling this applies the on_unbound policy'

_GATE_TOOL_NAMES = ('trigger_form', 'request_approval', 'prompt_handoff', 'await_message')


class PlaybookActionSpace:
    def __init__(self, analyzedActions: list, native, mcp, state, policy: dict, gates=None):
        self.analyzedActions = analyzedActions
        self.native = native
        self.mcp = mcp
        self.state = state
        self.policy = policy
        self.gates = gates

        # kind, action_name, server?, tool?, target?
        self.map: dict = {}
        # kind='mcp' entries only, used for building defs
        self.mcpEntries: dict = {}
        # {action_name, note} for unbound-style defs
        self.unboundEntries: dict = {}

        for action in analyzedActions:
            name = action.get('name') if action.get('name') is not None else ''
            kind = action.get('kind') if action.get('kind') is not None else ''
            target = action.get('target')

            if kind == 'native' and target is not None:
                self.map[target] = {
                    'kind': 'native',
                    'action_name': name,
                    'target': target,
                }
                continue

            if kind == 'bound' and target is not None and target.startswith('agent.'):
                # Bound agent.* targets are NOT implemented in this slice — no agent-invocation
                # dispatch exists yet. Treat them like unbound for now (honest handle + on_unbound
                # policy at execution time); real agent invocation arrives in a later slice.
                llmName = 'unbound__' + self._slug(name)
                self.unboundEntries[llmName] = {
                    'action_name': name,
                    'note': 'NOT AVAILABLE — agent invocation arrives in a later slice; the on_unbound policy applies for now',
                }
                self.map[llmName] = {
                    'kind': 'unbound',
                    'action_name': name,
                    'target': target,
                }
                continue

            if kind == 'bound' and target is not None:
                server, tool = self._splitTarget(target)
                llmName = self._sanitizeTarget(target)
                entry = {
                    'kind': 'mcp',
                    'action_name': name,
                    'server': server,
                    'tool': tool,
                    'target': target,
                }
                self.map[llmName] = entry
                self.mcpEntries[llmName] = entry
                continue

            # kind === 'unbound' (or anything else we don't recognize as bound/native)
            llmName = 'unbound__' + self._slug(name)
            self.unboundEntries[llmName] = {
                'action_name': name,
                'note': _UNBOUND_DESCRIPTION,
            }
            self.map[llmName] = {
                'kind': 'unbound',
                'action_name': name,
                'target': target,
            }

        # Spec: native verbs are built-in and executable unconditionally — no
        # binding required. Register every PlaybookNativeTools verb in the
        # dispatch map regardless of whether the playbook's actionsUsed
        # mentions it (toolDefinitions() below already always exposes them to
        # the LLM; dispatch must match). An action already registered above
        # (kind='native' with its own #Action name) is left untouched.
        for defn in self.native.definitions():
            toolName = defn.get('function', {}).get('name')
            if toolName is None or toolName in self.map:
                continue
            self.map[toolName] = {
                'kind': 'native',
                'action_name': toolName,
                'target': toolName,
            }

    def toolDefinitions(self) -> list:
        """PHP 121-159."""
        defs = list(self.native.definitions())
        available = self.mcp.availableTools()

        for llmName, entry in self.mcpEntries.items():
            toolInfo = available.get(entry['target'])
            mcpDescription = (toolInfo or {}).get('description') if toolInfo else ''
            mcpDescription = mcpDescription if mcpDescription is not None else ''
            parameters = (toolInfo or {}).get('input_schema') if toolInfo else None
            if parameters is None:
                parameters = {'type': 'object', 'properties': {}}

            description = php_trim(entry['action_name'] + (' — ' + mcpDescription if mcpDescription != '' else ''))

            defs.append({
                'type': 'function',
                'function': {
                    'name': llmName,
                    'description': description,
                    'parameters': parameters,
                },
            })

        for llmName, entry in self.unboundEntries.items():
            defs.append({
                'type': 'function',
                'function': {
                    'name': llmName,
                    'description': php_trim(entry['action_name'] + ': ' + entry['note']),
                    'parameters': {'type': 'object', 'properties': {}},
                },
            })

        if self.gates is not None:
            defs = defs + self.gates.definitions()

        return defs

    def execute(self, runId: int, leg: int, llmToolName: str, args: dict) -> dict:
        """PHP 161-183."""
        if self.gates is not None and llmToolName in _GATE_TOOL_NAMES:
            return self._executeGate(runId, leg, llmToolName, args)

        entry = self.map.get(llmToolName)

        if entry is None:
            self.state.ledgerAppend(runId, leg, llmToolName, llmToolName, args, 'skipped', None)
            return {'ok': False, 'error': 'tool not allowed'}

        kind = entry['kind']
        if kind == 'native':
            return self._executeNative(runId, leg, llmToolName, entry, args)
        if kind == 'mcp':
            return self._executeMcp(runId, leg, entry, args)
        if kind == 'unbound':
            return self._executeUnbound(runId, leg, llmToolName, entry, args)
        self.state.ledgerAppend(runId, leg, llmToolName, llmToolName, args, 'skipped', None)
        return {'ok': False, 'error': 'tool not allowed'}

    def _executeGate(self, runId: int, leg: int, llmToolName: str, args: dict) -> dict:
        result = self.gates.execute(runId, leg, llmToolName, args)

        if 'decision' not in result:
            # Unanswered (timeout/error) — audit fidelity wins: ledger the failure with
            # the full result (no sensitive values ever appear in this path).
            self.state.ledgerAppend(runId, leg, llmToolName, llmToolName, args, 'failed', self._summarize(result))
            return {**result, 'gate': True}

        decision = result['decision'] if isinstance(result['decision'], dict) else {}
        redactedDecision = GateManager.redactSensitiveFields(args, decision)
        self.state.ledgerAppend(runId, leg, llmToolName, llmToolName, args, 'ok', self._summarize(redactedDecision))
        return {**result, 'gate': True}

    def _executeNative(self, runId: int, leg: int, llmToolName: str, entry: dict, args: dict) -> dict:
        result = self.native.execute(runId, leg, llmToolName, args)
        outcome = 'failed' if result.get('ok', False) is False else 'ok'
        sensitive = bool(args.get('sensitive'))
        self.state.ledgerAppend(runId, leg, entry['action_name'], llmToolName, args, outcome, self._summarize(result), sensitive)
        return result

    def _executeMcp(self, runId: int, leg: int, entry: dict, args: dict) -> dict:
        target = entry['target']
        server = entry['server']
        tool = entry['tool']
        isWrite = self._isWriteTool(tool)

        # Replay guard applies to write-classified tools only — a read (e.g. a
        # repeated search) always re-executes, since re-running it is safe and
        # the requester may expect fresh data.
        if isWrite:
            replay = self.state.ledgerFindOk(runId, target, args)
            if replay is not None:
                self.state.ledgerAppend(runId, leg, entry['action_name'], target, args, 'replayed', replay.get('result_summary'))
                return {'ok': True, 'outcome': 'replayed', 'result': replay.get('result_summary')}

        # Write policy applies to MCP/connector tools only (spec: each MCP tool is tagged
        # read|write); native verbs act on the run record and are never blocked here.
        writesEnabled = bool(self.policy.get('writes_enabled', False))
        if not writesEnabled and isWrite:
            self.state.ledgerAppend(runId, leg, entry['action_name'], target, args, 'skipped', None)
            return {'ok': False, 'error': 'writes disabled by policy'}

        result = self.mcp.call(server, tool, args)
        outcome = 'failed' if result.get('ok', False) is False else 'ok'
        self.state.ledgerAppend(runId, leg, entry['action_name'], target, args, outcome, self._summarize(result))
        return result

    def _isWriteTool(self, tool: str) -> bool:
        """Fail-closed classifier: anything not recognizably read-only counts as a write."""
        return _READ_VERB_PATTERN.match(tool) is None

    def _executeUnbound(self, runId: int, leg: int, llmToolName: str, entry: dict, args: dict) -> dict:
        self.state.ledgerAppend(runId, leg, entry['action_name'], llmToolName, args, 'skipped', None)
        policy = self.policy.get('on_unbound')

        if policy == 'skip':
            return {
                'ok': False,
                'unbound': True,
                'skipped': True,
                'guidance': 'This action is unavailable and the policy says skip it: note it in the internal record and continue with the rest of the playbook.',
            }
        if policy == 'fail':
            return {
                'ok': False,
                'unbound': True,
                'fatal': True,
                'guidance': 'This action is unavailable and the policy says fail: leave an internal note and resolve the request as not completed.',
            }
        return {
            'ok': False,
            'unbound': True,
            'policy': policy,
            'guidance': 'This action has no connected implementation. Follow the policy: hand off to a human with prompt_handoff and note what could not be done.',
        }

    def _splitTarget(self, target: str):
        parts = target.split('.', 1)
        return (parts[0], parts[1] if len(parts) > 1 else '')

    def _sanitizeTarget(self, target: str) -> str:
        sanitized = target.replace('.', '__')
        sanitized = re.sub(r'[^a-z0-9_]+', '_', sanitized, flags=re.IGNORECASE)
        return sanitized.lower()

    def _slug(self, name: str) -> str:
        slug = re.sub(r'[^a-z0-9]+', '_', name, flags=re.IGNORECASE)
        return slug.strip('_').lower()

    def _summarize(self, result: dict) -> Optional[str]:
        try:
            json_ = _json_dumps(result)
        except (TypeError, ValueError):
            return None
        # Multibyte-safe truncation: PHP truncates by character count (mb_strlen),
        # never bytes, so a truncation can't split a UTF-8 sequence mid-character.
        return json_[:500] if len(json_) > 500 else json_
