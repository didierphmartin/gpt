"""Port of backend/src/AgentTeam/Services/PlaybookEmit.php -- the playbook node, shared by every compile target.

A playbook node is not an agent: it is an interpreter loop (the native verbs, the human gates, one
tool per bound #Action and a stub per unbound one), and the node's output is the Markdown transcript
the app's run overlay shows. LangGraph emits its own copy of the runtime (LangGraphRuntime.playbookBlock);
ADK, MAF and NOOA emit runtimeBlock() and call run_playbook_node().
"""
from __future__ import annotations

import re

from app.agent_team.services.code_node_emit import CodeNodeEmit
from app.agent_team.services.compiler_php import json_to_python
from app.agent_team.services.compiler_text import playbook_emit as T
from app.agent_team.services.playbook_source import PlaybookSource
from app.agent_team.services.python_emit_helpers import PythonEmitHelpers
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
from app.playbook.playbook_analyzer import PlaybookAnalyzer
from app.playbook.playbook_document import PlaybookDocument
from app.support.phpcompat import php_empty, php_floatval, php_intval, php_strval, php_trim


def _first(*values):
    """`$a ?? $b ?? ...`: the first value that is not None."""
    for v in values:
        if v is not None:
            return v
    return None


def _node_id(node: dict) -> str:
    return php_strval(_first(node.get('id'), node.get('drawflow_node_id'), node.get('_id'), ''))


class PlaybookEmit:
    @staticmethod
    def nodeData(node: dict, availableById: dict, providerDefaults: dict, userId: str | None) -> dict:
        """Bake one playbook node: parse + analyze the playbook against the registry ids ("<server slug>.<tool>")
        and describe what the emitted runtime needs. Raises when the playbook text is missing or has hard
        binding errors, like the browser runner does."""
        nid = _node_id(node)
        cfg = node.get('config') if isinstance(node.get('config'), dict) else {}
        if not php_empty(cfg.get('playbook_missing')):
            name = php_strval(_first(cfg.get('name'), cfg.get('agent_name'), nid))
            raise RuntimeError(f"Playbook #{php_strval(cfg.get('playbook_id'))} not found (node {name}).")
        raw = cfg.get('playbook')
        if isinstance(raw, str) and php_trim(raw) != '':
            doc = PlaybookDocument.fromConsoleText(raw)
        elif isinstance(raw, (dict, list)):
            doc = PlaybookDocument.fromArray(raw if isinstance(raw, dict) else dict(enumerate(raw)))
        else:
            raise RuntimeError(f"Playbook node {nid} has no playbook text.")
        writesEnabled = not php_empty(cfg.get('writes_enabled'))
        policy = dict(doc.policy) if isinstance(doc.policy, dict) else {}
        if writesEnabled:
            policy['writes_enabled'] = True
        analysis = PlaybookAnalyzer().analyze(doc, list(availableById.keys()), [])
        if analysis.get('errors'):
            raise RuntimeError(f"Playbook node {nid} has unresolved bindings: " + '; '.join(analysis['errors']))
        actions = []
        for a in analysis['actions']:
            name = php_strval(_first(a.get('name'), ''))
            kind = php_strval(_first(a.get('kind'), ''))
            target = a.get('target')
            if kind == 'native':
                continue   # native verbs are always exposed by the runtime
            if (kind == 'bound' and isinstance(target, str) and '.' in target
                    and not target.startswith('agent.') and target in availableById):
                info = availableById[target]
                # llm tool name = PlaybookActionSpace::sanitizeTarget() ("okta.lookup_users" -> "okta__lookup_users")
                llmName = re.sub(r'[^a-z0-9_]+', '_', target.replace('.', '__'), flags=re.IGNORECASE | re.ASCII).lower()
                actions.append({
                    'llm_name': llmName, 'kind': 'mcp', 'action_name': name, 'target': target,
                    'server_url': info['server_url'], 'tool': info['tool'],
                    'description': info['description'], 'input_schema': info['input_schema'],
                })
                continue
            slug = re.sub(r'[^a-z0-9]+', '_', name, flags=re.IGNORECASE | re.ASCII).lower().strip('_')
            actions.append({'llm_name': 'unbound__' + slug, 'kind': 'unbound', 'action_name': name, 'target': target})
        out = {
            'display': php_strval(_first(cfg.get('name'), cfg.get('agent_name'), doc.title)),
            'title': doc.title,
            'domain': doc.domain,
            'instructions': doc.instructions,
            'policy': policy,
            'approvers': doc.approvers,
            'requester': {'id': php_strval(userId) if userId is not None else ''},
        }
        out.update(PlaybookEmit._modelSettings(cfg, providerDefaults))
        out.update({'writes_enabled': writesEnabled, 'actions': actions})
        return out

    @staticmethod
    def _modelSettings(cfg: dict, providerDefaults: dict) -> dict:
        """Provider (default claude), model (default: the provider's platform default), sampling, thinking."""
        provider = php_strval(_first(cfg.get('agent_provider'), cfg.get('provider'), cfg.get('llm_provider'), '')).lower()
        if provider == '':
            provider = 'claude'
        model = php_strval(_first(cfg.get('model'), ''))
        if model == '':
            model = providerDefaults.get(provider, '')
        settings = cfg.get('settings') if isinstance(cfg.get('settings'), dict) else {}
        thinking = settings.get('thinking')
        return {
            'provider': provider,
            'model': model,
            'temperature': php_floatval(_first(settings.get('temperature'), 0.7)),
            'max_tokens': php_intval(_first(settings.get('max_tokens'), 4096)),
            'thinking': thinking if thinking in ('on', 'off') else None,
        }

    @staticmethod
    def inputNodeData(node: dict, providerDefaults: dict, userId: str | None) -> dict:
        """A "from input" playbook node: the node's own settings, no document -- the playbook its parent's
        JSON names comes from the baked PUBLISHED_PLAYBOOKS at run time (LangGraph only)."""
        nid = _node_id(node)
        cfg = node.get('config') if isinstance(node.get('config'), dict) else {}
        field = _first(cfg.get('playbook_input_field'), 'playbook')
        writesEnabled = not php_empty(cfg.get('writes_enabled'))
        out = {
            'display': php_strval(_first(cfg.get('name'), cfg.get('agent_name'), nid)),
            'title': 'Playbook from input',
            'domain': '',
            'instructions': '',
            'policy': {'writes_enabled': True} if writesEnabled else {},
            'approvers': [],
            'requester': {'id': php_strval(userId) if userId is not None else ''},
        }
        out.update(PlaybookEmit._modelSettings(cfg, providerDefaults))
        out.update({
            'writes_enabled': writesEnabled,
            'actions': [],
            'source': 'input',
            'input_field': field if isinstance(field, str) and field != '' else 'playbook',
        })
        return out

    @staticmethod
    def refuseLangGraphOnly(node: dict, edges: list) -> None:
        """ADK, MAF and NOOA bake fixed playbooks and run every child: a "from input" node, or a node whose
        "failed" exit is wired, is refused at compile time."""
        cfg = node.get('config') if isinstance(node.get('config'), dict) else {}
        nid = _node_id(node)
        name = php_strval(_first(cfg.get('name'), cfg.get('agent_name'), nid))
        if PlaybookSource.isFromInput(cfg):
            raise RuntimeError(f'Playbook node "{name}": "from input" is supported by the LangGraph target only.')
        exits = cfg.get('exits')
        if isinstance(exits, dict):
            exits = list(exits.values())
        if (isinstance(exits, list) and 'failed' in exits
                and CodeNodeEmit.exitTargets(nid, [php_strval(e) for e in exits], edges).get('failed', []) != []):
            raise RuntimeError(f'Playbook node "{name}": the "failed" exit is supported by the LangGraph target only.')

    @staticmethod
    def docNodes(analyzed: dict) -> list:
        """Doc nodes with playbook nodes described and marked as RUN (docNodesFromAnalyzed knows no playbooks)."""
        pbs = analyzed.get('playbooks') or {}
        if not pbs:
            return WorkflowGraphAnalyzer.docNodesFromAnalyzed(analyzed)
        agents = dict(analyzed.get('agents') or {})
        extra: dict = {}
        for nid, pd in pbs.items():
            nid = php_strval(nid)
            mcp = len([a for a in pd['actions'] if (a.get('kind') or '') == 'mcp'])
            extra.setdefault(nid, {})['playbook'] = {
                'title': pd['title'],
                'writes': pd['writes_enabled'],
                'bound': mcp,
                'unbound': len(pd['actions']) - mcp,
            }
            agents[nid] = {
                'name': pd['display'], 'provider': pd['provider'], 'model': pd['model'],
                'temperature': pd['temperature'], 'max_tokens': pd['max_tokens'],
                'thinking': pd['thinking'], 'tools': [], 'skills': [],
            }
        byId = analyzed.get('byId') or {}
        return WorkflowGraphAnalyzer.docNodes(
            byId,
            analyzed.get('order') if analyzed.get('order') is not None else list(byId.keys()),
            analyzed.get('edges') or [],
            agents,
            extra,
            ['start', 'agent', 'agent-template', 'playbook', 'code', 'output'],
        )

    @staticmethod
    def requirementNames(analyzed: dict) -> list:
        """The packages a playbook node adds to a non-LangGraph target: the shared interpreter (langchain-core +
        langgraph), httpx (a bound #Action calls its MCP server through the shared client) and each playbook
        provider's LangChain package."""
        if not analyzed.get('playbooks'):
            return []
        provs: dict = {}
        for pd in analyzed['playbooks'].values():
            p = php_strval(_first(pd.get('provider'), 'claude')).lower()
            provs[{'anthropic': 'claude', 'google': 'gemini'}.get(p, p)] = True
        pkg = {'claude': 'langchain-anthropic', 'gemini': 'langchain-google-genai'}
        extra: dict = {}
        for p in provs:
            # Everything else in the factory is an OpenAI-compatible endpoint.
            extra[pkg.get(p, 'langchain-openai')] = True
        return ['langchain-core', 'langgraph', 'httpx', *extra.keys()]

    @staticmethod
    def supportBlock(needsMcpClient: bool) -> str:
        """Imports, a date-grounding helper, the LangChain model factory, optionally the shared MCP client,
        and run_playbook_node() -- the entry point each non-LangGraph target's adapter calls."""
        from app.agent_team.services.lang_graph_generator import LangGraphGenerator
        parts = [T.supportBlock__ret]
        if needsMcpClient:
            # mcpClientBlock() calls httpx.Client; a target that emits no MCP section has never imported it.
            parts.append('import httpx')
            parts.append(PythonEmitHelpers.mcpClientBlock())
        parts.append('\n'.join(LangGraphGenerator.llmFactoryLines()))
        parts.append(T.supportBlock__ret_2)
        return '\n\n'.join(parts)

    @staticmethod
    def metadataBlock(playbooks: dict) -> str:
        """`PLAYBOOKS = {node id: node data}` -- the frozen editor values, one entry per playbook node."""
        return ("# Frozen playbook nodes from the editor: the playbook text, its resolved\n"
                + "# #Action bindings (MCP tool per bound action), approvers, write policy and\n"
                + "# the node form's model settings. run_playbook_node() reads this by node id.\n"
                + 'PLAYBOOKS = ' + json_to_python(playbooks, True))

    @staticmethod
    def runtimeBlock() -> str:
        return T.runtimeBlock__ret
