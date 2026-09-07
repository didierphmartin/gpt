"""Port of backend/src/AgentTeam/Controllers/AgentMCPController.php (501 lines).

MCP (Model Context Protocol) JSON-RPC endpoint for agent management, mounted
at `POST /api/v1/mcp/agents`. `handle()` is the sole HTTP entry point; every
`_xxx` method below is a private JSON-RPC method handler (PHP's `private`
methods of the same name, camelCase).

The constructor (PHP 46-70) builds the same AIPortfolioAssistant/AgentRunner
stack AgentController.__init__ / WorkflowController.__init__ build —
identical DB-overlay-first sequence.

`\\InvalidArgumentException`-shaped validation errors (agent_id required, not
found, name required, tool not found, method not found) map to JSON-RPC code
-32601 (PHP `jsonRpcError`'s `\\InvalidArgumentException` catch clause, PHP
105); any other exception maps to -32603 (PHP 107). Ported as a dedicated
`_InvalidArgument` exception so `handle()`'s try/except can distinguish the
two the same way PHP's two `catch` clauses do.

None of this controller's return dicts ever carry a `status_code` key (PHP
never sets one either) — the JSON-RPC envelope (success or error) is always
answered with HTTP 200, per `backend/index.php:149`'s `$result['status_code']
?? 200` default, exactly like `WorkflowController.toolResult`/`runEvents`.
"""
from __future__ import annotations

from app.agent_team.models.agent import Agent
from app.agent_team.services.agent_repository import AgentRepository
from app.agent_team.services.agent_runner import AgentRunner
from app.ai_portfolio_assistant import AIPortfolioAssistant
from app.services.llm_provider_resolver import LLMProviderResolver
from app.services.mcp_tools_loader import MCPToolsLoader
from app.support import phpjson
from app.support.phpcompat import php_array, php_bool, php_empty, php_intval, php_strval, php_trim


class _InvalidArgument(Exception):
    """Marks a PHP `\\InvalidArgumentException` — `jsonRpcError` code -32601."""


class AgentMCPController:
    PROTOCOL_VERSION = '2024-11-05'
    SERVER_NAME = 'AgentTeam'
    SERVER_VERSION = '1.0.0'

    def __init__(self, db, config):
        """PHP 46-70."""
        self.db = db
        self.config = config

        self.repository = AgentRepository(db)

        # DB-overlay first so providers from system_llm_settings register
        # (post-cutover the file no longer carries provider blocks) — same
        # sequence as AgentController.__init__ / WorkflowController.__init__.
        config = LLMProviderResolver.applyDbSettings(db, config)
        self.config = config
        assistant = AIPortfolioAssistant(config)
        assistant.setDatabase(db)

        mcpToolsLoader = MCPToolsLoader(db)

        self.runner = AgentRunner(
            assistant.getLLMManager(),
            assistant.getToolsManager(),
            mcpToolsLoader,
            db,
            config,
        )

    # ========================================================================
    # POST /api/v1/mcp/agents — PHP 79-119
    # ========================================================================

    def handle(self, request) -> dict:
        """PHP 79-119."""
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        body = request['body'] if request.get('body') is not None else {}

        # isset($body['jsonrpc']) && $body['jsonrpc'] !== '2.0': a missing
        # key (None) or a wrong value both take this branch.
        if body.get('jsonrpc') != '2.0':
            return self._jsonRpcError(None, -32600, 'Invalid Request: missing jsonrpc 2.0')

        method = body.get('method') if body.get('method') is not None else ''
        params = body.get('params')
        params = params if isinstance(params, dict) else {}
        id_ = body.get('id')

        try:
            if method == 'initialize':
                result = self._initialize(params)
            elif method == 'agents/list':
                result = self._listAgents(userId, params)
            elif method == 'agents/get':
                result = self._getAgent(userId, params)
            elif method == 'agents/create':
                result = self._createAgent(userId, params)
            elif method == 'agents/update':
                result = self._updateAgent(userId, params)
            elif method == 'agents/delete':
                result = self._deleteAgent(userId, params)
            elif method == 'agents/run':
                result = self._runAgent(userId, params)
            elif method == 'tools/list':
                result = self._listTools(userId)
            elif method == 'tools/call':
                result = self._callTool(userId, params)
            elif method == 'ping':
                result = {'pong': True}
            else:
                raise _InvalidArgument(f'Method not found: {method}')

            return self._jsonRpcSuccess(id_, result)

        except _InvalidArgument as e:
            return self._jsonRpcError(id_, -32601, str(e))
        except Exception as e:  # noqa: BLE001 -- mirrors PHP `catch (\Exception $e)`
            return self._jsonRpcError(id_, -32603, str(e))

    # ========================================================================
    # initialize — MCP handshake — PHP 124-143
    # ========================================================================

    def _initialize(self, params: dict) -> dict:
        return {
            'protocolVersion': self.PROTOCOL_VERSION,
            'capabilities': {
                'tools': {'listChanged': True},
                'resources': {'subscribe': True, 'listChanged': True},
                'prompts': {'listChanged': True},
            },
            'serverInfo': {
                'name': self.SERVER_NAME,
                'version': self.SERVER_VERSION,
            },
        }

    # ========================================================================
    # agents/list — PHP 148-172
    # ========================================================================

    def _listAgents(self, userId: int, params: dict) -> dict:
        filters = {
            'agent_type': params.get('type'),
            'provider': params.get('provider'),
            'limit': params.get('limit') if params.get('limit') is not None else 100,
        }
        filters = {k: v for k, v in filters.items() if v is not None}

        agents = self.repository.findAccessibleByUser(userId, filters)

        return {
            'agents': [
                {
                    'id': a.getId(),
                    'name': a.getName(),
                    'description': a.getDescription(),
                    'type': a.getAgentType(),
                    'provider': a.getProvider(),
                    'model': a.getModel(),
                    'visibility': a.getVisibility(),
                    'tools': a.getTools(),
                }
                for a in agents
            ],
            'count': len(agents),
        }

    # ========================================================================
    # agents/get — PHP 177-196
    # ========================================================================

    def _getAgent(self, userId: int, params: dict) -> dict:
        agentId = params.get('id') if params.get('id') is not None else params.get('agent_id')

        if php_empty(agentId):
            raise _InvalidArgument('agent_id is required')

        agentId = php_intval(agentId)
        if not self.repository.canUserAccess(userId, agentId):
            raise _InvalidArgument('Agent not found')

        agent = self.repository.findById(agentId)

        return {'agent': agent.toArray()}

    # ========================================================================
    # agents/create — PHP 201-225
    # ========================================================================

    def _createAgent(self, userId: int, params: dict) -> dict:
        if php_empty(params.get('name')):
            raise _InvalidArgument('name is required')

        agent = Agent({
            'user_id': userId,
            'name': params['name'],
            'description': params.get('description') if params.get('description') is not None else '',
            'agent_type': params.get('agent_type') if params.get('agent_type') is not None else 'standard',
            'provider': params.get('provider') if params.get('provider') is not None else 'claude',
            'model': params.get('model'),
            'instructions': params.get('instructions') if params.get('instructions') is not None else '',
            'tools': params.get('tools') if params.get('tools') is not None else [],
            'can_delegate_to': params.get('can_delegate_to') if params.get('can_delegate_to') is not None else [],
            'visibility': params.get('visibility') if params.get('visibility') is not None else 'personal',
            'settings': params.get('settings') if params.get('settings') is not None else [],
        })

        created = self.repository.create(agent)

        return {'agent': created.toArray(), 'message': 'Agent created successfully'}

    # ========================================================================
    # agents/update — PHP 231-269
    # ========================================================================

    def _updateAgent(self, userId: int, params: dict) -> dict:
        agentId = params.get('id') if params.get('id') is not None else params.get('agent_id')

        if php_empty(agentId):
            raise _InvalidArgument('agent_id is required')

        agentId = php_intval(agentId)
        if not self.repository.isOwner(userId, agentId):
            raise _InvalidArgument('Agent not found or access denied')

        agent = self.repository.findById(agentId)

        # isset($params[...]) -- false for an explicit JSON null, same as
        # Python `is not None`.
        if params.get('name') is not None:
            agent.setName(params['name'])
        if params.get('description') is not None:
            agent.setDescription(params['description'])
        if params.get('agent_type') is not None:
            agent.setAgentType(params['agent_type'])
        if params.get('provider') is not None:
            agent.setProvider(params['provider'])
        if params.get('model') is not None:
            agent.setModel(params['model'])
        if params.get('instructions') is not None:
            agent.setInstructions(params['instructions'])
        if params.get('tools') is not None:
            agent.setTools(params['tools'])
        if params.get('can_delegate_to') is not None:
            agent.setCanDelegateTo(params['can_delegate_to'])
        if params.get('visibility') is not None:
            agent.setVisibility(params['visibility'])
        if params.get('enabled') is not None:
            agent.setEnabled(php_bool(params['enabled']))
        if params.get('settings') is not None:
            agent.setSettings(params['settings'])

        updated = self.repository.update(agent)

        return {'agent': updated.toArray(), 'message': 'Agent updated successfully'}

    # ========================================================================
    # agents/delete — PHP 275-294
    # ========================================================================

    def _deleteAgent(self, userId: int, params: dict) -> dict:
        agentId = params.get('id') if params.get('id') is not None else params.get('agent_id')

        if php_empty(agentId):
            raise _InvalidArgument('agent_id is required')

        agentId = php_intval(agentId)
        if not self.repository.isOwner(userId, agentId):
            raise _InvalidArgument('Agent not found or access denied')

        self.repository.delete(agentId)

        return {'deleted': True, 'message': 'Agent deleted successfully'}

    # ========================================================================
    # agents/run — PHP 300-323. Note the reversed `agent_id ?? id`
    # precedence vs. get/update/delete's `id ?? agent_id` above -- copied
    # verbatim from the PHP source.
    # ========================================================================

    def _runAgent(self, userId: int, params: dict) -> dict:
        agentId = params.get('agent_id') if params.get('agent_id') is not None else params.get('id')
        input_ = params.get('input') if params.get('input') is not None else (
            params.get('message') if params.get('message') is not None else '')

        if php_empty(agentId):
            raise _InvalidArgument('agent_id is required')

        if php_empty(php_trim(php_strval(input_))):
            raise _InvalidArgument('input is required')

        agentId = php_intval(agentId)
        if not self.repository.canUserAccess(userId, agentId):
            raise _InvalidArgument('Agent not found')

        agent = self.repository.findById(agentId)

        if not agent.isEnabled():
            raise _InvalidArgument('Agent is disabled')

        conversationHistory = params.get('conversation_history') if params.get('conversation_history') is not None else []

        result = self.runner.run(agent, input_, conversationHistory, userId)

        return {
            'response': {
                'text': result.get('text') if result.get('text') is not None else '',
                'success': result.get('success') if result.get('success') is not None else False,
                'error': result.get('error'),
                'usage': result.get('usage') if result.get('usage') is not None else [],
                'tools_used': result.get('tools_used') if result.get('tools_used') is not None else [],
                'execution_id': result.get('execution_id'),
            },
            'agent': {'id': agent.getId(), 'name': agent.getName()},
        }

    # ========================================================================
    # tools/list — PHP 328-379
    # ========================================================================

    def _listTools(self, userId: int) -> dict:
        """PHP 328-379. `$tool['input_schema'] ?? []` and the
        `list_available_agents` tool's literal `'properties' => []` are both
        PHP arrays that `json_encode` to `[]`, not `{}` -- `php_array()`
        (phpcompat's established empty-array/empty-object disambiguator,
        e.g. agent.py's `toArray()`) reproduces that for both the fallback
        and the always-empty literal alike."""
        toolsManager = self.runner.getToolsManager()
        mcpLoader = self.runner.getMCPToolsLoader()

        tools = []

        for tool in toolsManager.getToolDefinitions():
            tools.append({
                'name': tool['name'],
                'description': tool.get('description') if tool.get('description') is not None else '',
                'inputSchema': php_array(tool.get('input_schema') if tool.get('input_schema') is not None else {}),
                'type': 'builtin',
            })

        if mcpLoader:
            for tool in mcpLoader.getToolDefinitions():
                tools.append({
                    'name': tool['name'],
                    'description': tool.get('description') if tool.get('description') is not None else '',
                    'inputSchema': php_array(
                        tool.get('input_schema') if tool.get('input_schema') is not None else {}),
                    'type': 'mcp',
                })

        delegationTools = [
            {
                'name': 'delegate_to_agent',
                'description': 'Delegate a task to a specialized sub-agent',
                'inputSchema': {
                    'type': 'object',
                    'properties': {
                        'agent_name': {'type': 'string'},
                        'task': {'type': 'string'},
                        'context': {'type': 'string'},
                    },
                    'required': ['task'],
                },
                'type': 'delegation',
            },
            {
                'name': 'list_available_agents',
                'description': 'List agents available for delegation',
                'inputSchema': {'type': 'object', 'properties': php_array({})},
                'type': 'delegation',
            },
            {
                'name': 'run_agents_parallel',
                'description': 'Run multiple agents in parallel',
                'inputSchema': {
                    'type': 'object',
                    'properties': {'delegations': {'type': 'array'}},
                    'required': ['delegations'],
                },
                'type': 'delegation',
            },
        ]

        tools = tools + delegationTools

        return {'tools': tools, 'count': len(tools)}

    # ========================================================================
    # tools/call — PHP 385-411
    # ========================================================================

    def _callTool(self, userId: int, params: dict) -> dict:
        toolName = params.get('name') if params.get('name') is not None else ''
        arguments = params.get('arguments') if params.get('arguments') is not None else {}

        if php_empty(toolName):
            raise _InvalidArgument('Tool name is required')

        toolsManager = self.runner.getToolsManager()

        if not toolsManager.hasFunction(toolName):
            raise _InvalidArgument(f'Tool not found: {toolName}')

        result = toolsManager.execute(toolName, arguments, userId)

        isArray = isinstance(result, (dict, list))
        # json_encode($result, JSON_PRETTY_PRINT) -- plain flag only, so
        # slashes and non-ASCII stay escaped (unescaped=False).
        text = phpjson.dumps_pretty(result, unescaped=False) if isArray else php_strval(result)
        isError = isinstance(result, dict) and result.get('error') is not None

        return {
            'content': [{'type': 'text', 'text': text}],
            'isError': isError,
        }

    # ========================================================================
    # JSON-RPC envelope helpers — PHP 416-449
    # ========================================================================

    def _jsonRpcSuccess(self, id_, result: dict) -> dict:
        return {'jsonrpc': '2.0', 'id': id_, 'result': result}

    def _jsonRpcError(self, id_, code: int, message: str, data=None) -> dict:
        error = {'code': code, 'message': message}
        if data is not None:
            error['data'] = data

        return {'jsonrpc': '2.0', 'id': id_, 'error': error}
