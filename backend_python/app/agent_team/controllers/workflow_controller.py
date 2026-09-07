"""Port of backend/src/AgentTeam/Controllers/WorkflowController.php (1957 lines).

Workflow Controller — data/CRUD paths only (Phase 4, Task 6). The following
PHP methods raise `NotImplementedError('Phase 5/6')` below and are NOT wired
into app/routes.py: `generatePython`, `generateAdk`, `generateMaf`,
`generateNooa` (code generators — separate compiler classes, out of scope),
`run`, `runByName`, `runStream`, `runPlaybookNode` (workflow execution —
depend on AgentRunner/GraphWorkflowRunner/PlaybookNodeRunner, none ported
yet), `toolResult` (depends on SkillToolBridge, execution-only).

Ported: `index`, `create`, `show`, `update`, `destroy`, `executions`,
`runEvents`, `toggle`, `duplicate`, `listOutputs`, `getOutput`,
`uploadNodeDocument`, `saveDocumentMetadata`, `listNodeDocuments`,
`deleteNodeDocument`, and the private helpers `getUniversalFSAdapter` (->
None, universalFS is PHP-only, not ported — same ruling as
WorkflowOutputStorage.getUniversalFSClient), `getUserStorageProvider`,
`getUserStorageFolder`, `getLocalStoragePath` (PHP 1843-1847 — dead code:
grep confirms no other WorkflowController method calls it; ported anyway
per the task brief's explicit method list), `detectMimeType`,
`guessMimeTypeFromExtension`, `isAllowedMimeType`, `sanitizeFilename`,
`getUploadErrorMessage`.

`executions` (PHP 1095-1144) calls `$this->workflowRunner->getExecutionHistory()`
(WorkflowRunner.php 403-413), a pure `SELECT ... LIMIT ? OFFSET ?` with no
dependency on the rest of WorkflowRunner (LLM/tool execution, Phase 5/6 out
of scope) — inlined here directly, same precedent as
agent_controller.py:397-400 (AgentController.executions inlining
AgentRunner::getExecutionHistory for the identical reason).

Upload field name: PHP reads `$_FILES['file']` (WorkflowController.php:1440,
1445), i.e. `request['files']['file']` here — verified against both the PHP
source and the frontend's FormData.append('file', file) call
(frontend/assets/js/workflow-editor.js:7239, uploadDocumentToNode).
"""
from __future__ import annotations

import os
import re

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.workflow_output_storage import WorkflowOutputStorage
from app.agent_team.services.workflow_repository import WorkflowRepository
from app.agent_team.services.workflow_run_log import WorkflowRunLog
from app.config import PHP_BACKEND
from app.controllers.chat_attachment_controller import ChatAttachmentController as _ChatAttachmentController
from app.support.logger import error_log
from app.support.phpcompat import (
    is_php_array,
    php_bool,
    php_date,
    php_empty,
    php_intval,
    php_strval,
    php_trim,
    php_uniqid,
)

_RUN_ID_RE = re.compile(r'^[a-f0-9]{32}$')


def _nested_get(d, *keys):
    """`$body[k1][k2] ?? null`-style chained lookup: returns None as soon as
    any intermediate value isn't itself a dict, exactly like PHP's array
    offset access returning null off a non-array."""
    cur = d
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def _node_config(node: dict) -> dict:
    """`$node['config'] ?? []`, coerced to a dict. WorkflowGraphRepository
    already JSON-decodes `config` (php_json_decode), so in practice this is
    always a dict or `[]`/None; a JSON array config is not a real-world
    shape for a node (nodes are always JSON objects), so it's normalized to
    `{}` here rather than round-tripped as a PHP mixed-type array."""
    config = node.get('config') if node else None
    return config if isinstance(config, dict) else {}


def _config_documents(config: dict) -> list:
    documents = config.get('documents')
    return documents if isinstance(documents, list) else []


_UPLOAD_ERR_MESSAGES = {
    1: 'File exceeds server upload limit',     # UPLOAD_ERR_INI_SIZE
    2: 'File exceeds form upload limit',       # UPLOAD_ERR_FORM_SIZE
    3: 'File was only partially uploaded',     # UPLOAD_ERR_PARTIAL
    4: 'No file was uploaded',                 # UPLOAD_ERR_NO_FILE
    6: 'Missing temporary folder',             # UPLOAD_ERR_NO_TMP_DIR
    7: 'Failed to write file to disk',         # UPLOAD_ERR_CANT_WRITE
    8: 'File upload stopped by extension',     # UPLOAD_ERR_EXTENSION
}

_EXT_MIME_MAP = {
    'txt': 'text/plain', 'md': 'text/markdown', 'html': 'text/html', 'htm': 'text/html',
    'css': 'text/css', 'js': 'application/javascript', 'json': 'application/json',
    'xml': 'application/xml', 'pdf': 'application/pdf', 'png': 'image/png',
    'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'webp': 'image/webp',
    'csv': 'text/csv', 'php': 'text/x-php', 'py': 'text/x-python', 'java': 'text/x-java',
    'c': 'text/x-c', 'h': 'text/x-c', 'cpp': 'text/x-c++', 'hpp': 'text/x-c++',
    'sql': 'application/sql', 'yaml': 'text/yaml', 'yml': 'text/yaml',
}

_UNSAFE_FILENAME_CHARS_RE = re.compile(r'[^a-zA-Z0-9._-]')


class WorkflowController:
    # PHP 1397-1408
    UNIVERSALFS_PATH = '/Applications/XAMPP/xamppfiles/htdocs/universalfs'
    ROOT_FOLDER = 'synergyaichatroot'
    UNIVERSALFS_USER_ID = 'Synergyaichat'
    MAX_FILE_SIZE = 1024 * 1024  # 1MB

    ALLOWED_MIME_TYPES = frozenset({
        'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/css',
        'application/json', 'application/xml', 'application/pdf',
        'image/png', 'image/jpeg', 'image/gif', 'image/webp',
        'text/x-python', 'text/x-php', 'application/javascript',
        'application/x-httpd-php', 'text/x-java', 'text/x-c', 'text/x-c++',
    })

    def __init__(self, db, config):
        self.db = db
        self.config = config
        self.workflowRepository = WorkflowRepository(db)
        self.graphRepository = self.workflowRepository.getGraphRepository()

    # ========================================================================
    # GET /api/v1/workflows
    # ========================================================================

    def index(self, request) -> dict:
        """PHP 78-122."""
        userId = request['user_id'] if request.get('user_id') is not None else 0

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        try:
            workflows = self.workflowRepository.findByUser(userId, False)

            ids = [w.getId() for w in workflows]
            realtimeIds = self.graphRepository.findRealtimeWorkflowIds(ids)
            realtimeSet = set(realtimeIds)

            data = []
            for workflow in workflows:
                arr = workflow.toApiArray()
                arr['runtime_mode'] = 'realtime' if workflow.getId() in realtimeSet else 'batch'
                data.append(arr)

            return {'success': True, 'data': data, 'count': len(workflows), 'status_code': 200}
        except Exception as e:  # noqa: BLE001 -- mirrors PHP `catch (\Exception $e)`
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # POST /api/v1/workflows
    # ========================================================================

    def create(self, request) -> dict:
        """PHP 128-225."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        body = request['body'] if request.get('body') is not None else {}

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if php_empty(body.get('name')):
            return {'success': False, 'error': 'Workflow name is required', 'status_code': 400}

        hasGraph = (not php_empty(_nested_get(body, 'definition', 'nodes'))
                    or not php_empty(_nested_get(body, 'graph', 'nodes')))
        hasSteps = not php_empty(body.get('steps')) and is_php_array(body.get('steps'))

        try:
            workflow = Workflow()
            workflow.setUserId(userId) \
                    .setName(body['name']) \
                    .setDescription(body['description'] if body.get('description') is not None else '') \
                    .setTriggers(body['triggers'] if body.get('triggers') is not None else []) \
                    .setVariables(body['variables'] if body.get('variables') is not None else []) \
                    .setEnabled(body['enabled'] if body.get('enabled') is not None else True) \
                    .setWorkspaceId(body.get('workspace_id')) \
                    .setOutputStorageEnabled(php_bool(body.get('output_storage_enabled'))) \
                    .setOutputFolder(body.get('output_folder'))

            if hasSteps:
                workflow.setSteps(body['steps'])
                errors = workflow.validateSteps()
                if errors:
                    return {
                        'success': False,
                        'error': 'Invalid workflow steps',
                        'validation_errors': errors,
                        'status_code': 400,
                    }
            else:
                # For graph-based workflows, set empty steps (graph is source of truth)
                workflow.setSteps([])

            created = self.workflowRepository.create(workflow)

            error_log(f'[WorkflowController] Created workflow ID: {created.getId()}')
            error_log(f"[WorkflowController] hasGraph: {'true' if hasGraph else 'false'}")

            if hasGraph:
                graphData = body.get('definition')
                if graphData is None:
                    graphData = body.get('graph')
                if graphData is None:
                    graphData = {}
                nodes = graphData.get('nodes') if isinstance(graphData, dict) else None
                if nodes is None:
                    nodes = graphData.get('steps') if isinstance(graphData, dict) else None
                if nodes is None:
                    nodes = []
                edges = graphData.get('edges') if isinstance(graphData, dict) else None
                if edges is None:
                    edges = []

                error_log(f'[WorkflowController] Saving graph with {len(nodes)} nodes and {len(edges)} edges')

                try:
                    self.graphRepository.saveGraph(created.getId(), nodes, edges)
                    error_log('[WorkflowController] Graph saved successfully')
                except Exception as e:  # noqa: BLE001
                    error_log(f'[WorkflowController] Error saving graph: {e}')
                    raise

                created = self.workflowRepository.findById(created.getId(), True)

            return {
                'success': True,
                'data': created.toArray(),
                'message': 'Workflow created successfully',
                'status_code': 201,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # Code generators (Phase 5/6, not routed) — PHP 240-467
    # ========================================================================

    def generatePython(self, request, id: int = 0) -> dict:
        raise NotImplementedError('Phase 5/6')

    def generateAdk(self, request, id: int = 0) -> dict:
        raise NotImplementedError('Phase 5/6')

    def generateMaf(self, request, id: int = 0) -> dict:
        raise NotImplementedError('Phase 5/6')

    def generateNooa(self, request, id: int = 0) -> dict:
        raise NotImplementedError('Phase 5/6')

    # ========================================================================
    # GET /api/v1/workflows/{id}
    # ========================================================================

    def show(self, request, id: int = 0) -> dict:
        """PHP 473-528."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)
        query = request['query'] if request.get('query') is not None else {}

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if not workflowId:
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}

        try:
            if not self.workflowRepository.canUserAccess(userId, workflowId):
                return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

            includeGraph = (query.get('include_graph') if query.get('include_graph') is not None else 'true') != 'false'
            workflow = self.workflowRepository.findById(workflowId, includeGraph)

            if not workflow:
                return {'success': False, 'error': 'Workflow not found', 'status_code': 404}

            return {'success': True, 'data': workflow.toArray(), 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # PUT /api/v1/workflows/{id}
    # ========================================================================

    def update(self, request, id: int = 0) -> dict:
        """PHP 534-663."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)
        body = request['body'] if request.get('body') is not None else {}

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if not workflowId:
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}

        try:
            if not self.workflowRepository.isOwner(userId, workflowId):
                return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

            workflow = self.workflowRepository.findById(workflowId)

            if not workflow:
                return {'success': False, 'error': 'Workflow not found', 'status_code': 404}

            if body.get('name') is not None:
                workflow.setName(body['name'])
            if body.get('description') is not None:
                workflow.setDescription(body['description'])
            if body.get('steps') is not None:
                workflow.setSteps(body['steps'])
            if body.get('triggers') is not None:
                workflow.setTriggers(body['triggers'])
            if body.get('variables') is not None:
                workflow.setVariables(body['variables'])
            if body.get('enabled') is not None:
                workflow.setEnabled(php_bool(body['enabled']))
            if body.get('workspace_id') is not None:
                workflow.setWorkspaceId(body['workspace_id'])
            if body.get('output_storage_enabled') is not None:
                workflow.setOutputStorageEnabled(php_bool(body['output_storage_enabled']))
            if 'output_folder' in body:
                workflow.setOutputFolder(body['output_folder'])

            hasGraph = (not php_empty(_nested_get(body, 'definition', 'nodes'))
                        or not php_empty(_nested_get(body, 'graph', 'nodes')))

            if body.get('steps') is not None and not hasGraph:
                errors = workflow.validateSteps()
                if errors:
                    return {
                        'success': False,
                        'error': 'Invalid workflow steps',
                        'validation_errors': errors,
                        'status_code': 400,
                    }

            updated = self.workflowRepository.update(workflow)

            error_log(f"[WorkflowController] Update - hasGraph: {'true' if hasGraph else 'false'}")

            if hasGraph:
                graphData = body.get('definition')
                if graphData is None:
                    graphData = body.get('graph')
                if graphData is None:
                    graphData = {}
                nodes = graphData.get('nodes') if isinstance(graphData, dict) else None
                if nodes is None:
                    nodes = graphData.get('steps') if isinstance(graphData, dict) else None
                if nodes is None:
                    nodes = []
                edges = graphData.get('edges') if isinstance(graphData, dict) else None
                if edges is None:
                    edges = []

                error_log(f'[WorkflowController] Updating graph with {len(nodes)} nodes and {len(edges)} edges')

                try:
                    self.graphRepository.saveGraph(workflowId, nodes, edges)
                    error_log('[WorkflowController] Graph updated successfully')
                except Exception as e:  # noqa: BLE001
                    error_log(f'[WorkflowController] Error updating graph: {e}')
                    raise

                updated = self.workflowRepository.findById(workflowId, True)

            return {
                'success': True,
                'data': updated.toArray(),
                'message': 'Workflow updated successfully',
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # DELETE /api/v1/workflows/{id}
    # ========================================================================

    def destroy(self, request, id: int = 0) -> dict:
        """PHP 669-713."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if not workflowId:
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}

        try:
            if not self.workflowRepository.isOwner(userId, workflowId):
                return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

            self.workflowRepository.delete(workflowId)

            return {'success': True, 'message': 'Workflow deleted successfully', 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # Execution endpoints (Phase 5/6, not routed) — PHP 719-1090
    # ========================================================================

    def run(self, request, id: int = 0) -> dict:
        raise NotImplementedError('Phase 5/6')

    def runByName(self, request) -> dict:
        raise NotImplementedError('Phase 5/6')

    def runStream(self, request, id: int = 0) -> None:
        raise NotImplementedError('Phase 5/6')

    def runPlaybookNode(self, request) -> None:
        raise NotImplementedError('Phase 5/6')

    def toolResult(self, request) -> dict:
        raise NotImplementedError('Phase 5/6')

    # ========================================================================
    # GET /api/v1/workflows/{id}/executions
    # ========================================================================

    def executions(self, request, id: int = 0) -> dict:
        """PHP 1095-1144. `getExecutionHistory` is inlined from
        WorkflowRunner::getExecutionHistory (WorkflowRunner.php 403-413) — see
        module docstring."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)
        query = request['query'] if request.get('query') is not None else {}

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if not workflowId:
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}

        try:
            if not self.workflowRepository.canUserAccess(userId, workflowId):
                return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

            limit = php_intval(query['limit']) if query.get('limit') is not None else 50
            offset = php_intval(query['offset']) if query.get('offset') is not None else 0

            executions = self.db.fetch_all(
                "SELECT * FROM agent_workflow_executions\n"
                "             WHERE workflow_id = ?\n"
                "             ORDER BY started_at DESC\n"
                "             LIMIT ? OFFSET ?",
                [workflowId, limit, offset],
            )

            return {'success': True, 'data': executions, 'count': len(executions), 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # GET /api/v1/workflows/runs/{runId}/events
    # ========================================================================

    def runEvents(self, request, runId: str = '') -> dict:
        """PHP 1159-1183. No per-run ownership check by design — see the PHP
        docblock (spec 2026-06-24 SS A5): a run id is an unguessable 128-bit
        token, not enumerable, and every request already passed the login
        auth middleware.

        Reads the run id from `request['params']['runId']` (PHP 1167:
        `(string) ($request['params']['runId'] ?? '')`) rather than trusting
        the positional `runId` argument: main.py's dispatcher (app/main.py,
        outside this task's file scope) runs every route param through
        `php_intval(v) if is_numeric(v) else v` before positional binding,
        and a run id that happens to be all-digit hex (e.g. the differential
        suite's 32-zero id) IS `is_numeric()`-true, so the positional value
        would arrive as the int `0`, not the 32-char string. `ctx['params']`
        is set separately from the raw, unconverted regex-capture strings
        (main.py: `ctx['params'] = dict(route.params)`), so reading from
        there — exactly like PHP reads `$request['params']['runId']` —
        sidesteps the coercion entirely.

        No `status_code` key on ANY branch here — deliberately, matching PHP.
        PHP's `http_response_code($code)` calls in this method (1163, 1169,
        1178) are dead: `backend/index.php:149` computes the actual HTTP
        status purely from `$result['status_code'] ?? 200`, ignoring
        whatever `http_response_code()` the controller already called, and
        `runEvents`'s return arrays never carry a `status_code` key. So this
        endpoint is 200 on EVERY branch on live PHP, including the 401/400/
        404-shaped error bodies — verified live (differential run against
        the Apache-hosted PHP backend, 2026-09-07). `app/support/http.py`'s
        `render()` has the identical `result.get('status_code', 200)`
        default, so omitting the key here reproduces the same behavior."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        if not userId:
            return {'error': 'Authentication required'}

        params = request['params'] if request.get('params') is not None else {}
        runIdStr = php_strval(params['runId'] if params.get('runId') is not None else '')
        if not _RUN_ID_RE.match(runIdStr):
            return {'error': 'Invalid runId'}

        log = WorkflowRunLog(WorkflowRunLog.defaultDir(self.config))
        events = log.read(runIdStr)
        if events is None:
            return {'error': 'Run not found'}

        return {'run_id': runIdStr, 'events': events}

    # ========================================================================
    # POST /api/v1/workflows/{id}/toggle
    # ========================================================================

    def toggle(self, request, id: int = 0) -> dict:
        """PHP 1189-1235."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if not workflowId:
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}

        try:
            if not self.workflowRepository.isOwner(userId, workflowId):
                return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

            self.workflowRepository.toggleEnabled(workflowId)
            workflow = self.workflowRepository.findById(workflowId)

            return {
                'success': True,
                'data': workflow.toApiArray(),
                'message': 'Workflow enabled' if workflow.isEnabled() else 'Workflow disabled',
                'status_code': 200,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # POST /api/v1/workflows/{id}/duplicate
    # ========================================================================

    def duplicate(self, request, id: int = 0) -> dict:
        """PHP 1241-1296."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)
        body = request['body'] if request.get('body') is not None else {}

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if not workflowId:
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}

        try:
            if not self.workflowRepository.canUserAccess(userId, workflowId):
                return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

            newName = body.get('name')
            duplicated = self.workflowRepository.duplicate(workflowId, userId, newName)

            if not duplicated:
                return {'success': False, 'error': 'Failed to duplicate workflow', 'status_code': 500}

            return {
                'success': True,
                'data': duplicated.toArray(),
                'message': 'Workflow duplicated successfully',
                'status_code': 201,
            }
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # GET /api/v1/workflows/{id}/outputs
    # ========================================================================

    def listOutputs(self, request, id: int = 0) -> dict:
        """PHP 1302-1343."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if not workflowId:
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}

        try:
            if not self.workflowRepository.canUserAccess(userId, workflowId):
                return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

            outputStorage = WorkflowOutputStorage(self.db, self.config)
            result = outputStorage.listOutputs(workflowId, userId)

            merged = dict(result)
            merged['status_code'] = 200
            return merged
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # GET /api/v1/workflows/{id}/outputs/{filename}
    # ========================================================================

    def getOutput(self, request, id: int = 0, filename: str = '') -> dict:
        """PHP 1349-1391."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if not workflowId or php_empty(filename):
            return {'success': False, 'error': 'Workflow ID and filename are required', 'status_code': 400}

        try:
            if not self.workflowRepository.canUserAccess(userId, workflowId):
                return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

            outputStorage = WorkflowOutputStorage(self.db, self.config)
            result = outputStorage.getOutput(workflowId, userId, filename)

            merged = dict(result)
            merged['status_code'] = 200 if result.get('success') else 404
            return merged
        except Exception as e:  # noqa: BLE001
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # NODE DOCUMENT ATTACHMENT METHODS — PHP 1393-1761
    # ========================================================================

    def uploadNodeDocument(self, request, id: int = 0, nodeId: int = 0) -> dict:
        """PHP 1414-1539. POST /api/v1/workflows/{id}/nodes/{nodeId}/documents
        (multipart, field `file`). universalFS is never available in this
        port (getUniversalFSAdapter -> None), so every upload that passes
        validation ends at PHP's own 503 'adapter unavailable' branch
        (PHP 1476-1482) — the mkdir/writeStream/config-update code that
        follows it (PHP 1484-1522) is unreachable and not implemented."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)
        nodeIdInt = php_intval(nodeId)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if not workflowId or not nodeIdInt:
            return {'success': False, 'error': 'Workflow ID and Node ID are required', 'status_code': 400}

        if not self.workflowRepository.isOwner(userId, workflowId):
            return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

        node = self.graphRepository.getNode(nodeIdInt)
        if not node or php_intval(node.get('workflow_id')) != workflowId:
            return {'success': False, 'error': 'Node not found', 'status_code': 404}

        files = request['files'] if request.get('files') is not None else {}
        upload = files.get('file')
        if not upload or php_intval(upload.get('error') if upload.get('error') is not None else 4) != 0:
            errorMsg = (self.getUploadErrorMessage(php_intval(upload.get('error')))
                        if upload else 'No file uploaded')
            return {'success': False, 'error': errorMsg, 'status_code': 400}

        # Validate file size
        size = php_intval(upload.get('size') if upload.get('size') is not None else 0)
        if size > self.MAX_FILE_SIZE:
            return {'success': False, 'error': 'File exceeds 1MB limit', 'status_code': 400}

        # Validate MIME type
        tmpName = php_strval(upload.get('tmp_name') if upload.get('tmp_name') is not None else '')
        origName = php_strval(upload.get('name') if upload.get('name') is not None else '')
        mimeType = self.detectMimeType(tmpName, origName)
        if not self.isAllowedMimeType(mimeType):
            return {'success': False, 'error': f'File type not allowed: {mimeType}', 'status_code': 400}

        try:
            # Generate unique document ID / storage path (PHP 1464-1472) — kept
            # for parity even though the adapter check below always 503s, since
            # this mirrors PHP's own call order exactly (a real users-table read
            # happens here on both backends).
            docId = self._uniqidDoc()
            filename = self.sanitizeFilename(origName)
            userFolder = self.getUserStorageFolder(userId)
            storagePath = f'workflow_docs/{workflowId}/{docId}_{filename}'
            fullPath = f'{self.ROOT_FOLDER}/{userFolder}/{storagePath}'

            adapter = self.getUniversalFSAdapter(userId)
            if not adapter:
                return {
                    'success': False,
                    'error': 'Storage system (UniversalFS) not available',
                    'status_code': 503,
                }

            # PHP 1484-1522 (mkdir + writeStream via universalFS, then node
            # config update) is unreachable below this point — adapter is
            # always None here — and is therefore not implemented. Fail loudly
            # instead of falling through and returning None if that ever
            # changes (getUniversalFSAdapter starts returning something truthy)
            # rather than silently mis-behaving.
            raise NotImplementedError(
                'universalFS adapter write path is not ported (Phase 3/4 ruling: '
                'non-local providers are unavailable)'
            )
        except NotImplementedError:
            raise  # fail loudly rather than being swallowed into a 500 dict below
        except Exception as e:  # noqa: BLE001
            error_log(f'[WorkflowController] uploadNodeDocument error: {e}')
            return {'success': False, 'error': f'Failed to upload document: {e}', 'status_code': 500}

    def saveDocumentMetadata(self, request, id: int = 0, nodeId: int = 0) -> dict:
        """PHP 1545-1621. POST .../documents/metadata — for locally stored
        files (File System Access API); no server-side file storage."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)
        nodeIdInt = php_intval(nodeId)
        body = request['body'] if request.get('body') is not None else {}

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if not workflowId or not nodeIdInt:
            return {'success': False, 'error': 'Workflow ID and Node ID are required', 'status_code': 400}

        if not self.workflowRepository.isOwner(userId, workflowId):
            return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

        node = self.graphRepository.getNode(nodeIdInt)
        if not node or php_intval(node.get('workflow_id')) != workflowId:
            return {'success': False, 'error': 'Node not found', 'status_code': 404}

        docData = body.get('document')
        if not docData or php_empty(docData.get('id')) or php_empty(docData.get('name')):
            return {'success': False, 'error': 'Document metadata required (id, name)', 'status_code': 400}

        try:
            document = {
                'id': docData['id'],
                'name': docData['name'],
                'path': docData.get('path'),
                'localUri': docData.get('localUri'),
                'mimeType': docData['mimeType'] if docData.get('mimeType') is not None else 'application/octet-stream',
                'size': docData['size'] if docData.get('size') is not None else 0,
                'storage': 'local',
                'addedAt': docData['addedAt'] if docData.get('addedAt') is not None else php_date('c'),
            }

            config = _node_config(node)
            documents = _config_documents(config)
            documents = documents + [document]
            config = dict(config)
            config['documents'] = documents

            self.graphRepository.updateNode(nodeIdInt, {
                'config': config,
                'node_type': node.get('node_type'),
                'agent_id': node.get('agent_id'),
                'pos_x': node.get('pos_x'),
                'pos_y': node.get('pos_y'),
            })

            return {'success': True, 'document': document, 'message': 'Document metadata saved', 'status_code': 201}
        except Exception as e:  # noqa: BLE001
            error_log(f'[WorkflowController] saveDocumentMetadata error: {e}')
            return {'success': False, 'error': f'Failed to save document metadata: {e}', 'status_code': 500}

    def listNodeDocuments(self, request, id: int = 0, nodeId: int = 0) -> dict:
        """PHP 1627-1660. GET .../documents."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)
        nodeIdInt = php_intval(nodeId)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if not workflowId or not nodeIdInt:
            return {'success': False, 'error': 'Workflow ID and Node ID are required', 'status_code': 400}

        if not self.workflowRepository.canUserAccess(userId, workflowId):
            return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

        node = self.graphRepository.getNode(nodeIdInt)
        if not node or php_intval(node.get('workflow_id')) != workflowId:
            return {'success': False, 'error': 'Node not found', 'status_code': 404}

        documents = _config_documents(_node_config(node))

        return {'success': True, 'documents': documents, 'count': len(documents), 'status_code': 200}

    def deleteNodeDocument(self, request, id: int = 0, nodeId: int = 0, docId: str = '') -> dict:
        """PHP 1666-1761. DELETE .../documents/{docId}."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)
        nodeIdInt = php_intval(nodeId)
        docIdStr = php_strval(docId)

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if not workflowId or not nodeIdInt or php_empty(docIdStr):
            return {
                'success': False,
                'error': 'Workflow ID, Node ID, and Document ID are required',
                'status_code': 400,
            }

        if not self.workflowRepository.isOwner(userId, workflowId):
            return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

        node = self.graphRepository.getNode(nodeIdInt)
        if not node or php_intval(node.get('workflow_id')) != workflowId:
            return {'success': False, 'error': 'Node not found', 'status_code': 404}

        config = _node_config(node)
        documents = _config_documents(config)

        documentToDelete = None
        updatedDocuments = []
        for doc in documents:
            if isinstance(doc, dict) and doc.get('id') == docIdStr:
                documentToDelete = doc
            else:
                updatedDocuments.append(doc)

        if documentToDelete is None:
            return {'success': False, 'error': 'Document not found', 'status_code': 404}

        try:
            storageType = documentToDelete['storage'] if documentToDelete.get('storage') is not None else 'remote'

            if storageType == 'remote':
                userFolder = self.getUserStorageFolder(userId)
                fullPath = f"{self.ROOT_FOLDER}/{userFolder}/{documentToDelete.get('path')}"

                adapter = self.getUniversalFSAdapter(userId)
                if adapter:
                    # PHP 1721-1723 (universalFS delete, itself wrapped in a
                    # try/catch that only logs) — unreachable here, adapter
                    # is never available; not implemented.
                    pass
                else:
                    error_log('[WorkflowController] UniversalFS adapter not available, cannot delete remote file')
            else:
                error_log('[WorkflowController] Document is stored locally, skipping file deletion')

            config = dict(config)
            config['documents'] = updatedDocuments
            self.graphRepository.updateNode(nodeIdInt, {
                'config': config,
                'node_type': node.get('node_type'),
                'agent_id': node.get('agent_id'),
                'pos_x': node.get('pos_x'),
                'pos_y': node.get('pos_y'),
            })

            return {'success': True, 'message': 'Document deleted successfully', 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            error_log(f'[WorkflowController] deleteNodeDocument error: {e}')
            return {'success': False, 'error': f'Failed to delete document: {e}', 'status_code': 500}

    # ========================================================================
    # HELPER METHODS FOR DOCUMENT STORAGE — PHP 1763-1956
    # ========================================================================

    def getUniversalFSAdapter(self, userId: int):
        """PHP 1770-1803. universalFS (Dotenv + PDO credential store +
        AdapterFactory) is a PHP-only package with no Python port — same
        ruling as WorkflowOutputStorage.getUniversalFSClient
        (workflow_output_storage.py module docstring). Always returns None;
        uploadNodeDocument/deleteNodeDocument therefore always take PHP's
        own adapter-unavailable branch."""
        return None

    def getUserStorageProvider(self, userId: int) -> str:
        """PHP 1808-1827. User setting overrides global config."""
        row = self.db.fetch_one("SELECT storage_provider FROM users WHERE id = ?", [userId])
        userProvider = row.get('storage_provider') if row else None

        if not php_empty(userProvider):
            return userProvider

        storageCfg = self.config.get('storage')
        if isinstance(storageCfg, dict) and storageCfg.get('default_provider') is not None:
            return storageCfg['default_provider']
        if self.config.get('default_storage_provider') is not None:
            return self.config['default_storage_provider']
        if self.config.get('storage_provider') is not None:
            return self.config['storage_provider']
        return 'local'

    def getUserStorageFolder(self, userId: int) -> str:
        """PHP 1832-1838."""
        row = self.db.fetch_one("SELECT storage_folder FROM users WHERE id = ?", [userId])
        folder = row.get('storage_folder') if row else None
        return folder if folder is not None else f'user_{userId}'

    def getLocalStoragePath(self, relativePath: str) -> str:
        """PHP 1843-1847. Dead code in PHP (no caller within this class) —
        ported for parity per the task brief's method list. Default base:
        `__DIR__ . '/../../../../storage'` from
        backend/src/AgentTeam/Controllers walks up 4 levels to `gpt/`, i.e.
        `PHP_BACKEND.parent / 'storage'` (verified via the same `php -r`
        walk documented in workflow_output_storage.py's module docstring —
        this constant is one directory name shorter, no `workflow_outputs`
        suffix)."""
        basePath = self.config.get('storage_path')
        if basePath is None:
            basePath = str(PHP_BACKEND.parent / 'storage')
        return basePath + '/' + php_trim(relativePath, '/')

    def detectMimeType(self, tmpPath: str, originalName: str) -> str:
        """PHP 1852-1868. Try fileinfo-style sniffing first; fall back to
        extension-based guessing only when the sniff result is exactly
        'application/octet-stream' (PHP's finfo-returns-octet-stream check).
        No native `finfo` binding exists in Python — reuses
        ChatAttachmentController._sniff (byte-signature + text-family
        sniffer calibrated against the live XAMPP php finfo binary; see that
        module's docstring) as the finfo stand-in, rather than
        re-implementing an equivalent sniffer here."""
        mime = None
        if tmpPath and os.path.isfile(tmpPath):
            mime = _ChatAttachmentController._sniff(tmpPath)

        if mime is not None and mime != 'application/octet-stream':
            return mime

        return self.guessMimeTypeFromExtension(originalName)

    def guessMimeTypeFromExtension(self, filename: str) -> str:
        """PHP 1873-1900."""
        ext = os.path.splitext(filename)[1].lstrip('.').lower()
        return _EXT_MIME_MAP.get(ext, 'application/octet-stream')

    def isAllowedMimeType(self, mimeType: str) -> bool:
        """PHP 1905-1918."""
        if mimeType.startswith('text/'):
            return True
        if mimeType.startswith('image/'):
            return True
        return mimeType in self.ALLOWED_MIME_TYPES

    def sanitizeFilename(self, filename: str) -> str:
        """PHP 1923-1939."""
        filename = os.path.basename(filename)
        filename = _UNSAFE_FILENAME_CHARS_RE.sub('_', filename)

        if len(filename) > 100:
            if '.' in filename:
                name, ext = filename.rsplit('.', 1)
            else:
                name, ext = filename, ''
            filename = name[:90] + '.' + ext

        return filename

    def getUploadErrorMessage(self, errorCode: int) -> str:
        """PHP 1944-1956."""
        return _UPLOAD_ERR_MESSAGES.get(errorCode, 'Unknown upload error')

    @staticmethod
    def _uniqidDoc() -> str:
        """`uniqid('doc_', true)` (PHP 1464)."""
        return php_uniqid('doc_', True)
