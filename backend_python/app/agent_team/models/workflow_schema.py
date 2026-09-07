"""Port of backend/src/AgentTeam/Models/WorkflowSchema.php.

Represents a reusable JSON Schema definition that can be attached to
agent workflow nodes for constrained decoding (structured outputs).

Stored in the workflow_schemas table.
"""
from __future__ import annotations

import json
import re

from app.support.phpcompat import php_array, php_bool, php_empty, php_intval

_NAME_RE = re.compile(r'^[a-zA-Z0-9_\-]+$')


def _decode_json(value):
    """Mirror WorkflowSchema::decodeJson (PHP 47-54)."""
    if isinstance(value, str) and value != '':
        try:
            decoded = json.loads(value)
        except ValueError:
            decoded = None
        return decoded if isinstance(decoded, (list, dict)) else []
    return value if isinstance(value, (list, dict)) else []


class WorkflowSchema:
    def __init__(self, data: dict | None = None):
        """PHP: `if (!empty($data)) { $this->hydrate($data); }`."""
        self.id: int | None = None
        self.userId: int = 0
        self.name: str = ''
        self.description: str = ''
        self.schemaJson: list = []
        self.strict: bool = True
        self.createdAt: str | None = None
        self.updatedAt: str | None = None

        if data:
            self.hydrate(data)

    def hydrate(self, data: dict) -> 'WorkflowSchema':
        self.id = php_intval(data['id']) if data.get('id') is not None else None
        self.userId = php_intval(data['user_id']) if data.get('user_id') is not None else 0
        self.name = data.get('name') if data.get('name') is not None else ''
        self.description = data.get('description') if data.get('description') is not None else ''
        schema_json = data.get('schema_json')
        self.schemaJson = _decode_json(schema_json if schema_json is not None else [])
        strict = data.get('strict')
        self.strict = php_bool(strict if strict is not None else True)
        self.createdAt = data.get('created_at') if data.get('created_at') is not None else None
        self.updatedAt = data.get('updated_at') if data.get('updated_at') is not None else None

        return self

    def toArray(self) -> dict:
        return {
            'id': self.id,
            'user_id': self.userId,
            'name': self.name,
            'description': self.description,
            'schema_json': php_array(self.schemaJson),
            'strict': self.strict,
            'created_at': self.createdAt,
            'updated_at': self.updatedAt,
        }

    def toApiArray(self) -> dict:
        return {
            'id': self.id,
            'name': self.name,
            'description': self.description,
            'schema_json': php_array(self.schemaJson),
            'strict': self.strict,
            'created_at': self.createdAt,
            'updated_at': self.updatedAt,
        }

    def toOutputSchema(self) -> dict:
        """Build the canonical "output_schema" structure that gets passed
        to providers for constrained decoding."""
        return {
            'name': self.name,
            'description': self.description,
            'strict': self.strict,
            'schema': php_array(self.schemaJson),
        }

    def validate(self) -> list:
        """Validate that schema_json is a non-empty JSON Schema-like structure.
        Returns list of error messages (empty = valid)."""
        errors = []

        if self.name == '':
            errors.append('Schema name is required')
        if not _NAME_RE.match(self.name):
            errors.append('Schema name must contain only letters, numbers, dashes and underscores')
        if php_empty(self.schemaJson):
            errors.append('schema_json is required')
        else:
            schema = self.schemaJson if isinstance(self.schemaJson, dict) else {}
            schema_type = schema.get('type')
            if schema_type != 'object':
                errors.append('Top-level schema type must be "object"')
            properties = schema.get('properties')
            if properties is None or not isinstance(properties, (list, dict)):
                errors.append('Schema must have a "properties" object')

        return errors

    # Getters
    def getId(self) -> int | None:
        return self.id

    def getUserId(self) -> int:
        return self.userId

    def getName(self) -> str:
        return self.name

    def getDescription(self) -> str:
        return self.description

    def getSchemaJson(self) -> list:
        return self.schemaJson

    def isStrict(self) -> bool:
        return self.strict

    # Setters
    def setId(self, id: int | None) -> 'WorkflowSchema':
        self.id = id
        return self

    def setUserId(self, user_id: int) -> 'WorkflowSchema':
        self.userId = user_id
        return self

    def setName(self, name: str) -> 'WorkflowSchema':
        self.name = name
        return self

    def setDescription(self, description: str) -> 'WorkflowSchema':
        self.description = description
        return self

    def setSchemaJson(self, schema_json: dict) -> 'WorkflowSchema':
        self.schemaJson = schema_json
        return self

    def setStrict(self, strict: bool) -> 'WorkflowSchema':
        self.strict = strict
        return self
