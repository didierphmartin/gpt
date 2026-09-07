"""Port of backend/src/AgentTeam/Models/Team.php.

Represents a team that groups agents together.
"""
from __future__ import annotations

from app.support.phpcompat import php_intval


class Team:
    def __init__(self, data: dict | None = None):
        """PHP: `if (!empty($data)) { $this->hydrate($data); }`."""
        self.id: int | None = None
        self.userId: int = 0
        self.workspaceId: int | None = None
        self.name: str = ''
        self.description: str = ''
        self.createdAt: str | None = None
        self.updatedAt: str | None = None

        # Related agents (loaded separately)
        self.agents: list = []

        # Agents with pipeline info (position, labels, etc.)
        self.agentsWithPipelineInfo: list = []

        if data:
            self.hydrate(data)

    def hydrate(self, data: dict) -> 'Team':
        self.id = php_intval(data['id']) if data.get('id') is not None else None
        self.userId = php_intval(data['user_id']) if data.get('user_id') is not None else 0
        self.workspaceId = php_intval(data['workspace_id']) if data.get('workspace_id') is not None else None
        self.name = data.get('name') if data.get('name') is not None else ''
        self.description = data.get('description') if data.get('description') is not None else ''
        self.createdAt = data.get('created_at') if data.get('created_at') is not None else None
        self.updatedAt = data.get('updated_at') if data.get('updated_at') is not None else None

        return self

    def toArray(self) -> dict:
        return {
            'id': self.id,
            'user_id': self.userId,
            'workspace_id': self.workspaceId,
            'name': self.name,
            'description': self.description,
            'created_at': self.createdAt,
            'updated_at': self.updatedAt,
        }

    def toArrayWithAgents(self) -> dict:
        data = self.toArray()

        # If we have agents with pipeline info, use that
        if self.agentsWithPipelineInfo:
            agents = []
            for item in self.agentsWithPipelineInfo:
                agent_data = item['agent'].toApiArray()
                agent_data['pipeline_position'] = item['pipeline_position']
                agent_data['pipeline_label'] = item['pipeline_label']
                agent_data['is_pipeline_head'] = item['is_pipeline_head']
                agent_data['is_pipeline_tail'] = item['is_pipeline_tail']
                agent_data['can_reorder'] = item['can_reorder']
                agents.append(agent_data)
            data['agents'] = agents
        else:
            # Fallback to basic agents array
            data['agents'] = [agent.toApiArray() for agent in self.agents]

        return data

    def toApiArray(self) -> dict:
        return {
            'id': self.id,
            'name': self.name,
            'description': self.description,
            'created_at': self.createdAt,
        }

    # ========================================
    # Getters
    # ========================================

    def getId(self) -> int | None:
        return self.id

    def getUserId(self) -> int:
        return self.userId

    def getWorkspaceId(self) -> int | None:
        return self.workspaceId

    def getName(self) -> str:
        return self.name

    def getDescription(self) -> str:
        return self.description

    def getCreatedAt(self) -> str | None:
        return self.createdAt

    def getUpdatedAt(self) -> str | None:
        return self.updatedAt

    def getAgents(self) -> list:
        return self.agents

    # ========================================
    # Setters (Fluent Interface)
    # ========================================

    def setId(self, id: int) -> 'Team':
        self.id = id
        return self

    def setUserId(self, user_id: int) -> 'Team':
        self.userId = user_id
        return self

    def setWorkspaceId(self, workspace_id: int | None) -> 'Team':
        self.workspaceId = workspace_id
        return self

    def setName(self, name: str) -> 'Team':
        self.name = name
        return self

    def setDescription(self, description: str) -> 'Team':
        self.description = description
        return self

    def setAgents(self, agents: list) -> 'Team':
        self.agents = agents
        return self

    def setAgentsWithPipelineInfo(self, agents_with_info: list) -> 'Team':
        """agentsWithInfo: list of {'agent': Agent, 'pipeline_position': int|None, ...}."""
        self.agentsWithPipelineInfo = agents_with_info

        # Also populate basic agents array for backwards compatibility
        self.agents = [item['agent'] for item in agents_with_info]

        return self

    def getAgentsWithPipelineInfo(self) -> list:
        return self.agentsWithPipelineInfo
