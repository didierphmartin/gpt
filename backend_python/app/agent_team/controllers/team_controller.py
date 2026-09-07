"""Port of backend/src/AgentTeam/Controllers/TeamController.php.

Team Controller

Handles REST API endpoints for team management.

See docs/agentDesign.md
"""
from __future__ import annotations

from app.agent_team.models.team import Team
from app.agent_team.services.agent_repository import AgentRepository
from app.agent_team.services.team_repository import TeamRepository
from app.support.phpcompat import php_empty, php_intval


class TeamController:
    def __init__(self, db, config):
        self.db = db
        self.config = config
        self.agentRepository = AgentRepository(db)
        self.teamRepository = TeamRepository(db, self.agentRepository)

    def index(self, request) -> dict:
        """GET /api/v1/teams. List all teams for the authenticated user. PHP 38-69."""
        userId = request['user_id'] if request.get('user_id') is not None else 0

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        try:
            teams = self.teamRepository.findByUserWithAgents(userId)

            return {
                'success': True,
                'data': [team.toArrayWithAgents() for team in teams],
                'count': len(teams),
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001 -- mirrors PHP `catch (\Exception $e)`
            return {'success': False, 'error': str(e), 'status_code': 500}

    def create(self, request) -> dict:
        """POST /api/v1/teams. Create a new team. PHP 75-119."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        body = request['body'] if request.get('body') is not None else {}

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        # Validate required fields
        if php_empty(body.get('name')):
            return {'success': False, 'error': 'Team name is required', 'status_code': 400}

        try:
            team = Team()
            team.setUserId(userId) \
                .setName(body['name']) \
                .setDescription(body['description'] if body.get('description') is not None else '') \
                .setWorkspaceId(body['workspace_id'] if body.get('workspace_id') is not None else None)

            created = self.teamRepository.create(team)

            return {
                'success': True,
                'data': created.toArray(),
                'message': 'Team created successfully',
                'status_code': 201,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def show(self, request, id: int = 0) -> dict:
        """GET /api/v1/teams/{id}. Get a specific team with its agents. PHP 125-178."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        teamId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if not teamId:
            return {'success': False, 'error': 'Team ID is required', 'status_code': 400}

        try:
            # Check access
            if not self.teamRepository.canUserAccess(userId, teamId):
                return {'success': False, 'error': 'Team not found or access denied', 'status_code': 404}

            team = self.teamRepository.findByIdWithAgents(teamId)

            if not team:
                return {'success': False, 'error': 'Team not found', 'status_code': 404}

            return {'success': True, 'data': team.toArrayWithAgents(), 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def update(self, request, id: int = 0) -> dict:
        """PUT /api/v1/teams/{id}. Update a team. PHP 184-252."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        teamId = php_intval(id)
        body = request['body'] if request.get('body') is not None else {}

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if not teamId:
            return {'success': False, 'error': 'Team ID is required', 'status_code': 400}

        try:
            # Check ownership
            if not self.teamRepository.isOwner(userId, teamId):
                return {'success': False, 'error': 'Team not found or access denied', 'status_code': 404}

            team = self.teamRepository.findById(teamId)

            if not team:
                return {'success': False, 'error': 'Team not found', 'status_code': 404}

            # Update fields
            if body.get('name') is not None:
                team.setName(body['name'])
            if body.get('description') is not None:
                team.setDescription(body['description'])
            if body.get('workspace_id') is not None:
                team.setWorkspaceId(body['workspace_id'])

            updated = self.teamRepository.update(team)

            return {
                'success': True,
                'data': updated.toArray(),
                'message': 'Team updated successfully',
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def destroy(self, request, id: int = 0) -> dict:
        """DELETE /api/v1/teams/{id}. Delete a team. PHP 258-303."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        teamId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if not teamId:
            return {'success': False, 'error': 'Team ID is required', 'status_code': 400}

        try:
            # Check ownership
            if not self.teamRepository.isOwner(userId, teamId):
                return {'success': False, 'error': 'Team not found or access denied', 'status_code': 404}

            self.teamRepository.delete(teamId)

            return {'success': True, 'message': 'Team deleted successfully', 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    def agents(self, request, id: int = 0) -> dict:
        """GET /api/v1/teams/{id}/agents. List all agents in a team with pipeline info. PHP 314-372.

        Pipeline info includes:
        - pipeline_position: Position in execution order (None for managers)
        - pipeline_label: Human-readable label (e.g., "Step 1 of 3")
        - can_reorder: Whether agent can be reordered (managers always stay at top)
        """
        userId = request['user_id'] if request.get('user_id') is not None else 0
        teamId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if not teamId:
            return {'success': False, 'error': 'Team ID is required', 'status_code': 400}

        try:
            # Check access
            if not self.teamRepository.canUserAccess(userId, teamId):
                return {'success': False, 'error': 'Team not found or access denied', 'status_code': 404}

            # Get agents with pipeline info
            agentsWithInfo = self.agentRepository.findByTeamIdWithPipelineInfo(teamId)

            # Format response
            agentsList = []
            for item in agentsWithInfo:
                agentData = item['agent'].toApiArray()
                agentData['pipeline_position'] = item['pipeline_position']
                agentData['pipeline_label'] = item['pipeline_label']
                agentData['is_pipeline_head'] = item['is_pipeline_head']
                agentData['is_pipeline_tail'] = item['is_pipeline_tail']
                agentData['can_reorder'] = item['can_reorder']
                agentsList.append(agentData)

            return {'success': True, 'data': agentsList, 'count': len(agentsList), 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}
