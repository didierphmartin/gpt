<?php

declare(strict_types=1);

namespace AgentTeam\Controllers;

use AgentTeam\Models\Workflow;
use AgentTeam\Services\WorkflowRepository;
use AgentTeam\Services\WorkflowRunner;
use AgentTeam\Services\WorkflowOutputStorage;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\AgentRunner;
use AgentTeam\Services\StreamContext;
use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;
use Quantis\AIPortfolioAssistant\Services\LLMProviderResolver;
use PDO;

/**
 * Workflow Controller
 *
 * Handles REST API endpoints for workflow management and execution.
 *
 * @see docs/agentDesign.md
 */
class WorkflowController
{
    private PDO $db;
    private array $config;
    private WorkflowRepository $workflowRepository;
    private WorkflowRunner $workflowRunner;
    private \AgentTeam\Services\WorkflowGraphRepository $graphRepository;
    private \AgentTeam\Services\GraphWorkflowRunner $graphWorkflowRunner;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;

        // Create repositories and services
        $this->workflowRepository = new WorkflowRepository($db);

        $agentRepository = new AgentRepository($db);

        // Create AIPortfolioAssistant for LLMManager and ToolsManager.
        // DB-overlay first so the assistant registers all providers from
        // system_llm_settings (post-cutover the file no longer has providers).
        $config = LLMProviderResolver::applyDbSettings($db, $config);
        $this->config = $config;
        $assistant = new AIPortfolioAssistant($config);
        $assistant->setDatabase($db);

        $mcpToolsLoader = new MCPToolsLoader($db);

        $agentRunner = new AgentRunner(
            $assistant->getLLMManager(),
            $assistant->getToolsManager(),
            $mcpToolsLoader,
            $db,
            $config
        );

        $this->workflowRunner = new WorkflowRunner($db, $agentRepository, $agentRunner, $config);
        $this->graphRepository = $this->workflowRepository->getGraphRepository();
        $this->graphWorkflowRunner = new \AgentTeam\Services\GraphWorkflowRunner(
            $db,
            $agentRepository,
            $agentRunner,
            $this->graphRepository,
            $config
        );
    }

    /**
     * GET /api/v1/workflows
     * List all workflows for the authenticated user
     */
    public function index(array $request): array
    {
        $userId = $request['user_id'] ?? 0;

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        try {
            // Pass false for $includeGraph to skip the per-workflow graph
            // fetch — the sidebar list doesn't need node/edge data and
            // pulling it triggers an N+1 (one query per workflow's nodes
            // PLUS one for its edges). On a remote DB that's seconds of
            // round-trip latency for a 10-workflow list. We still need
            // runtime_mode for the icon (🎙 realtime vs ⚙️ batch), so we
            // batch-detect it with a single extra query and override
            // the toApiArray()'s fallback 'batch' result below.
            $workflows = $this->workflowRepository->findByUser($userId, false);

            $ids = array_map(fn($w) => $w->getId(), $workflows);
            $realtimeIds = $this->graphRepository->findRealtimeWorkflowIds($ids);
            $realtimeSet = array_flip($realtimeIds);

            return [
                'success' => true,
                'data' => array_map(function($workflow) use ($realtimeSet) {
                    $arr = $workflow->toApiArray();
                    $arr['runtime_mode'] = isset($realtimeSet[$workflow->getId()]) ? 'realtime' : 'batch';
                    return $arr;
                }, $workflows),
                'count' => count($workflows),
                'status_code' => 200
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * POST /api/v1/workflows
     * Create a new workflow
     */
    public function create(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $body = $request['body'] ?? [];

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        // Validate required fields
        if (empty($body['name'])) {
            return [
                'success' => false,
                'error' => 'Workflow name is required',
                'status_code' => 400
            ];
        }

        // Check for graph-based workflow (from visual editor)
        // Note: Empty workflows are allowed - user can add nodes later
        $hasGraph = !empty($body['definition']['nodes']) || !empty($body['graph']['nodes']);
        $hasSteps = !empty($body['steps']) && \is_array($body['steps']);

        try {
            $workflow = new Workflow();
            $workflow->setUserId($userId)
                     ->setName($body['name'])
                     ->setDescription($body['description'] ?? '')
                     ->setTriggers($body['triggers'] ?? [])
                     ->setVariables($body['variables'] ?? [])
                     ->setEnabled($body['enabled'] ?? true)
                     ->setWorkspaceId($body['workspace_id'] ?? null)
                     ->setOutputStorageEnabled((bool) ($body['output_storage_enabled'] ?? false))
                     ->setOutputFolder($body['output_folder'] ?? null);

            // Set steps (for backward compatibility or legacy workflows)
            if ($hasSteps) {
                $workflow->setSteps($body['steps']);

                // Validate steps
                $errors = $workflow->validateSteps();
                if (!empty($errors)) {
                    return [
                        'success' => false,
                        'error' => 'Invalid workflow steps',
                        'validation_errors' => $errors,
                        'status_code' => 400
                    ];
                }
            } else {
                // For graph-based workflows, set empty steps (graph is source of truth)
                $workflow->setSteps([]);
            }

            // Create the workflow first to get its ID
            $created = $this->workflowRepository->create($workflow);

            error_log("[WorkflowController] Created workflow ID: " . $created->getId());
            error_log("[WorkflowController] hasGraph: " . ($hasGraph ? 'true' : 'false'));

            // If we have graph data, save it
            if ($hasGraph) {
                $graphData = $body['definition'] ?? $body['graph'] ?? [];
                $nodes = $graphData['nodes'] ?? $graphData['steps'] ?? [];
                $edges = $graphData['edges'] ?? [];

                error_log("[WorkflowController] Saving graph with " . count($nodes) . " nodes and " . count($edges) . " edges");

                try {
                    $this->graphRepository->saveGraph($created->getId(), $nodes, $edges);
                    error_log("[WorkflowController] Graph saved successfully");
                } catch (\Exception $e) {
                    error_log("[WorkflowController] Error saving graph: " . $e->getMessage());
                    throw $e;
                }

                // Reload with graph data
                $created = $this->workflowRepository->findById($created->getId(), true);
            }

            return [
                'success' => true,
                'data' => $created->toArray(),
                'message' => 'Workflow created successfully',
                'status_code' => 201
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * GET /api/v1/workflows/{id}/generate-python
     * Generate a standalone LangGraph Python script from the workflow.
     *
     * Returns either:
     *   - Content-Type: text/x-python  (raw source) when ?download=1
     *   - application/json {filename, code} otherwise (default)
     */
    public function generatePython(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        $download = ($request['query']['download'] ?? '0') === '1';

        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        if (!$workflowId) {
            return ['success' => false, 'error' => 'Workflow ID is required', 'status_code' => 400];
        }

        try {
            if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
                return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
            }

            $agentRepo = new \AgentTeam\Services\AgentRepository($this->db);
            $gen = new \AgentTeam\Services\LangGraphGenerator(
                $this->db,
                $this->workflowRepository,
                $this->graphRepository,
                $agentRepo
            );
            $result = $gen->generate($workflowId, (string) $userId);

            if ($download) {
                return [
                    'success' => true,
                    'raw_body' => $result['code'],
                    'headers' => [
                        'Content-Type' => 'text/x-python; charset=utf-8',
                        'Content-Disposition' => 'attachment; filename="' . $result['filename'] . '"',
                    ],
                    'status_code' => 200,
                ];
            }

            return [
                'success' => true,
                'data' => $result,
                'status_code' => 200,
            ];
        } catch (\Throwable $e) {
            error_log('[WorkflowController] generatePython failed: ' . $e->getMessage());
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 500];
        }
    }

    /**
     * GET /api/v1/workflows/{id}/generate-adk
     * Generate a standalone Google ADK Python script from the workflow.
     *
     * Returns either:
     *   - Content-Type: text/x-python  (raw source) when ?download=1
     *   - application/json {filename, code} otherwise (default)
     */
    public function generateAdk(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        $download = ($request['query']['download'] ?? '0') === '1';

        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        if (!$workflowId) {
            return ['success' => false, 'error' => 'Workflow ID is required', 'status_code' => 400];
        }

        try {
            if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
                return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
            }

            $agentRepo = new \AgentTeam\Services\AgentRepository($this->db);
            $gen = new \AgentTeam\Services\ADKGenerator(
                $this->db,
                $this->workflowRepository,
                $this->graphRepository,
                $agentRepo
            );
            $result = $gen->generate($workflowId, (string) $userId);

            if ($download) {
                return [
                    'success' => true,
                    'raw_body' => $result['code'],
                    'headers' => [
                        'Content-Type' => 'text/x-python; charset=utf-8',
                        'Content-Disposition' => 'attachment; filename="' . $result['filename'] . '"',
                    ],
                    'status_code' => 200,
                ];
            }

            return [
                'success' => true,
                'data' => $result,
                'status_code' => 200,
            ];
        } catch (\Throwable $e) {
            error_log('[WorkflowController] generateAdk failed: ' . $e->getMessage());
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 500];
        }
    }

    /**
     * GET /api/v1/workflows/{id}/generate-maf
     * Generate a standalone MAF Python script from the workflow.
     *
     * Returns either:
     *   - Content-Type: text/x-python  (raw source) when ?download=1
     *   - application/json {filename, code} otherwise (default)
     */
    public function generateMaf(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        $download = ($request['query']['download'] ?? '0') === '1';

        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        if (!$workflowId) {
            return ['success' => false, 'error' => 'Workflow ID is required', 'status_code' => 400];
        }

        try {
            if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
                return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
            }

            $agentRepo = new \AgentTeam\Services\AgentRepository($this->db);
            $gen = new \AgentTeam\Services\MAFGenerator(
                $this->db,
                $this->workflowRepository,
                $this->graphRepository,
                $agentRepo
            );
            $result = $gen->generate($workflowId, (string) $userId);

            if ($download) {
                return [
                    'success' => true,
                    'raw_body' => $result['code'],
                    'headers' => [
                        'Content-Type' => 'text/x-python; charset=utf-8',
                        'Content-Disposition' => 'attachment; filename="' . $result['filename'] . '"',
                    ],
                    'status_code' => 200,
                ];
            }

            return [
                'success' => true,
                'data' => $result,
                'status_code' => 200,
            ];
        } catch (\Throwable $e) {
            error_log('[WorkflowController] generateMaf failed: ' . $e->getMessage());
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 500];
        }
    }

    /**
     * GET /api/v1/workflows/{id}
     * Get a specific workflow
     */
    public function show(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        $query = $request['query'] ?? [];

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        if (!$workflowId) {
            return [
                'success' => false,
                'error' => 'Workflow ID is required',
                'status_code' => 400
            ];
        }

        try {
            if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
                return [
                    'success' => false,
                    'error' => 'Workflow not found or access denied',
                    'status_code' => 404
                ];
            }

            // Include graph data by default or if requested
            $includeGraph = ($query['include_graph'] ?? 'true') !== 'false';
            $workflow = $this->workflowRepository->findById($workflowId, $includeGraph);

            if (!$workflow) {
                return [
                    'success' => false,
                    'error' => 'Workflow not found',
                    'status_code' => 404
                ];
            }

            return [
                'success' => true,
                'data' => $workflow->toArray(),
                'status_code' => 200
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * PUT /api/v1/workflows/{id}
     * Update a workflow
     */
    public function update(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        $body = $request['body'] ?? [];

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        if (!$workflowId) {
            return [
                'success' => false,
                'error' => 'Workflow ID is required',
                'status_code' => 400
            ];
        }

        try {
            if (!$this->workflowRepository->isOwner($userId, $workflowId)) {
                return [
                    'success' => false,
                    'error' => 'Workflow not found or access denied',
                    'status_code' => 404
                ];
            }

            $workflow = $this->workflowRepository->findById($workflowId);

            if (!$workflow) {
                return [
                    'success' => false,
                    'error' => 'Workflow not found',
                    'status_code' => 404
                ];
            }

            // Update fields
            if (isset($body['name'])) {
                $workflow->setName($body['name']);
            }
            if (isset($body['description'])) {
                $workflow->setDescription($body['description']);
            }
            if (isset($body['steps'])) {
                $workflow->setSteps($body['steps']);
            }
            if (isset($body['triggers'])) {
                $workflow->setTriggers($body['triggers']);
            }
            if (isset($body['variables'])) {
                $workflow->setVariables($body['variables']);
            }
            if (isset($body['enabled'])) {
                $workflow->setEnabled((bool) $body['enabled']);
            }
            if (isset($body['workspace_id'])) {
                $workflow->setWorkspaceId($body['workspace_id']);
            }
            if (isset($body['output_storage_enabled'])) {
                $workflow->setOutputStorageEnabled((bool) $body['output_storage_enabled']);
            }
            if (array_key_exists('output_folder', $body)) {
                $workflow->setOutputFolder($body['output_folder']);
            }

            // Check for graph-based workflow (from visual editor)
            $hasGraph = !empty($body['definition']['nodes']) || !empty($body['graph']['nodes']);

            // Validate steps if updated (only for legacy workflows)
            if (isset($body['steps']) && !$hasGraph) {
                $errors = $workflow->validateSteps();
                if (!empty($errors)) {
                    return [
                        'success' => false,
                        'error' => 'Invalid workflow steps',
                        'validation_errors' => $errors,
                        'status_code' => 400
                    ];
                }
            }

            // Update the workflow metadata
            $updated = $this->workflowRepository->update($workflow);

            error_log("[WorkflowController] Update - hasGraph: " . ($hasGraph ? 'true' : 'false'));

            // If we have graph data, update it
            if ($hasGraph) {
                $graphData = $body['definition'] ?? $body['graph'] ?? [];
                $nodes = $graphData['nodes'] ?? $graphData['steps'] ?? [];
                $edges = $graphData['edges'] ?? [];

                error_log("[WorkflowController] Updating graph with " . count($nodes) . " nodes and " . count($edges) . " edges");

                // Validate the graph
                // First clear and save, then validate
                try {
                    $this->graphRepository->saveGraph($workflowId, $nodes, $edges);
                    error_log("[WorkflowController] Graph updated successfully");
                } catch (\Exception $e) {
                    error_log("[WorkflowController] Error updating graph: " . $e->getMessage());
                    throw $e;
                }

                // Note: Validation is done when running the workflow, not when saving
                // This allows saving work-in-progress workflows with incomplete connections

                // Reload with graph data
                $updated = $this->workflowRepository->findById($workflowId, true);
            }

            return [
                'success' => true,
                'data' => $updated->toArray(),
                'message' => 'Workflow updated successfully',
                'status_code' => 200
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * DELETE /api/v1/workflows/{id}
     * Delete a workflow
     */
    public function destroy(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        if (!$workflowId) {
            return [
                'success' => false,
                'error' => 'Workflow ID is required',
                'status_code' => 400
            ];
        }

        try {
            if (!$this->workflowRepository->isOwner($userId, $workflowId)) {
                return [
                    'success' => false,
                    'error' => 'Workflow not found or access denied',
                    'status_code' => 404
                ];
            }

            $this->workflowRepository->delete($workflowId);

            return [
                'success' => true,
                'message' => 'Workflow deleted successfully',
                'status_code' => 200
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * POST /api/v1/workflows/{id}/run
     * Execute a workflow
     */
    public function run(array $request): array
    {
        // Multi-agent runs routinely exceed PHP's default 120s — raise to the
        // same ceiling ChatController uses (600s). Without this, a long run is
        // killed mid-flight and the caller gets a connection error, not JSON.
        @set_time_limit(600);

        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        $body = $request['body'] ?? [];

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        if (!$workflowId) {
            return [
                'success' => false,
                'error' => 'Workflow ID is required',
                'status_code' => 400
            ];
        }

        // App-key auth is scope-gated. A JWT-authed user reaches the
        // ownership check below unrestricted; an app key must explicitly
        // carry `workflows:run` or `workflows:run:<id>` in its scopes.
        // ($userId is already the app key's bound user — set by the
        // middleware — so the canUserAccess() ownership check still holds.)
        if (($request['auth_type'] ?? null) === 'app_key') {
            $scopes = $request['app_key_scopes'] ?? [];
            $scopeAllowed = in_array('workflows:run', $scopes, true)
                || in_array("workflows:run:{$workflowId}", $scopes, true);
            if (!$scopeAllowed) {
                return [
                    'success' => false,
                    'error' => 'App key not authorized for this workflow (missing scope workflows:run)',
                    'status_code' => 403
                ];
            }
        }

        try {
            if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
                return [
                    'success' => false,
                    'error' => 'Workflow not found or access denied',
                    'status_code' => 404
                ];
            }

            $workflow = $this->workflowRepository->findById($workflowId);

            if (!$workflow) {
                return [
                    'success' => false,
                    'error' => 'Workflow not found',
                    'status_code' => 404
                ];
            }

            if (!$workflow->isEnabled()) {
                return [
                    'success' => false,
                    'error' => 'Workflow is disabled',
                    'status_code' => 400
                ];
            }

            // Get input variables from request
            $inputVariables = $body['variables'] ?? $body['inputs'] ?? [];

            // Check if this is a graph-based workflow
            $hasGraphNodes = $this->graphRepository->getNodes($workflowId);
            $isGraphWorkflow = !empty($hasGraphNodes);

            // Run the workflow with the appropriate runner
            if ($isGraphWorkflow) {
                $result = $this->graphWorkflowRunner->run($workflow, $userId, $inputVariables);
            } else {
                $result = $this->workflowRunner->run($workflow, $userId, $inputVariables);
            }

            $result['status_code'] = $result['success'] ? 200 : 500;

            return $result;
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * POST /api/v1/workflows/run
     * Execute a workflow addressed by name instead of numeric id.
     * Body: { workflow: string, variables?: object }
     *
     * The name is resolved against the caller's own workflows — (user_id,
     * name) is unique — and execution then delegates to run(), so the scope
     * check, ownership check, enabled check and run path are all identical
     * to the id-based endpoint. The numeric id never leaves the server.
     */
    public function runByName(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $body = $request['body'] ?? [];
        $name = trim((string) ($body['workflow'] ?? ''));

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }
        if ($name === '') {
            return [
                'success' => false,
                'error' => 'A "workflow" name is required',
                'status_code' => 400
            ];
        }

        $stmt = $this->db->prepare(
            "SELECT id FROM agent_workflows WHERE user_id = ? AND name = ? LIMIT 1"
        );
        $stmt->execute([$userId, $name]);
        $workflowId = $stmt->fetchColumn();

        if ($workflowId === false) {
            return [
                'success' => false,
                'error' => "No workflow named \"{$name}\" found for this account",
                'status_code' => 404
            ];
        }

        $request['params']['id'] = (int) $workflowId;
        return $this->run($request);
    }

    /**
     * POST /api/v1/workflows/{id}/run-stream
     * Execute a workflow with SSE streaming for real-time node updates
     */
    public function runStream(array $request): void
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        $body = $request['body'] ?? [];

        // Set SSE headers immediately
        header('Content-Type: text/event-stream');
        header('Cache-Control: no-cache');
        header('Connection: keep-alive');
        header('X-Accel-Buffering: no');

        // Disable output buffering
        if (ob_get_level()) {
            ob_end_clean();
        }

        // Create SSE callback
        $sseCallback = function ($event) {
            echo "data: " . json_encode($event) . "\n\n";
            if (ob_get_level()) {
                ob_flush();
            }
            flush();
        };

        // Validation
        if (!$userId) {
            $sseCallback(['type' => 'error', 'error' => 'Authentication required']);
            echo "data: [DONE]\n\n";
            flush();
            return;
        }

        if (!$workflowId) {
            $sseCallback(['type' => 'error', 'error' => 'Workflow ID is required']);
            echo "data: [DONE]\n\n";
            flush();
            return;
        }

        try {
            if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
                $sseCallback(['type' => 'error', 'error' => 'Workflow not found or access denied']);
                echo "data: [DONE]\n\n";
                flush();
                return;
            }

            $workflow = $this->workflowRepository->findById($workflowId);

            if (!$workflow) {
                $sseCallback(['type' => 'error', 'error' => 'Workflow not found']);
                echo "data: [DONE]\n\n";
                flush();
                return;
            }

            if (!$workflow->isEnabled()) {
                $sseCallback(['type' => 'error', 'error' => 'Workflow is disabled']);
                echo "data: [DONE]\n\n";
                flush();
                return;
            }

            // Get input variables from request
            $inputVariables = $body['variables'] ?? $body['inputs'] ?? [];

            // Inline folder-backed skill bundle from the browser. Only
            // present when the user has the editor open and at least one
            // node is bound to a local-FS skill — see
            // workflow-editor.js::_collectClientSkillsForRun.
            $clientSkills = is_array($body['client_skills'] ?? null) ? $body['client_skills'] : [];

            // Inline content for any locally-stored document attached to
            // a node. Browser reads files via the local FS adapter at run
            // start so the agent can see them like cloud-stored docs.
            $inlineDocuments = is_array($body['inline_documents'] ?? null) ? $body['inline_documents'] : [];

            // Scratch-file metadata for workflows that have a folder-backed
            // skill agent. The browser pre-stashes the file content for
            // Pyodide /scratch/<name> at tool-call time, and the agent's
            // prompt sees a "file at /scratch/<name>" reference instead
            // of the full body. Saves ~14K input tokens per LLM call.
            // See workflow-editor.js::_collectInlineDocumentsForRun.
            $scratchFiles = is_array($body['scratch_files'] ?? null) ? $body['scratch_files'] : [];
            error_log("[WorkflowController] runStream: inline_documents keys=" . json_encode(array_keys($inlineDocuments)) . ", scratch_files=" . json_encode(array_column($scratchFiles, 'path')) . ", client_skills keys=" . json_encode(array_keys($clientSkills)));

            // Check if this is a graph-based workflow
            $hasGraphNodes = $this->graphRepository->getNodes($workflowId);
            $isGraphWorkflow = !empty($hasGraphNodes);

            if ($isGraphWorkflow) {
                // Validate graph before running
                $validationErrors = $this->graphRepository->validateGraph($workflowId);
                if (!empty($validationErrors)) {
                    $sseCallback([
                        'type' => 'error',
                        'error' => 'Invalid workflow: ' . implode(', ', $validationErrors)
                    ]);
                    echo "data: [DONE]\n\n";
                    flush();
                    return;
                }

                // Create StreamContext for SSE events
                $streamContext = new StreamContext($sseCallback, $userId);
                $this->graphWorkflowRunner->setStreamContext($streamContext);

                // Run the graph workflow with streaming
                $result = $this->graphWorkflowRunner->run($workflow, $userId, $inputVariables, $clientSkills, $inlineDocuments, $scratchFiles);
            } else {
                // Old-style workflow doesn't support streaming
                $sseCallback(['type' => 'info', 'message' => 'Step-based workflow - running without streaming']);
                $result = $this->workflowRunner->run($workflow, $userId, $inputVariables);
                $sseCallback([
                    'type' => 'workflow_complete',
                    'success' => $result['success'] ?? false,
                    'output' => $result['output'] ?? null,
                    'node_outputs' => $result['node_outputs'] ?? [],
                ]);
            }

        } catch (\Throwable $e) {
            // Catch both Exception and Error (e.g., TypeError, Error)
            $sseCallback(['type' => 'error', 'error' => $e->getMessage()]);
        }

        echo "data: [DONE]\n\n";
        flush();
    }

    /**
     * POST /api/v1/workflows/tool-result
     * Browser-side dispatcher posts here after running a workflow's
     * client-side tool (run_skill_script). Body shape:
     *   { tool_call_id, success, output, log_messages?, outputs?, error? }
     * The runner's awaitResult() picks the file up and resumes.
     *
     * No DB, no per-user check beyond auth — the tool_call_id is
     * 32-char random hex (~128 bits) so a forged POST can't collide
     * with a real pending call.
     */
    public function toolResult(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        if (!$userId) {
            http_response_code(401);
            return ['error' => 'Authentication required'];
        }

        $body = $request['body'] ?? [];
        $toolCallId = isset($body['tool_call_id']) ? (string) $body['tool_call_id'] : '';
        if ($toolCallId === '' || !preg_match('/^[a-f0-9]{32}$/', $toolCallId)) {
            http_response_code(400);
            return ['error' => 'Invalid tool_call_id'];
        }

        $bridge = new \AgentTeam\Services\SkillToolBridge();
        $bridge->writeResult($toolCallId, $body);
        return ['success' => true];
    }

    /**
     * GET /api/v1/workflows/{id}/executions
     * Get execution history for a workflow
     */
    public function executions(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        $query = $request['query'] ?? [];

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        if (!$workflowId) {
            return [
                'success' => false,
                'error' => 'Workflow ID is required',
                'status_code' => 400
            ];
        }

        try {
            if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
                return [
                    'success' => false,
                    'error' => 'Workflow not found or access denied',
                    'status_code' => 404
                ];
            }

            $limit = isset($query['limit']) ? (int) $query['limit'] : 50;
            $offset = isset($query['offset']) ? (int) $query['offset'] : 0;

            $executions = $this->workflowRunner->getExecutionHistory($workflowId, $limit, $offset);

            return [
                'success' => true,
                'data' => $executions,
                'count' => count($executions),
                'status_code' => 200
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * GET /api/v1/workflows/runs/{runId}/events
     * Return the persisted per-run event log (JSONL) for the node form to
     * replay.
     *
     * Access model (intentional — see spec 2026-06-24 §A5): every backend
     * request already carries a login-issued auth token (enforced upstream by
     * the auth middleware), so only logged-in users reach this handler. There
     * is deliberately no per-run ownership check, unlike the workflow-id
     * endpoints: a run is addressable only by its unguessable 128-bit id, which
     * is not enumerable and never leaves the owner's own session. This is a
     * conscious choice for an authenticated app, not a missing guard.
     */
    public function runEvents(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        if (!$userId) {
            http_response_code(401);
            return ['error' => 'Authentication required'];
        }

        $runId = (string) ($request['params']['runId'] ?? '');
        if (!preg_match('/^[a-f0-9]{32}$/', $runId)) {
            http_response_code(400);
            return ['error' => 'Invalid runId'];
        }

        $log = new \AgentTeam\Services\WorkflowRunLog(
            \AgentTeam\Services\WorkflowRunLog::defaultDir($this->config)
        );
        $events = $log->read($runId);
        if ($events === null) {
            http_response_code(404);
            return ['error' => 'Run not found'];
        }

        return ['run_id' => $runId, 'events' => $events];
    }

    /**
     * POST /api/v1/workflows/{id}/toggle
     * Toggle workflow enabled/disabled
     */
    public function toggle(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        if (!$workflowId) {
            return [
                'success' => false,
                'error' => 'Workflow ID is required',
                'status_code' => 400
            ];
        }

        try {
            if (!$this->workflowRepository->isOwner($userId, $workflowId)) {
                return [
                    'success' => false,
                    'error' => 'Workflow not found or access denied',
                    'status_code' => 404
                ];
            }

            $this->workflowRepository->toggleEnabled($workflowId);
            $workflow = $this->workflowRepository->findById($workflowId);

            return [
                'success' => true,
                'data' => $workflow->toApiArray(),
                'message' => $workflow->isEnabled() ? 'Workflow enabled' : 'Workflow disabled',
                'status_code' => 200
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * POST /api/v1/workflows/{id}/duplicate
     * Duplicate a workflow
     */
    public function duplicate(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        $body = $request['body'] ?? [];

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        if (!$workflowId) {
            return [
                'success' => false,
                'error' => 'Workflow ID is required',
                'status_code' => 400
            ];
        }

        try {
            if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
                return [
                    'success' => false,
                    'error' => 'Workflow not found or access denied',
                    'status_code' => 404
                ];
            }

            $newName = $body['name'] ?? null;
            $duplicated = $this->workflowRepository->duplicate($workflowId, $userId, $newName);

            if (!$duplicated) {
                return [
                    'success' => false,
                    'error' => 'Failed to duplicate workflow',
                    'status_code' => 500
                ];
            }

            return [
                'success' => true,
                'data' => $duplicated->toArray(),
                'message' => 'Workflow duplicated successfully',
                'status_code' => 201
            ];
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * GET /api/v1/workflows/{id}/outputs
     * List all stored outputs for a workflow
     */
    public function listOutputs(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        if (!$workflowId) {
            return [
                'success' => false,
                'error' => 'Workflow ID is required',
                'status_code' => 400
            ];
        }

        try {
            if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
                return [
                    'success' => false,
                    'error' => 'Workflow not found or access denied',
                    'status_code' => 404
                ];
            }

            $outputStorage = new WorkflowOutputStorage($this->db, $this->config);
            $result = $outputStorage->listOutputs($workflowId, $userId);

            return array_merge($result, ['status_code' => 200]);
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * GET /api/v1/workflows/{id}/outputs/{filename}
     * Get a specific workflow output file
     */
    public function getOutput(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        $filename = $request['params']['filename'] ?? '';

        if (!$userId) {
            return [
                'success' => false,
                'error' => 'Authentication required',
                'status_code' => 401
            ];
        }

        if (!$workflowId || empty($filename)) {
            return [
                'success' => false,
                'error' => 'Workflow ID and filename are required',
                'status_code' => 400
            ];
        }

        try {
            if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
                return [
                    'success' => false,
                    'error' => 'Workflow not found or access denied',
                    'status_code' => 404
                ];
            }

            $outputStorage = new WorkflowOutputStorage($this->db, $this->config);
            $result = $outputStorage->getOutput($workflowId, $userId, $filename);

            return array_merge($result, ['status_code' => $result['success'] ? 200 : 404]);
        } catch (\Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    // =========================================================================
    // NODE DOCUMENT ATTACHMENT METHODS
    // =========================================================================

    private const UNIVERSALFS_PATH = '/Applications/XAMPP/xamppfiles/htdocs/universalfs';
    private const ROOT_FOLDER = 'synergyaichatroot';
    private const UNIVERSALFS_USER_ID = 'Synergyaichat';
    private const MAX_FILE_SIZE = 1024 * 1024; // 1MB

    private const ALLOWED_MIME_TYPES = [
        'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/css',
        'application/json', 'application/xml', 'application/pdf',
        'image/png', 'image/jpeg', 'image/gif', 'image/webp',
        'text/x-python', 'text/x-php', 'application/javascript',
        'application/x-httpd-php', 'text/x-java', 'text/x-c', 'text/x-c++',
    ];

    /**
     * POST /api/v1/workflows/{id}/nodes/{nodeId}/documents
     * Upload a document to attach to a workflow node
     */
    public function uploadNodeDocument(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        $nodeId = (int) ($request['params']['nodeId'] ?? 0);

        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }

        if (!$workflowId || !$nodeId) {
            return ['success' => false, 'error' => 'Workflow ID and Node ID are required', 'status_code' => 400];
        }

        // Check access
        if (!$this->workflowRepository->isOwner($userId, $workflowId)) {
            return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
        }

        // Verify node exists
        $node = $this->graphRepository->getNode($nodeId);
        if (!$node || (int)$node['workflow_id'] !== $workflowId) {
            return ['success' => false, 'error' => 'Node not found', 'status_code' => 404];
        }

        // Check if file was uploaded
        if (empty($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
            $errorMsg = isset($_FILES['file']) ? $this->getUploadErrorMessage($_FILES['file']['error']) : 'No file uploaded';
            return ['success' => false, 'error' => $errorMsg, 'status_code' => 400];
        }

        $file = $_FILES['file'];

        // Validate file size
        if ($file['size'] > self::MAX_FILE_SIZE) {
            return ['success' => false, 'error' => 'File exceeds 1MB limit', 'status_code' => 400];
        }

        // Validate MIME type
        $mimeType = $this->detectMimeType($file['tmp_name'], $file['name']);
        if (!$this->isAllowedMimeType($mimeType)) {
            return [
                'success' => false,
                'error' => "File type not allowed: {$mimeType}",
                'status_code' => 400
            ];
        }

        try {
            // Generate unique document ID
            $docId = uniqid('doc_', true);
            $filename = $this->sanitizeFilename($file['name']);

            // Get user's storage folder
            $userFolder = $this->getUserStorageFolder($userId);

            // Build storage path: synergyaichatroot/{user_folder}/workflow_docs/{workflowId}/{docId}_{filename}
            $storagePath = "workflow_docs/{$workflowId}/{$docId}_{$filename}";
            $fullPath = self::ROOT_FOLDER . "/{$userFolder}/{$storagePath}";

            // Store file via universalFS only
            $adapter = $this->getUniversalFSAdapter($userId);
            if (!$adapter) {
                return [
                    'success' => false,
                    'error' => 'Storage system (UniversalFS) not available',
                    'status_code' => 503
                ];
            }

            // Ensure directory exists
            $dirPath = "/" . self::ROOT_FOLDER . "/{$userFolder}/workflow_docs/{$workflowId}";
            try {
                $adapter->mkdir($dirPath);
            } catch (\Exception $e) {
                // Directory may already exist
            }

            // Write file via universalFS
            $stream = fopen($file['tmp_name'], 'r');
            $adapter->writeStream("/{$fullPath}", $stream);
            fclose($stream);

            // Create document metadata
            $document = [
                'id' => $docId,
                'name' => $filename,
                'path' => $storagePath,
                'fullPath' => $fullPath,
                'mimeType' => $mimeType,
                'size' => $file['size'],
                'addedAt' => date('c'),
            ];

            // Update node config with new document
            $config = $node['config'] ?? [];
            if (!isset($config['documents'])) {
                $config['documents'] = [];
            }
            $config['documents'][] = $document;

            // Save updated node config
            $this->graphRepository->updateNode($nodeId, [
                'config' => $config,
                'node_type' => $node['node_type'],
                'agent_id' => $node['agent_id'],
                'pos_x' => $node['pos_x'],
                'pos_y' => $node['pos_y'],
            ]);

            return [
                'success' => true,
                'document' => $document,
                'message' => 'Document uploaded successfully',
                'status_code' => 201
            ];

        } catch (\Exception $e) {
            error_log("[WorkflowController] uploadNodeDocument error: " . $e->getMessage());
            return [
                'success' => false,
                'error' => 'Failed to upload document: ' . $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * POST /api/v1/workflows/{id}/nodes/{nodeId}/documents/metadata
     * Save document metadata for locally stored files (File System Access API)
     */
    public function saveDocumentMetadata(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        $nodeId = (int) ($request['params']['nodeId'] ?? 0);
        $body = $request['body'] ?? [];

        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }

        if (!$workflowId || !$nodeId) {
            return ['success' => false, 'error' => 'Workflow ID and Node ID are required', 'status_code' => 400];
        }

        // Check access
        if (!$this->workflowRepository->isOwner($userId, $workflowId)) {
            return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
        }

        // Verify node exists
        $node = $this->graphRepository->getNode($nodeId);
        if (!$node || (int)$node['workflow_id'] !== $workflowId) {
            return ['success' => false, 'error' => 'Node not found', 'status_code' => 404];
        }

        // Validate document metadata
        $docData = $body['document'] ?? null;
        if (!$docData || empty($docData['id']) || empty($docData['name'])) {
            return ['success' => false, 'error' => 'Document metadata required (id, name)', 'status_code' => 400];
        }

        try {
            // Build document metadata (for local files, no server-side file storage)
            $document = [
                'id' => $docData['id'],
                'name' => $docData['name'],
                'path' => $docData['path'] ?? null,
                'localUri' => $docData['localUri'] ?? null,
                'mimeType' => $docData['mimeType'] ?? 'application/octet-stream',
                'size' => $docData['size'] ?? 0,
                'storage' => 'local', // Mark as locally stored
                'addedAt' => $docData['addedAt'] ?? date('c'),
            ];

            // Update node config with new document
            $config = $node['config'] ?? [];
            if (!isset($config['documents'])) {
                $config['documents'] = [];
            }
            $config['documents'][] = $document;

            // Save updated node config
            $this->graphRepository->updateNode($nodeId, [
                'config' => $config,
                'node_type' => $node['node_type'],
                'agent_id' => $node['agent_id'],
                'pos_x' => $node['pos_x'],
                'pos_y' => $node['pos_y'],
            ]);

            return [
                'success' => true,
                'document' => $document,
                'message' => 'Document metadata saved',
                'status_code' => 201
            ];

        } catch (\Exception $e) {
            error_log("[WorkflowController] saveDocumentMetadata error: " . $e->getMessage());
            return [
                'success' => false,
                'error' => 'Failed to save document metadata: ' . $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    /**
     * GET /api/v1/workflows/{id}/nodes/{nodeId}/documents
     * List all documents attached to a workflow node
     */
    public function listNodeDocuments(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        $nodeId = (int) ($request['params']['nodeId'] ?? 0);

        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }

        if (!$workflowId || !$nodeId) {
            return ['success' => false, 'error' => 'Workflow ID and Node ID are required', 'status_code' => 400];
        }

        // Check access
        if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
            return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
        }

        // Get node
        $node = $this->graphRepository->getNode($nodeId);
        if (!$node || (int)$node['workflow_id'] !== $workflowId) {
            return ['success' => false, 'error' => 'Node not found', 'status_code' => 404];
        }

        $documents = $node['config']['documents'] ?? [];

        return [
            'success' => true,
            'documents' => $documents,
            'count' => count($documents),
            'status_code' => 200
        ];
    }

    /**
     * DELETE /api/v1/workflows/{id}/nodes/{nodeId}/documents/{docId}
     * Remove a document from a workflow node
     */
    public function deleteNodeDocument(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        $nodeId = (int) ($request['params']['nodeId'] ?? 0);
        $docId = $request['params']['docId'] ?? '';

        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }

        if (!$workflowId || !$nodeId || empty($docId)) {
            return ['success' => false, 'error' => 'Workflow ID, Node ID, and Document ID are required', 'status_code' => 400];
        }

        // Check ownership
        if (!$this->workflowRepository->isOwner($userId, $workflowId)) {
            return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
        }

        // Get node
        $node = $this->graphRepository->getNode($nodeId);
        if (!$node || (int)$node['workflow_id'] !== $workflowId) {
            return ['success' => false, 'error' => 'Node not found', 'status_code' => 404];
        }

        $config = $node['config'] ?? [];
        $documents = $config['documents'] ?? [];

        // Find and remove document
        $documentToDelete = null;
        $updatedDocuments = [];
        foreach ($documents as $doc) {
            if ($doc['id'] === $docId) {
                $documentToDelete = $doc;
            } else {
                $updatedDocuments[] = $doc;
            }
        }

        if (!$documentToDelete) {
            return ['success' => false, 'error' => 'Document not found', 'status_code' => 404];
        }

        try {
            // Only delete file from remote storage - local files are managed by browser
            $storageType = $documentToDelete['storage'] ?? 'remote';

            if ($storageType === 'remote') {
                // Delete from remote storage via universalFS only
                $userFolder = $this->getUserStorageFolder($userId);
                $fullPath = self::ROOT_FOLDER . "/{$userFolder}/{$documentToDelete['path']}";

                $adapter = $this->getUniversalFSAdapter($userId);
                if ($adapter) {
                    try {
                        $adapter->delete("/{$fullPath}");
                    } catch (\Exception $e) {
                        // File may not exist or deletion failed
                        error_log("[WorkflowController] Could not delete remote file via universalFS: " . $e->getMessage());
                    }
                } else {
                    // No adapter available - log error but continue to remove metadata
                    error_log("[WorkflowController] UniversalFS adapter not available, cannot delete remote file");
                }
            } else {
                // Local storage (File System Access API) - file is on user's machine
                // Backend only removes metadata; frontend handles file deletion if needed
                error_log("[WorkflowController] Document is stored locally, skipping file deletion");
            }

            // Update node config
            $config['documents'] = $updatedDocuments;
            $this->graphRepository->updateNode($nodeId, [
                'config' => $config,
                'node_type' => $node['node_type'],
                'agent_id' => $node['agent_id'],
                'pos_x' => $node['pos_x'],
                'pos_y' => $node['pos_y'],
            ]);

            return [
                'success' => true,
                'message' => 'Document deleted successfully',
                'status_code' => 200
            ];

        } catch (\Exception $e) {
            error_log("[WorkflowController] deleteNodeDocument error: " . $e->getMessage());
            return [
                'success' => false,
                'error' => 'Failed to delete document: ' . $e->getMessage(),
                'status_code' => 500
            ];
        }
    }

    // =========================================================================
    // HELPER METHODS FOR DOCUMENT STORAGE
    // =========================================================================

    /**
     * Get universalFS adapter for a user
     */
    private function getUniversalFSAdapter(int $userId): ?object
    {
        $autoloadPath = self::UNIVERSALFS_PATH . '/vendor/autoload.php';

        if (!file_exists($autoloadPath)) {
            return null;
        }

        try {
            require_once $autoloadPath;

            $dotenv = \Dotenv\Dotenv::createImmutable(self::UNIVERSALFS_PATH);
            $dotenv->load();

            $pdo = new \PDO(
                sprintf('mysql:host=%s;dbname=%s;charset=utf8mb4', $_ENV['DB_HOST'], $_ENV['DB_NAME']),
                $_ENV['DB_USER'],
                $_ENV['DB_PASS'],
                [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]
            );

            $credentialStore = new \UniversalFS\Credential\PdoCredentialStore($pdo);
            $adapterFactory = new \UniversalFS\Factory\AdapterFactory($credentialStore);

            // Get user's storage provider from their settings
            $provider = $this->getUserStorageProvider($userId);

            return $adapterFactory->connect(self::UNIVERSALFS_USER_ID, $provider);

        } catch (\Exception $e) {
            error_log("[WorkflowController] universalFS adapter error: " . $e->getMessage());
            return null;
        }
    }

    /**
     * Get user's storage provider - user setting overrides global config
     */
    private function getUserStorageProvider(int $userId): string
    {
        // First check user's setting
        $stmt = $this->db->prepare("SELECT storage_provider FROM users WHERE id = ?");
        $stmt->execute([$userId]);
        $result = $stmt->fetch(\PDO::FETCH_ASSOC);

        $userProvider = $result['storage_provider'] ?? null;

        // User setting takes precedence, then global config, then 'local' as fallback
        if (!empty($userProvider)) {
            return $userProvider;
        }

        // Check config for default storage provider (supports both flat and nested config)
        return $this->config['storage']['default_provider']
            ?? $this->config['default_storage_provider']
            ?? $this->config['storage_provider']
            ?? 'local';
    }

    /**
     * Get user's storage folder from settings
     */
    private function getUserStorageFolder(int $userId): string
    {
        $stmt = $this->db->prepare("SELECT storage_folder FROM users WHERE id = ?");
        $stmt->execute([$userId]);
        $result = $stmt->fetch(\PDO::FETCH_ASSOC);
        return $result['storage_folder'] ?? "user_{$userId}";
    }

    /**
     * Get local storage path (fallback when universalFS not available)
     */
    private function getLocalStoragePath(string $relativePath): string
    {
        $basePath = $this->config['storage_path'] ?? __DIR__ . '/../../../../storage';
        return $basePath . '/' . ltrim($relativePath, '/');
    }

    /**
     * Detect MIME type of uploaded file
     */
    private function detectMimeType(string $tmpPath, string $originalName): string
    {
        // Try finfo first
        if (function_exists('finfo_open')) {
            $finfo = finfo_open(FILEINFO_MIME_TYPE);
            $mimeType = finfo_file($finfo, $tmpPath);
            finfo_close($finfo);

            // finfo returns application/octet-stream for text files sometimes
            if ($mimeType !== 'application/octet-stream') {
                return $mimeType;
            }
        }

        // Fallback to extension-based detection
        return $this->guessMimeTypeFromExtension($originalName);
    }

    /**
     * Guess MIME type from file extension
     */
    private function guessMimeTypeFromExtension(string $filename): string
    {
        $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));

        return match ($ext) {
            'txt' => 'text/plain',
            'md' => 'text/markdown',
            'html', 'htm' => 'text/html',
            'css' => 'text/css',
            'js' => 'application/javascript',
            'json' => 'application/json',
            'xml' => 'application/xml',
            'pdf' => 'application/pdf',
            'png' => 'image/png',
            'jpg', 'jpeg' => 'image/jpeg',
            'gif' => 'image/gif',
            'webp' => 'image/webp',
            'csv' => 'text/csv',
            'php' => 'text/x-php',
            'py' => 'text/x-python',
            'java' => 'text/x-java',
            'c', 'h' => 'text/x-c',
            'cpp', 'hpp' => 'text/x-c++',
            'sql' => 'application/sql',
            'yaml', 'yml' => 'text/yaml',
            default => 'application/octet-stream',
        };
    }

    /**
     * Check if MIME type is allowed
     */
    private function isAllowedMimeType(string $mimeType): bool
    {
        // Allow text/* types
        if (str_starts_with($mimeType, 'text/')) {
            return true;
        }

        // Allow image/* types
        if (str_starts_with($mimeType, 'image/')) {
            return true;
        }

        return in_array($mimeType, self::ALLOWED_MIME_TYPES);
    }

    /**
     * Sanitize filename for storage
     */
    private function sanitizeFilename(string $filename): string
    {
        // Remove path components
        $filename = basename($filename);

        // Replace unsafe characters
        $filename = preg_replace('/[^a-zA-Z0-9._-]/', '_', $filename);

        // Limit length
        if (strlen($filename) > 100) {
            $ext = pathinfo($filename, PATHINFO_EXTENSION);
            $name = pathinfo($filename, PATHINFO_FILENAME);
            $filename = substr($name, 0, 90) . '.' . $ext;
        }

        return $filename;
    }

    /**
     * Get human-readable upload error message
     */
    private function getUploadErrorMessage(int $errorCode): string
    {
        return match ($errorCode) {
            UPLOAD_ERR_INI_SIZE => 'File exceeds server upload limit',
            UPLOAD_ERR_FORM_SIZE => 'File exceeds form upload limit',
            UPLOAD_ERR_PARTIAL => 'File was only partially uploaded',
            UPLOAD_ERR_NO_FILE => 'No file was uploaded',
            UPLOAD_ERR_NO_TMP_DIR => 'Missing temporary folder',
            UPLOAD_ERR_CANT_WRITE => 'Failed to write file to disk',
            UPLOAD_ERR_EXTENSION => 'File upload stopped by extension',
            default => 'Unknown upload error',
        };
    }
}
