"""Port of backend/src/AgentTeam/Models/Workflow.php.

Represents a multi-step automated workflow that orchestrates agents.
"""
from __future__ import annotations

import json
import re

from app.support.phpcompat import php_array, php_bool, php_empty, php_intval, php_strval

_VAR_PATTERN = re.compile(r'\{\{(\w+)\}\}', re.ASCII)
_VALID_STEP_TYPES = ('agent', 'condition', 'transform')


def _decode_json(value):
    """Mirror Workflow::decodeJson (PHP 72-79) — identical to Agent::decodeJson."""
    if isinstance(value, str) and not php_empty(value):
        try:
            decoded = json.loads(value)
        except ValueError:
            decoded = None
        return decoded if isinstance(decoded, (list, dict)) else []
    return value if isinstance(value, (list, dict)) else []


def _iter_indexed(steps):
    """`foreach ($this->steps as $index => $step)` over a JSON-decoded PHP array:
    a JSON list -> (0, 1, 2, ...) indices, a JSON object -> its string keys."""
    if isinstance(steps, dict):
        return steps.items()
    return enumerate(steps)


def _step_dict(step) -> dict:
    """A step that isn't itself an array/object behaves like PHP accessing an
    offset on a non-array (undefined -> null for every key)."""
    return step if isinstance(step, dict) else {}


class Workflow:
    def __init__(self, data: dict | None = None):
        """PHP: `if (!empty($data)) { $this->hydrate($data); }`."""
        self.id: int | None = None
        self.userId: int = 0
        self.workspaceId: int | None = None
        self.name: str = ''
        self.description: str = ''
        self.steps: list = []
        self.triggers: list = []
        self.variables: list = []
        self.enabled: bool = True
        self.createdAt: str | None = None
        self.updatedAt: str | None = None

        # Output storage settings
        self.outputStorageEnabled: bool = False
        self.outputFolder: str | None = None

        # Graph structure (normalized nodes/edges from database)
        self.graph: dict | None = None

        if data:
            self.hydrate(data)

    def hydrate(self, data: dict) -> 'Workflow':
        self.id = php_intval(data['id']) if data.get('id') is not None else None
        self.userId = php_intval(data['user_id']) if data.get('user_id') is not None else 0
        self.workspaceId = php_intval(data['workspace_id']) if data.get('workspace_id') is not None else None
        self.name = data.get('name') if data.get('name') is not None else ''
        self.description = data.get('description') if data.get('description') is not None else ''
        steps = data.get('steps')
        self.steps = _decode_json(steps if steps is not None else [])
        triggers = data.get('triggers')
        self.triggers = _decode_json(triggers if triggers is not None else [])
        variables = data.get('variables')
        self.variables = _decode_json(variables if variables is not None else [])
        enabled = data.get('enabled')
        self.enabled = php_bool(enabled if enabled is not None else True)
        self.createdAt = data.get('created_at') if data.get('created_at') is not None else None
        self.updatedAt = data.get('updated_at') if data.get('updated_at') is not None else None

        # Output storage settings
        output_storage_enabled = data.get('output_storage_enabled')
        self.outputStorageEnabled = php_bool(output_storage_enabled if output_storage_enabled is not None else False)
        self.outputFolder = data.get('output_folder') if data.get('output_folder') is not None else None

        return self

    def toArray(self) -> dict:
        data = {
            'id': self.id,
            'user_id': self.userId,
            'workspace_id': self.workspaceId,
            'name': self.name,
            'description': self.description,
            'steps': php_array(self.steps),
            'triggers': php_array(self.triggers),
            'variables': php_array(self.variables),
            'enabled': self.enabled,
            'created_at': self.createdAt,
            'updated_at': self.updatedAt,
            'output_storage_enabled': self.outputStorageEnabled,
            'output_folder': self.outputFolder,
        }

        # Include graph if available
        if self.graph is not None:
            data['graph'] = self.graph

        return data

    def toApiArray(self) -> dict:
        data = {
            'id': self.id,
            'name': self.name,
            'description': self.description,
            'steps': php_array(self.steps),
            'triggers': php_array(self.triggers),
            'variables': php_array(self.variables),
            'enabled': self.enabled,
            'created_at': self.createdAt,
            'output_storage_enabled': self.outputStorageEnabled,
            'output_folder': self.outputFolder,
            'schedule_enabled': self.isScheduleEnabled(),  # Computed from triggers
            'runtime_mode': self._detectRuntimeMode(),
        }

        # Include graph if available
        if self.graph is not None:
            data['graph'] = self.graph

        return data

    def _detectRuntimeMode(self) -> str:
        """Infer runtime mode ('realtime' or 'batch') from loaded graph node types.
        Falls back to 'batch' when no graph is loaded."""
        nodes = self.graph.get('nodes') if self.graph is not None else None
        if nodes is None:
            nodes = []
        for n in nodes:
            n = n if isinstance(n, dict) else {}
            config = n.get('config')
            config = config if isinstance(config, dict) else None
            node_type = n.get('type')
            if node_type is None:
                node_type = n.get('node_type')
            if node_type is None:
                node_type = config.get('type') if config is not None else None
            if node_type is None:
                node_type = ''
            if isinstance(node_type, str) and node_type.startswith('realtime-'):
                return 'realtime'
            runtime_mode = config.get('runtime_mode') if config is not None else None
            if runtime_mode == 'realtime':
                return 'realtime'
        return 'batch'

    def validateSteps(self) -> list:
        errors = []

        if php_empty(self.steps):
            errors.append('Workflow must have at least one step')
            return errors

        for index, step in _iter_indexed(self.steps):
            step = _step_dict(step)
            if php_empty(step.get('id')):
                errors.append(f"Step {index}: missing 'id'")
            if php_empty(step.get('type')):
                errors.append(f"Step {index}: missing 'type'")
            step_type = step.get('type')
            step_type_str = step_type if step_type is not None else ''
            if step_type_str not in _VALID_STEP_TYPES:
                errors.append(f"Step {index}: invalid type '{php_strval(step_type)}'")

        return errors

    def getStep(self, step_id: str) -> dict | None:
        for _, step in _iter_indexed(self.steps):
            sid = _step_dict(step).get('id')
            sid = sid if sid is not None else ''
            if sid == step_id:
                return step
        return None

    def getDependentSteps(self, step_id: str) -> list:
        dependents = []
        for _, step in _iter_indexed(self.steps):
            depends_on = _step_dict(step).get('depends_on')
            depends_on = depends_on if depends_on is not None else []
            if step_id in depends_on:
                dependents.append(step)
        return dependents

    def getEntrySteps(self) -> list:
        entry_steps = []
        for _, step in _iter_indexed(self.steps):
            if php_empty(_step_dict(step).get('depends_on')):
                entry_steps.append(step)
        return entry_steps

    def interpolateVariables(self, template: str, context: dict | None = None) -> str:
        context = context if context is not None else {}
        variables = self.variables if isinstance(self.variables, dict) else {}
        all_vars = {**variables, **context}

        def _replace(match: re.Match) -> str:
            key = match.group(1)
            value = all_vars.get(key)
            if key in all_vars and value is not None:
                return php_strval(value)
            return match.group(0)

        return _VAR_PATTERN.sub(_replace, template)

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

    def getSteps(self) -> list:
        return self.steps

    def getTriggers(self) -> list:
        return self.triggers

    def getVariables(self) -> list:
        return self.variables

    def isEnabled(self) -> bool:
        return self.enabled

    def getCreatedAt(self) -> str | None:
        return self.createdAt

    def getUpdatedAt(self) -> str | None:
        return self.updatedAt

    def isOutputStorageEnabled(self) -> bool:
        return self.outputStorageEnabled

    def getOutputFolder(self) -> str | None:
        return self.outputFolder

    def isScheduleEnabled(self) -> bool:
        """Check if workflow has scheduling enabled (from triggers JSON).
        When schedule is enabled, document attachments must use remote storage."""
        schedule = self.triggers.get('schedule') if isinstance(self.triggers, dict) else None
        enabled = schedule.get('enabled') if isinstance(schedule, dict) else None
        return not php_empty(enabled)

    def getScheduleConfig(self) -> dict | None:
        if isinstance(self.triggers, dict):
            return self.triggers.get('schedule')
        return None

    # ========================================
    # Setters (Fluent Interface)
    # ========================================

    def setId(self, id: int) -> 'Workflow':
        self.id = id
        return self

    def setUserId(self, user_id: int) -> 'Workflow':
        self.userId = user_id
        return self

    def setWorkspaceId(self, workspace_id: int | None) -> 'Workflow':
        self.workspaceId = workspace_id
        return self

    def setName(self, name: str) -> 'Workflow':
        self.name = name
        return self

    def setDescription(self, description: str) -> 'Workflow':
        self.description = description
        return self

    def setSteps(self, steps: list) -> 'Workflow':
        self.steps = steps
        return self

    def setTriggers(self, triggers: dict) -> 'Workflow':
        self.triggers = triggers
        return self

    def setVariables(self, variables: dict) -> 'Workflow':
        self.variables = variables
        return self

    def setEnabled(self, enabled: bool) -> 'Workflow':
        self.enabled = enabled
        return self

    def setOutputStorageEnabled(self, enabled: bool) -> 'Workflow':
        self.outputStorageEnabled = enabled
        return self

    def setOutputFolder(self, folder: str | None) -> 'Workflow':
        self.outputFolder = folder
        return self

    # ========================================
    # Graph Data (Nodes & Edges)
    # ========================================

    def getGraph(self) -> dict | None:
        return self.graph

    def setGraph(self, graph: dict | None) -> 'Workflow':
        self.graph = graph
        return self

    def hasGraph(self) -> bool:
        if self.graph is None:
            return False
        return not php_empty(self.graph.get('nodes'))
