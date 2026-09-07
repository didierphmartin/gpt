"""Port of backend/src/AgentTeam/Services/GraphWorkflowRunner.php (3362 lines).

Executes workflows defined as a graph (nodes + edges) from the visual editor.
Traverses from Start node through agent nodes to Output node.

Task 5a scope (this file): the sequential-run spine — `run()`, node
traversal/routing, agent-node execution (single-agent, non-parallel path),
output-node aggregation, merge strategies, execution/trace persistence, and
the conversation_contexts archive. PHP `private`/`protected` methods -> `_name`
(matches the established convention, e.g. `workflow_runner.py`,
`execution_trace_store.py`'s `_pricing`/`_verdict`/`_query`).

Task 5b scope (NOT this file): true parallel fan-out (`executeAgentsInParallel`
and its whole family), and the document-reading leaves (`readDocumentContent`,
`isImageFile`, PDF extraction, storage adapters). Each such method below is a
literal `raise NotImplementedError('Task 5b')` stub with PHP's signature, per
the Task 5a brief/constraints ("Interfaces you consume").

Two methods on that same "5b stub" list are instead ported for REAL here, with
justification (PHP wins over the brief — constraints.md):

  * `buildDocumentsContext` (PHP 2828-2860) — called UNCONDITIONALLY by both
    `run()` (for the Start node, PHP 299) and `executeAgentNode` (PHP 898),
    both of which are squarely Task 5a scope. Its PHP body early-returns ''
    when a node has no `config.documents` (PHP 2830-2833) *before* touching
    `isImageFile`/`readDocumentContent` — the actual document-reading leaves,
    which stay literal 5b stubs below. A node with no attached documents (the
    case every 5a acceptance test uses) is therefore fully functional; a node
    WITH attached documents correctly defers to Task 5b.
  * `runAgentWithClientToolBridge` (PHP 1231-1373) — called unconditionally
    by `executeAgentNode` (PHP 986), which is explicitly 5a scope. Its only
    non-trivial dependency is `SkillToolBridge`, already delivered (Task 2d,
    `app/agent_team/services/skill_tool_bridge.py`) — there is no unshipped
    collaborator left to stub out. Making this a hard stub would make the
    brief's own required test ("run over a 3-node linear graph ... event
    sequence exact, execution rows, final output") impossible to satisfy.

`AgentRunner` (Task 2) does not exist yet in this port; accepted via
constructor injection typed loosely (`Any`), exactly like `workflow_runner.py`
already does. `ParallelAgentExecutor` (Task 3, already on disk) is
deliberately NOT imported — `getParallelExecutor` is one of the literal 5b
stubs above, so nothing here ever needs to construct it.
"""
from __future__ import annotations

import json
import re
import secrets
import time
from typing import Any

from app.agent_team.models.agent import Agent
from app.agent_team.models.workflow import Workflow
from app.agent_team.services.dispatch_routing import DispatchRouting
from app.agent_team.services.execution_trace_store import ExecutionTraceStore
from app.agent_team.services.prompt_template_processor import PromptTemplateProcessor
from app.agent_team.services.session_search_service import SessionSearchService
from app.agent_team.services.skill_tool_bridge import SkillToolBridge
from app.agent_team.services.workflow_output_storage import WorkflowOutputStorage
from app.agent_team.services.workflow_run_log import WorkflowRunLog
from app.agent_team.services.workflow_schema_repository import WorkflowSchemaRepository
from app.exceptions import PricingUnavailableException
from app.services.pricing_resolver import PricingResolver
from app.support.logger import error_log
from app.support.phpcompat import (
    PHP_TRIM_CHARS,
    is_php_array,
    mb_substr,
    php_bool,
    php_date,
    php_empty,
    php_intval,
    php_strval,
    php_trim,
)
from app.support.phpjson import dumps_pretty, php_json_decode, php_json_encode


def _coalesce(*vals):
    """PHP `??` chain: the first non-None value, else None."""
    for v in vals:
        if v is not None:
            return v
    return None


def _json_encode_unescaped_unicode(value) -> str:
    """`json_encode($v, JSON_UNESCAPED_UNICODE)`: compact, literal non-ASCII,
    '/' still escaped. Matches GraphWorkflowRunner.php:3204
    (archiveRunToConversationContexts) exactly -- a flag combination
    app/support/phpjson.py's dumps()/dumps_pretty() don't cover on their own,
    kept local here to avoid touching phpjson.py under the Task 5a staging
    restriction (only graph_workflow_runner.py + its test file are staged)."""
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).replace('/', '\\/')


class NodeLogFormat:
    """Pure formatters for per-node processing-log lines (the node_log event's
    `message`). Ported inline from
    backend/src/AgentTeam/Services/NodeLogFormat.php (58 lines) -- kept in
    this module rather than a separate node_log_format.py, per the Task 5a
    staging restriction (only graph_workflow_runner.py and its test file are
    staged this task). Its oracle, NodeLogFormatTest.php, is ported
    one-to-one in tests/unit/test_graph_workflow_runner_core.py.
    """

    @staticmethod
    def callingProvider(provider: str, model: str | None) -> str:
        return f"calling {provider} ({model})" if model is not None and model != '' else f"calling {provider}"

    @staticmethod
    def modelRequestedTool(tool: str) -> str:
        return f"model requested {tool}"

    @staticmethod
    def modelRespondedText() -> str:
        return 'model responded with text'

    @staticmethod
    def runningSkill(dir_: str) -> str:
        return f"running skill {dir_}"

    @staticmethod
    def skillFinished(exitCode: int | None, byteCount: int | None) -> str:
        exit_ = 'unknown' if exitCode is None else str(exitCode)
        return f"skill finished (exit {exit_}, {php_intval(byteCount)} bytes)"

    @staticmethod
    def skillTimedOut(seconds: int) -> str:
        return f"skill timed out after {seconds}s"

    @staticmethod
    def completed(tokens: int, costUsd: float | None) -> str:
        if costUsd is not None:
            return f"completed ({tokens} tok, ${costUsd:.4f})"
        return f"completed ({tokens} tok)"

    @staticmethod
    def httpError(httpCode: int, message: str) -> str:
        return f"HTTP {httpCode} — {message}"


class GraphWorkflowRunner:
    def __init__(self, db, agentRepository, agentRunner: Any, graphRepository, config: dict | None = None):
        self.db = db
        self.traceStore = ExecutionTraceStore(db)
        self.agentRepository = agentRepository
        self.agentRunner = agentRunner
        self.graphRepository = graphRepository
        self.config = config if config is not None else {}
        self.outputStorage = WorkflowOutputStorage(db, self.config)
        self.schemaRepository = WorkflowSchemaRepository(db)
        self.runLog = WorkflowRunLog(WorkflowRunLog.defaultDir(self.config))
        # Task 5b: ParallelAgentExecutor, lazily constructed by
        # _getParallelExecutor() (a literal stub in this task).
        self.parallelExecutor = None

        self.nodeOutputs: dict = {}
        # Nodes indexed by id for the current run (DispatchRouting needs target names).
        self.graphNodes: dict = {}
        self.workflowName: str = ''
        self.executionId: int | None = None
        self.streamContext = None
        self.currentUserId: int | None = None

        # Inline `client_skills` map shipped by the browser at run start so
        # folder-backed (local-FS) skills can be resolved server-side.
        self.clientSkills: dict = {}
        # Inline `inline_documents` map shipped by the browser at run start.
        self.inlineDocuments: dict = {}
        # Scratch-file metadata for bound-skill workflows, indexed by doc_id.
        self.scratchFilesByDocId: dict = {}

        self.totalInputTokens: int = 0
        self.totalOutputTokens: int = 0
        # provider => [priceIn, priceOut] per 1M tokens
        self.pricingCache: dict = {}
        self.runId: str = ''
        self.currentWorkflowId: int | None = None
        # skill round-trip result (output/script/argv) keyed by node id
        self.skillResultByNode: dict = {}
        # parallel nodes already finalized/emitted this run
        self.parallelEmitted: dict = {}

        self.templateProcessor: PromptTemplateProcessor | None = None
        self.workflowContext: dict = {}

    def setStreamContext(self, context) -> 'GraphWorkflowRunner':
        self.streamContext = context
        return self

    # ─── Template processing ────────────────────────────────────────────────

    def _initTemplateProcessor(self, workflow: Workflow, userId: int, userPrompt: str) -> None:
        self.templateProcessor = PromptTemplateProcessor()

        userInfo = self._getUserInfo(userId)

        self.workflowContext = {
            'user_id': userId,
            'username': _coalesce(userInfo.get('name'), userInfo.get('username'), 'User'),
            'user_email': userInfo.get('email') if userInfo.get('email') is not None else '',
            'user_locale': userInfo.get('locale') if userInfo.get('locale') is not None else 'en-US',

            'workflow_id': workflow.getId(),
            'workflow_name': workflow.getName(),
            'user_prompt': userPrompt,

            'app_name': _coalesce(self.config.get('app_name'), 'AI Assistant'),
            'app_version': _coalesce(self.config.get('app_version'), '1.0'),

            'custom_vars': [],
        }

        self.templateProcessor.setContext(self.workflowContext)

        if not php_empty(self.config.get('timezone')):
            self.templateProcessor.setTimezone(self.config['timezone'])

    def _processPromptTemplate(self, prompt: str, additionalContext: dict | None = None) -> str:
        if not self.templateProcessor:
            return prompt
        if not php_empty(additionalContext):
            self.templateProcessor.setContext(additionalContext)
        return self.templateProcessor.process(prompt)

    def _getUserInfo(self, userId: int) -> dict:
        try:
            row = self.db.fetch_one("SELECT id, username, email, name FROM users WHERE id = ?", [userId])
            return row if row else {}
        except Exception:  # noqa: BLE001 -- mirrors PHP catch (\Exception $e)
            return {}

    # ─── Events ──────────────────────────────────────────────────────────────

    def _emitNodeEvent(self, type_: str, node: dict, extra: dict | None = None) -> None:
        data = {
            'type': type_,
            'node_id': node.get('id'),
            'node_type': node.get('node_type'),
            'drawflow_id': node.get('drawflow_node_id'),
            'agent_id': node.get('agent_id'),
            'agent_name': extra.get('agent_name') if extra else None,
            'timestamp': time.time(),
        }

        if extra:
            data.update(extra)

        # Persist first so the event survives even with no SSE / a dead run.
        if self.runId != '':
            self.runLog.append(self.runId, data)

        if self.streamContext:
            self.streamContext.emit(data)

    def _nodeLog(self, node: dict, level: str, phase: str, message: str, data: dict | None = None) -> None:
        """Narrate one per-node processing milestone: write it to the server
        log AND emit a structured node_log event. Never throws into the run path."""
        error_log(f"[GraphWorkflowRunner] node {node.get('id', '?')} {phase}: {message}")
        self._emitNodeEvent('node_log', node, {
            'level': level,
            'phase': phase,
            'message': message,
            'data': data if data is not None else {},
        })

    def _emitWorkflowEvent(self, type_: str, workflow: Workflow, extra: dict | None = None) -> None:
        data = {
            'type': type_,
            'workflow_id': workflow.getId(),
            'workflow_name': workflow.getName(),
            'timestamp': time.time(),
        }

        if extra:
            data.update(extra)

        if self.runId != '':
            self.runLog.append(self.runId, data)

        if self.streamContext:
            self.streamContext.emit(data)

    # ─── run() ───────────────────────────────────────────────────────────────

    def run(
        self,
        workflow: Workflow,
        userId: int,
        inputVariables: dict | None = None,
        clientSkills: dict | None = None,
        inlineDocuments: dict | None = None,
        scratchFiles: list | None = None,
    ) -> dict:
        """Run a graph-based workflow (PHP 251-628)."""
        inputVariables = inputVariables if inputVariables is not None else {}
        clientSkills = clientSkills if clientSkills is not None else {}
        inlineDocuments = inlineDocuments if inlineDocuments is not None else {}
        scratchFiles = scratchFiles if scratchFiles is not None else []

        self.nodeOutputs = {}
        # Phase 0: one run_id correlates all node traces of this workflow run.
        self.runId = secrets.token_hex(16)
        self.currentWorkflowId = workflow.getId() if hasattr(workflow, 'getId') else None
        self.skillResultByNode = {}
        self.parallelEmitted = {}
        self.currentUserId = userId
        self.clientSkills = clientSkills
        self.inlineDocuments = inlineDocuments
        # Index scratch files by doc_id so readDocumentContent can swap
        # them in for the inline body in O(1).
        self.scratchFilesByDocId = {}
        for sf in scratchFiles:
            if not isinstance(sf, dict):
                continue
            id_ = sf.get('doc_id')
            if isinstance(id_, str) and id_ != '':
                self.scratchFilesByDocId[id_] = sf
        self.totalInputTokens = 0
        self.totalOutputTokens = 0
        startTime = time.time()

        userPrompt = _coalesce(inputVariables.get('prompt'), inputVariables.get('input'), '')

        self._initTemplateProcessor(workflow, userId, userPrompt)

        self.executionId = self._createExecution(workflow, userId, inputVariables)

        try:
            startNode = self.graphRepository.findStartNode(workflow.getId())
            if not startNode:
                raise RuntimeError('Workflow has no Start node')

            startCfg = startNode.get('config')
            startCfg = startCfg if isinstance(startCfg, dict) else {}
            runtimeMode = _coalesce(startCfg.get('runtime_mode'), 'batch')
            if runtimeMode == 'realtime':
                raise RuntimeError(
                    'This workflow is configured for realtime audio. Use the browser-based realtime runner instead.'
                )

            startOutput = userPrompt
            startDocumentsContext = self._buildDocumentsContext(startNode)
            if not php_empty(startDocumentsContext):
                startOutput = startDocumentsContext + "\n\n---\n\n" + userPrompt
                error_log("[GraphWorkflowRunner] Start node has attached documents, prepending to output")

            self.nodeOutputs[startNode['id']] = {
                'type': 'start',
                'output': startOutput,
                'documents': _coalesce(startCfg.get('documents'), []),
            }

            graph = self.graphRepository.getGraph(workflow.getId())
            nodes = self._indexNodesById(graph['nodes'])
            self.graphNodes = nodes
            self.workflowName = php_strval(workflow.getName())
            edges = graph['edges']

            self._emitWorkflowEvent('workflow_start', workflow, {
                'run_id': self.runId,
                'execution_id': self.executionId,
                'total_nodes': len(nodes),
            })

            self._emitNodeEvent('node_start', startNode, {'input': userPrompt})
            time.sleep(0.3)  # 300ms delay so the active glow is visible before completion
            self._emitNodeEvent('node_complete', startNode, {'success': True})

            executedNodes = [startNode['id']]
            queue = self._getNextNodeIds(startNode['id'], edges)
            finalOutput = None

            error_log("[GraphWorkflowRunner] Starting traversal with queue: " + php_json_encode(queue))

            # Check for parallel execution right after Start node
            startParallelAgents = self._findAgentNodesInList(queue, nodes, executedNodes)
            if len(startParallelAgents) > 1:
                error_log(
                    f"[GraphWorkflowRunner] Detected {len(startParallelAgents)} parallel agents "
                    "from Start node (implicit parallelism)"
                )

                parallelResults = self._executeAgentsInParallel(
                    startParallelAgents, userId, userPrompt, edges, executedNodes
                )

                queue = []
                error_log(f"[GraphWorkflowRunner] Storing {len(parallelResults)} parallel results")
                for nodeId, result in parallelResults.items():
                    agentName = _coalesce(result.get('agent_name'), 'Unknown')
                    outputLen = len(_coalesce(result.get('output'), ''))
                    error_log(
                        f"[GraphWorkflowRunner] Storing output for node {nodeId} ({agentName}), "
                        f"output length: {outputLen}"
                    )

                    self.nodeOutputs[nodeId] = result
                    executedNodes.append(nodeId)

                    agentNextIds = self._getNextNodeIds(nodeId, edges)
                    error_log(f"[GraphWorkflowRunner] Node {nodeId} next nodes: " + php_json_encode(agentNextIds))
                    for nextId in agentNextIds:
                        if nextId not in queue and nextId not in executedNodes:
                            queue.append(nextId)

                self._ensureDbConnection()

                error_log(
                    "[GraphWorkflowRunner] Start parallel execution complete, queue now: "
                    + php_json_encode(queue)
                )

            while queue:
                currentNodeId = queue.pop(0)
                error_log(f"[GraphWorkflowRunner] Processing node ID: {currentNodeId}")

                if currentNodeId in executedNodes:
                    error_log(f"[GraphWorkflowRunner] Node {currentNodeId} already executed, skipping")
                    continue

                node = nodes.get(currentNodeId)
                if not node:
                    error_log(f"[GraphWorkflowRunner] Node {currentNodeId} not found in nodes array")
                    continue

                error_log(f"[GraphWorkflowRunner] Node {currentNodeId} type: {node.get('node_type')}")

                # Check if all incoming nodes are executed (for merge nodes)
                if not self._canExecuteNode(currentNodeId, edges, executedNodes):
                    queue.append(currentNodeId)
                    error_log(f"[GraphWorkflowRunner] Node {currentNodeId} not ready, re-queued")
                    continue

                # Build input context for agent nodes before emitting node_start
                nodeInput = None
                if node.get('node_type') == 'agent':
                    cfg = node.get('config')
                    cfg = cfg if isinstance(cfg, dict) else {}
                    mergeStrategy = _coalesce(cfg.get('merge_strategy'), 'labeled')
                    context = self._buildContextForNode(node['id'], edges, executedNodes, mergeStrategy)
                    nodeInput = f"Do your job on the following input:\n\n{context}" if not php_empty(context) else userPrompt

                self._emitNodeEvent('node_start', node, {'input': nodeInput})

                error_log(f"[GraphWorkflowRunner] Executing node {currentNodeId}...")
                output = self._executeNode(node, userId, userPrompt, edges, executedNodes)
                error_log(
                    f"[GraphWorkflowRunner] Node {currentNodeId} executed, output type: "
                    + _coalesce(output.get('type'), 'unknown')
                )

                # Ensure DB connection is alive after potentially long LLM call
                self._ensureDbConnection()

                self.nodeOutputs[currentNodeId] = output
                executedNodes.append(currentNodeId)

                usage = output.get('usage')
                usage = usage if isinstance(usage, dict) else {}
                inputTokens = _coalesce(usage.get('input_tokens'), usage.get('prompt_tokens'), 0)
                outputTokens = _coalesce(usage.get('output_tokens'), usage.get('completion_tokens'), 0)
                if node.get('node_type') == 'agent':
                    self.totalInputTokens += inputTokens
                    self.totalOutputTokens += outputTokens

                # Derive node success from the executed output.
                nodeSuccess = bool(output['success']) if 'success' in output else (output.get('type') != 'error')

                self._emitNodeEvent('node_complete', node, {
                    'agent_name': output.get('agent_name'),
                    'server_name': output.get('server_name'),
                    'success': nodeSuccess,
                    'output': output.get('output'),
                    'input_tokens': inputTokens,
                    'output_tokens': outputTokens,
                    'cost_usd': self._computeNodeCost(output.get('provider'), inputTokens, outputTokens),
                })

                # Phase 0: record an execution trace for agent nodes.
                if output.get('type') == 'agent':
                    self._recordExecutionTrace(
                        node, output.get('provider'), output.get('model'),
                        nodeSuccess, output.get('output'), inputTokens, outputTokens,
                    )

                # If output node, capture final output
                if node.get('node_type') == 'output':
                    finalOutput = self._collectFinalOutput(currentNodeId, edges)
                    error_log("[GraphWorkflowRunner] Output node reached, final output collected")
                    continue  # Don't queue nodes after output

                # Dispatcher routing: one chosen branch, siblings skipped.
                if self._applyRoute(currentNodeId, output, edges, queue, executedNodes):
                    continue

                # Check for parallel execution opportunity
                nextNodeIds = self._getNextNodeIds(currentNodeId, edges)
                parallelAgents = self._findAgentNodesInList(nextNodeIds, nodes, executedNodes)

                if len(parallelAgents) > 1:
                    error_log(
                        f"[GraphWorkflowRunner] Detected {len(parallelAgents)} parallel agents "
                        f"from node {currentNodeId} (implicit parallelism)"
                    )

                    parallelResults = self._executeAgentsInParallel(
                        parallelAgents, userId, userPrompt, edges, executedNodes
                    )

                    for nodeId, result in parallelResults.items():
                        self.nodeOutputs[nodeId] = result
                        executedNodes.append(nodeId)

                        agentNextIds = self._getNextNodeIds(nodeId, edges)
                        for nextId in agentNextIds:
                            if nextId not in queue and nextId not in executedNodes:
                                queue.append(nextId)

                    # Queue any non-agent nodes from the original next nodes
                    for nextId in nextNodeIds:
                        nextNode = nodes.get(nextId)
                        if (nextNode and nextNode.get('node_type') != 'agent'
                                and nextId not in executedNodes and nextId not in queue):
                            queue.append(nextId)

                    self._ensureDbConnection()

                    error_log(
                        "[GraphWorkflowRunner] Parallel execution complete, queue now: " + php_json_encode(queue)
                    )
                    continue  # Skip normal queuing since we handled it

                # Queue next nodes (normal sequential flow)
                nextNodeIds = self._getNextNodeIds(currentNodeId, edges)
                error_log(f"[GraphWorkflowRunner] Next nodes for {currentNodeId}: " + php_json_encode(nextNodeIds))
                for nextId in nextNodeIds:
                    if nextId not in queue and nextId not in executedNodes:
                        queue.append(nextId)
                error_log("[GraphWorkflowRunner] Queue now: " + php_json_encode(queue))

            error_log(f"[GraphWorkflowRunner] Traversal complete, executed {len(executedNodes)} nodes")

            responseTime = (time.time() - startTime) * 1000

            # Complete execution
            self._completeExecution(self.executionId, self.nodeOutputs, responseTime)

            self._emitWorkflowEvent('workflow_complete', workflow, {
                'execution_id': self.executionId,
                'success': True,
                'nodes_executed': len(executedNodes),
                'response_time_ms': round(responseTime, 2),
                'output': finalOutput,
                'node_outputs': self.nodeOutputs,
                'total_input_tokens': self.totalInputTokens,
                'total_output_tokens': self.totalOutputTokens,
                'total_tokens': self.totalInputTokens + self.totalOutputTokens,
            })

            # Save output to storage if enabled
            storageSaveResult = None
            try:
                storageSaveResult = self.outputStorage.saveOutput(
                    workflow.getId(),
                    userId,
                    {
                        'execution_id': self.executionId,
                        'workflow_id': workflow.getId(),
                        'workflow_name': workflow.getName(),
                        'timestamp': php_date('c'),
                        'response_time_ms': round(responseTime, 2),
                        'nodes_executed': len(executedNodes),
                        'output': finalOutput,
                        'node_outputs': self.nodeOutputs,
                        'input_variables': inputVariables,
                    },
                )

                if storageSaveResult.get('success'):
                    error_log(
                        "[GraphWorkflowRunner] Output saved to storage: "
                        + php_strval(_coalesce(storageSaveResult.get('path'), 'unknown'))
                    )
            except Exception as e:  # noqa: BLE001 -- mirrors PHP catch (\Exception $e)
                error_log(f"[GraphWorkflowRunner] Failed to save output to storage: {e}")

            # Archive the run into conversation_contexts so it shows up in
            # the chat sidebar and is searchable via session_search. This is
            # best-effort — a failure here never fails the workflow.
            try:
                self._archiveRunToConversationContexts(
                    userId,
                    php_intval(workflow.getId()),
                    php_strval(workflow.getName()),
                    php_strval(userPrompt),
                    php_strval(_coalesce(finalOutput, '')),
                )
            except Exception as e:  # noqa: BLE001 -- mirrors PHP catch (\Throwable $e)
                error_log(f"[GraphWorkflowRunner] Archive to conversation_contexts failed: {e}")

            return {
                'success': True,
                'execution_id': self.executionId,
                'workflow': {'id': workflow.getId(), 'name': workflow.getName()},
                'output': finalOutput,
                'node_outputs': self.nodeOutputs,
                'nodes_executed': len(executedNodes),
                'response_time_ms': round(responseTime, 2),
                'storage': storageSaveResult,
            }

        except Exception as e:  # noqa: BLE001 -- mirrors PHP catch (\Exception $e)
            self._emitWorkflowEvent('workflow_error', workflow, {
                'execution_id': self.executionId,
                'error': str(e),
            })

            self._failExecution(self.executionId, str(e))

            return {
                'success': False,
                'error': str(e),
                'execution_id': self.executionId,
                'workflow': {'id': workflow.getId(), 'name': workflow.getName()},
                'partial_outputs': self.nodeOutputs,
            }

    # ─── Graph traversal helpers ─────────────────────────────────────────────

    def _indexNodesById(self, nodes: list) -> dict:
        """Index nodes by ID for quick lookup (PHP 633-640)."""
        return {n['id']: n for n in nodes}

    def _applyRoute(self, nodeId: int, output: dict, edges: list, queue: list, executedNodes: list) -> bool:
        """Dispatcher routing (PHP 649-664): when a node's output carries a
        'route', queue ONLY the chosen target and mark the unchosen branches
        — and everything reachable solely through them — as done. Returns
        False (and touches nothing) for ordinary outputs. `queue` and
        `executedNodes` are mutated in place (PHP's `array &$queue`/
        `array &$executedNodes`)."""
        route = output.get('route')
        if not isinstance(route, dict) or 'id' not in route:
            return False
        chosen = php_intval(route['id'])
        nextIds = self._getNextNodeIds(nodeId, edges)
        unchosen = [i for i in nextIds if i != chosen]
        for skipId in DispatchRouting.skipSet(unchosen, edges):
            if skipId not in executedNodes:
                executedNodes.append(skipId)
        if chosen not in queue and chosen not in executedNodes:
            queue.append(chosen)
        error_log(
            f"[GraphWorkflowRunner] Dispatcher {nodeId} routed to {chosen} ({route.get('name')}); "
            "skipped " + php_json_encode(unchosen)
        )
        return True

    def _getNextNodeIds(self, nodeId: int, edges: list) -> list:
        """Get IDs of nodes connected from the given node (PHP 669-678)."""
        return [php_intval(e.get('to_node_id')) for e in edges if php_intval(e.get('from_node_id')) == nodeId]

    def _canExecuteNode(self, nodeId: int, edges: list, executedNodes: list) -> bool:
        """Check if a node can be executed: all incoming dependencies satisfied (PHP 683-693)."""
        for e in edges:
            if php_intval(e.get('to_node_id')) == nodeId:
                if php_intval(e.get('from_node_id')) not in executedNodes:
                    return False
        return True

    def _executeNode(self, node: dict, userId: int, userPrompt: str, edges: list, executedNodes: list) -> dict:
        """Execute a single node (PHP 698-717)."""
        nodeType = node.get('node_type')
        config = node.get('config')
        config = config if isinstance(config, dict) else {}

        # Disabled node: a debugging no-op.
        if not php_empty(config.get('disabled')):
            self._nodeLog(node, 'info', 'done', 'disabled node — skipped')
            return {'type': nodeType, 'output': 'disabled node', 'success': True}

        if nodeType == 'agent':
            return self._executeAgentNode(node, userId, userPrompt, edges, executedNodes)
        if nodeType == 'agent-template':
            raise RuntimeError(
                "Unconfigured agent template node found. Please configure all agent nodes before running the workflow."
            )
        if nodeType == 'playbook':
            raise RuntimeError(
                "Playbook nodes run only from the workflow editor's browser run path "
                "(server-side durable runs arrive in slice 1c)."
            )
        if nodeType == 'output':
            return self._executeOutputNode(node, edges, executedNodes)
        return {'type': nodeType, 'output': None}

    # ─── Agent node execution ────────────────────────────────────────────────

    def _executeAgentNode(self, node: dict, userId: int, userPrompt: str, edges: list, executedNodes: list) -> dict:
        """Execute an agent node (PHP 722-1051)."""
        self._ensureDbConnection()

        agentId = node.get('agent_id')
        config = node.get('config')
        config = config if isinstance(config, dict) else {}

        agent = None
        # Dispatcher routing targets (filled once the agent's type is known).
        dispatchTargets: list = []

        agentContext = {
            'agent_name': _coalesce(config.get('agent_name'), config.get('name'), ''),
            'node_id': node.get('id'),
            'node_name': _coalesce(config.get('name'), f"Node {node.get('id')}"),
        }

        # Node-level skill content resolution.
        skillContent = ''
        boundSkill = config.get('bound_skill')
        if not php_empty(boundSkill) and isinstance(boundSkill, dict):
            dirName = php_strval(_coalesce(boundSkill.get('dir_name'), ''))
            entry = self.clientSkills.get(dirName) if dirName != '' else None
            if dirName != '' and isinstance(entry, dict):
                skillContent = php_strval(_coalesce(entry.get('skill_content'), ''))
            if skillContent == '':
                error_log(
                    f"[GraphWorkflowRunner] bound_skill dir_name='{dirName}' has no inline client_skills "
                    "entry — node will run without skill content."
                )
        if skillContent == '':
            skillContent = php_trim(_coalesce(config.get('skill_content'), ''))

        # Memory is a CONVERSATION-ONLY feature — workflows run memory-free.
        userMemoryBlock = ''
        userProfileBlock = ''

        if not php_empty(agentId):
            error_log(f"[GraphWorkflowRunner] Looking up agent ID: {agentId}")
            agentRow = self.agentRepository.findById(agentId)
            if not agentRow:
                raise RuntimeError(f"Agent not found: {agentId}")

            agentContext['agent_name'] = agentRow.getName()
            processedInstructions = self._processPromptTemplate(agentRow.getInstructions(), agentContext)
            processedDescription = self._processPromptTemplate(agentRow.getDescription(), agentContext)

            if skillContent != '':
                processedSkill = self._processPromptTemplate(skillContent, agentContext)
                processedInstructions = processedInstructions.rstrip(PHP_TRIM_CHARS) + "\n\n## Skill\n" + processedSkill

            if userMemoryBlock != '':
                processedInstructions = processedInstructions.rstrip(PHP_TRIM_CHARS) + "\n\n## Memory\n" + userMemoryBlock
            if userProfileBlock != '':
                processedInstructions = processedInstructions.rstrip(PHP_TRIM_CHARS) + "\n\n## User\n" + userProfileBlock

            agent = Agent({
                'id': agentRow.getId(),
                'user_id': agentRow.getUserId(),
                'name': agentRow.getName(),
                'description': processedDescription,
                'agent_type': agentRow.getAgentType(),
                'provider': agentRow.getProvider(),
                'model': agentRow.getModel(),
                'instructions': processedInstructions,
                'tools': agentRow.getTools(),
                'settings': agentRow.getSettings(),
            })
        elif (not php_empty(config.get('agent_name')) or not php_empty(config.get('instructions'))
              or skillContent != ''):
            error_log("[GraphWorkflowRunner] Creating inline agent from node config")

            agentName = _coalesce(config.get('agent_name'), config.get('name'), 'Inline Agent')
            agentContext['agent_name'] = agentName

            processedInstructions = self._processPromptTemplate(_coalesce(config.get('instructions'), ''), agentContext)
            processedDescription = self._processPromptTemplate(_coalesce(config.get('description'), ''), agentContext)

            if skillContent != '':
                processedSkill = self._processPromptTemplate(skillContent, agentContext)
                processedInstructions = processedInstructions.rstrip(PHP_TRIM_CHARS) + "\n\n## Skill\n" + processedSkill

            if userMemoryBlock != '':
                processedInstructions = processedInstructions.rstrip(PHP_TRIM_CHARS) + "\n\n## Memory\n" + userMemoryBlock
            if userProfileBlock != '':
                processedInstructions = processedInstructions.rstrip(PHP_TRIM_CHARS) + "\n\n## User\n" + userProfileBlock

            agent = Agent({
                'id': None,
                'user_id': userId,
                'name': agentName,
                'description': processedDescription,
                'agent_type': _coalesce(config.get('agent_type'), 'worker'),
                'provider': _coalesce(config.get('agent_provider'), config.get('provider'), 'openai'),
                'model': config.get('model'),
                'instructions': processedInstructions,
                'tools': _coalesce(config.get('tools'), []),
                'settings': _coalesce(config.get('settings'), []),
            })
        else:
            raise RuntimeError("Agent node has no agent_id and no inline configuration")

        # A blank node must not inherit the user's conversation persona.
        if php_trim(agent.getInstructions()) == '':
            agent = Agent({
                **agent.toArray(),
                'instructions': DispatchRouting.defaultInstructions(
                    agent.getName(), php_strval(agent.getDescription()), self.workflowName
                ),
            })
        # The node a dispatcher routed to is told so (and not to re-route).
        routedBy = DispatchRouting.routedBy(php_intval(node.get('id')), edges, self.nodeOutputs)
        if routedBy is not None:
            agent = Agent({
                **agent.toArray(),
                'instructions': (
                    agent.getInstructions().rstrip(PHP_TRIM_CHARS) + "\n\n"
                    + DispatchRouting.routedPrompt(agent.getName(), routedBy['from'], routedBy['notes'])
                ),
            })

        # Dispatcher agents: outgoing edges are a MENU of branches.
        if agent.getAgentType() == 'dispatcher':
            dispatchTargets = DispatchRouting.targets(php_intval(node.get('id')), edges, self.graphNodes)
            if dispatchTargets != []:
                agent = Agent({
                    **agent.toArray(),
                    'instructions': agent.getInstructions().rstrip(PHP_TRIM_CHARS) + "\n\n" + DispatchRouting.promptBlock(dispatchTargets),
                })
            else:
                error_log(
                    f"[GraphWorkflowRunner] Dispatcher node {node.get('id')} has no downstream agent "
                    "— running as a plain agent."
                )

        # Build context from previous nodes.
        mergeStrategy = _coalesce(config.get('merge_strategy'), 'labeled')
        context = self._buildContextForNode(php_intval(node.get('id')), edges, executedNodes, mergeStrategy)

        # Add attached documents to context.
        documentsContext = self._buildDocumentsContext(node)
        if not php_empty(documentsContext):
            context = documentsContext + "\n\n" + context

        if not php_empty(context):
            task = f"Do your job on the following input:\n\n{context}"
        else:
            task = userPrompt

        # Extract tools filter from node config (if specified). [] = no tools.
        toolsFilter = None
        cfgTools = config.get('tools')
        if is_php_array(cfgTools):
            toolsFilter = cfgTools
            error_log("[GraphWorkflowRunner] Using node-level tools filter: " + php_json_encode(toolsFilter))

        outputSchema = self._resolveOutputSchema(config, userId)

        extraTools: list = []
        skillMetadata = None
        skillScripts = self._getBoundSkillScripts(config)
        skillDirName = boundSkill.get('dir_name') if isinstance(boundSkill, dict) else None
        if not php_empty(skillScripts) and isinstance(skillDirName, str) and skillDirName != '':
            skillMetadata = {'dir_name': skillDirName, 'scripts': skillScripts}
            extraTools.append(self._buildRunSkillScriptTool(skillMetadata))

        runContext = {
            'workflow_execution_id': self.executionId,
            'node_id': node.get('id'),
            'tools_filter': toolsFilter,
            'output_schema': outputSchema,
            'extra_tools': extraTools,
            'skill_metadata': skillMetadata,
        }

        # Force run_skill_script on the FIRST agent turn.
        if not php_empty(skillScripts) and isinstance(skillDirName, str) and skillDirName != '':
            runContext['tool_choice'] = {'type': 'function', 'function': {'name': 'run_skill_script'}}

        # Dispatcher: declare route_to and force the call.
        if dispatchTargets != []:
            runContext['extra_tools'].append(DispatchRouting.toolDefinition(dispatchTargets))
            runContext['tool_choice'] = (
                'required' if agent.getProvider().lower() in ('grok', 'deepseek')
                else {'type': 'function', 'function': {'name': DispatchRouting.TOOL_NAME}}
            )

        self._nodeLog(node, 'info', 'llm', NodeLogFormat.callingProvider(agent.getProvider(), agent.getModel()))
        result = self._runAgentWithClientToolBridge(agent, task, [], userId, runContext, node)

        # Dispatcher: resolve the route_to choice here.
        if dispatchTargets != []:
            if result.get('success', True) is False:
                err = php_strval(_coalesce(result.get('error'), 'agent execution failed'))
                self._nodeLog(node, 'error', 'llm', err)
                return {
                    'type': 'agent', 'agent_id': agentId, 'agent_name': agent.getName(), 'input': task,
                    'output': f"Error: {err}", 'success': False, 'usage': result.get('usage'),
                    'provider': agent.getProvider(),
                }
            route = DispatchRouting.resolve(_coalesce(result.get('pending_tool_calls'), []), dispatchTargets)
            if route is None:
                names = ', '.join(t['name'] for t in dispatchTargets)
                self._nodeLog(node, 'error', 'routing', f"dispatcher did not call route_to with one of: {names}")
                return {
                    'type': 'agent', 'agent_id': agentId, 'agent_name': agent.getName(), 'input': task,
                    'output': (
                        f'Error: dispatcher "{agent.getName()}" did not route the request. '
                        f'Expected a route_to call with target in [{names}].'
                    ),
                    'success': False, 'usage': result.get('usage'), 'provider': agent.getProvider(),
                }
            self._nodeLog(
                node, 'info', 'routing',
                f"routed to {route['name']}" + (f" — {route['notes']}" if route['notes'] != '' else '')
            )
            return {
                'type': 'agent', 'agent_id': agentId, 'agent_name': agent.getName(), 'input': task,
                'output': task + (f"\n\n## Dispatcher notes\n{route['notes']}" if route['notes'] != '' else ''),
                'route': route, 'success': True, 'usage': result.get('usage'), 'provider': agent.getProvider(),
            }

        rawOutput = _coalesce(result.get('text'), result.get('output'), '')
        self._nodeLog(node, 'info', 'analysis', 'generating final output')
        structured = None
        if outputSchema is not None and isinstance(rawOutput, str) and rawOutput != '':
            decoded = php_json_decode(rawOutput)
            if decoded is not None and isinstance(decoded, (list, dict)):
                structured = decoded
            else:
                error_log(
                    f"[GraphWorkflowRunner] Schema-constrained output was not valid JSON for node {node.get('id')}"
                )

        return {
            'type': 'agent',
            'agent_id': agentId,
            'agent_name': agent.getName(),
            'input': task,
            'output': rawOutput,
            'structured': structured,
            'schema_name': outputSchema.get('name') if outputSchema is not None else None,
            'success': _coalesce(result.get('success'), True),
            'usage': result.get('usage'),
            'provider': agent.getProvider(),
        }

    # ─── Pricing / cost ──────────────────────────────────────────────────────

    def _getProviderPricing(self, provider: str) -> list:
        """Per-1M-token pricing [input, output] in USD for a provider (PHP 1059-1078)."""
        provider = provider.lower()
        aliases = {'anthropic': 'claude', 'google': 'gemini'}
        key = aliases.get(provider, provider)

        if key in self.pricingCache:
            return self.pricingCache[key]

        try:
            resolver = PricingResolver(self.db)
            in_, out_ = resolver.resolve(key)
        except PricingUnavailableException:
            # Forecast/trace surface: unknown pricing renders "—", not a guessed number.
            in_, out_ = None, None

        self.pricingCache[key] = [in_, out_]
        return self.pricingCache[key]

    def _recordExecutionTrace(
        self, node: dict, provider: str | None, model: str | None, success: bool,
        outputText: str | None, inTok: int, outTok: int,
    ) -> None:
        """Assemble + persist one execution trace for a workflow agent node (PHP 1091-1132)."""
        nodeId = php_intval(node.get('id'))
        config = node.get('config')
        config = config if isinstance(config, dict) else {}
        sr = self.skillResultByNode.get(nodeId, {})
        out = sr.get('output') if isinstance(sr.get('output'), dict) else {}
        boundSkill = config.get('bound_skill')
        skillDir = boundSkill.get('dir_name') if isinstance(boundSkill, dict) else None

        self.traceStore.insert({
            'run_id': self.runId,
            'ts': php_date('Y-m-d H:i:s'),
            'env': 'workflow',
            'invocation_mode': 'workflow_node',
            'workflow_id': self.currentWorkflowId,
            'node_id': nodeId,
            'provider': provider,
            'model': model,
            'skill_dir': skillDir,
            'script': sr.get('script'),
            'argv': _coalesce(sr.get('argv'), []),
            'skill_exit_code': out.get('exit_code'),
            'skill_stdout': out.get('stdout'),
            'skill_log_messages': out.get('log_messages'),
            'output_files': list(out['outputs'].keys()) if isinstance(out.get('outputs'), dict) else [],
            'final_text': outputText,
            'success': success,
            'error_text': None if success else outputText,
            'tokens_in': inTok,
            'tokens_out': outTok,
            'cost_usd': self._computeNodeCost(provider, inTok, outTok),
        })
        # Mirror the skill stdout/logs into the per-run event log.
        self._emitNodeEvent('node_trace', node, {
            'skill_dir': skillDir,
            'skill_exit_code': out.get('exit_code'),
            'skill_stdout': out.get('stdout'),
            'skill_log_messages': out.get('log_messages'),
            'final_text': outputText,
            'success': success,
            'error_text': None if success else outputText,
        })

    def _computeNodeCost(self, provider: str | None, inputTokens: int, outputTokens: int) -> float | None:
        """Compute USD cost for a node from its token usage and provider pricing (PHP 1134-1140).
        Returns None when pricing is unknown so the UI can show "—" rather than a misleading $0.00."""
        if php_empty(provider):
            return None
        priceIn, priceOut = self._getProviderPricing(provider)
        if priceIn is None and priceOut is None:
            return None
        return (inputTokens * (priceIn if priceIn is not None else 0)
                + outputTokens * (priceOut if priceOut is not None else 0)) / 1_000_000

    # ─── Bound-skill tooling ─────────────────────────────────────────────────

    def _getBoundSkillScripts(self, config: dict) -> list:
        """Pull the executable script list for a node's bound folder-backed
        skill out of the inline `client_skills` bundle (PHP 1149-1167)."""
        bs = config.get('bound_skill')
        if not isinstance(bs, dict) or _coalesce(bs.get('source'), '') != 'local':
            return []
        dir_ = _coalesce(bs.get('dir_name'), '')
        if not isinstance(dir_, str) or dir_ == '':
            return []
        entry = self.clientSkills.get(dir_)
        if not isinstance(entry, dict):
            return []
        scripts = entry.get('scripts')
        if not isinstance(scripts, list):
            return []
        out: list = []
        seen: set = set()
        for s in scripts:
            if not isinstance(s, str):
                continue
            s = php_trim(s)
            if s == '' or s.startswith('/') or '..' in s:
                continue
            if s not in seen:
                seen.add(s)
                out.append(s)
        return out

    def _buildRunSkillScriptTool(self, metadata: dict) -> dict:
        """Build the run_skill_script tool definition for a node (PHP 1176-1218)."""
        dirName = metadata['dir_name']
        scripts = metadata['scripts']

        description = (
            f'Execute one of the Python scripts bundled with the active skill "{dirName}". '
            'This tool IS available to you and you should call it whenever the workflow input '
            "maps to one of the skill's scripts — do not attempt the transformation manually if a "
            'script can do it. Available scripts: ' + ', '.join(scripts) + '. '
            'OUTPUT: files MUST be written to absolute paths under /outputs/ '
            '(e.g. -o /outputs/foo.html in argv) AND listed in read_outputs.'
        )

        return {
            'name': 'run_skill_script',
            'description': description,
            'input_schema': {
                'type': 'object',
                'properties': {
                    'script': {
                        'type': 'string',
                        'description': 'Path to the script within the skill folder. Must be one of the listed scripts.',
                        'enum': scripts,
                    },
                    'argv': {
                        'type': 'array',
                        'description': 'Command-line arguments passed to the script (sys.argv[1:]). Output paths (e.g. -o, --output) MUST start with /outputs/.',
                        'items': {'type': 'string'},
                    },
                    'input_files': {
                        'type': 'object',
                        'description': 'OPTIONAL — small synthesized files to write before running the script. Keys are absolute paths, values are file contents.',
                        'additionalProperties': {'type': 'string'},
                    },
                    'read_outputs': {
                        'type': 'array',
                        'description': 'Paths whose contents should be returned to you after the script finishes. Use absolute /outputs/<filename> paths.',
                        'items': {'type': 'string'},
                    },
                },
                'required': ['script'],
            },
        }

    # ─── Client-tool bridge (real port — see module docstring) ──────────────

    def _runAgentWithClientToolBridge(
        self,
        agent: Agent,
        task: str,
        conversationHistory: list,
        userId: int,
        runContext: dict,
        node: dict,
    ) -> dict:
        """Run an agent and, if the LLM emits a client-side tool call,
        round-trip through the browser via SkillToolBridge before resuming
        (PHP 1231-1373). Bound to MAX_ROUNDS so a runaway tool loop can't
        pin the worker."""
        MAX_ROUNDS = 3
        bridge = SkillToolBridge()
        history = list(conversationHistory)
        currentTask = task
        result: dict | None = None

        for round_ in range(MAX_ROUNDS + 1):
            result = self.agentRunner.run(agent, currentTask, history, userId, runContext)

            uRaw = _coalesce(result.get('usage'), {})
            u = uRaw if isinstance(uRaw, dict) else {}
            error_log(
                "[BridgeUsage] node=%s provider=%s round=%d pending=%s in=%s out=%s keys=[%s]" % (
                    node.get('id', '?'), agent.getProvider(), round_,
                    'no' if php_empty(result.get('pending_client_tool_call')) else 'yes',
                    str(_coalesce(u.get('input_tokens'), u.get('prompt_tokens'), 'NULL')),
                    str(_coalesce(u.get('output_tokens'), u.get('completion_tokens'), 'NULL')),
                    ','.join(uRaw.keys()) if isinstance(uRaw, dict) else type(uRaw).__name__,
                )
            )

            if php_empty(result.get('pending_client_tool_call')):
                return result
            pending = _coalesce(result.get('pending_tool_calls'), [])
            if php_empty(pending) or not isinstance(pending[0], dict):
                error_log(
                    "[GraphWorkflowRunner] pending_client_tool_call set but no tool_calls payload "
                    "— aborting round-trip."
                )
                return result
            # route_to is resolved by executeAgentNode (DispatchRouting), not the browser.
            if _coalesce(pending[0].get('name'), '') == DispatchRouting.TOOL_NAME:
                return result
            if round_ == MAX_ROUNDS:
                error_log(
                    f"[GraphWorkflowRunner] client-tool round limit ({MAX_ROUNDS}) hit on node "
                    f"{node.get('id')} — returning last assistant text."
                )
                return result

            call = pending[0]
            toolCallId = SkillToolBridge.generateToolCallId()
            callForFrontend = {
                'id': toolCallId,
                'name': _coalesce(call.get('name'), 'run_skill_script'),
                'input': _coalesce(call.get('input'), {}),
            }
            assistantText = _coalesce(result.get('pending_assistant_text'), '')
            assistantReasoning = php_strval(result.get('pending_assistant_reasoning'))

            skillMeta = runContext.get('skill_metadata')
            skillMeta = skillMeta if isinstance(skillMeta, dict) else {}
            self._nodeLog(
                node, 'info', 'skill',
                NodeLogFormat.runningSkill(_coalesce(skillMeta.get('dir_name'), 'skill')),
            )
            self._emitNodeEvent('client_tool_call', node, {
                'tool_call_id': toolCallId,
                'tool_calls': [callForFrontend],
                'assistant_text': assistantText,
                'dir_name': skillMeta.get('dir_name'),
            })

            # Same cap as the parallel path: don't let a stuck browser skill
            # hang this node for the full 5-minute default.
            seqTimeoutMs = php_intval(_coalesce(self.config.get('parallel_skill_timeout_ms'), 60000))
            bridgeResult = bridge.awaitResult(toolCallId, seqTimeoutMs)
            if bridgeResult is None:
                seqTimeoutSec = round(seqTimeoutMs / 1000)
                error_log(
                    f"[GraphWorkflowRunner] bridge timed out ({seqTimeoutSec}s) waiting for "
                    f"tool_call_id={toolCallId}"
                )
                self._nodeLog(node, 'error', 'skill', NodeLogFormat.skillTimedOut(seqTimeoutSec))
                raise RuntimeError(
                    f"Skill did not return within {seqTimeoutSec}s — it may be unable to run in the "
                    "browser (e.g. heavy/blocked network fetches). Check the editor console."
                )

            outputBlock = bridgeResult.get('output') if isinstance(bridgeResult, dict) else None
            outputBlock = outputBlock if isinstance(outputBlock, dict) else {}
            stdout = outputBlock.get('stdout')
            seqStdoutBytes = len((stdout if isinstance(stdout, str) else '').encode('utf-8'))
            self._nodeLog(
                node, 'info', 'skill',
                NodeLogFormat.skillFinished(outputBlock.get('exit_code'), seqStdoutBytes),
            )

            # Phase 0: stash the skill stdout/script/argv for the execution trace.
            inputArg = callForFrontend['input']
            inputArg = inputArg if isinstance(inputArg, dict) else {}
            self.skillResultByNode[php_intval(node.get('id', 0))] = {
                'output': outputBlock,
                'script': inputArg.get('script'),
                'argv': _coalesce(inputArg.get('argv'), []),
            }

            assistantToolCall = {
                'id': toolCallId,
                'type': 'function',
                'function': {
                    'name': callForFrontend['name'],
                    'arguments': php_json_encode(_coalesce(callForFrontend['input'], {})),
                },
            }
            if call.get('thought_signature'):
                assistantToolCall['thought_signature'] = call['thought_signature']

            history.append({'role': 'user', 'content': currentTask})
            assistantMsg: dict = {'role': 'assistant'}
            if assistantReasoning != '':
                assistantMsg['reasoning_content'] = assistantReasoning
            assistantMsg['content'] = assistantText
            assistantMsg['tool_calls'] = [assistantToolCall]
            history.append(assistantMsg)
            history.append({
                'role': 'tool',
                'tool_call_id': toolCallId,
                'name': callForFrontend['name'],
                # json_encode($bridgeResult, JSON_UNESCAPED_SLASHES): unicode
                # escaped (\uXXXX), '/' literal.
                'content': json.dumps(bridgeResult, ensure_ascii=True, separators=(',', ':')),
            })

            # After the first tool round, drop any forced tool_choice.
            runContext.pop('tool_choice', None)
            currentTask = ''

        return result if result is not None else {'success': False, 'text': ''}

    # ─── Output schema / output node ─────────────────────────────────────────

    def _resolveOutputSchema(self, config: dict, userId: int) -> dict | None:
        """Resolve the output schema configured on a node (PHP 1384-1420)."""
        inline = config.get('output_schema')
        if not php_empty(inline) and isinstance(inline, dict):
            if 'schema' in inline:
                return {
                    'name': _coalesce(inline.get('name'), 'output'),
                    'description': _coalesce(inline.get('description'), ''),
                    'strict': php_bool(_coalesce(inline.get('strict'), True)),
                    'schema': inline.get('schema'),
                }
            if 'type' in inline or 'properties' in inline:
                return {'name': 'output', 'description': '', 'strict': True, 'schema': inline}

        schemaId = config.get('output_schema_id')
        if not php_empty(schemaId) and self.schemaRepository:
            schemaId = php_intval(schemaId)
            schema = self.schemaRepository.findById(schemaId)
            if schema and schema.getUserId() == userId:
                return schema.toOutputSchema()
            error_log(f"[GraphWorkflowRunner] Output schema id {schemaId} not found or not owned by user {userId}")

        return None

    def _executeOutputNode(self, node: dict, edges: list, executedNodes: list) -> dict:
        """Execute an output node: aggregates all incoming inputs (PHP 1426-1474)."""
        inputs = []
        inputSources = []

        for edge in edges:
            if php_intval(edge.get('to_node_id')) == php_intval(node.get('id')):
                fromNodeId = php_intval(edge.get('from_node_id'))

                if fromNodeId in self.nodeOutputs:
                    out = self.nodeOutputs[fromNodeId]
                    output = _coalesce(out.get('output') if isinstance(out, dict) else None, '')
                    sourceName = _coalesce(
                        out.get('agent_name') if isinstance(out, dict) else None,
                        out.get('type') if isinstance(out, dict) else None,
                        f"Node {fromNodeId}",
                    )

                    inputs.append({'source': sourceName, 'output': output, 'node_id': fromNodeId})
                    inputSources.append(sourceName)

        if len(inputs) == 1:
            return {'type': 'output', 'output': inputs[0]['output']}

        combined = [f"## 📄 {i['source']}\n\n{i['output']}" for i in inputs]

        error_log(
            f"[GraphWorkflowRunner] Output node aggregating {len(inputs)} inputs from: "
            + ', '.join(inputSources)
        )

        return {
            'type': 'output',
            'inputs_count': len(inputs),
            'input_sources': inputSources,
            'output': "\n\n---\n\n".join(combined),
        }

    def _getInputForNode(self, nodeId: int, edges: list, executedNodes: list | None = None) -> str:
        """Get input for a node from its incoming edges. Uses the most
        recently executed incoming node for robustness (PHP 1480-1511)."""
        executedNodes = executedNodes if executedNodes is not None else []
        incomingOutputs: dict = {}

        for edge in edges:
            if php_intval(edge.get('to_node_id')) == nodeId:
                fromNodeId = php_intval(edge.get('from_node_id'))
                if fromNodeId in self.nodeOutputs:
                    incomingOutputs[fromNodeId] = self.nodeOutputs[fromNodeId]

        if php_empty(incomingOutputs):
            return ''

        if not php_empty(executedNodes):
            for executedNodeId in reversed(executedNodes):
                if executedNodeId in incomingOutputs:
                    out = incomingOutputs[executedNodeId]
                    return _coalesce(out.get('output') if isinstance(out, dict) else None, '')

        lastOutput = list(incomingOutputs.values())[-1]
        return _coalesce(lastOutput.get('output') if isinstance(lastOutput, dict) else None, '')

    # ─── Context building / merge strategies ─────────────────────────────────

    def _buildContextForNode(self, nodeId: int, edges: list, executedNodes: list, mergeStrategy: str = 'labeled') -> str:
        """Build context string from previous node outputs (PHP 1522-1585)."""
        inputs = []
        incomingEdgeCount = 0

        availableOutputs = list(self.nodeOutputs.keys())
        error_log(
            f"[GraphWorkflowRunner] buildContextForNode({nodeId}): Available outputs from nodes: "
            + php_json_encode(availableOutputs)
        )

        for edge in edges:
            if php_intval(edge.get('to_node_id')) == nodeId:
                incomingEdgeCount += 1
                fromNodeId = php_intval(edge.get('from_node_id'))
                toPort = _coalesce(edge.get('to_port'), 'input_1')

                error_log(f"[GraphWorkflowRunner] buildContextForNode({nodeId}): Found incoming edge from node {fromNodeId}")

                if fromNodeId in self.nodeOutputs:
                    output = self.nodeOutputs[fromNodeId]
                    agentName = _coalesce(output.get('agent_name'), output.get('type'), 'Unknown')
                    outLen = len(_coalesce(output.get('output'), ''))
                    error_log(
                        f"[GraphWorkflowRunner] buildContextForNode({nodeId}): Output from {fromNodeId} "
                        f"({agentName}) exists, length: {outLen}"
                    )

                    if not php_empty(output.get('output')):
                        content = output.get('output')
                        isStructured = not php_empty(output.get('structured'))
                        if isStructured:
                            schemaName = _coalesce(output.get('schema_name'), 'output')
                            content = f'```json schema="{schemaName}"\n{output.get("output")}\n```'

                        inputs.append({
                            'source': agentName,
                            'port': toPort,
                            'content': content,
                            'from_node_id': fromNodeId,
                            'structured': isStructured,
                        })
                    else:
                        error_log(f"[GraphWorkflowRunner] buildContextForNode({nodeId}): WARNING - Output from {fromNodeId} is empty!")
                else:
                    error_log(f"[GraphWorkflowRunner] buildContextForNode({nodeId}): WARNING - No output found for node {fromNodeId}!")

        error_log(
            f"[GraphWorkflowRunner] buildContextForNode({nodeId}): Found {incomingEdgeCount} incoming edges, "
            f"{{{len(inputs)}}} valid inputs, strategy: {mergeStrategy}"
        )

        if not inputs:
            return ''

        if len(inputs) == 1:
            error_log(f"[GraphWorkflowRunner] buildContextForNode({nodeId}): Single input, returning as-is")
            return inputs[0]['content']

        error_log(f"[GraphWorkflowRunner] buildContextForNode({nodeId}): Merging {len(inputs)} inputs with strategy: {mergeStrategy}")
        return self._applyMergeStrategy(inputs, mergeStrategy)

    def _applyMergeStrategy(self, inputs: list, strategy: str) -> str:
        """Apply merge strategy to combine multiple inputs (PHP 1594-1607)."""
        if strategy == 'concatenate':
            return "\n\n".join(i['content'] for i in inputs)
        if strategy == 'json':
            mapped = [{'source': i['source'], 'content': i['content']} for i in inputs]
            # JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE (no JSON_UNESCAPED_SLASHES) — PHP 1600.
            return dumps_pretty(mapped, unescaped=True, unescape_slashes=False)
        if strategy == 'numbered':
            return self._formatNumberedInputs(inputs)
        if strategy == 'xml':
            return self._formatXmlInputs(inputs)
        if strategy == 'labeled':
            return self._formatLabeledInputs(inputs)
        return self._formatLabeledInputs(inputs)

    def _formatNumberedInputs(self, inputs: list) -> str:
        """Format inputs with numbered sections (PHP 1612-1620)."""
        parts = []
        for i, inp in enumerate(inputs):
            parts.append(f"[Input {i + 1} - {inp['source']}]\n{inp['content']}")
        return "\n\n".join(parts)

    def _formatXmlInputs(self, inputs: list) -> str:
        """Format inputs with XML-style tags (PHP 1625-1633). PHP computes a
        `safeName` (regex-sanitized source) but never uses it in the output —
        this is dead code in PHP; elided here since it has zero effect on the
        returned string."""
        parts = []
        for i, inp in enumerate(inputs):
            parts.append(f'<input source="{inp["source"]}" index="{i + 1}">\n{inp["content"]}\n</input>')
        return "\n\n".join(parts)

    def _formatLabeledInputs(self, inputs: list) -> str:
        """Format inputs with labeled sections — the default (PHP 1638-1645)."""
        return "\n\n".join(f"[{inp['source']}]:\n{inp['content']}" for inp in inputs)

    def _collectFinalOutput(self, outputNodeId: int, edges: list) -> str:
        """Collect final output at the output node (PHP 1650-1653)."""
        out = self.nodeOutputs.get(outputNodeId)
        val = out.get('output') if isinstance(out, dict) else None
        return _coalesce(val, '')

    # ─── Execution record persistence ────────────────────────────────────────

    def _createExecution(self, workflow: Workflow, userId: int, inputVariables: dict) -> int:
        """Create workflow execution record (PHP 1658-1671)."""
        return self.db.insert(
            "INSERT INTO agent_workflow_executions (workflow_id, user_id, input_variables, status, started_at)\n"
            "             VALUES (?, ?, ?, 'running', NOW())",
            [workflow.getId(), userId, php_json_encode(inputVariables)],
        )

    def _completeExecution(self, executionId: int, outputs: dict, responseTime: float) -> None:
        """Complete workflow execution (PHP 1676-1689)."""
        self._ensureDbConnection()
        self.db.execute(
            "UPDATE agent_workflow_executions\n"
            "             SET status = 'completed', output = ?, response_time_ms = ?, completed_at = NOW()\n"
            "             WHERE id = ?",
            [php_json_encode(outputs), php_intval(responseTime), executionId],
        )

    def _failExecution(self, executionId: int, error: str) -> None:
        """Fail workflow execution (PHP 1694-1703)."""
        self._ensureDbConnection()
        self.db.execute(
            "UPDATE agent_workflow_executions\n"
            "             SET status = 'failed', error_message = ?, completed_at = NOW()\n"
            "             WHERE id = ?",
            [error, executionId],
        )

    def _ensureDbConnection(self) -> None:
        """Ensure DB connection is alive, reconnect if needed (PHP 1708-1729).

        PHP manually pings with `SELECT 1` and, on failure, rebuilds the PDO
        handle AND recreates graphRepository/agentRepository/traceStore
        around it. Here, `Db._run()` (app/db.py, the Task 2a reconnect
        helper — see tests/unit/test_db_reconnect.py) already retries once
        on a "gone away" error by reconnecting the SAME `Db` instance in
        place; since agentRepository/graphRepository/traceStore all hold a
        reference to that same `Db` object (not a raw connection handle), a
        reconnect is visible to them without recreating anything. This is
        therefore a lightweight probe + log, not a manual rebuild."""
        try:
            self.db.fetch_one('SELECT 1')
        except Exception as e:  # noqa: BLE001 -- mirrors PHP catch (\PDOException $e)
            error_log(f"[GraphWorkflowRunner] DB connection check failed: {e}")

    def _findAgentNodesInList(self, nodeIds: list, nodes: dict, executedNodes: list) -> list:
        """Find agent nodes from a list of node IDs — implicit-parallelism
        detection (PHP 1735-1752)."""
        agentNodes = []
        for nodeId in nodeIds:
            if nodeId in executedNodes:
                continue
            node = nodes.get(nodeId)
            if node and node.get('node_type') == 'agent':
                agentNodes.append(node)
        return agentNodes

    # ─── Task 5b stubs: parallel execution / client-tool bridge (parallel) ──

    def _finalizeParallelNode(self, nodeId: int, state: dict, results: dict) -> None:
        """PHP 1760-1805."""
        raise NotImplementedError('Task 5b')

    def _executeAgentsInParallel(
        self, agentNodes: list, userId: int, userPrompt: str, edges: list, executedNodes: list
    ) -> dict:
        """PHP 1811-2159."""
        raise NotImplementedError('Task 5b')

    def _getParallelExecutor(self):
        """PHP 2160-2172 (`protected function getParallelExecutor(): ParallelAgentExecutor`)."""
        raise NotImplementedError('Task 5b')

    def _isClientSideToolName(self, name: str) -> bool:
        """PHP 2173-2195."""
        raise NotImplementedError('Task 5b')

    def _emitClientToolCallInParallel(self, toolCall: dict, node: dict, assistantText: str) -> None:
        """PHP 2196-2230."""
        raise NotImplementedError('Task 5b')

    def _awaitClientToolResultInParallel(self, toolCall: dict, node: dict) -> str:
        """PHP 2231-2261."""
        raise NotImplementedError('Task 5b')

    def _executeToolForParallel(self, toolCall: dict, toolsFilter: list | None) -> str:
        """PHP 2262-2281."""
        raise NotImplementedError('Task 5b')

    def _buildToolsForParallelAgent(self, agent: Agent, toolsFilter: list | None) -> list:
        """PHP 2282-2297."""
        raise NotImplementedError('Task 5b')

    def _executeAgentsInParallelNoTools(
        self, agentNodes: list, userId: int, userPrompt: str, edges: list, executedNodes: list
    ) -> dict:
        """PHP 2298-2503."""
        raise NotImplementedError('Task 5b')

    def _buildAgentLLMRequest(self, agent: Agent, task: str, nodeConfig: dict | None = None) -> dict | None:
        """PHP 2504-2767."""
        raise NotImplementedError('Task 5b')

    def _parseAgentLLMResponse(self, response: str, provider: str) -> dict:
        """PHP 2768-2827."""
        raise NotImplementedError('Task 5b')

    # ─── Documents: buildDocumentsContext ported for real (see module docstring) ──

    def _buildDocumentsContext(self, node: dict) -> str:
        """Build the `## Attached Documents` context block for a node (PHP
        2828-2860). Early-returns '' when the node has no `config.documents`
        (the case every 5a test exercises); with documents present, the
        per-document `isImageFile`/`readDocumentContent` reads defer to the
        literal Task 5b stubs below — see module docstring."""
        config = node.get('config')
        config = config if isinstance(config, dict) else {}
        documents = _coalesce(config.get('documents'), [])
        if php_empty(documents):
            return ''

        textParts = ["## Attached Documents\n"]
        imageCount = 0

        for doc in documents:
            doc = doc if isinstance(doc, dict) else {}
            if self._isImageFile(_coalesce(doc.get('mimeType'), '')):
                imageCount += 1
                continue  # Images are handled separately for multimodal

            try:
                content = self._readDocumentContent(doc)
                if not php_empty(content):
                    textParts.append(f"### {doc.get('name')}\n```\n{content}\n```\n")
            except Exception as e:  # noqa: BLE001 -- mirrors PHP catch (\Exception $e)
                error_log(f"[GraphWorkflowRunner] Error reading document {doc.get('name')}: {e}")
                textParts.append(f"### {doc.get('name')}\n[Error: Could not read document]\n")

        if imageCount > 0:
            textParts.append(f"\n_Note: {imageCount} image(s) attached (processed separately if model supports vision)_\n")

        return "\n".join(textParts) if len(textParts) > 1 else ''

    # ─── Task 5b stubs: documents (leaf reads) ───────────────────────────────

    def _getDocumentImages(self, node: dict) -> list:
        """PHP 2866-2901."""
        raise NotImplementedError('Task 5b')

    def _readDocumentContent(self, doc: dict) -> str:
        """PHP 2906-2965."""
        raise NotImplementedError('Task 5b')

    def _readFileRaw(self, doc: dict) -> str | None:
        """PHP 2966-3000."""
        raise NotImplementedError('Task 5b')

    def _extractPdfText(self, doc: dict) -> str:
        """PHP 3001-3033."""
        raise NotImplementedError('Task 5b')

    def _basicPdfTextExtract(self, pdfContent: str) -> str:
        """PHP 3034-3060."""
        raise NotImplementedError('Task 5b')

    def _isImageFile(self, mimeType: str) -> bool:
        """PHP 3061-3068."""
        raise NotImplementedError('Task 5b')

    def _getDocumentStorageAdapter(self, userId: int | None = None):
        """PHP 3069-3122."""
        raise NotImplementedError('Task 5b')

    def _getUserStorageProvider(self, userId: int) -> str:
        """PHP 3127-3146."""
        raise NotImplementedError('Task 5b')

    def _getDocumentLocalPath(self, relativePath: str) -> str:
        """PHP 3151-3155."""
        raise NotImplementedError('Task 5b')

    # ─── Archive to conversation_contexts ────────────────────────────────────

    def _archiveRunToConversationContexts(
        self, userId: int, workflowId: int, workflowName: str, userPrompt: str, finalOutput: str
    ) -> None:
        """Archive a completed workflow run into conversation_contexts so it
        appears in the chat sidebar and is searchable via session_search
        (PHP 3177-3237)."""
        if userId <= 0:
            return

        archiveOutput = self._buildArchiveOutput(finalOutput)
        if archiveOutput == '' and php_trim(userPrompt) == '':
            return  # nothing worth archiving

        contextsDb = SessionSearchService.connectFromConfig(self.config)
        try:
            messages = [
                {'role': 'user', 'content': userPrompt},
                {'role': 'assistant', 'content': archiveOutput},
            ]
            contextData = _json_encode_unescaped_unicode({'messages': messages})

            title = php_trim(userPrompt)
            if title == '':
                title = f'(no prompt) — {workflowName}'
            if len(title) > 60:
                title = mb_substr(title, 0, 60) + '…'

            provider = f'workflow:{workflowId}'
            messageCount = len(messages)

            newId = contextsDb.insert(
                "INSERT INTO conversation_contexts\n"
                "              (user_id, title, context_data, provider, message_count)\n"
                "            VALUES\n"
                "              (:user_id, :title, :context_data, :provider, :message_count)",
                {
                    'user_id': userId,
                    'title': title,
                    'context_data': contextData,
                    'provider': provider,
                    'message_count': messageCount,
                },
            )

            error_log(
                f"[GraphWorkflowRunner] Archived workflow {workflowId} ({workflowName}) to "
                f"conversation_contexts id={newId}"
            )
        finally:
            contextsDb.close()

    def _buildArchiveOutput(self, finalOutput: str) -> str:
        """Build the content written to the archive row (PHP 3250-3286)."""
        finalOutput = php_trim(finalOutput)
        if finalOutput == '':
            return self._pickMarkdownAgentOutput()

        if not self._isHtmlShaped(finalOutput):
            return finalOutput

        # No Python port of league/html-to-markdown exists in this backend.
        # PHP itself guards this with `class_exists(HtmlConverter::class)`
        # and falls back to the walk-back heuristic when the library isn't
        # installed (PHP 3279-3281) — that PHP fallback branch is the one
        # exercised here.
        error_log('[GraphWorkflowRunner] league/html-to-markdown not installed; falling back to walk-back heuristic')
        return self._pickMarkdownAgentOutput()

    def _pickMarkdownAgentOutput(self) -> str:
        """Walk nodeOutputs in reverse insertion order and return the most
        recent agent output that is plain markdown (not HTML-shaped) (PHP 3295-3319)."""
        reversedItems = list(reversed(list(self.nodeOutputs.items())))

        for _, nodeOutput in reversedItems:
            text = php_strval(nodeOutput.get('output')) if isinstance(nodeOutput, dict) else ''
            text = php_trim(text)
            if text == '' or self._isHtmlShaped(text):
                continue
            return text

        # Fallback: every output looked HTML-ish.
        for _, nodeOutput in reversedItems:
            text = php_strval(nodeOutput.get('output')) if isinstance(nodeOutput, dict) else ''
            text = php_trim(text)
            if text != '':
                return text

        return ''

    def _isHtmlShaped(self, content: str) -> bool:
        """Heuristic: does this content contain HTML that should be converted? (PHP 3328-3361)."""
        if php_trim(content) == '':
            return False

        lower = content.lower()
        if '<!doctype' in lower:
            return True
        if '<html' in lower:
            return True
        if '<body' in lower:
            return True
        if '<head>' in lower:
            return True

        tags = re.findall(r'<[a-zA-Z][^>]*>', content)
        if tags:
            tagChars = sum(len(t.encode('utf-8')) for t in tags)
            total = len(content.encode('utf-8'))
            return total > 0 and (tagChars / total) > 0.15

        return False
