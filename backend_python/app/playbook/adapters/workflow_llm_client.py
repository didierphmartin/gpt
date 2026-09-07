"""Port of backend/src/Playbook/Adapters/WorkflowLlmClient.php (152 lines).

Adapts one LLM round of the existing AgentTeam engine to the interpreter's
LLM-closure contract: `fn(messages: list, toolDefs: list) -> {text: ?str,
tool_calls: list}`.

Built from GraphWorkflowRunner.php:1840-1980 (state construction) and
ParallelAgentExecutor.dispatchChunk (~line 194-228): dispatchChunk calls
`buildAgentLLMRequestWithTools($state['agent'], $state['messages'],
$state['tools'])` — it takes tool definitions straight from the state's
'tools' entry rather than deriving them from the agent/runner (there is no
buildToolsForParallelAgent-style lookup in the dispatch path itself), so we
pass toolDefs through verbatim via that field. No agent-tools lookup is
needed.

AgentRunner (backend/src/AgentTeam/Services/AgentRunner.php) is ported in a
later Phase 5 task; imported lazily inside __call__ (mirroring PHP's lazy
class autoloading — a `use` import that is never instantiated never fails)
so this module (and flattenToolDefs/normalizeToolCalls, which is all
WorkflowLlmClientTest.php exercises) is importable before that lands.
"""
from __future__ import annotations

import json

from app.agent_team.services.skill_tool_bridge import SkillToolBridge
from app.support.phpcompat import php_array_cast


class WorkflowLlmClient:
    def __init__(self, nodeConfig: dict, config: dict, db):
        self.nodeConfig = nodeConfig
        self.config = config
        self.db = db

    def __call__(self, messages: list, toolDefs: list) -> dict:
        from app.agent_team.models.agent import Agent
        from app.agent_team.services.agent_runner import AgentRunner
        from app.services.llm_provider_resolver import LLMProviderResolver
        from app.services.mcp_tools_loader import MCPToolsLoader
        from app.ai_portfolio_assistant import AIPortfolioAssistant

        config = LLMProviderResolver.applyDbSettings(self.db, self.config)
        assistant = AIPortfolioAssistant(config)
        assistant.setDatabase(self.db)

        agentRunner = AgentRunner(
            assistant.getLLMManager(),
            assistant.getToolsManager(),
            MCPToolsLoader(self.db),
            self.db,
            config,
        )

        # Instructions are intentionally left empty: the interpreter's full
        # system prompt (playbook instructions + policy) already travels as
        # the first entry of messages (see PlaybookInterpreter._buildSystemPrompt),
        # so anything set here would never reach the model.
        agent = Agent({
            # falsy-or, not None-coalesce — the node modal's "(default)" option submits an
            # EMPTY STRING, which a plain "or default" passes through; run 33
            # then died with "No API key for provider ''".
            'provider': (self.nodeConfig.get('agent_provider') or '') or (self.nodeConfig.get('provider') or '') or 'openai',
            'model': self.nodeConfig.get('model'),
            'instructions': '',
            'settings': self.nodeConfig.get('settings') if self.nodeConfig.get('settings') is not None else {},
        })

        # State shape mirrors GraphWorkflowRunner's parallel agentStates entries
        # (node/agent/input/messages/tools/tools_filter) — see
        # GraphWorkflowRunner.php:1850-1865. 'tools_filter' is left None: the
        # interpreter's PlaybookActionSpace already whitelists exactly the
        # tools it hands to us in toolDefs, so there is nothing further to filter.
        state = {
            'key': 'playbook',
            'agent': agent,
            'input': '',
            'messages': messages,
            'tools': self._flattenToolDefs(toolDefs),
            'tools_filter': None,
        }

        responses = agentRunner.createParallelExecutor(False).runConcurrentRound({'playbook': state})
        response = responses.get('playbook') if responses.get('playbook') is not None else {'success': False, 'error': 'No response from LLM'}

        if not response.get('success', False):
            # Raise, don't return error-as-text: a returned string reads to
            # the interpreter as a benign final answer and the leg ends
            # silently with nothing done (run 33). An exception surfaces as
            # a red SSE error event with the real cause.
            raise RuntimeError('LLM call failed: ' + (response.get('error') if response.get('error') is not None else 'no response'))

        parsed = response.get('parsed') if response.get('parsed') is not None else {}
        return {
            'text': parsed.get('text'),
            'tool_calls': self._normalizeToolCalls(parsed.get('tool_calls') if parsed.get('tool_calls') is not None else []),
        }

    def _flattenToolDefs(self, toolDefs: list) -> list:
        """Convert the interpreter's OpenAI-nested tool definitions
        ({type:'function', function:{name, description, parameters}} — the
        shape pinned by PlaybookActionSpaceTest/PlaybookNativeToolsTest) to the
        flat {name, description, input_schema} shape the rest of the AgentTeam
        engine actually expects for the 'tools' state entry (see
        MCPToolsLoader.getToolDefinitions and OpenAIProvider's tool
        conversion, which converts FROM this flat shape — i.e. flat is the
        common-denominator format ParallelAgentExecutor/ProviderRequestFactory/
        ClaudeProvider read; passing the nested shape through verbatim, as
        this adapter used to do, makes ClaudeProvider send tools with no
        top-level `name` and the API rejects the request)."""
        flat = []
        for defn in toolDefs:
            if isinstance(defn, dict) and isinstance(defn.get('function'), dict):
                function = defn['function']
                flat.append({
                    'name': function.get('name') if function.get('name') is not None else '',
                    'description': function.get('description') if function.get('description') is not None else '',
                    'input_schema': function.get('parameters') if function.get('parameters') is not None else {'type': 'object', 'properties': {}},
                })
            else:
                # Already flat (defensive — no current caller does this).
                flat.append(defn)
        return flat

    def _normalizeToolCalls(self, toolCalls: list) -> list:
        """Normalize provider tool-call shapes to the interpreter's
        {id, name, arguments:dict} contract. Every provider parser already
        emits the OpenAI-style `function.name` / `function.arguments` (JSON
        string) shape, but a flat `name`/`input` (or `name`/`arguments` dict)
        shape is also accepted defensively, matching the same fallback
        GraphWorkflowRunner uses elsewhere (`tc['function']['name'] ?? tc['name']`)."""
        normalized = []
        for tc in toolCalls:
            function = tc.get('function') if isinstance(tc.get('function'), dict) else {}
            name = function.get('name') if function.get('name') is not None else (tc.get('name') if tc.get('name') is not None else '')
            rawArgs = function.get('arguments')
            if rawArgs is None:
                rawArgs = tc.get('input') if tc.get('input') is not None else (tc.get('arguments') if tc.get('arguments') is not None else {})
            if isinstance(rawArgs, str):
                try:
                    args = json.loads(rawArgs)
                    if not isinstance(args, dict):
                        args = {}
                except (ValueError, TypeError):
                    args = {}
            else:
                # PHP: `(array)$rawArgs` when it isn't a JSON string
                # (WorkflowLlmClient.php:142) -- a scalar `rawArgs` casts to
                # a single-element array, not the empty-dict fallback this
                # used to reproduce.
                args = php_array_cast(rawArgs)

            normalized.append({
                'id': tc.get('id') if tc.get('id') is not None else SkillToolBridge.generateToolCallId(),
                'name': name,
                'arguments': args,
            })
        return normalized
