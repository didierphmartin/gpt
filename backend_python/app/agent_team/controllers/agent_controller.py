"""Port of backend/src/AgentTeam/Controllers/AgentController.php (812 lines).

Agent Controller

REST API controller for agent CRUD and execution.

Endpoints:
- GET    /api/v1/agents           - List agents
- POST   /api/v1/agents           - Create agent
- GET    /api/v1/agents/{id}      - Get agent
- PUT    /api/v1/agents/{id}      - Update agent
- DELETE /api/v1/agents/{id}      - Delete agent
- POST   /api/v1/agents/{id}/run  - Run agent               (Phase 5 — NOT routed here)
- POST   /api/v1/agents/{id}/chat - Run agent (streaming)   (Phase 5 — NOT routed here)
- GET    /api/v1/agents/tools     - List available tools

@see docs/agentDesign.md

Only `run` (PHP 373-430) and `chat` (PHP 436-509) are out of scope for this
task (Phase 5 — they need AgentRunner/StreamContext, not ported yet). Every
other method is ported below.
"""
from __future__ import annotations

from app.agent_team.models.agent import Agent
from app.agent_team.services.agent_repository import AgentRepository
from app.ai_portfolio_assistant import AIPortfolioAssistant
from app.services.llm_provider_resolver import LLMProviderResolver
from app.services.mcp_tools_loader import MCPToolsLoader
from app.support.logger import error_log
from app.support.phpcompat import (
    is_php_array,
    php_bool,
    php_empty,
    php_intval,
    php_strval,
    php_trim,
    php_values,
)

AGENT_TYPES = ('standard', 'manager', 'worker', 'dispatcher', 'playbook')
VISIBILITIES = ('personal', 'workspace', 'public')


class AgentController:
    def __init__(self, db, config):
        self.db = db
        self.config = config
        self.repository = AgentRepository(db)

    # ========================================================================
    # GET /api/v1/agents — List agents accessible to the current user
    # ========================================================================

    def index(self, request) -> dict:
        """PHP 73-104."""
        userId = self.getUserId(request)
        query = request.get('query') if request.get('query') is not None else {}

        filters = {
            'agent_type': query.get('type'),
            'provider': query.get('provider'),
            'visibility': query.get('visibility'),
            'search': query.get('search'),
            'category': query.get('category'),
            'limit': php_intval(query['limit']) if query.get('limit') is not None else 100,
            'offset': php_intval(query['offset']) if query.get('offset') is not None else 0,
        }

        # Remove null filters (PHP: array_filter($filters, fn($v) => $v !== null))
        filters = {k: v for k, v in filters.items() if v is not None}

        agents = self.repository.findAccessibleByUser(userId, filters)
        total = self.repository.countAccessible(userId)

        return {
            'success': True,
            'data': [a.toApiArray() for a in agents],
            'meta': {
                'total': total,
                'count': len(agents),
                'limit': filters['limit'] if filters.get('limit') is not None else 100,
                'offset': filters['offset'] if filters.get('offset') is not None else 0,
            },
        }

    # ========================================================================
    # POST /api/v1/agents — Create a new agent
    # ========================================================================

    def create(self, request) -> dict:
        """PHP 110-168."""
        userId = self.getUserId(request)
        data = request.get('body') if request.get('body') is not None else {}

        if php_empty(data.get('name')):
            return self.error('Name is required', 400)

        agentType = data.get('agent_type') if data.get('agent_type') is not None else 'standard'
        if agentType not in AGENT_TYPES:
            return self.error('Invalid agent_type. Must be: standard, manager, worker, dispatcher, or playbook', 400)

        visibility = data.get('visibility') if data.get('visibility') is not None else 'personal'
        if visibility not in VISIBILITIES:
            return self.error('Invalid visibility. Must be: personal, workspace, or public', 400)

        tools = data.get('tools') if data.get('tools') is not None else []
        # Playbook agents: the tool selection is derived from the playbook's
        # bound #Actions (see PlaybookAgentTools), not typed by hand.
        instructions = data.get('instructions') if data.get('instructions') is not None else ''
        if agentType == 'playbook' and php_trim(php_strval(instructions)) != '':
            tools = self._playbookAgentToolsForUser(userId, php_strval(instructions))

        agent = Agent({
            'user_id': userId,
            'team_id': data.get('team_id'),
            'category': data.get('category'),
            'name': data['name'],
            'description': data.get('description') if data.get('description') is not None else '',
            'agent_type': agentType,
            'parent_agent_id': data.get('parent_agent_id'),
            'can_delegate_to': data.get('can_delegate_to') if data.get('can_delegate_to') is not None else [],
            'display_order': data.get('display_order') if data.get('display_order') is not None else 0,
            'provider': data.get('provider') if data.get('provider') is not None else 'claude',
            'model': data.get('model'),
            'instructions': instructions,
            'tools': tools,
            'visibility': visibility,
            'settings': data.get('settings') if data.get('settings') is not None else [],
        })

        try:
            created = self.repository.create(agent)
            return {
                'success': True,
                'data': created.toArray(),
                'message': f"Agent '{created.getName()}' created successfully",
            }
        except Exception as e:  # noqa: BLE001 -- mirrors PHP `catch (\Exception $e)`
            return self.error(f'Failed to create agent: {e}', 500)

    # ========================================================================
    # GET /api/v1/agents/{id} — Get a specific agent
    # ========================================================================

    def show(self, request, id: int = 0) -> dict:
        """PHP 174-197."""
        userId = self.getUserId(request)
        agentId = php_intval(id)

        if not self.repository.canUserAccess(userId, agentId):
            return self.error('Agent not found', 404)

        agent = self.repository.findById(agentId)

        query = request.get('query') if request.get('query') is not None else {}
        includeStats = (query.get('include_stats') if query.get('include_stats') is not None else False) == 'true'
        data = agent.toArray()

        if includeStats:
            data['stats'] = self.repository.getAgentStats(agentId)

        return {'success': True, 'data': data}

    # ========================================================================
    # PUT /api/v1/agents/{id} — Update an agent
    # ========================================================================

    def update(self, request, id: int = 0) -> dict:
        """PHP 203-278."""
        userId = self.getUserId(request)
        agentId = php_intval(id)
        data = request.get('body') if request.get('body') is not None else {}

        # Check ownership (only owner can update)
        if not self.repository.isOwner(userId, agentId):
            return self.error('Agent not found or access denied', 404)

        agent = self.repository.findById(agentId)

        # Update fields (isset -> `is not None`; array_key_exists -> `in data`)
        if data.get('name') is not None:
            agent.setName(data['name'])
        if data.get('description') is not None:
            agent.setDescription(data['description'])
        if 'team_id' in data:
            agent.setTeamId(data['team_id'])
        if 'category' in data:
            agent.setCategory(data['category'])
        if data.get('agent_type') is not None:
            agent.setAgentType(data['agent_type'])
        if data.get('parent_agent_id') is not None:
            agent.setParentAgentId(data['parent_agent_id'])
        if data.get('can_delegate_to') is not None:
            agent.setCanDelegateTo(data['can_delegate_to'])
        if data.get('provider') is not None:
            agent.setProvider(data['provider'])
        if data.get('model') is not None:
            agent.setModel(data['model'])
        if data.get('instructions') is not None:
            agent.setInstructions(data['instructions'])
        if data.get('tools') is not None:
            agent.setTools(data['tools'])
        if data.get('display_order') is not None:
            agent.setDisplayOrder(php_intval(data['display_order']))
        if data.get('visibility') is not None:
            agent.setVisibility(data['visibility'])
        if data.get('enabled') is not None:
            agent.setEnabled(php_bool(data['enabled']))
        if data.get('settings') is not None:
            agent.setSettings(data['settings'])

        try:
            # Playbook agents: keep the tool selection in step with the text.
            if agent.getAgentType() == 'playbook' and php_trim(php_strval(agent.getInstructions())) != '':
                agent.setTools(self._playbookAgentToolsForUser(agent.getUserId(), php_strval(agent.getInstructions())))
            updated = self.repository.update(agent)

            return {
                'success': True,
                'data': updated.toArray(),
                'message': f"Agent '{updated.getName()}' updated successfully",
            }
        except Exception as e:  # noqa: BLE001
            return self.error(f'Failed to update agent: {e}', 500)

    # ========================================================================
    # DELETE /api/v1/agents/{id} — Delete an agent
    # ========================================================================

    def destroy(self, request, id: int = 0) -> dict:
        """PHP 284-307."""
        userId = self.getUserId(request)
        agentId = php_intval(id)

        if not self.repository.isOwner(userId, agentId):
            return self.error('Agent not found or access denied', 404)

        agent = self.repository.findById(agentId)
        agentName = agent.getName()

        try:
            self.repository.delete(agentId)
            return {'success': True, 'message': f"Agent '{agentName}' deleted successfully"}
        except Exception as e:  # noqa: BLE001
            return self.error(f'Failed to delete agent: {e}', 500)

    # ========================================================================
    # GET /api/v1/agents/categories — List the user's distinct container/category names.
    # ========================================================================

    def listCategories(self, request) -> dict:
        """PHP 313-322."""
        userId = self.getUserId(request)
        categories = self.repository.findDistinctCategories(userId)
        return {
            'success': True,
            'data': categories,
            'meta': {'count': len(categories)},
        }

    # ========================================================================
    # PUT /api/v1/agents/categories/rename — Rename a container across all of the user's agents.
    # Body: { old_name: string, new_name: string }
    # ========================================================================

    def renameCategory(self, request) -> dict:
        """PHP 329-346."""
        userId = self.getUserId(request)
        data = request.get('body') if request.get('body') is not None else {}
        old = php_trim(php_strval(data.get('old_name') if data.get('old_name') is not None else ''))
        new = php_trim(php_strval(data.get('new_name') if data.get('new_name') is not None else ''))
        if old == '' or new == '':
            return self.error('old_name and new_name are required', 400)
        if old == new:
            return {'success': True, 'data': {'affected': 0}}
        affected = self.repository.renameCategory(userId, old, new)
        return {
            'success': True,
            'data': {'affected': affected, 'old_name': old, 'new_name': new},
        }

    # ========================================================================
    # DELETE /api/v1/agents/categories — Clears the named container.
    # Body or query: { name: string }
    # ========================================================================

    def deleteCategory(self, request) -> dict:
        """PHP 353-367."""
        userId = self.getUserId(request)
        body = request.get('body') if request.get('body') is not None else {}
        query = request.get('query') if request.get('query') is not None else {}
        name = php_trim(php_strval(
            body['name'] if body.get('name') is not None else (
                query['name'] if query.get('name') is not None else '')
        ))
        if name == '':
            return self.error('name is required', 400)
        affected = self.repository.clearCategory(userId, name)
        return {'success': True, 'data': {'affected': affected, 'name': name}}

    # ========================================================================
    # GET /api/v1/agents/tools — List all available tools that can be assigned to agents
    # ========================================================================

    def listTools(self, request) -> dict:
        """PHP 515-574. Composes AIPortfolioAssistant + MCPToolsLoader exactly
        like ToolsController.list() (app/controllers/tools_controller.py),
        close()-in-finally included.

        DEVIATION (parity, not a fix): PHP's AgentController never calls
        MCPToolsLoader::loadToolsForUser() before reading getToolDefinitions()
        here (AgentController.php:517-539) — nor does AgentRunner's constructor
        (AgentRunner.php:55-66) — so the loader's internal `$this->tools` stays
        empty and `mcp` is always `[]` on live PHP today (verified against
        /api/v1/agents/tools on the running PHP backend: counts == {'builtin':
        21, 'mcp': 0, 'delegation': 3, 'total': 24}). We reproduce that by
        instantiating (and closing) the loader without loading tools into it —
        NOT by copying ToolsController's loadToolsForUser() call, which would
        populate mcp_tools and break parity.
        """
        config = LLMProviderResolver.applyDbSettings(self.db, self.config)
        assistant = AIPortfolioAssistant(config)
        assistant.setDatabase(self.db)

        builtinTools: list = []
        try:
            toolsManager = assistant.getToolsManager()
            for tool in toolsManager.getToolDefinitions():
                builtinTools.append({
                    'name': tool['name'],
                    'description': tool.get('description') if tool.get('description') is not None else '',
                    'type': 'builtin',
                })
        finally:
            try:
                assistant.close()
            except Exception as closeErr:  # noqa: BLE001
                error_log(f"[AgentController] assistant.close() failed: {closeErr}")

        mcpTools: list = []
        mcpLoader = None
        try:
            mcpLoader = MCPToolsLoader(self.db)
            for tool in mcpLoader.getToolDefinitions():
                mcpTools.append({
                    'name': tool['name'],
                    'description': tool.get('description') if tool.get('description') is not None else '',
                    'type': 'mcp',
                    'server': tool.get('server_name'),
                })
        finally:
            if mcpLoader is not None:
                try:
                    mcpLoader.close()
                except Exception as closeErr:  # noqa: BLE001
                    error_log(f"[AgentController] mcpLoader.close() failed: {closeErr}")

        # Add delegation tools
        delegationTools = [
            {
                'name': 'delegate_to_agent',
                'description': 'Delegate a task to a specialized sub-agent',
                'type': 'delegation',
            },
            {
                'name': 'list_available_agents',
                'description': 'List agents that can be delegated to',
                'type': 'delegation',
            },
            {
                'name': 'run_agents_parallel',
                'description': 'Run multiple agents in parallel',
                'type': 'delegation',
            },
        ]

        return {
            'success': True,
            'tools': {
                'builtin': builtinTools,
                'mcp': mcpTools,
                'delegation': delegationTools,
            },
            'counts': {
                'builtin': len(builtinTools),
                'mcp': len(mcpTools),
                'delegation': len(delegationTools),
                'total': len(builtinTools) + len(mcpTools) + len(delegationTools),
            },
        }

    # ========================================================================
    # GET /api/v1/agents/{id}/executions — Get execution history for an agent
    # ========================================================================

    def executions(self, request, id: int = 0) -> dict:
        """PHP 580-605. Query built inline from AgentRunner::getExecutionHistory
        (AgentRunner.php:853-861) — the rest of AgentRunner (LLM/tool execution)
        is Phase 5, out of scope here."""
        userId = self.getUserId(request)
        agentId = php_intval(id)
        query = request.get('query') if request.get('query') is not None else {}

        if not self.repository.canUserAccess(userId, agentId):
            return self.error('Agent not found', 404)

        limit = php_intval(query['limit']) if query.get('limit') is not None else 50
        offset = php_intval(query['offset']) if query.get('offset') is not None else 0

        executions = self.db.fetch_all(
            "SELECT * FROM agent_executions\n"
            "             WHERE agent_id = ?\n"
            "             ORDER BY started_at DESC\n"
            "             LIMIT ? OFFSET ?",
            [agentId, limit, offset],
        )

        return {
            'success': True,
            'data': executions,
            'meta': {
                'count': len(executions),
                'limit': limit,
                'offset': offset,
            },
        }

    # ========================================================================
    # POST /api/v1/agents/{id}/duplicate — Duplicate an agent
    # ========================================================================

    def duplicate(self, request, id: int = 0) -> dict:
        """PHP 611-639."""
        userId = self.getUserId(request)
        agentId = php_intval(id)
        data = request.get('body') if request.get('body') is not None else {}

        if not self.repository.canUserAccess(userId, agentId):
            return self.error('Agent not found', 404)

        newName = data.get('name')

        try:
            duplicated = self.repository.duplicate(agentId, userId, newName)

            if not duplicated:
                return self.error('Failed to duplicate agent', 500)

            return {
                'success': True,
                'data': duplicated.toArray(),
                'message': 'Agent duplicated successfully',
            }
        except Exception as e:  # noqa: BLE001
            return self.error(f'Failed to duplicate agent: {e}', 500)

    # ========================================================================
    # POST /api/v1/agents/{id}/move-up — Move an agent up in display order within its team
    # ========================================================================

    def moveUp(self, request, id: int = 0) -> dict:
        """PHP 645-673."""
        userId = self.getUserId(request)
        agentId = php_intval(id)

        if not self.repository.isOwner(userId, agentId):
            return self.error('Agent not found or access denied', 404)

        try:
            success = self.repository.moveAgentUp(agentId)

            if not success:
                return self.error('Cannot move agent up (already at top or not in a team)', 400)

            agent = self.repository.findById(agentId)
            teamAgents = self.repository.findByTeamId(agent.getTeamId())

            return {
                'success': True,
                'message': 'Agent moved up successfully',
                'agents': [a.toApiArray() for a in teamAgents],
            }
        except Exception as e:  # noqa: BLE001
            return self.error(f'Failed to move agent: {e}', 500)

    # ========================================================================
    # POST /api/v1/agents/{id}/move-down — Move an agent down in display order within its team
    # ========================================================================

    def moveDown(self, request, id: int = 0) -> dict:
        """PHP 679-707."""
        userId = self.getUserId(request)
        agentId = php_intval(id)

        if not self.repository.isOwner(userId, agentId):
            return self.error('Agent not found or access denied', 404)

        try:
            success = self.repository.moveAgentDown(agentId)

            if not success:
                return self.error('Cannot move agent down (already at bottom or not in a team)', 400)

            agent = self.repository.findById(agentId)
            teamAgents = self.repository.findByTeamId(agent.getTeamId())

            return {
                'success': True,
                'message': 'Agent moved down successfully',
                'agents': [a.toApiArray() for a in teamAgents],
            }
        except Exception as e:  # noqa: BLE001
            return self.error(f'Failed to move agent: {e}', 500)

    # ========================================================================
    # POST /api/v1/agents/reorder — Reorder agents within a team
    # Body: { team_id: int, agent_ids: int[] }
    #
    # NOTE: Manager agents are always enforced at position 0 (top of stack).
    # If the submitted order places a manager elsewhere, the order will be
    # adjusted and a message will be returned.
    # ========================================================================

    def reorder(self, request) -> dict:
        """PHP 718-776."""
        userId = self.getUserId(request)
        data = request.get('body') if request.get('body') is not None else {}

        if php_empty(data.get('team_id')):
            return self.error('team_id is required', 400)

        agentIdsRaw = data.get('agent_ids')
        if php_empty(agentIdsRaw) or not is_php_array(agentIdsRaw):
            return self.error('agent_ids array is required', 400)

        teamId = php_intval(data['team_id'])
        agentIds = [php_intval(a) for a in php_values(agentIdsRaw)]

        # Verify user owns all agents in the list
        for agentId in agentIds:
            if not self.repository.isOwner(userId, agentId):
                return self.error(f'Access denied for agent ID: {agentId}', 403)

        try:
            result = self.repository.updateAgentOrder(agentIds, teamId)

            if not result.get('success'):
                return self.error(result.get('error') if result.get('error') is not None else 'Failed to reorder agents', 500)

            # Get agents with pipeline info
            teamAgentsWithInfo = self.repository.findByTeamIdWithPipelineInfo(teamId)

            # Format response
            agents = []
            for item in teamAgentsWithInfo:
                agentData = item['agent'].toApiArray()
                agentData['pipeline_position'] = item['pipeline_position']
                agentData['pipeline_label'] = item['pipeline_label']
                agentData['can_reorder'] = item['can_reorder']
                agents.append(agentData)

            response = {
                'success': True,
                'message': 'Agents reordered successfully',
                'agents': agents,
            }

            # Notify if order was adjusted (manager moved back to top)
            if result.get('reordered'):
                response['notice'] = result.get('message')
                response['enforced'] = True

            return response
        except Exception as e:  # noqa: BLE001
            return self.error(f'Failed to reorder agents: {e}', 500)

    # ========================================================================
    # POST /api/v1/agents/{id}/run and /chat — Phase 5, not routed
    # ========================================================================

    def run(self, request, id: int = 0):
        """PHP 373-430. Needs AgentRunner (LLM tool loop) — Phase 5."""
        raise NotImplementedError('Phase 5')

    def chat(self, request, id: int = 0):
        """PHP 436-509. Needs AgentRunner + StreamContext (SSE) — Phase 5."""
        raise NotImplementedError('Phase 5')

    # ========================================================================
    # Helper Methods
    # ========================================================================

    def getUserId(self, request) -> int:
        """PHP 782-785."""
        return php_intval(request.get('user_id') if request.get('user_id') is not None else 0)

    def _playbookAgentToolsForUser(self, user_id: int, text: str) -> list:
        """Port of PlaybookAgentTools::forUser (backend/src/AgentTeam/Services/
        PlaybookAgentTools.php:42-53) — "never throws, returns [] on any
        failure" when the playbook registry/analyzer is unavailable.

        DEVIATION: The Playbook interpreter (PlaybookAnalyzer / PlaybookDocument
        / LoaderMcpExecutor) has not been ported to Python — it lives on the
        separate, unmerged feat/playbook-interpreter branch, out of scope for
        this Phase 4 (agent-team data) task. So this always takes PHP's own
        "any failure" fallback path (PlaybookAgentTools.php:49-52: catch
        \\Throwable -> error_log + return []) rather than attempting analysis.
        When the interpreter is ported, replace this with the real call.
        """
        error_log(
            '[PlaybookAgentTools] registry unavailable: PlaybookAnalyzer not yet '
            'ported to Python (backend_python/app/agent_team/controllers/agent_controller.py)'
        )
        return []

    def error(self, message: str, status: int = 400) -> dict:
        """PHP 792-804. index.php reads the HTTP status from `status_code`, not
        `status` — `status` is kept in the JSON body for any existing readers."""
        return {
            'success': False,
            'error': message,
            'status': status,
            'status_code': status,
        }
