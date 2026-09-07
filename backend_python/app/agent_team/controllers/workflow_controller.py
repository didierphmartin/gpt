"""Port of backend/src/AgentTeam/Controllers/WorkflowController.php (1957 lines).

Workflow Controller. The following PHP methods raise `NotImplementedError
('Phase 5/6')` below and are NOT wired into app/routes.py: `generatePython`,
`generateAdk`, `generateMaf`, `generateNooa` (code generators — separate
compiler classes, Phase 6 scope).

Ported: `index`, `create`, `show`, `update`, `destroy`, `run`, `runByName`,
`runStream`, `runPlaybookNode`, `toolResult` (Phase 5, Task 6 — execution
paths, PHP 719-1094), `executions`, `runEvents`, `toggle`, `duplicate`,
`listOutputs`, `getOutput`, `uploadNodeDocument`, `saveDocumentMetadata`,
`listNodeDocuments`, `deleteNodeDocument`, and the private helpers
`getUniversalFSAdapter` (-> None, universalFS is PHP-only, not ported — same
ruling as WorkflowOutputStorage.getUniversalFSClient), `getUserStorageProvider`,
`getUserStorageFolder`, `getLocalStoragePath` (PHP 1843-1847 — dead code:
grep confirms no other WorkflowController method calls it; ported anyway
per the task brief's explicit method list), `detectMimeType`,
`guessMimeTypeFromExtension`, `isAllowedMimeType`, `sanitizeFilename`,
`getUploadErrorMessage`.

The constructor (PHP 36-70) now builds the same AIPortfolioAssistant/
AgentRunner/WorkflowRunner/GraphWorkflowRunner stack AgentController.php
40-67 builds for its own AgentRunner — identical DB-overlay-first sequence
(`LLMProviderResolver.applyDbSettings` before `AIPortfolioAssistant`
construction) per agent_controller.py's own `__init__`.

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
from app.agent_team.services.adk_generator import ADKGenerator
from app.agent_team.services.agent_repository import AgentRepository
from app.agent_team.services.agent_runner import AgentRunner
from app.agent_team.services.graph_workflow_runner import GraphWorkflowRunner
from app.agent_team.services.lang_graph_generator import LangGraphGenerator
from app.agent_team.services.maf_generator import MAFGenerator
from app.agent_team.services.nooa_generator import NOOAGenerator
from app.agent_team.services.playbook_node_runner import PlaybookNodeRunner
from app.agent_team.services.skill_tool_bridge import SkillToolBridge
from app.agent_team.services.stream_context import StreamContext
from app.agent_team.services.workflow_output_storage import WorkflowOutputStorage
from app.agent_team.services.workflow_repository import WorkflowRepository
from app.agent_team.services.workflow_run_log import WorkflowRunLog
from app.agent_team.services.workflow_runner import WorkflowRunner
from app.ai_portfolio_assistant import AIPortfolioAssistant
from app.config import PHP_BACKEND
from app.controllers.chat_attachment_controller import ChatAttachmentController as _ChatAttachmentController
from app.services.llm_provider_resolver import LLMProviderResolver
from app.services.mcp_tools_loader import MCPToolsLoader
from app.support import phpjson
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
        """PHP 36-70."""
        self.db = db
        self.config = config
        self.workflowRepository = WorkflowRepository(db)

        agentRepository = AgentRepository(db)

        # DB-overlay first so the assistant registers all providers from
        # system_llm_settings (post-cutover the file no longer has
        # providers) — same sequence as AgentController.__init__.
        config = LLMProviderResolver.applyDbSettings(db, config)
        self.config = config
        # Python-only: kept as an attribute (rather than a dropped local) so
        # `run`/`runStream` (the entry points that actually drive the
        # runner stack built from it) can close its provider httpx.Client(s)
        # in `finally` — PHP has no equivalent since Guzzle clients die with
        # the request.
        self.assistant = AIPortfolioAssistant(config)
        self.assistant.setDatabase(db)

        mcpToolsLoader = MCPToolsLoader(db)

        agentRunner = AgentRunner(
            self.assistant.getLLMManager(),
            self.assistant.getToolsManager(),
            mcpToolsLoader,
            db,
            config,
        )

        self.workflowRunner = WorkflowRunner(db, agentRepository, agentRunner, config)
        self.graphRepository = self.workflowRepository.getGraphRepository()
        self.graphWorkflowRunner = GraphWorkflowRunner(
            db,
            agentRepository,
            agentRunner,
            self.graphRepository,
            config,
        )

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
    # GET /api/v1/workflows/{id}/generate-python
    # ========================================================================

    def generatePython(self, request, id: int = 0) -> dict:
        """PHP 240-293.

        Query parameters:
          - ?a2a=1: Multi-file A2A manifest mode. Returns {root, files: [...]} (always JSON).
          - ?download=1: In single-file mode, return raw Python (text/x-python). Ignored in A2A mode.
        """
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)
        query = request['query'] if request.get('query') is not None else {}
        download = (query.get('download') if query.get('download') is not None else '0') == '1'

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        if not workflowId:
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}

        try:
            if not self.workflowRepository.canUserAccess(userId, workflowId):
                return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

            agentRepo = AgentRepository(self.db)
            gen = LangGraphGenerator(self.db, self.workflowRepository, self.graphRepository, agentRepo)
            a2a = (query.get('a2a') if query.get('a2a') is not None else '0') == '1'
            result = gen.generate(workflowId, php_strval(userId), {'a2a': a2a})
            if a2a:
                # Multi-file output: always JSON (the editor writes the folder itself).
                return {'success': True, 'data': result, 'status_code': 200}

            if download:
                return {
                    'success': True,
                    'raw_body': result['code'],
                    'headers': {
                        'Content-Type': 'text/x-python; charset=utf-8',
                        'Content-Disposition': f'attachment; filename="{result["filename"]}"',
                    },
                    'status_code': 200,
                }

            return {'success': True, 'data': result, 'status_code': 200}
        except Exception as e:  # noqa: BLE001 -- mirrors PHP `catch (\Throwable $e)`
            error_log(f'[WorkflowController] generatePython failed: {e}')
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # GET /api/v1/workflows/{id}/generate-adk
    # ========================================================================

    def generateAdk(self, request, id: int = 0) -> dict:
        """PHP 303-351."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)
        query = request['query'] if request.get('query') is not None else {}
        download = (query.get('download') if query.get('download') is not None else '0') == '1'

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        if not workflowId:
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}

        try:
            if not self.workflowRepository.canUserAccess(userId, workflowId):
                return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

            agentRepo = AgentRepository(self.db)
            gen = ADKGenerator(self.db, self.workflowRepository, self.graphRepository, agentRepo)
            result = gen.generate(workflowId, php_strval(userId))

            if download:
                return {
                    'success': True,
                    'raw_body': result['code'],
                    'headers': {
                        'Content-Type': 'text/x-python; charset=utf-8',
                        'Content-Disposition': f'attachment; filename="{result["filename"]}"',
                    },
                    'status_code': 200,
                }

            return {'success': True, 'data': result, 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            error_log(f'[WorkflowController] generateAdk failed: {e}')
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # GET /api/v1/workflows/{id}/generate-maf
    # ========================================================================

    def generateMaf(self, request, id: int = 0) -> dict:
        """PHP 361-409."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)
        query = request['query'] if request.get('query') is not None else {}
        download = (query.get('download') if query.get('download') is not None else '0') == '1'

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        if not workflowId:
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}

        try:
            if not self.workflowRepository.canUserAccess(userId, workflowId):
                return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

            agentRepo = AgentRepository(self.db)
            gen = MAFGenerator(self.db, self.workflowRepository, self.graphRepository, agentRepo)
            result = gen.generate(workflowId, php_strval(userId))

            if download:
                return {
                    'success': True,
                    'raw_body': result['code'],
                    'headers': {
                        'Content-Type': 'text/x-python; charset=utf-8',
                        'Content-Disposition': f'attachment; filename="{result["filename"]}"',
                    },
                    'status_code': 200,
                }

            return {'success': True, 'data': result, 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            error_log(f'[WorkflowController] generateMaf failed: {e}')
            return {'success': False, 'error': str(e), 'status_code': 500}

    # ========================================================================
    # GET /api/v1/workflows/{id}/generate-nooa
    # ========================================================================

    def generateNooa(self, request, id: int = 0) -> dict:
        """PHP 419-467."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)
        query = request['query'] if request.get('query') is not None else {}
        download = (query.get('download') if query.get('download') is not None else '0') == '1'

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        if not workflowId:
            return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}

        try:
            if not self.workflowRepository.canUserAccess(userId, workflowId):
                return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

            agentRepo = AgentRepository(self.db)
            gen = NOOAGenerator(self.db, self.workflowRepository, self.graphRepository, agentRepo)
            result = gen.generate(workflowId, php_strval(userId))

            if download:
                return {
                    'success': True,
                    'raw_body': result['code'],
                    'headers': {
                        'Content-Type': 'text/x-python; charset=utf-8',
                        'Content-Disposition': f'attachment; filename="{result["filename"]}"',
                    },
                    'status_code': 200,
                }

            return {'success': True, 'data': result, 'status_code': 200}
        except Exception as e:  # noqa: BLE001
            error_log(f'[WorkflowController] generateNooa failed: {e}')
            return {'success': False, 'error': str(e), 'status_code': 500}

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
    # POST /api/v1/workflows/{id}/run — Phase 5, Task 6 — PHP 719-807
    # ========================================================================

    def run(self, request, id: int = 0) -> dict:
        """PHP 719-807. `@set_time_limit(600)` is a no-op here (uvicorn has
        no per-request PHP-style time limit — see constraints.md's porting
        table)."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)
        body = request['body'] if request.get('body') is not None else {}

        try:
            if not userId:
                return {'success': False, 'error': 'Authentication required', 'status_code': 401}

            if not workflowId:
                return {'success': False, 'error': 'Workflow ID is required', 'status_code': 400}

            # App-key auth is scope-gated (PHP 745-757) — same pattern as
            # AgentController.run's own app-key check (agent_controller.py:614-623).
            if request.get('auth_type') == 'app_key':
                scopes = request.get('app_key_scopes') if request.get('app_key_scopes') is not None else []
                scopeAllowed = ('workflows:run' in scopes
                                 or f'workflows:run:{workflowId}' in scopes)
                if not scopeAllowed:
                    return {
                        'success': False,
                        'error': 'App key not authorized for this workflow (missing scope workflows:run)',
                        'status_code': 403,
                    }

            try:
                if not self.workflowRepository.canUserAccess(userId, workflowId):
                    return {'success': False, 'error': 'Workflow not found or access denied', 'status_code': 404}

                workflow = self.workflowRepository.findById(workflowId)

                if not workflow:
                    return {'success': False, 'error': 'Workflow not found', 'status_code': 404}

                if not workflow.isEnabled():
                    return {'success': False, 'error': 'Workflow is disabled', 'status_code': 400}

                inputVariables = body.get('variables') if body.get('variables') is not None else (
                    body.get('inputs') if body.get('inputs') is not None else {})

                hasGraphNodes = self.graphRepository.getNodes(workflowId)
                isGraphWorkflow = not php_empty(hasGraphNodes)

                if isGraphWorkflow:
                    result = self.graphWorkflowRunner.run(workflow, userId, inputVariables)
                else:
                    result = self.workflowRunner.run(workflow, userId, inputVariables)

                result = dict(result)
                result['status_code'] = 200 if result.get('success') else 500

                return result
            except Exception as e:  # noqa: BLE001 -- mirrors PHP `catch (\Exception $e)`
                return {'success': False, 'error': str(e), 'status_code': 500}
        finally:
            # Python-only cleanup — see __init__'s comment on self.assistant.
            try:
                self.assistant.close()
            except Exception as closeErr:  # noqa: BLE001
                error_log(f"[WorkflowController] assistant.close() failed: {closeErr}")

    # ========================================================================
    # POST /api/v1/workflows/run — PHP 813-849
    # ========================================================================

    def runByName(self, request) -> dict:
        """PHP 813-849. Resolves `(user_id, name)` (unique) to a workflow id
        and delegates to `run()` — identical scope/ownership/enabled/run
        path. `run()` reads the workflow id from its positional `id`
        parameter (this file's convention for every route-param method, e.g.
        `show`/`update`/`toggle`), not from `request['params']['id']` like
        PHP mutates — so the resolved id is simply passed straight through
        as the second positional argument instead."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        body = request['body'] if request.get('body') is not None else {}
        name = php_trim(php_strval(body.get('workflow') if body.get('workflow') is not None else ''))

        if not userId:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        if name == '':
            return {'success': False, 'error': 'A "workflow" name is required', 'status_code': 400}

        row = self.db.fetch_one(
            "SELECT id FROM agent_workflows WHERE user_id = ? AND name = ? LIMIT 1",
            [userId, name],
        )

        if row is None:
            return {
                'success': False,
                'error': f'No workflow named "{name}" found for this account',
                'status_code': 404,
            }

        workflowId = php_intval(row['id'])
        return self.run(request, workflowId)

    # ========================================================================
    # POST /api/v1/workflows/{id}/run-stream — PHP 855-970
    # ========================================================================

    def runStream(self, request, id: int = 0) -> None:
        """PHP 855-970. SSE headers/output-buffering/flush are handled by
        the shared bridge (`request['sse']` — see app/support/sse.py and
        main.py's StreamingResponse generator, spec §3); every PHP
        `$sseCallback(...)` call below becomes `sse.send_data(event)` (bare
        `data:` frame, no `event:` line — PHP 887-893), matching
        agent_controller.py's `chat()` pattern. Unlike `chat()`, EVERY
        validation branch here streams its error through the SSE callback
        (PHP sets headers unconditionally as the very first statements of
        this method, before any validation) rather than returning a plain
        JSON error dict."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        workflowId = php_intval(id)
        body = request['body'] if request.get('body') is not None else {}

        sse = request['sse']

        def sseCallback(event) -> None:
            sse.send_data(event)

        try:
            return self._runStreamInner(userId, workflowId, body, sse, sseCallback)
        finally:
            # Python-only cleanup — see __init__'s comment on self.assistant.
            try:
                self.assistant.close()
            except Exception as closeErr:  # noqa: BLE001
                error_log(f"[WorkflowController] assistant.close() failed: {closeErr}")

    def _runStreamInner(self, userId, workflowId, body, sse, sseCallback) -> None:
        """Python-only split so `runStream`'s outer `finally`
        (`self.assistant.close()`) wraps every return path of the ported
        PHP 855-970 body below without re-indenting it."""
        if not userId:
            sseCallback({'type': 'error', 'error': 'Authentication required'})
            sse.send_data('[DONE]')
            return None

        if not workflowId:
            sseCallback({'type': 'error', 'error': 'Workflow ID is required'})
            sse.send_data('[DONE]')
            return None

        try:
            if not self.workflowRepository.canUserAccess(userId, workflowId):
                sseCallback({'type': 'error', 'error': 'Workflow not found or access denied'})
                sse.send_data('[DONE]')
                return None

            workflow = self.workflowRepository.findById(workflowId)

            if not workflow:
                sseCallback({'type': 'error', 'error': 'Workflow not found'})
                sse.send_data('[DONE]')
                return None

            if not workflow.isEnabled():
                sseCallback({'type': 'error', 'error': 'Workflow is disabled'})
                sse.send_data('[DONE]')
                return None

            inputVariables = body.get('variables') if body.get('variables') is not None else (
                body.get('inputs') if body.get('inputs') is not None else {})

            # Inline folder-backed skill bundle / local-doc content / scratch
            # metadata from the browser dispatcher — see PHP's own comments
            # at 878-897 (workflow-editor.js::_collectClientSkillsForRun /
            # _collectInlineDocumentsForRun).
            clientSkills = body.get('client_skills') if isinstance(body.get('client_skills'), dict) else {}
            inlineDocuments = body.get('inline_documents') if isinstance(body.get('inline_documents'), dict) else {}
            scratchFiles = body.get('scratch_files') if isinstance(body.get('scratch_files'), list) else []

            error_log(
                '[WorkflowController] runStream: inline_documents keys='
                + phpjson.php_json_encode(list(inlineDocuments.keys()))
                + ', scratch_files=' + phpjson.php_json_encode(
                    [sf.get('path') for sf in scratchFiles if isinstance(sf, dict) and 'path' in sf])
                + ', client_skills keys=' + phpjson.php_json_encode(list(clientSkills.keys()))
            )

            hasGraphNodes = self.graphRepository.getNodes(workflowId)
            isGraphWorkflow = not php_empty(hasGraphNodes)

            if isGraphWorkflow:
                validationErrors = self.graphRepository.validateGraph(workflowId)
                if not php_empty(validationErrors):
                    sseCallback({'type': 'error', 'error': 'Invalid workflow: ' + ', '.join(validationErrors)})
                    sse.send_data('[DONE]')
                    return None

                streamContext = StreamContext(sseCallback, userId)
                self.graphWorkflowRunner.setStreamContext(streamContext)

                self.graphWorkflowRunner.run(
                    workflow, userId, inputVariables, clientSkills, inlineDocuments, scratchFiles)
            else:
                sseCallback({'type': 'info', 'message': 'Step-based workflow - running without streaming'})
                result = self.workflowRunner.run(workflow, userId, inputVariables)
                sseCallback({
                    'type': 'workflow_complete',
                    'success': result.get('success') if result.get('success') is not None else False,
                    'output': result.get('output'),
                    'node_outputs': result.get('node_outputs') if result.get('node_outputs') is not None else {},
                })

        except Exception as e:  # noqa: BLE001 -- mirrors PHP `catch (\Throwable $e)`
            sseCallback({'type': 'error', 'error': str(e)})

        sse.send_data('[DONE]')
        return None

    # ========================================================================
    # POST /api/v1/workflows/playbook-node/run — PHP 976-1029
    # ========================================================================

    def runPlaybookNode(self, request) -> None:
        """PHP 976-1029. `@set_time_limit(0)` is a no-op (see `run()`'s
        docstring). Unlike `runStream`, there is no trailing `[DONE]`
        sentinel anywhere in the PHP source — the terminal frame is a named
        `event: done`/`event: error` (`sse.send(...)`, matching
        `format_sse_frame`), not the bare `data:` frame `sseCallback` itself
        uses for the node runner's own round/tool/message events."""
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        body = request['body'] if request.get('body') is not None else {}

        sse = request['sse']

        if not userId:
            sse.send('error', {'error': 'Authentication required'})
            return None

        nodeConfig = body.get('node_config') if isinstance(body.get('node_config'), dict) else {}
        prompt = php_strval(body.get('prompt') if body.get('prompt') is not None else '')

        def sseCallback(event: dict) -> None:
            sse.send_data(event)

        try:
            runner = PlaybookNodeRunner(self.config)
            result = runner.run(userId, nodeConfig, prompt, sseCallback)

            sse.send('done', result)
        except Exception as e:  # noqa: BLE001 -- mirrors PHP `catch (\Throwable $e)`
            sse.send('error', {'error': str(e)})

        return None

    # ========================================================================
    # POST /api/v1/workflows/tool-result — PHP 1035-1054
    # ========================================================================

    def toolResult(self, request) -> dict:
        """PHP 1035-1054. PHP's `http_response_code(401)`/`http_response_code
        (400)` calls here are dead code for the exact reason documented on
        `runEvents()` above: `backend/index.php:149` always derives the
        final HTTP status from `$result['status_code'] ?? 200`, and neither
        of this method's early-return arrays carries a `status_code` key —
        so every branch of this endpoint answers 200 on live PHP, error body
        included. No `status_code` key here either, for the same reason."""
        userId = request['user_id'] if request.get('user_id') is not None else 0
        if not userId:
            return {'error': 'Authentication required'}

        body = request['body'] if request.get('body') is not None else {}
        toolCallId = php_strval(body['tool_call_id']) if body.get('tool_call_id') is not None else ''
        if toolCallId == '' or not _RUN_ID_RE.match(toolCallId):
            return {'error': 'Invalid tool_call_id'}

        bridge = SkillToolBridge()
        bridge.writeResult(toolCallId, body)
        return {'success': True}

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
