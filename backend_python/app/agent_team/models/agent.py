"""Port of backend/src/AgentTeam/Models/Agent.php.

Represents an AI agent with its configuration, tools, and settings.
Supports three types: standard, manager, and worker.
"""
from __future__ import annotations

import json

from app.support.phpcompat import php_array, php_bool, php_empty, php_intval, php_strval


def _decode_json(value):
    """Mirror Agent::decodeJson (PHP 96-103): a non-empty string is JSON-decoded
    (invalid JSON / non-array result -> []); anything else passes through if it
    is already an array (dict/list), else []."""
    if isinstance(value, str) and not php_empty(value):
        try:
            decoded = json.loads(value)
        except ValueError:
            decoded = None
        return decoded if isinstance(decoded, (list, dict)) else []
    return value if isinstance(value, (list, dict)) else []


AGENT_TYPES = ('standard', 'manager', 'worker', 'dispatcher', 'playbook')
VISIBILITIES = ('personal', 'workspace', 'public')


class Agent:
    def __init__(self, data: dict | None = None):
        """PHP: `if (!empty($data)) { $this->hydrate($data); }` — an empty/None
        dict leaves every field at its declared default (below), never calling
        hydrate at all."""
        self.id: int | None = None
        self.userId: int = 0
        self.teamId: int | None = None
        self.category: str | None = None
        self.name: str = ''
        self.description: str = ''

        self.agentType: str = 'standard'
        self.parentAgentId: int | None = None
        self.canDelegateTo: list = []
        self.displayOrder: int = 0

        self.provider: str = 'claude'
        self.model: str | None = None
        self.instructions: str = ''

        self.tools: list = []

        self.visibility: str = 'personal'
        self.enabled: bool = True

        self.settings: dict | list = []

        self.createdAt: str | None = None
        self.updatedAt: str | None = None

        if data:
            self.hydrate(data)

    def hydrate(self, data: dict) -> 'Agent':
        self.id = php_intval(data['id']) if data.get('id') is not None else None
        self.userId = php_intval(data['user_id']) if data.get('user_id') is not None else 0
        self.teamId = php_intval(data['team_id']) if data.get('team_id') is not None else None
        category = data.get('category')
        self.category = php_strval(category) if (category is not None and category != '') else None
        self.name = data.get('name') if data.get('name') is not None else ''
        self.description = data.get('description') if data.get('description') is not None else ''

        self.agentType = data.get('agent_type') if data.get('agent_type') is not None else 'standard'
        self.parentAgentId = php_intval(data['parent_agent_id']) if data.get('parent_agent_id') is not None else None
        can_delegate_to = data.get('can_delegate_to')
        self.canDelegateTo = _decode_json(can_delegate_to if can_delegate_to is not None else [])
        self.displayOrder = php_intval(data['display_order']) if data.get('display_order') is not None else 0

        self.provider = data.get('provider') if data.get('provider') is not None else 'claude'
        self.model = data.get('model') if data.get('model') is not None else None
        self.instructions = data.get('instructions') if data.get('instructions') is not None else ''

        tools = data.get('tools')
        self.tools = _decode_json(tools if tools is not None else [])

        self.visibility = data.get('visibility') if data.get('visibility') is not None else 'personal'
        enabled = data.get('enabled')
        self.enabled = php_bool(enabled if enabled is not None else True)

        settings = data.get('settings')
        self.settings = _decode_json(settings if settings is not None else [])

        self.createdAt = data.get('created_at') if data.get('created_at') is not None else None
        self.updatedAt = data.get('updated_at') if data.get('updated_at') is not None else None

        return self

    def toArray(self) -> dict:
        return {
            'id': self.id,
            'user_id': self.userId,
            'team_id': self.teamId,
            'category': self.category,
            'name': self.name,
            'description': self.description,
            'agent_type': self.agentType,
            'parent_agent_id': self.parentAgentId,
            'can_delegate_to': php_array(self.canDelegateTo),
            'display_order': self.displayOrder,
            'provider': self.provider,
            'model': self.model,
            'instructions': self.instructions,
            'tools': php_array(self.tools),
            'visibility': self.visibility,
            'enabled': self.enabled,
            'settings': php_array(self.settings),
            'created_at': self.createdAt,
            'updated_at': self.updatedAt,
        }

    def toApiArray(self) -> dict:
        return {
            'id': self.id,
            'name': self.name,
            'description': self.description,
            'category': self.category,
            'agent_type': self.agentType,
            'display_order': self.displayOrder,
            'provider': self.provider,
            'model': self.model,
            'instructions': self.instructions,
            'tools': php_array(self.tools),
            'settings': php_array(self.settings),
            'visibility': self.visibility,
            'enabled': self.enabled,
            'created_at': self.createdAt,
        }

    def buildSystemPrompt(self) -> str:
        prompt = f"You are {self.name}."

        if not php_empty(self.description):
            prompt += f"\n\n{self.description}"

        if not php_empty(self.instructions):
            prompt += f"\n\n## Instructions\n{self.instructions}"

        if self.isManager():
            prompt += "\n\n## Agent Capabilities\n"
            prompt += "You are a manager agent with the ability to delegate tasks to specialized worker agents.\n"
            prompt += "Use the `list_available_agents` tool to see your team.\n"
            prompt += "Use `delegate_to_agent` to assign tasks to specific agents.\n"
            prompt += "Use `run_agents_parallel` to run multiple agents simultaneously."

        return prompt

    def isManager(self) -> bool:
        return self.agentType == 'manager'

    def isWorker(self) -> bool:
        return self.agentType == 'worker'

    def isStandard(self) -> bool:
        return self.agentType == 'standard'

    def canDelegateToAgent(self, agent_id: int) -> bool:
        if not self.isManager():
            return False

        # Empty array means can delegate to any agent
        if php_empty(self.canDelegateTo):
            return True

        return agent_id in self.canDelegateTo

    def isAccessibleBy(self, user_id: int) -> bool:
        # Owner always has access
        if self.userId == user_id:
            return True

        # Public agents are accessible to all
        if self.visibility == 'public':
            return True

        return False

    def getSetting(self, key: str, default=None):
        if isinstance(self.settings, dict):
            value = self.settings.get(key)
            return value if value is not None else default
        return default

    def setSetting(self, key: str, value) -> 'Agent':
        if not isinstance(self.settings, dict):
            self.settings = {}
        self.settings[key] = value
        return self

    # ========================================
    # Getters
    # ========================================

    def getId(self) -> int | None:
        return self.id

    def getUserId(self) -> int:
        return self.userId

    def getTeamId(self) -> int | None:
        return self.teamId

    def getCategory(self) -> str | None:
        return self.category

    def getName(self) -> str:
        return self.name

    def getDescription(self) -> str:
        return self.description

    def getAgentType(self) -> str:
        return self.agentType

    def getParentAgentId(self) -> int | None:
        return self.parentAgentId

    def getCanDelegateTo(self) -> list:
        return self.canDelegateTo

    def getDisplayOrder(self) -> int:
        return self.displayOrder

    def getProvider(self) -> str:
        return self.provider

    def getModel(self) -> str | None:
        return self.model

    def getInstructions(self) -> str:
        return self.instructions

    def getTools(self) -> list:
        return self.tools

    def getVisibility(self) -> str:
        return self.visibility

    def isEnabled(self) -> bool:
        return self.enabled

    def getSettings(self) -> dict:
        return self.settings

    def getCreatedAt(self) -> str | None:
        return self.createdAt

    def getUpdatedAt(self) -> str | None:
        return self.updatedAt

    # ========================================
    # Setters (Fluent Interface)
    # ========================================

    def setId(self, id: int) -> 'Agent':
        self.id = id
        return self

    def setUserId(self, user_id: int) -> 'Agent':
        self.userId = user_id
        return self

    def setTeamId(self, team_id: int | None) -> 'Agent':
        self.teamId = team_id
        return self

    def setCategory(self, category: str | None) -> 'Agent':
        self.category = None if (category is None or category == '') else category
        return self

    def setName(self, name: str) -> 'Agent':
        self.name = name
        return self

    def setDescription(self, description: str) -> 'Agent':
        self.description = description
        return self

    def setAgentType(self, agent_type: str) -> 'Agent':
        if agent_type not in AGENT_TYPES:
            raise ValueError(f'Invalid agent type: {agent_type}')
        self.agentType = agent_type
        return self

    def setParentAgentId(self, parent_agent_id: int | None) -> 'Agent':
        self.parentAgentId = parent_agent_id
        return self

    def setCanDelegateTo(self, agent_ids: list) -> 'Agent':
        self.canDelegateTo = [php_intval(a) for a in agent_ids]
        return self

    def setProvider(self, provider: str) -> 'Agent':
        self.provider = provider
        return self

    def setModel(self, model: str | None) -> 'Agent':
        self.model = model
        return self

    def setInstructions(self, instructions: str) -> 'Agent':
        self.instructions = instructions
        return self

    def setTools(self, tools: list) -> 'Agent':
        self.tools = tools
        return self

    def addTool(self, tool: str) -> 'Agent':
        if tool not in self.tools:
            self.tools.append(tool)
        return self

    def removeTool(self, tool: str) -> 'Agent':
        self.tools = [t for t in self.tools if t != tool]
        return self

    def setDisplayOrder(self, order: int) -> 'Agent':
        self.displayOrder = order
        return self

    def setVisibility(self, visibility: str) -> 'Agent':
        if visibility not in VISIBILITIES:
            raise ValueError(f'Invalid visibility: {visibility}')
        self.visibility = visibility
        return self

    def setEnabled(self, enabled: bool) -> 'Agent':
        self.enabled = enabled
        return self

    def setSettings(self, settings: dict) -> 'Agent':
        self.settings = settings
        return self
