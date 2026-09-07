r"""Port of backend/src/AgentTeam/Services/AgentRunner.php (935 lines).

Executes agents with their configured tools and settings. Integrates with
the existing LLMManager and ToolsManager.

`private` PHP methods/props -> `_name`. `public` stay unprefixed.

Ruling (Phase 5, Task 2 brief): `createParallelExecutor` imports
`app.agent_team.services.parallel_agent_executor` LAZILY inside the method,
exactly like PHP's fully-qualified `\AgentTeam\Services\ParallelAgentExecutor`
reference is resolved at call time by the autoloader — Task 3 owns that
module and its unit test; no test for it is written here.
"""
from __future__ import annotations

import time
from typing import Callable

from app.agent_team.functions.agent_delegation_functions import AgentDelegationFunctions
from app.agent_team.services.agent_repository import AgentRepository
from app.agent_team.services.agent_tools_executor import AgentToolsExecutor
from app.agent_team.services.session_search_service import SessionSearchService
from app.agent_team.services.stream_context import StreamContext
from app.db import Db
from app.services.combined_tools_executor import CombinedToolsExecutor
from app.support.logger import error_log
from app.support.phpcompat import is_php_array, php_empty, php_intval, php_values
from app.support.phpjson import php_json_encode


class AgentRunner:
    def __init__(self, llm_manager, tools_manager, mcp_tools_loader, db, config: dict | None = None):
        self.llmManager = llm_manager
        self.toolsManager = tools_manager
        self.mcpToolsLoader = mcp_tools_loader
        self.db = db
        self.config = config if config is not None else {}

        # Delegation functions for manager agents
        self.delegationFunctions: AgentDelegationFunctions | None = None

        # Tracks whether session_search has been registered on the shared
        # ToolsManager for the current request. Idempotent.
        self.sessionSearchRegistered = False

        # Context passed to tools during execution (for delegation)
        self.executionContext: dict = {}

        # Stream context for real-time agent activity events
        self.streamContext: StreamContext | None = None

    # ------------------------------------------------------------------
    # run() — non-streaming
    # ------------------------------------------------------------------

    def run(
        self,
        agent,
        input_: str,
        conversation_history: list | None = None,
        user_id: int = 0,
        context: dict | None = None,
    ) -> dict:
        """Run an agent with the given input (non-streaming). Uses the
        provider's built-in tool loop for unified execution. Delegation
        tools are auto-added for manager agents. PHP 75-271."""
        conversation_history = conversation_history if conversation_history is not None else []
        context = context if context is not None else {}

        error_log(f"[AgentRunner::run] Starting agent: {agent.getName()} (id={agent.getId()})")

        # Create execution record
        executionId = self._createExecution(agent, user_id, input_, context)
        error_log(f"[AgentRunner::run] Execution record created: id={executionId}")

        # Set execution context for delegation tools
        self.executionContext = {
            'current_agent_id': agent.getId(),
            'execution_id': executionId,
            'user_id': user_id,
            'parent_execution_id': context.get('parent_execution_id'),
            'stream_context': self.streamContext,
        }

        # Emit agent_start event
        if self.streamContext:
            self.streamContext.emitAgentStart(
                agent.getId(),
                agent.getName(),
                agent.getAgentType(),
                context.get('parent_agent_id'),
                executionId,
            )

        try:
            # Get the LLM provider
            provider = self.llmManager.getProvider(agent.getProvider())

            if not provider:
                raise RuntimeError(f"Provider '{agent.getProvider()}' not found")

            # Set model if specified
            if agent.getModel():
                provider.setModel(agent.getModel())

            # Set up unified function executor with delegation tools for managers
            self._setupFunctionExecutor(provider, agent)

            # Build options from agent settings
            options = self._buildOptions(agent)
            options['user_id'] = user_id

            # Extract tools filter from context
            toolsFilter = context.get('tools_filter')

            # Build tool definitions (auto-includes delegation for managers)
            tools = self._buildToolsForAgent(agent, toolsFilter)

            # Per-call extras from the caller (e.g. workflow runner injecting
            # `run_skill_script` when the node is bound to a folder-backed
            # skill with executable scripts). These are appended to the
            # agent's normal tool set so they're only visible for this
            # single call — the underlying agent template is unchanged.
            extraTools = context.get('extra_tools')
            if not php_empty(extraTools) and is_php_array(extraTools):
                for extra in php_values(extraTools):
                    if is_php_array(extra):
                        tools.append(extra)

            if not php_empty(tools):
                options['tools'] = tools
                # Force tool usage for manager agents - they MUST delegate
                if agent.getAgentType() == 'manager':
                    options['tool_choice'] = 'required'

            # Per-call tool_choice override from the caller. Workflow runner
            # uses this to force run_skill_script on the first turn for
            # bound-skill agents — without forcing, the LLM sometimes
            # produces prose instead of calling the script. Caller-supplied
            # value wins over the manager default above.
            if context.get('tool_choice') is not None:
                options['tool_choice'] = context['tool_choice']

            # skill_metadata mirrors what ChatController passes when
            # run_skill_script is in play, so the providers' B3
            # short-circuit (emitClientToolCallEvent) recognises this as a
            # browser-bound tool. Workflow runner sets it from the bound
            # folder-backed skill before calling AgentRunner.
            skillMetadata = context.get('skill_metadata')
            if not php_empty(skillMetadata) and is_php_array(skillMetadata):
                options['skill_metadata'] = skillMetadata

            # Pass output_schema through for constrained decoding (structured
            # outputs). Resolved upstream by GraphWorkflowRunner from node config.
            outputSchema = context.get('output_schema')
            if not php_empty(outputSchema) and is_php_array(outputSchema):
                options['output_schema'] = outputSchema

            # Build system prompt - workflow logic is defined in manager's instructions
            systemPrompt = agent.buildSystemPrompt()

            # Build messages with system prompt
            messages = self._buildMessages(systemPrompt, conversation_history, input_)

            # Execute chat - provider handles tool loop internally
            startTime = time.time()
            response = provider.chat(input_, messages, options)
            responseTime = (time.time() - startTime) * 1000

            # Extract response data
            text = response.get('text') if response.get('text') is not None else ''
            usage = response.get('usage') if response.get('usage') is not None else {}
            functionsCalled = response.get('functions_called') if response.get('functions_called') is not None else []

            # Complete execution record
            self._completeExecution(executionId, {
                'text': text,
                'usage': usage,
                'tool_calls': functionsCalled,
            }, responseTime)

            # Emit agent_complete event
            if self.streamContext:
                self.streamContext.emitAgentComplete(
                    agent.getId(),
                    agent.getName(),
                    agent.getAgentType(),
                    True,
                    None,
                    executionId,
                )

            result = {
                'success': True,
                'text': text,
                'usage': usage,
                'tools_used': functionsCalled,
                'execution_id': executionId,
                'agent': {
                    'id': agent.getId(),
                    'name': agent.getName(),
                    'type': agent.getAgentType(),
                },
                'provider': agent.getProvider(),
                # PHP: $agent->getModel() ?? $provider->getModel() -- null
                # coalescing, NOT a truthy check. An empty-string model
                # (a real DB value on some rows) must be kept verbatim, not
                # treated as "unset" -- verified live: PHP returns '' here
                # for agent id 25 ("Transformer to Medium format"), whose
                # `model` column is ''. never-override-agent-form-params.
                'model': agent.getModel() if agent.getModel() is not None else provider.getModel(),
                'response_time_ms': round(responseTime),
            }

            # B3 short-circuit: provider bailed out because the LLM emitted a
            # client-side tool (run_skill_script). Surface the marker so the
            # workflow runner can take the round-trip to the browser and resume.
            if not php_empty(response.get('pending_client_tool_call')):
                result['pending_client_tool_call'] = True
                result['pending_tool_calls'] = response.get('pending_tool_calls') if response.get('pending_tool_calls') is not None else []
                result['pending_assistant_text'] = text
                reasoning = response.get('assistant_reasoning')
                if reasoning is None:
                    reasoning = response.get('_pending_assistant_reasoning')
                result['pending_assistant_reasoning'] = str(reasoning) if reasoning is not None else ''

            return result

        except Exception as e:  # noqa: BLE001 -- mirrors PHP `catch (\Exception $e)`
            self._failExecution(executionId, str(e))

            # Emit agent_complete event with error
            if self.streamContext:
                self.streamContext.emitAgentComplete(
                    agent.getId(),
                    agent.getName(),
                    agent.getAgentType(),
                    False,
                    str(e),
                    executionId,
                )

            return {
                'success': False,
                'error': str(e),
                'execution_id': executionId,
                'agent': {
                    'id': agent.getId(),
                    'name': agent.getName(),
                },
            }

    # ------------------------------------------------------------------
    # setupFunctionExecutor / ensureSessionSearchRegistered
    # ------------------------------------------------------------------

    def _setupFunctionExecutor(self, provider, agent) -> None:
        """Set up function executor on the provider. For manager agents,
        includes delegation tools. For all agents, combines built-in + MCP
        tools. PHP 279-302."""
        if not hasattr(provider, 'setFunctionExecutor'):
            return

        # Register session_search on the shared ToolsManager once per
        # request (idempotent). user_id comes from the per-run
        # executionContext set earlier in run()/streamRun().
        self._ensureSessionSearchRegistered()

        # Create base executor (built-in + MCP)
        baseExecutor = CombinedToolsExecutor(self.toolsManager, self.mcpToolsLoader)

        # For managers, wrap with AgentToolsExecutor to include delegation
        if agent.getAgentType() == 'manager':
            executor = AgentToolsExecutor(baseExecutor, self._getDelegationFunctions())
            executor.setExecutionContext(self.executionContext)
            provider.setFunctionExecutor(executor)
        else:
            # Workers use base executor (no delegation tools)
            provider.setFunctionExecutor(baseExecutor)

    def _ensureSessionSearchRegistered(self) -> None:
        """Register session_search on the shared ToolsManager bound to the
        current executionContext's user_id. Idempotent — runs once per
        AgentRunner instance (which lives for one HTTP request). PHP 309-323."""
        if self.sessionSearchRegistered:
            return
        userId = php_intval(self.executionContext.get('user_id') if self.executionContext.get('user_id') is not None else 0)
        if userId <= 0:
            return
        self.sessionSearchRegistered = SessionSearchService.registerAsTool(
            self.toolsManager, userId, self.config,
        )

    # ------------------------------------------------------------------
    # streamRun() — streaming (SSE)
    # ------------------------------------------------------------------

    def streamRun(
        self,
        agent,
        input_: str,
        conversation_history: list | None = None,
        user_id: int = 0,
        on_chunk: Callable[[dict], None] | None = None,
        context: dict | None = None,
    ) -> dict:
        """Run an agent with streaming response (SSE). PHP 335-496."""
        conversation_history = conversation_history if conversation_history is not None else []
        context = context if context is not None else {}

        # Create execution record
        executionId = self._createExecution(agent, user_id, input_, {})

        # Create or update stream context with the callback
        if on_chunk and not self.streamContext:
            self.streamContext = StreamContext(on_chunk, user_id)
        elif on_chunk and self.streamContext:
            self.streamContext.setEventCallback(on_chunk)

        # Set root execution ID if this is the first agent
        if self.streamContext and not self.streamContext.getRootExecutionId():
            self.streamContext.setRootExecutionId(executionId)

        # Set execution context
        self.executionContext = {
            'current_agent_id': agent.getId(),
            'execution_id': executionId,
            'user_id': user_id,
            'stream_context': self.streamContext,
        }

        # Debug: Log stream context status
        error_log(f"[AgentRunner::streamRun] Agent: {agent.getName()}, StreamContext set: "
                  + ('YES' if self.streamContext else 'NO'))

        # Emit agent_start event
        if self.streamContext:
            self.streamContext.emitAgentStart(
                agent.getId(),
                agent.getName(),
                agent.getAgentType(),
                None,
                executionId,
            )

        try:
            # Get provider
            provider = self.llmManager.getProvider(agent.getProvider())

            if not provider:
                raise RuntimeError(f"Provider '{agent.getProvider()}' not found")

            # Set model
            if agent.getModel():
                provider.setModel(agent.getModel())

            # Set up function executor (required for tool calls including delegation)
            self._setupFunctionExecutor(provider, agent)

            # Build options
            options = self._buildOptions(agent)
            options['user_id'] = user_id

            # Extract tools filter from context
            toolsFilter = context.get('tools_filter')

            # Build tools with optional filter
            tools = self._buildToolsForAgent(agent, toolsFilter)
            if not php_empty(tools):
                options['tools'] = tools
                # Force tool usage for manager agents - they MUST delegate
                if agent.getAgentType() == 'manager':
                    options['tool_choice'] = 'required'

            # Build system prompt - workflow logic is defined in manager's instructions
            systemPrompt = agent.buildSystemPrompt()

            # Build messages
            messages = self._buildMessages(systemPrompt, conversation_history, input_)

            # Create streaming callback
            fullTextHolder = {'text': ''}

            def _streamCallback(chunk):
                text = (chunk.get('text') if chunk.get('text') is not None else '') if isinstance(chunk, dict) else chunk
                text = text if text is not None else ''
                fullTextHolder['text'] += text

                if on_chunk:
                    on_chunk({
                        'type': 'chunk',
                        'text': text,
                        'agent_id': agent.getId(),
                        'agent_name': agent.getName(),
                    })

            # Execute streaming chat
            startTime = time.time()
            response = provider.streamChat(input_, _streamCallback, messages, options)
            responseTime = (time.time() - startTime) * 1000
            fullText = fullTextHolder['text']

            # Complete execution
            self._completeExecution(executionId, {
                'text': fullText,
                'usage': response.get('usage') if response.get('usage') is not None else {},
                'tool_calls': response.get('tool_calls') if response.get('tool_calls') is not None else [],
            }, responseTime)

            # Emit agent_complete event
            if self.streamContext:
                self.streamContext.emitAgentComplete(
                    agent.getId(),
                    agent.getName(),
                    agent.getAgentType(),
                    True,
                    None,
                    executionId,
                )

            return {
                'success': True,
                'text': fullText,
                'usage': response.get('usage') if response.get('usage') is not None else {},
                'execution_id': executionId,
            }

        except Exception as e:  # noqa: BLE001
            self._failExecution(executionId, str(e))

            # Emit agent_complete event with error
            if self.streamContext:
                self.streamContext.emitAgentComplete(
                    agent.getId(),
                    agent.getName(),
                    agent.getAgentType(),
                    False,
                    str(e),
                    executionId,
                )

            # Send error through stream if callback exists
            if on_chunk:
                on_chunk({
                    'type': 'error',
                    'error': str(e),
                    'agent_id': agent.getId(),
                })

            return {
                'success': False,
                'error': str(e),
                'execution_id': executionId,
            }

    # ------------------------------------------------------------------
    # Delegation functions
    # ------------------------------------------------------------------

    def _getDelegationFunctions(self) -> AgentDelegationFunctions:
        """Get delegation functions with fresh DB connection. Always creates
        fresh repository to ensure current DB connection is used (connection
        may have been refreshed after going stale). PHP 503-510."""
        self._ensureDbConnection()
        repository = AgentRepository(self.db)
        self.delegationFunctions = AgentDelegationFunctions(repository, self)
        return self.delegationFunctions

    # ------------------------------------------------------------------
    # buildToolsForAgent / buildOptions / buildMessages
    # ------------------------------------------------------------------

    def _buildToolsForAgent(self, agent, tools_filter: list | None = None) -> list:
        """Build tool definitions for an agent. Tool access by agent type:
        Manager: ONLY delegation tools (forces delegation to workers).
        Worker/Standard: Built-in tools + configured MCP tools. PHP 522-602."""
        # Manager agents get delegation tools: delegate_to_agent,
        # list_available_agents, complete_task, run_agents_parallel.
        if agent.getAgentType() == 'manager':
            delegationFuncs = self._getDelegationFunctions().getAllFunctions()

            tools: dict = {}

            # Give managers list_available_agents to discover their workers
            if 'list_available_agents' in delegationFuncs:
                func = delegationFuncs['list_available_agents']
                tools['list_available_agents'] = {
                    'name': 'list_available_agents',
                    'description': func['schema']['description'],
                    'input_schema': func['schema']['input_schema'],
                }

            # Give managers delegate_to_agent for delegating to workers
            if 'delegate_to_agent' in delegationFuncs:
                func = delegationFuncs['delegate_to_agent']
                tools['delegate_to_agent'] = {
                    'name': 'delegate_to_agent',
                    'description': func['schema']['description'],
                    'input_schema': func['schema']['input_schema'],
                }

            # Give managers complete_task to signal workflow completion
            if 'complete_task' in delegationFuncs:
                func = delegationFuncs['complete_task']
                tools['complete_task'] = {
                    'name': 'complete_task',
                    'description': func['schema']['description'],
                    'input_schema': func['schema']['input_schema'],
                }

            # Give managers run_agents_parallel to fan out independent sub-agents at once.
            if 'run_agents_parallel' in delegationFuncs:
                func = delegationFuncs['run_agents_parallel']
                tools['run_agents_parallel'] = {
                    'name': 'run_agents_parallel',
                    'description': func['schema']['description'],
                    'input_schema': func['schema']['input_schema'],
                }

            # Managers don't get built-in or MCP tools - they must delegate
            return list(tools.values())

        # Workers and standard agents get built-in tools
        tools = {}
        builtinTools = self.toolsManager.getToolDefinitions()
        for tool in builtinTools:
            tools[tool['name']] = tool

        # Add ALL MCP tools - same as conversation does. This ensures agents
        # have the same capabilities as regular chat.
        if self.mcpToolsLoader:
            mcpTools = self.mcpToolsLoader.getToolDefinitions()
            for tool in mcpTools:
                tools[tool['name']] = tool

        allTools = list(tools.values())

        # Apply tools filter if specified — an EMPTY list means no tools
        # (the node selected none); only null means "all".
        if tools_filter is not None:
            filteredTools = [t for t in allTools if t.get('name') in tools_filter]
            error_log(f"[AgentRunner] Tool filter applied: {len(filteredTools)}/{len(allTools)} tools")
            return filteredTools

        return allTools

    def _buildOptions(self, agent) -> dict:
        """Build options array from agent settings. PHP 607-634."""
        settings = agent.getSettings()
        options: dict = {}

        # Temperature
        if isinstance(settings, dict) and settings.get('temperature') is not None:
            options['temperature'] = float(settings['temperature'])

        # Max tokens
        if isinstance(settings, dict) and settings.get('max_tokens') is not None:
            options['max_tokens'] = php_intval(settings['max_tokens'])

        # Per-agent thinking switch ('on' | 'off'). Providers with a native
        # thinking mode (DeepSeek V4, GLM, Kimi K2) honor it; others ignore
        # the option. Absent/'default' keeps each provider's own default.
        thinking = settings.get('thinking') if isinstance(settings, dict) else None
        if thinking == 'on' or thinking == 'off':
            options['thinking'] = thinking

        # System prompt is passed to provider via system_prompt key
        options['system_prompt'] = agent.buildSystemPrompt()

        return options

    def _buildMessages(self, system_prompt: str, conversation_history: list, input_: str) -> list:
        """Build messages array for LLM. PHP 639-651 — note `systemPrompt`
        and `input` are unused in the PHP body (dead parameters); the
        returned list is purely the filtered conversation history."""
        messages = []

        # Add conversation history
        for msg in conversation_history:
            if isinstance(msg, dict) and msg.get('role') is not None and msg.get('content') is not None:
                messages.append(msg)

        return messages

    # ------------------------------------------------------------------
    # Execution record CRUD (SQL byte-identical to PHP)
    # ------------------------------------------------------------------

    def _createExecution(self, agent, user_id: int, input_: str, context: dict) -> int:
        """Create execution record in database. PHP 656-690."""
        # Skip execution record for inline agents (no database ID)
        if agent.getId() is None:
            error_log(f"[AgentRunner] Skipping execution record for inline agent: {agent.getName()}")
            return 0

        try:
            self._ensureDbConnection()
            return self.db.insert(
                "INSERT INTO agent_executions\n"
                "                 (agent_id, user_id, parent_execution_id, input, status, metadata)\n"
                "                 VALUES (?, ?, ?, ?, 'running', ?)",
                [
                    agent.getId(),
                    user_id,
                    context.get('parent_execution_id'),
                    input_,
                    php_json_encode({
                        'provider': agent.getProvider(),
                        'model': agent.getModel(),
                        'agent_type': agent.getAgentType(),
                    }),
                ],
            )
        except Exception as e:  # noqa: BLE001 -- mirrors PHP `catch (\PDOException $e)`
            # Log error but don't fail the execution
            error_log(f"[AgentRunner] Failed to create execution record: {e}")
            return 0

    def _completeExecution(self, execution_id: int, response: dict, response_time: float) -> None:
        """Mark execution as completed. PHP 695-735."""
        if execution_id == 0:
            return

        try:
            self._ensureDbConnection()
            usage = response.get('usage') if response.get('usage') is not None else {}
            promptTokens = usage.get('input_tokens')
            if promptTokens is None:
                promptTokens = usage.get('prompt_tokens') if usage.get('prompt_tokens') is not None else 0
            completionTokens = usage.get('output_tokens')
            if completionTokens is None:
                completionTokens = usage.get('completion_tokens') if usage.get('completion_tokens') is not None else 0

            toolCalls = response.get('tool_calls') if response.get('tool_calls') is not None else []
            toolNames = [
                ((t.get('name') if t.get('name') is not None else 'unknown') if isinstance(t, dict) else t)
                for t in toolCalls
            ]

            self.db.execute(
                "UPDATE agent_executions SET\n"
                "                 status = 'completed',\n"
                "                 output = ?,\n"
                "                 prompt_tokens = ?,\n"
                "                 completion_tokens = ?,\n"
                "                 tokens_used = ?,\n"
                "                 response_time_ms = ?,\n"
                "                 tools_called = ?,\n"
                "                 completed_at = NOW()\n"
                "                 WHERE id = ?",
                [
                    response.get('text') if response.get('text') is not None else '',
                    promptTokens,
                    completionTokens,
                    promptTokens + completionTokens,
                    php_intval(response_time),
                    php_json_encode(toolNames),
                    execution_id,
                ],
            )
        except Exception as e:  # noqa: BLE001
            error_log(f"[AgentRunner] Failed to complete execution record: {e}")

    def _failExecution(self, execution_id: int, error: str) -> None:
        """Mark execution as failed. PHP 740-763."""
        # Always log the error for debugging
        error_log(f"[AgentRunner] Agent execution failed: {error}")

        if execution_id == 0:
            return

        try:
            self._ensureDbConnection()
            self.db.execute(
                "UPDATE agent_executions SET\n"
                "                 status = 'failed',\n"
                "                 error_message = ?,\n"
                "                 completed_at = NOW()\n"
                "                 WHERE id = ?",
                [error, execution_id],
            )
        except Exception as e:  # noqa: BLE001
            error_log(f"[AgentRunner] Failed to mark execution as failed: {e}")

    # ------------------------------------------------------------------
    # DB helpers
    # ------------------------------------------------------------------

    def getFreshRepository(self) -> AgentRepository:
        """Get a fresh AgentRepository with valid DB connection. Used by
        delegation functions to ensure connection is alive. PHP 769-773."""
        self._ensureDbConnection()
        return AgentRepository(self.db)

    def _ensureDbConnection(self) -> None:
        """Ensure database connection is alive, reconnect if needed. PHP
        778-795 -> the established Python reconnect pattern (see
        app.services.usage_logger.UsageLogger._ensureConnection)."""
        try:
            self.db.fetch_one('SELECT 1')
        except Exception:  # noqa: BLE001 -- mirrors PHP `catch (\PDOException $e)`
            # Connection lost, try to reconnect
            error_log("[AgentRunner] DB connection lost, reconnecting...")
            dbConfig = self.config.get('contexts_database')
            if dbConfig is None:
                dbConfig = self.config.get('database')
            dbConfig = dbConfig if dbConfig is not None else {}
            if not php_empty(dbConfig):
                self.db = Db.connect(dbConfig)
                error_log("[AgentRunner] DB reconnected successfully")

    # ------------------------------------------------------------------
    # Misc accessors
    # ------------------------------------------------------------------

    def getAvailableWorkers(self, manager_id: int) -> list:
        """Get available worker agents for a manager (for workflow
        decisions). PHP 800-814."""
        self._ensureDbConnection()
        repository = AgentRepository(self.db)
        workers = repository.findWorkerAgents(manager_id)

        return [
            {
                'id': a.getId(),
                'name': a.getName(),
                'description': a.getDescription(),
                'agent_type': a.getAgentType(),
            }
            for a in workers
        ]

    def getExecutionContext(self) -> dict:
        return self.executionContext

    def setExecutionContext(self, context: dict) -> 'AgentRunner':
        self.executionContext = context
        return self

    def getStreamContext(self) -> StreamContext | None:
        return self.streamContext

    def setStreamContext(self, context: StreamContext | None) -> 'AgentRunner':
        self.streamContext = context
        return self

    def getExecutionHistory(self, agent_id: int, limit: int = 50, offset: int = 0) -> list:
        """Get execution history for an agent. PHP 853-864."""
        return self.db.fetch_all(
            "SELECT * FROM agent_executions\n"
            "             WHERE agent_id = ?\n"
            "             ORDER BY started_at DESC\n"
            "             LIMIT ? OFFSET ?",
            [agent_id, limit, offset],
        )

    def getExecution(self, execution_id: int) -> dict | None:
        """Get a specific execution by ID. PHP 869-876."""
        result = self.db.fetch_one("SELECT * FROM agent_executions WHERE id = ?", [execution_id])
        return result if result else None

    def getChildExecutions(self, parent_execution_id: int) -> list:
        """Get child executions (delegations) for a parent execution. PHP 881-893."""
        return self.db.fetch_all(
            "SELECT e.*, a.name as agent_name\n"
            "             FROM agent_executions e\n"
            "             JOIN agents a ON e.agent_id = a.id\n"
            "             WHERE e.parent_execution_id = ?\n"
            "             ORDER BY e.started_at ASC",
            [parent_execution_id],
        )

    def getLLMManager(self):
        return self.llmManager

    def getToolsManager(self):
        return self.toolsManager

    def getMCPToolsLoader(self):
        return self.mcpToolsLoader

    # ------------------------------------------------------------------
    # ParallelAgentExecutor wiring (Task 3)
    # ------------------------------------------------------------------

    def recordExecutionStart(self, agent, user_id: int, input_: str) -> int:
        """Public wrapper so ParallelAgentExecutor can log per-sub-agent
        executions. PHP 920-923."""
        return self._createExecution(agent, user_id, input_, {})

    def recordExecutionComplete(self, execution_id: int, response: dict, response_time_ms: float) -> None:
        """PHP 925-928."""
        self._completeExecution(execution_id, response, response_time_ms)

    def createParallelExecutor(self, record_executions: bool):
        """PHP 930-934. Lazy import: Task 3 (running concurrently) owns
        `parallel_agent_executor.py` and its unit test."""
        from app.agent_team.services.parallel_agent_executor import ParallelAgentExecutor
        return ParallelAgentExecutor(self, self.db, self.config, record_executions)
