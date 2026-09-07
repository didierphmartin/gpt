"""Port of backend/src/AgentTeam/Controllers/WorkflowSchemaController.php.

Workflow Schema Controller

REST endpoints for managing reusable JSON Schemas used by workflow
agent nodes for constrained decoding (structured outputs).
"""
from __future__ import annotations

from app.agent_team.models.workflow_schema import WorkflowSchema
from app.agent_team.services.workflow_schema_repository import WorkflowSchemaRepository
from app.support.phpcompat import is_php_array, php_bool, php_intval, php_strval


class WorkflowSchemaController:
    def __init__(self, db, config):
        self.db = db
        self.config = config
        self.repository = WorkflowSchemaRepository(db)

    def index(self, request) -> dict:
        """GET /api/v1/workflow-schemas. PHP 33-51."""
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        if not userId:
            return self.error('Authentication required', 401)

        try:
            schemas = self.repository.findByUser(userId)
            return {
                'success': True,
                'data': [s.toApiArray() for s in schemas],
                'count': len(schemas),
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001 -- mirrors PHP `catch (\Throwable $e)`
            return self.error(str(e), 500)

    def show(self, request, id: int = 0) -> dict:
        """GET /api/v1/workflow-schemas/{id}. PHP 56-78."""
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        schemaId = php_intval(id)

        if not userId:
            return self.error('Authentication required', 401)

        try:
            schema = self.repository.findById(schemaId)
            if not schema or schema.getUserId() != userId:
                return self.error('Schema not found', 404)
            return {'success': True, 'data': schema.toApiArray(), 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return self.error(str(e), 500)

    def create(self, request) -> dict:
        """POST /api/v1/workflow-schemas. Body: { name, description, schema_json, strict }. PHP 84-128."""
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        body = request['body'] if request.get('body') is not None else {}

        if not userId:
            return self.error('Authentication required', 401)

        try:
            schema = WorkflowSchema()
            schema.setUserId(userId) \
                  .setName(php_strval(body['name'] if body.get('name') is not None else '')) \
                  .setDescription(php_strval(body['description'] if body.get('description') is not None else '')) \
                  .setSchemaJson(body['schema_json'] if is_php_array(body.get('schema_json')) else []) \
                  .setStrict(php_bool(body['strict'] if body.get('strict') is not None else True))

            errors = schema.validate()
            if errors:
                return {
                    'success': False,
                    'error': 'Invalid schema',
                    'validation_errors': errors,
                    'status_code': 400,
                }

            # Enforce unique name per user
            existing = self.repository.findByName(userId, schema.getName())
            if existing:
                return self.error(f"A schema named '{schema.getName()}' already exists", 409)

            created = self.repository.create(schema)

            return {
                'success': True,
                'data': created.toApiArray(),
                'message': 'Schema created',
                'status_code': 201,
            }
        except Exception as e:  # noqa: BLE001
            return self.error(str(e), 500)

    def update(self, request, id: int = 0) -> dict:
        """PUT /api/v1/workflow-schemas/{id}. PHP 133-183."""
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        schemaId = php_intval(id)
        body = request['body'] if request.get('body') is not None else {}

        if not userId:
            return self.error('Authentication required', 401)

        try:
            schema = self.repository.findById(schemaId)
            if not schema or schema.getUserId() != userId:
                return self.error('Schema not found', 404)

            if 'name' in body:
                schema.setName(php_strval(body['name']))
            if 'description' in body:
                schema.setDescription(php_strval(body['description']))
            if 'schema_json' in body and is_php_array(body['schema_json']):
                schema.setSchemaJson(body['schema_json'])
            if 'strict' in body:
                schema.setStrict(php_bool(body['strict']))

            errors = schema.validate()
            if errors:
                return {
                    'success': False,
                    'error': 'Invalid schema',
                    'validation_errors': errors,
                    'status_code': 400,
                }

            # If renamed, check uniqueness
            sameName = self.repository.findByName(userId, schema.getName())
            if sameName and sameName.getId() != schema.getId():
                return self.error(f"A schema named '{schema.getName()}' already exists", 409)

            self.repository.update(schema)

            return {
                'success': True,
                'data': schema.toApiArray(),
                'message': 'Schema updated',
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return self.error(str(e), 500)

    def destroy(self, request, id: int = 0) -> dict:
        """DELETE /api/v1/workflow-schemas/{id}. PHP 188-211."""
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        schemaId = php_intval(id)

        if not userId:
            return self.error('Authentication required', 401)

        try:
            schema = self.repository.findById(schemaId)
            if not schema or schema.getUserId() != userId:
                return self.error('Schema not found', 404)
            self.repository.delete(schemaId, userId)
            return {'success': True, 'message': 'Schema deleted', 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return self.error(str(e), 500)

    @staticmethod
    def error(message: str, status: int) -> dict:
        return {'success': False, 'error': message, 'status_code': status}
