<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use AgentTeam\Models\Workflow;
use PDO;
use Quantis\AIPortfolioAssistant\Providers\ProviderRequestFactory;

/**
 * Graph Workflow Runner
 *
 * Executes workflows defined as a graph (nodes + edges) from the visual editor.
 * Traverses from Start node through agent nodes to Output node.
 */
class GraphWorkflowRunner
{
    private PDO $db;
    private AgentRepository $agentRepository;
    private AgentRunner $agentRunner;
    private WorkflowGraphRepository $graphRepository;
    private array $config;
    private ?WorkflowOutputStorage $outputStorage = null;
    private ?WorkflowSchemaRepository $schemaRepository = null;

    private array $nodeOutputs = [];
    private ?int $executionId = null;
    private ?StreamContext $streamContext = null;
    private ?int $currentUserId = null;

    // Inline `client_skills` map shipped by the browser at run start so
    // folder-backed (local-FS) skills can be resolved server-side. Keyed
    // by skill dir_name → ['skill_content' => '...', 'scripts' => [...]].
    // Empty when no folder-backed skills are bound to any node.
    private array $clientSkills = [];

    // Inline `inline_documents` map shipped by the browser at run start
    // so locally-stored attachments become visible to the agent. Keyed
    // by document id → string content. Without this, local-storage docs
    // surface as a "stored locally, can't be accessed" placeholder.
    private array $inlineDocuments = [];

    // Scratch-file metadata for bound-skill workflows. Browser pre-stashes
    // the file content for Pyodide /scratch/<name> at tool-call time;
    // the agent's prompt sees a one-line "file at /scratch/<name>"
    // reference instead of the full body — saves ~14K input tokens per
    // LLM call. Indexed by doc_id for O(1) lookup in readDocumentContent.
    private array $scratchFilesByDocId = [];

    // Token tracking across all nodes
    private int $totalInputTokens = 0;
    private int $totalOutputTokens = 0;
    /** @var array<string,array{0:?float,1:?float}> provider => [priceIn, priceOut] per 1M tokens */
    private array $pricingCache = [];
    // Phase 0 self-healing trace capture (docs/specs/2026-06-13-phase0-trace-store.md)
    private ExecutionTraceStore $traceStore;
    private string $runId = '';
    private ?int $currentWorkflowId = null;
    /** @var array<int,array> skill round-trip result (output/script/argv) keyed by node id */
    private array $skillResultByNode = [];

    // Template processor for dynamic prompt variables
    private ?PromptTemplateProcessor $templateProcessor = null;

    // Workflow context for template processing
    private array $workflowContext = [];

    public function __construct(
        PDO $db,
        AgentRepository $agentRepository,
        AgentRunner $agentRunner,
        WorkflowGraphRepository $graphRepository,
        array $config = []
    ) {
        $this->db = $db;
        $this->traceStore = new ExecutionTraceStore($db);
        $this->agentRepository = $agentRepository;
        $this->agentRunner = $agentRunner;
        $this->graphRepository = $graphRepository;
        $this->config = $config;
        $this->outputStorage = new WorkflowOutputStorage($db, $config);
        $this->schemaRepository = new WorkflowSchemaRepository($db);
    }

    /**
     * Set stream context for SSE events
     */
    public function setStreamContext(?StreamContext $context): self
    {
        $this->streamContext = $context;
        return $this;
    }

    /**
     * Initialize template processor with workflow context
     */
    private function initTemplateProcessor(Workflow $workflow, int $userId, string $userPrompt): void
    {
        $this->templateProcessor = new PromptTemplateProcessor();

        // Get user info if available
        $userInfo = $this->getUserInfo($userId);

        // Build workflow context
        $this->workflowContext = [
            // User context
            'user_id' => $userId,
            'username' => $userInfo['name'] ?? $userInfo['username'] ?? 'User',
            'user_email' => $userInfo['email'] ?? '',
            'user_locale' => $userInfo['locale'] ?? 'en-US',

            // Workflow context
            'workflow_id' => $workflow->getId(),
            'workflow_name' => $workflow->getName(),
            'user_prompt' => $userPrompt,

            // System context
            'app_name' => $this->config['app_name'] ?? 'AI Assistant',
            'app_version' => $this->config['app_version'] ?? '1.0',

            // Custom workflow variables (from workflow config if available)
            'custom_vars' => [],
        ];

        $this->templateProcessor->setContext($this->workflowContext);

        // Set timezone if configured
        if (!empty($this->config['timezone'])) {
            $this->templateProcessor->setTimezone($this->config['timezone']);
        }
    }

    /**
     * Process template placeholders in a prompt string
     */
    private function processPromptTemplate(string $prompt, array $additionalContext = []): string
    {
        if (!$this->templateProcessor) {
            return $prompt;
        }

        // Add any additional context (e.g., agent-specific or node-specific)
        if (!empty($additionalContext)) {
            $this->templateProcessor->setContext($additionalContext);
        }

        return $this->templateProcessor->process($prompt);
    }

    /**
     * Get user info for template context
     */
    private function getUserInfo(int $userId): array
    {
        try {
            $stmt = $this->db->prepare("SELECT id, username, email, name FROM users WHERE id = ?");
            $stmt->execute([$userId]);
            return $stmt->fetch(\PDO::FETCH_ASSOC) ?: [];
        } catch (\Exception $e) {
            return [];
        }
    }

    /**
     * Emit a node event via SSE
     */
    private function emitNodeEvent(string $type, array $node, ?array $extra = null): void
    {
        if (!$this->streamContext) {
            return;
        }

        $data = [
            'type' => $type,
            'node_id' => $node['id'],
            'node_type' => $node['node_type'],
            'drawflow_id' => $node['drawflow_node_id'] ?? null,
            'agent_id' => $node['agent_id'] ?? null,
            'agent_name' => $extra['agent_name'] ?? null,
            'timestamp' => microtime(true),
        ];

        if ($extra) {
            $data = array_merge($data, $extra);
        }

        $this->streamContext->emit($data);
    }

    /**
     * Emit a workflow event via SSE
     */
    private function emitWorkflowEvent(string $type, Workflow $workflow, ?array $extra = null): void
    {
        if (!$this->streamContext) {
            return;
        }

        $data = [
            'type' => $type,
            'workflow_id' => $workflow->getId(),
            'workflow_name' => $workflow->getName(),
            'timestamp' => microtime(true),
        ];

        if ($extra) {
            $data = array_merge($data, $extra);
        }

        $this->streamContext->emit($data);
    }

    /**
     * Run a graph-based workflow
     */
    public function run(Workflow $workflow, int $userId, array $inputVariables = [], array $clientSkills = [], array $inlineDocuments = [], array $scratchFiles = []): array
    {
        $this->nodeOutputs = [];
        // Phase 0: one run_id correlates all node traces of this workflow run.
        $this->runId = bin2hex(random_bytes(16));
        $this->currentWorkflowId = method_exists($workflow, 'getId') ? $workflow->getId() : null;
        $this->skillResultByNode = [];
        $this->currentUserId = $userId;
        $this->clientSkills = $clientSkills;
        $this->inlineDocuments = $inlineDocuments;
        // Index scratch files by doc_id so readDocumentContent can swap
        // them in for the inline body in O(1).
        $this->scratchFilesByDocId = [];
        foreach ($scratchFiles as $sf) {
            if (!is_array($sf)) continue;
            $id = $sf['doc_id'] ?? null;
            if (is_string($id) && $id !== '') {
                $this->scratchFilesByDocId[$id] = $sf;
            }
        }
        $this->totalInputTokens = 0;
        $this->totalOutputTokens = 0;
        $startTime = microtime(true);

        // Get user prompt from input
        $userPrompt = $inputVariables['prompt'] ?? $inputVariables['input'] ?? '';

        // Initialize template processor for dynamic prompt variables
        $this->initTemplateProcessor($workflow, $userId, $userPrompt);

        // Create execution record
        $this->executionId = $this->createExecution($workflow, $userId, $inputVariables);

        try {
            // Find start node
            $startNode = $this->graphRepository->findStartNode($workflow->getId());
            if (!$startNode) {
                throw new \RuntimeException('Workflow has no Start node');
            }

            // Refuse realtime workflows — they require the browser-side JS runner
            if (($startNode['config']['runtime_mode'] ?? 'batch') === 'realtime') {
                throw new \RuntimeException('This workflow is configured for realtime audio. Use the browser-based realtime runner instead.');
            }

            // Build start node output: user prompt + attached documents
            $startOutput = $userPrompt;
            $startDocumentsContext = $this->buildDocumentsContext($startNode);
            if (!empty($startDocumentsContext)) {
                $startOutput = $startDocumentsContext . "\n\n---\n\n" . $userPrompt;
                error_log("[GraphWorkflowRunner] Start node has attached documents, prepending to output");
            }

            // Store user input (with documents) as start node output
            $this->nodeOutputs[$startNode['id']] = [
                'type' => 'start',
                'output' => $startOutput,
                'documents' => $startNode['config']['documents'] ?? []
            ];

            // Get all nodes and edges for traversal
            $graph = $this->graphRepository->getGraph($workflow->getId());
            $nodes = $this->indexNodesById($graph['nodes']);
            $edges = $graph['edges'];

            // Emit workflow_start event
            $this->emitWorkflowEvent('workflow_start', $workflow, [
                'execution_id' => $this->executionId,
                'total_nodes' => count($nodes),
            ]);

            // Emit start node events (node_start for active glow, then node_complete)
            $this->emitNodeEvent('node_start', $startNode, ['input' => $userPrompt]);
            usleep(300000); // 300ms delay so the active glow is visible before completion
            $this->emitNodeEvent('node_complete', $startNode, ['success' => true]);

            // Traverse graph from start node
            $executedNodes = [$startNode['id']];
            $queue = $this->getNextNodeIds($startNode['id'], $edges);
            $finalOutput = null;

            error_log("[GraphWorkflowRunner] Starting traversal with queue: " . json_encode($queue));

            // Check for parallel execution right after Start node
            $startParallelAgents = $this->findAgentNodesInList($queue, $nodes, $executedNodes);
            if (count($startParallelAgents) > 1) {
                error_log("[GraphWorkflowRunner] Detected " . count($startParallelAgents) . " parallel agents from Start node (implicit parallelism)");

                // Execute all agents in parallel
                $parallelResults = $this->executeAgentsInParallel(
                    $startParallelAgents,
                    $userId,
                    $userPrompt,
                    $edges,
                    $executedNodes
                );

                // Store results and mark as executed
                $queue = []; // Clear queue, we'll re-populate with next nodes
                error_log("[GraphWorkflowRunner] Storing " . count($parallelResults) . " parallel results");
                foreach ($parallelResults as $nodeId => $result) {
                    $agentName = $result['agent_name'] ?? 'Unknown';
                    $outputLen = strlen($result['output'] ?? '');
                    error_log("[GraphWorkflowRunner] Storing output for node {$nodeId} ({$agentName}), output length: {$outputLen}");

                    $this->nodeOutputs[$nodeId] = $result;
                    $executedNodes[] = $nodeId;

                    // Queue next nodes for each parallel agent
                    $agentNextIds = $this->getNextNodeIds($nodeId, $edges);
                    error_log("[GraphWorkflowRunner] Node {$nodeId} next nodes: " . json_encode($agentNextIds));
                    foreach ($agentNextIds as $nextId) {
                        if (!in_array($nextId, $queue) && !in_array($nextId, $executedNodes)) {
                            $queue[] = $nextId;
                        }
                    }
                }

                // Ensure DB connection after parallel execution
                $this->ensureDbConnection();

                error_log("[GraphWorkflowRunner] Start parallel execution complete, queue now: " . json_encode($queue));
            }

            while (!empty($queue)) {
                $currentNodeId = array_shift($queue);
                error_log("[GraphWorkflowRunner] Processing node ID: {$currentNodeId}");

                // Skip if already executed
                if (in_array($currentNodeId, $executedNodes)) {
                    error_log("[GraphWorkflowRunner] Node {$currentNodeId} already executed, skipping");
                    continue;
                }

                $node = $nodes[$currentNodeId] ?? null;
                if (!$node) {
                    error_log("[GraphWorkflowRunner] Node {$currentNodeId} not found in nodes array");
                    continue;
                }

                error_log("[GraphWorkflowRunner] Node {$currentNodeId} type: {$node['node_type']}");

                // Check if all incoming nodes are executed (for merge nodes)
                if (!$this->canExecuteNode($currentNodeId, $edges, $executedNodes)) {
                    // Re-queue for later
                    $queue[] = $currentNodeId;
                    error_log("[GraphWorkflowRunner] Node {$currentNodeId} not ready, re-queued");
                    continue;
                }

                // Build input context for agent nodes before emitting node_start
                $nodeInput = null;
                if ($node['node_type'] === 'agent') {
                    $config = $node['config'] ?? [];
                    $mergeStrategy = $config['merge_strategy'] ?? 'labeled';
                    $context = $this->buildContextForNode($node['id'], $edges, $executedNodes, $mergeStrategy);
                    $nodeInput = !empty($context) ? "Do your job on the following input:\n\n{$context}" : $userPrompt;
                }

                // Emit node_start event with input content
                $this->emitNodeEvent('node_start', $node, [
                    'input' => $nodeInput,
                ]);

                // Execute the node (may take long time for LLM calls)
                error_log("[GraphWorkflowRunner] Executing node {$currentNodeId}...");
                $output = $this->executeNode($node, $userId, $userPrompt, $edges, $executedNodes);
                error_log("[GraphWorkflowRunner] Node {$currentNodeId} executed, output type: " . ($output['type'] ?? 'unknown'));

                // Ensure DB connection is alive after potentially long LLM call
                $this->ensureDbConnection();

                $this->nodeOutputs[$currentNodeId] = $output;
                $executedNodes[] = $currentNodeId;

                // Accumulate tokens for agent nodes
                $usage = $output['usage'] ?? null;
                $inputTokens = $usage['input_tokens'] ?? $usage['prompt_tokens'] ?? 0;
                $outputTokens = $usage['output_tokens'] ?? $usage['completion_tokens'] ?? 0;
                if ($node['node_type'] === 'agent') {
                    $this->totalInputTokens += $inputTokens;
                    $this->totalOutputTokens += $outputTokens;
                }

                // Derive node success from the executed output. Agent/MCP
                // nodes set an explicit 'success'; nodes that don't (start,
                // output) are successful unless they reported type 'error'.
                // Previously this referenced an undefined $nodeSuccess, which
                // emitted success=null and made failed nodes render as green.
                $nodeSuccess = array_key_exists('success', $output)
                    ? (bool)$output['success']
                    : (($output['type'] ?? '') !== 'error');

                // Emit node_complete event for all nodes with output content
                $this->emitNodeEvent('node_complete', $node, [
                    'agent_name' => $output['agent_name'] ?? null,
                    'server_name' => $output['server_name'] ?? null,
                    'success' => $nodeSuccess,
                    'output' => $output['output'] ?? null,
                    'input_tokens' => $inputTokens,
                    'output_tokens' => $outputTokens,
                    'cost_usd' => $this->computeNodeCost($output['provider'] ?? null, $inputTokens, $outputTokens),
                ]);

                // Phase 0: record an execution trace for agent nodes.
                if (($output['type'] ?? '') === 'agent') {
                    $this->recordExecutionTrace($node, $output['provider'] ?? null, $output['model'] ?? null,
                        $nodeSuccess, $output['output'] ?? null, $inputTokens, $outputTokens);
                }

                // If output node, capture final output
                if ($node['node_type'] === 'output') {
                    $finalOutput = $this->collectFinalOutput($currentNodeId, $edges);
                    error_log("[GraphWorkflowRunner] Output node reached, final output collected");
                    continue; // Don't queue nodes after output
                }

                // Check for parallel execution opportunity
                // NEW: Detect parallelism from multiple outgoing edges to agent nodes (not just from 'parallel' node)
                $nextNodeIds = $this->getNextNodeIds($currentNodeId, $edges);
                $parallelAgents = $this->findAgentNodesInList($nextNodeIds, $nodes, $executedNodes);

                if (count($parallelAgents) > 1) {
                    error_log("[GraphWorkflowRunner] Detected " . count($parallelAgents) . " parallel agents from node {$currentNodeId} (implicit parallelism)");

                    // Execute all agents in parallel
                    $parallelResults = $this->executeAgentsInParallel(
                        $parallelAgents,
                        $userId,
                        $userPrompt,
                        $edges,
                        $executedNodes
                    );

                    // Store results and mark as executed
                    foreach ($parallelResults as $nodeId => $result) {
                        $this->nodeOutputs[$nodeId] = $result;
                        $executedNodes[] = $nodeId;

                        // Queue next nodes for each parallel agent
                        $agentNextIds = $this->getNextNodeIds($nodeId, $edges);
                        foreach ($agentNextIds as $nextId) {
                            if (!in_array($nextId, $queue) && !in_array($nextId, $executedNodes)) {
                                $queue[] = $nextId;
                            }
                        }
                    }

                    // Queue any non-agent nodes from the original next nodes
                    foreach ($nextNodeIds as $nextId) {
                        $nextNode = $nodes[$nextId] ?? null;
                        if ($nextNode && $nextNode['node_type'] !== 'agent' && !in_array($nextId, $executedNodes) && !in_array($nextId, $queue)) {
                            $queue[] = $nextId;
                        }
                    }

                    // Ensure DB connection after parallel execution
                    $this->ensureDbConnection();

                    error_log("[GraphWorkflowRunner] Parallel execution complete, queue now: " . json_encode($queue));
                    continue; // Skip normal queuing since we handled it
                }

                // Queue next nodes (normal sequential flow)
                $nextNodeIds = $this->getNextNodeIds($currentNodeId, $edges);
                error_log("[GraphWorkflowRunner] Next nodes for {$currentNodeId}: " . json_encode($nextNodeIds));
                foreach ($nextNodeIds as $nextId) {
                    if (!in_array($nextId, $queue) && !in_array($nextId, $executedNodes)) {
                        $queue[] = $nextId;
                    }
                }
                error_log("[GraphWorkflowRunner] Queue now: " . json_encode($queue));
            }
            error_log("[GraphWorkflowRunner] Traversal complete, executed " . count($executedNodes) . " nodes");

            $responseTime = (microtime(true) - $startTime) * 1000;

            // Complete execution
            $this->completeExecution($this->executionId, $this->nodeOutputs, $responseTime);

            // Emit workflow_complete event
            $this->emitWorkflowEvent('workflow_complete', $workflow, [
                'execution_id' => $this->executionId,
                'success' => true,
                'nodes_executed' => count($executedNodes),
                'response_time_ms' => round($responseTime, 2),
                'output' => $finalOutput,
                'node_outputs' => $this->nodeOutputs,
                'total_input_tokens' => $this->totalInputTokens,
                'total_output_tokens' => $this->totalOutputTokens,
                'total_tokens' => $this->totalInputTokens + $this->totalOutputTokens,
            ]);

            // Save output to storage if enabled
            $storageSaveResult = null;
            try {
                $storageSaveResult = $this->outputStorage->saveOutput(
                    $workflow->getId(),
                    $userId,
                    [
                        'execution_id' => $this->executionId,
                        'workflow_id' => $workflow->getId(),
                        'workflow_name' => $workflow->getName(),
                        'timestamp' => date('c'),
                        'response_time_ms' => round($responseTime, 2),
                        'nodes_executed' => count($executedNodes),
                        'output' => $finalOutput,
                        'node_outputs' => $this->nodeOutputs,
                        'input_variables' => $inputVariables,
                    ]
                );

                if ($storageSaveResult['success']) {
                    error_log("[GraphWorkflowRunner] Output saved to storage: " . ($storageSaveResult['path'] ?? 'unknown'));
                }
            } catch (\Exception $e) {
                error_log("[GraphWorkflowRunner] Failed to save output to storage: " . $e->getMessage());
            }

            // Archive the run into conversation_contexts so it shows up in
            // the chat sidebar and is searchable via session_search. This is
            // best-effort — a failure here never fails the workflow.
            try {
                $this->archiveRunToConversationContexts(
                    $userId,
                    (int) $workflow->getId(),
                    (string) $workflow->getName(),
                    (string) $userPrompt,
                    (string) ($finalOutput ?? '')
                );
            } catch (\Throwable $e) {
                error_log('[GraphWorkflowRunner] Archive to conversation_contexts failed: ' . $e->getMessage());
            }

            return [
                'success' => true,
                'execution_id' => $this->executionId,
                'workflow' => [
                    'id' => $workflow->getId(),
                    'name' => $workflow->getName(),
                ],
                'output' => $finalOutput,
                'node_outputs' => $this->nodeOutputs,
                'nodes_executed' => count($executedNodes),
                'response_time_ms' => round($responseTime, 2),
                'storage' => $storageSaveResult,
            ];

        } catch (\Exception $e) {
            // Emit workflow_error event
            $this->emitWorkflowEvent('workflow_error', $workflow, [
                'execution_id' => $this->executionId,
                'error' => $e->getMessage(),
            ]);

            $this->failExecution($this->executionId, $e->getMessage());

            return [
                'success' => false,
                'error' => $e->getMessage(),
                'execution_id' => $this->executionId,
                'workflow' => [
                    'id' => $workflow->getId(),
                    'name' => $workflow->getName(),
                ],
                'partial_outputs' => $this->nodeOutputs,
            ];
        }
    }

    /**
     * Index nodes by ID for quick lookup
     */
    private function indexNodesById(array $nodes): array
    {
        $indexed = [];
        foreach ($nodes as $node) {
            $indexed[$node['id']] = $node;
        }
        return $indexed;
    }

    /**
     * Get IDs of nodes connected from the given node
     */
    private function getNextNodeIds(int $nodeId, array $edges): array
    {
        $nextIds = [];
        foreach ($edges as $edge) {
            if ((int)$edge['from_node_id'] === $nodeId) {
                $nextIds[] = (int)$edge['to_node_id'];
            }
        }
        return $nextIds;
    }

    /**
     * Check if a node can be executed (all incoming dependencies satisfied)
     */
    private function canExecuteNode(int $nodeId, array $edges, array $executedNodes): bool
    {
        foreach ($edges as $edge) {
            if ((int)$edge['to_node_id'] === $nodeId) {
                if (!in_array((int)$edge['from_node_id'], $executedNodes)) {
                    return false;
                }
            }
        }
        return true;
    }

    /**
     * Execute a single node
     */
    private function executeNode(array $node, int $userId, string $userPrompt, array $edges, array $executedNodes): array
    {
        $nodeType = $node['node_type'];

        return match ($nodeType) {
            'agent' => $this->executeAgentNode($node, $userId, $userPrompt, $edges, $executedNodes),
            'agent-template' => throw new \RuntimeException("Unconfigured agent template node found. Please configure all agent nodes before running the workflow."),
            'output' => $this->executeOutputNode($node, $edges, $executedNodes),
            default => ['type' => $nodeType, 'output' => null],
        };
    }

    /**
     * Execute an agent node
     */
    private function executeAgentNode(array $node, int $userId, string $userPrompt, array $edges, array $executedNodes): array
    {
        // Ensure DB connection before looking up agent
        $this->ensureDbConnection();

        $agentId = $node['agent_id'] ?? null;
        $config = $node['config'] ?? [];

        $agent = null;

        // Build agent context for template processing
        $agentContext = [
            'agent_name' => $config['agent_name'] ?? $config['name'] ?? '',
            'node_id' => $node['id'],
            'node_name' => $config['name'] ?? "Node {$node['id']}",
        ];

        // Node-level skill content: appended as a distinct "## Skill" section
        // to the system prompt at execution time (not stored on the agent
        // template). Resolution order:
        //   1. bound_skill — a pointer to a filesystem-backed skill. The
        //      browser reads SKILL.md off the user's disk at workflow start
        //      and ships the body inline as $clientSkills, keyed by dir_name.
        //   2. skill_content — inline string kept for back-compat with
        //      workflows saved before the picker UX.
        // (DB skills no longer exist; the SkillRepository indirection was
        //  retired when skills consolidated to the filesystem.)
        $skillContent = '';
        if (!empty($config['bound_skill']) && is_array($config['bound_skill'])) {
            $dirName = (string) ($config['bound_skill']['dir_name'] ?? '');
            if ($dirName !== '' && isset($this->clientSkills[$dirName]) && is_array($this->clientSkills[$dirName])) {
                $skillContent = (string) ($this->clientSkills[$dirName]['skill_content'] ?? '');
            }
            if ($skillContent === '') {
                error_log("[GraphWorkflowRunner] bound_skill dir_name='{$dirName}' has no inline client_skills entry — node will run without skill content.");
            }
        }
        if ($skillContent === '') {
            $skillContent = trim((string) ($config['skill_content'] ?? ''));
        }

        // Memory is a CONVERSATION-ONLY feature. Workflows run memory-free:
        // injecting the user's personal memory/profile into task-specific
        // workflow nodes pollutes their context, wastes tokens, and skews
        // self-heal evaluations. The LangGraph export was already user-agnostic
        // for this reason — the runtime now matches it. (Conversation mode keeps
        // memory; see ChatController.)
        $userMemoryBlock = '';
        $userProfileBlock = '';

        if ($agentId) {
            // Fetch agent from database
            error_log("[GraphWorkflowRunner] Looking up agent ID: {$agentId}");
            $agent = $this->agentRepository->findById($agentId);
            if (!$agent) {
                throw new \RuntimeException("Agent not found: {$agentId}");
            }

            // Process template placeholders in agent's instructions
            $agentContext['agent_name'] = $agent->getName();
            $processedInstructions = $this->processPromptTemplate(
                $agent->getInstructions(),
                $agentContext
            );
            $processedDescription = $this->processPromptTemplate(
                $agent->getDescription(),
                $agentContext
            );

            if ($skillContent !== '') {
                $processedSkill = $this->processPromptTemplate($skillContent, $agentContext);
                $processedInstructions = rtrim($processedInstructions) . "\n\n## Skill\n" . $processedSkill;
            }

            if ($userMemoryBlock !== '') {
                $processedInstructions = rtrim($processedInstructions) . "\n\n## Memory\n" . $userMemoryBlock;
            }
            if ($userProfileBlock !== '') {
                $processedInstructions = rtrim($processedInstructions) . "\n\n## User\n" . $userProfileBlock;
            }

            // Create a copy of the agent with processed instructions
            $agent = new \AgentTeam\Models\Agent([
                'id' => $agent->getId(),
                'user_id' => $agent->getUserId(),
                'name' => $agent->getName(),
                'description' => $processedDescription,
                'agent_type' => $agent->getAgentType(),
                'provider' => $agent->getProvider(),
                'model' => $agent->getModel(),
                'instructions' => $processedInstructions,
                'tools' => $agent->getTools(),
                'settings' => $agent->getSettings(),
            ]);
        } elseif (!empty($config['agent_name']) || !empty($config['instructions']) || $skillContent !== '') {
            // Create inline agent from node config with processed templates
            error_log("[GraphWorkflowRunner] Creating inline agent from node config");

            $agentName = $config['agent_name'] ?? $config['name'] ?? 'Inline Agent';
            $agentContext['agent_name'] = $agentName;

            // Process templates in instructions and description
            $processedInstructions = $this->processPromptTemplate(
                $config['instructions'] ?? '',
                $agentContext
            );
            $processedDescription = $this->processPromptTemplate(
                $config['description'] ?? '',
                $agentContext
            );

            if ($skillContent !== '') {
                $processedSkill = $this->processPromptTemplate($skillContent, $agentContext);
                $processedInstructions = rtrim($processedInstructions) . "\n\n## Skill\n" . $processedSkill;
            }

            if ($userMemoryBlock !== '') {
                $processedInstructions = rtrim($processedInstructions) . "\n\n## Memory\n" . $userMemoryBlock;
            }
            if ($userProfileBlock !== '') {
                $processedInstructions = rtrim($processedInstructions) . "\n\n## User\n" . $userProfileBlock;
            }

            $agent = new \AgentTeam\Models\Agent([
                'id' => null,
                'user_id' => $userId,
                'name' => $agentName,
                'description' => $processedDescription,
                'agent_type' => $config['agent_type'] ?? 'worker',
                'provider' => $config['agent_provider'] ?? $config['provider'] ?? 'openai',
                'model' => $config['model'] ?? null,
                'instructions' => $processedInstructions,
                'tools' => $config['tools'] ?? [],
                'settings' => $config['settings'] ?? [],
            ]);
        } else {
            throw new \RuntimeException("Agent node has no agent_id and no inline configuration");
        }

        // Build context from previous nodes (with merge strategy from config)
        $mergeStrategy = $config['merge_strategy'] ?? 'labeled';
        $context = $this->buildContextForNode($node['id'], $edges, $executedNodes, $mergeStrategy);

        // Add attached documents to context
        $documentsContext = $this->buildDocumentsContext($node);
        if (!empty($documentsContext)) {
            $context = $documentsContext . "\n\n" . $context;
        }

        // Determine task input:
        // - If no context (directly connected to Start): use user prompt
        // - If has context (downstream agent): tell it to do its job on the input
        if (!empty($context)) {
            // Downstream agent - simple instruction + context
            $task = "Do your job on the following input:\n\n{$context}";
        } else {
            // First agent after Start - receives user prompt directly
            $task = $userPrompt;
        }

        // Extract tools filter from node config (if specified)
        $toolsFilter = null;
        if (!empty($config['tools']) && is_array($config['tools'])) {
            $toolsFilter = $config['tools'];
            error_log("[GraphWorkflowRunner] Using node-level tools filter: " . json_encode($toolsFilter));
        }

        // Resolve output schema for constrained decoding (if configured)
        $outputSchema = $this->resolveOutputSchema($config, $userId);

        // If the node is bound to a folder-backed skill that has
        // executable scripts (and the browser shipped them inline at
        // run start), declare run_skill_script so the LLM can invoke
        // them. The actual execution lives in the user's browser via
        // Pyodide; the runner bridges results back over SSE +
        // /workflows/tool-result.
        $extraTools = [];
        $skillMetadata = null;
        $skillScripts = $this->getBoundSkillScripts($config);
        $skillDirName = $config['bound_skill']['dir_name'] ?? null;
        if (!empty($skillScripts) && is_string($skillDirName) && $skillDirName !== '') {
            $skillMetadata = ['dir_name' => $skillDirName, 'scripts' => $skillScripts];
            $extraTools[] = $this->buildRunSkillScriptTool($skillMetadata);
        }

        $runContext = [
            'workflow_execution_id' => $this->executionId,
            'node_id' => $node['id'],
            'tools_filter' => $toolsFilter,
            'output_schema' => $outputSchema,
            'extra_tools' => $extraTools,
            'skill_metadata' => $skillMetadata,
        ];

        // Force run_skill_script on the FIRST agent turn when the node has
        // a bound folder-backed skill with executable scripts. Without
        // this the LLM occasionally produces prose ("here's how to
        // convert HTML manually...") instead of calling the script,
        // especially after a few successful runs in a row. The bridge
        // loop in runAgentWithClientToolBridge clears this on subsequent
        // rounds so the model can summarize freely after the tool result.
        //
        // Shape note: we use the OpenAI form below because that's the
        // common-denominator across providers we support. ClaudeProvider
        // translates this to its native {type:'tool',name:'...'} shape
        // automatically. OpenAI/Grok/Kimi consume it natively. Gemini
        // ignores tool_choice entirely (it uses its own
        // function_calling_config) — the prompt instructions still
        // apply, so the soft constraint is the fallback there.
        if (!empty($skillScripts) && is_string($skillDirName) && $skillDirName !== '') {
            $runContext['tool_choice'] = [
                'type' => 'function',
                'function' => ['name' => 'run_skill_script'],
            ];
        }

        // Run the agent. If the LLM emits run_skill_script, B3 short-
        // circuits and we round-trip through the browser before
        // re-calling the agent with the tool_result in history.
        $result = $this->runAgentWithClientToolBridge(
            $agent,
            $task,
            [],
            $userId,
            $runContext,
            $node
        );

        $rawOutput = $result['text'] ?? $result['output'] ?? '';
        $structured = null;
        if ($outputSchema !== null && is_string($rawOutput) && $rawOutput !== '') {
            $decoded = json_decode($rawOutput, true);
            if (json_last_error() === JSON_ERROR_NONE && (is_array($decoded) || is_object($decoded))) {
                $structured = $decoded;
            } else {
                error_log("[GraphWorkflowRunner] Schema-constrained output was not valid JSON for node {$node['id']}: " . json_last_error_msg());
            }
        }

        return [
            'type' => 'agent',
            'agent_id' => $agentId,
            'agent_name' => $agent->getName(),
            'input' => $task,
            'output' => $rawOutput,
            'structured' => $structured,
            'schema_name' => $outputSchema['name'] ?? null,
            'success' => $result['success'] ?? true,
            'usage' => $result['usage'] ?? null,
            'provider' => $agent->getProvider(),
        ];
    }

    /**
     * Per-1M-token pricing [input, output] in USD for a provider, sourced from
     * the centralized system_llm_settings table (the same place the app's
     * usage-cost reporting reads), falling back to sane defaults. Cached per
     * provider for the run. Handles the anthropic/claude alias.
     */
    private function getProviderPricing(string $provider): array
    {
        $provider = strtolower($provider);
        $aliases = ['anthropic' => 'claude', 'google' => 'gemini'];
        $key = $aliases[$provider] ?? $provider;

        if (isset($this->pricingCache[$key])) {
            return $this->pricingCache[$key];
        }

        // Keep in sync with SystemSettingsController::PRICE_DEFAULTS.
        $defaults = [
            'claude'   => [3.00, 15.00],
            'openai'   => [2.50, 10.00],
            'gemini'   => [0.30, 2.50],
            'grok'     => [0.20, 0.50],
            'deepseek' => [0.28, 0.42],
            'kimi'     => [0.55, 2.20],
        ];
        [$priceIn, $priceOut] = $defaults[$key] ?? [null, null];

        try {
            $stmt = $this->db->prepare(
                "SELECT price_input_per_1m, price_output_per_1m
                 FROM system_llm_settings WHERE provider_key = :k LIMIT 1"
            );
            $stmt->execute([':k' => $key]);
            $row = $stmt->fetch(\PDO::FETCH_ASSOC);
            if ($row) {
                if ($row['price_input_per_1m'] !== null)  $priceIn  = (float)$row['price_input_per_1m'];
                if ($row['price_output_per_1m'] !== null) $priceOut = (float)$row['price_output_per_1m'];
            }
        } catch (\Throwable $e) {
            // Column/table may not exist yet — defaults already applied.
        }

        return $this->pricingCache[$key] = [$priceIn, $priceOut];
    }

    /**
     * Compute USD cost for a node from its token usage and provider pricing.
     * Returns null when pricing is unknown so the UI can show "—" rather
     * than a misleading $0.00.
     */
    /**
     * Phase 0: assemble + persist one execution trace for a workflow agent node.
     * Pulls the skill stdout/script/argv stashed during the client-tool
     * round-trip. Never throws (insert() swallows errors) — tracing must not
     * break a workflow run. Spec: docs/specs/2026-06-13-phase0-trace-store.md
     */
    private function recordExecutionTrace(array $node, ?string $provider, ?string $model, bool $success, ?string $outputText, int $inTok, int $outTok): void
    {
        $nodeId = (int)($node['id'] ?? 0);
        $config = $node['config'] ?? [];
        $sr = $this->skillResultByNode[$nodeId] ?? [];
        $out = is_array($sr['output'] ?? null) ? $sr['output'] : [];
        $this->traceStore->insert([
            'run_id'             => $this->runId,
            'ts'                 => date('Y-m-d H:i:s'),
            'env'                => 'workflow',
            'invocation_mode'    => 'workflow_node',
            'workflow_id'        => $this->currentWorkflowId,
            'node_id'            => $nodeId,
            'provider'           => $provider,
            'model'              => $model,
            'skill_dir'          => $config['bound_skill']['dir_name'] ?? null,
            'script'             => $sr['script'] ?? null,
            'argv'               => $sr['argv'] ?? [],
            'skill_exit_code'    => $out['exit_code'] ?? null,
            'skill_stdout'       => $out['stdout'] ?? null,
            'skill_log_messages' => $out['log_messages'] ?? null,
            'output_files'       => array_keys(is_array($out['outputs'] ?? null) ? $out['outputs'] : []),
            'final_text'         => $outputText,
            'success'            => $success,
            'error_text'         => $success ? null : $outputText,
            'tokens_in'          => $inTok,
            'tokens_out'         => $outTok,
            'cost_usd'           => $this->computeNodeCost($provider, $inTok, $outTok),
        ]);
    }

    private function computeNodeCost(?string $provider, int $inputTokens, int $outputTokens): ?float
    {
        if (!$provider) return null;
        [$priceIn, $priceOut] = $this->getProviderPricing($provider);
        if ($priceIn === null && $priceOut === null) return null;
        return ($inputTokens * ($priceIn ?? 0) + $outputTokens * ($priceOut ?? 0)) / 1_000_000;
    }

    /**
     * Pull the executable script list for a node's bound folder-backed
     * skill out of the inline `client_skills` bundle the browser sent.
     * Returns [] when the skill is DB-backed, missing from the bundle,
     * or has no scripts. Server-side resolution of folder-backed
     * scripts isn't possible — they live on the user's local FS.
     */
    private function getBoundSkillScripts(array $config): array
    {
        $bs = $config['bound_skill'] ?? null;
        if (!is_array($bs) || ($bs['source'] ?? '') !== 'local') return [];
        $dir = $bs['dir_name'] ?? '';
        if (!is_string($dir) || $dir === '') return [];
        $entry = $this->clientSkills[$dir] ?? null;
        if (!is_array($entry)) return [];
        $scripts = $entry['scripts'] ?? [];
        if (!is_array($scripts)) return [];
        $out = [];
        foreach ($scripts as $s) {
            if (!is_string($s)) continue;
            $s = trim($s);
            if ($s === '' || str_starts_with($s, '/') || str_contains($s, '..')) continue;
            $out[] = $s;
        }
        return array_values(array_unique($out));
    }

    /**
     * Build the run_skill_script tool definition for a node. Mirrors
     * ChatController::buildRunSkillScriptTool so providers consume it
     * via the same B3 short-circuit path. Workflow context note in the
     * description: the LLM should call the script rather than do the
     * transformation by hand, just like in chat.
     */
    private function buildRunSkillScriptTool(array $metadata): array
    {
        $dirName = $metadata['dir_name'];
        $scripts = $metadata['scripts'];

        $description = "Execute one of the Python scripts bundled with the active skill \"{$dirName}\". "
            . "This tool IS available to you and you should call it whenever the workflow input "
            . "maps to one of the skill's scripts — do not attempt the transformation manually if a "
            . "script can do it. Available scripts: " . implode(', ', $scripts) . ". "
            . "OUTPUT: files MUST be written to absolute paths under /outputs/ "
            . "(e.g. -o /outputs/foo.html in argv) AND listed in read_outputs.";

        return [
            'name' => 'run_skill_script',
            'description' => $description,
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'script' => [
                        'type' => 'string',
                        'description' => 'Path to the script within the skill folder. Must be one of the listed scripts.',
                        'enum' => $scripts,
                    ],
                    'argv' => [
                        'type' => 'array',
                        'description' => 'Command-line arguments passed to the script (sys.argv[1:]). Output paths (e.g. -o, --output) MUST start with /outputs/.',
                        'items' => ['type' => 'string'],
                    ],
                    'input_files' => [
                        'type' => 'object',
                        'description' => 'OPTIONAL — small synthesized files to write before running the script. Keys are absolute paths, values are file contents.',
                        'additionalProperties' => ['type' => 'string'],
                    ],
                    'read_outputs' => [
                        'type' => 'array',
                        'description' => 'Paths whose contents should be returned to you after the script finishes. Use absolute /outputs/<filename> paths.',
                        'items' => ['type' => 'string'],
                    ],
                ],
                'required' => ['script'],
            ],
        ];
    }

    /**
     * Run an agent and, if the LLM emits a client-side tool call,
     * round-trip through the browser via the SkillToolBridge before
     * resuming. Mirrors chat's two-shot protocol but server-driven:
     * we synthesise the next-shot conversation_history (assistant
     * tool_use + user tool_result) instead of having the browser
     * re-issue the request.
     *
     * Bound to MAX_ROUNDS so a runaway tool loop can't pin the
     * worker. Stream events let the editor surface progress.
     */
    private function runAgentWithClientToolBridge(
        \AgentTeam\Models\Agent $agent,
        string $task,
        array $conversationHistory,
        int $userId,
        array $runContext,
        array $node
    ): array {
        $MAX_ROUNDS = 3;
        $bridge = new SkillToolBridge();
        $history = $conversationHistory;
        $currentTask = $task;

        for ($round = 0; $round < $MAX_ROUNDS + 1; $round++) {
            $result = $this->agentRunner->run($agent, $currentTask, $history, $userId, $runContext);

            // INSTRUMENTATION: trace token usage per round so we can pinpoint
            // where OpenAI/Gemini lose their usage in the client-tool bridge
            // (Claude/Grok/Kimi/DeepSeek report tokens; OpenAI/Gemini emit 0).
            $u = $result['usage'] ?? [];
            error_log(sprintf(
                "[BridgeUsage] node=%s provider=%s round=%d pending=%s in=%s out=%s keys=[%s]",
                $node['id'] ?? '?',
                $agent->getProvider(),
                $round,
                empty($result['pending_client_tool_call']) ? 'no' : 'yes',
                (string)($u['input_tokens'] ?? $u['prompt_tokens'] ?? 'NULL'),
                (string)($u['output_tokens'] ?? $u['completion_tokens'] ?? 'NULL'),
                is_array($u) ? implode(',', array_keys($u)) : gettype($u)
            ));

            if (empty($result['pending_client_tool_call'])) {
                return $result;
            }
            $pending = $result['pending_tool_calls'] ?? [];
            if (empty($pending) || !is_array($pending[0] ?? null)) {
                error_log("[GraphWorkflowRunner] pending_client_tool_call set but no tool_calls payload — aborting round-trip.");
                return $result;
            }
            if ($round === $MAX_ROUNDS) {
                error_log("[GraphWorkflowRunner] client-tool round limit ({$MAX_ROUNDS}) hit on node {$node['id']} — returning last assistant text.");
                return $result;
            }

            // Stamp each pending call with a bridge-correlatable id
            // (provider may have generated its own; we replace with hex
            // so the result endpoint's regex accepts it). The frontend
            // dispatcher gets this id and posts the result back keyed
            // on it.
            $call = $pending[0];
            $toolCallId = SkillToolBridge::generateToolCallId();
            $callForFrontend = [
                'id' => $toolCallId,
                'name' => $call['name'] ?? 'run_skill_script',
                'input' => $call['input'] ?? [],
            ];
            $assistantText = $result['pending_assistant_text'] ?? '';

            $this->emitNodeEvent('client_tool_call', $node, [
                'tool_call_id' => $toolCallId,
                'tool_calls' => [$callForFrontend],
                'assistant_text' => $assistantText,
                'dir_name' => $runContext['skill_metadata']['dir_name'] ?? null,
            ]);

            $bridgeResult = $bridge->awaitResult($toolCallId);
            if ($bridgeResult === null) {
                error_log("[GraphWorkflowRunner] bridge timed out waiting for tool_call_id={$toolCallId}");
                throw new \RuntimeException("Browser timed out running skill script. Make sure the workflow editor stayed open during the run.");
            }

            // Phase 0: stash the skill stdout/script/argv for the execution trace.
            $this->skillResultByNode[(int)($node['id'] ?? 0)] = [
                'output' => is_array($bridgeResult['output'] ?? null) ? $bridgeResult['output'] : [],
                'script' => $callForFrontend['input']['script'] ?? null,
                'argv'   => $callForFrontend['input']['argv'] ?? [],
            ];

            // Build the continuation: assistant turn that called the
            // tool, followed by the tool result. Provider buildMessages
            // converts these to native shape (Claude content blocks,
            // OpenAI tool_calls, Gemini functionCall+functionResponse).
            $assistantToolCall = [
                'id' => $toolCallId,
                'type' => 'function',
                'function' => [
                    'name' => $callForFrontend['name'],
                    'arguments' => json_encode($callForFrontend['input'] ?? new \stdClass()),
                ],
            ];
            // Gemini 2.5+/3 require the thoughtSignature from the original
            // functionCall to be echoed back on the continuation turn, or
            // the follow-up request 400s ("Function call is missing a
            // thought_signature"). GeminiProvider stamps it onto the pending
            // call; carry it through here so GeminiProvider::buildContents
            // can re-emit it on the reconstructed assistant turn. Other
            // providers don't set it, so this is a no-op for them.
            if (!empty($call['thought_signature'])) {
                $assistantToolCall['thought_signature'] = $call['thought_signature'];
            }
            $history[] = ['role' => 'user', 'content' => $currentTask];
            $history[] = [
                'role' => 'assistant',
                'content' => $assistantText,
                'tool_calls' => [$assistantToolCall],
            ];
            $history[] = [
                'role' => 'tool',
                'tool_call_id' => $toolCallId,
                'name' => $callForFrontend['name'],
                'content' => json_encode($bridgeResult, JSON_UNESCAPED_SLASHES),
            ];

            // After the first tool round, drop any forced tool_choice so
            // the model can summarize freely on the continuation turn.
            // Forcing run_skill_script again would loop the model back
            // into calling the script with no new input.
            unset($runContext['tool_choice']);
            // Empty next-turn input: the tool_result tail is what the
            // model needs to keep going. Providers' buildMessages
            // recognises this and skips a synthesized empty user turn.
            $currentTask = '';
        }

        return $result ?? ['success' => false, 'text' => ''];
    }

    /**
     * Resolve the output schema configured on a node.
     *
     * Supports two forms in node config:
     *   1. output_schema_id: <int>   — reference a saved WorkflowSchema
     *   2. output_schema: { name, description, strict, schema } — inline schema
     *
     * Returns null if no schema is configured.
     */
    private function resolveOutputSchema(array $config, int $userId): ?array
    {
        // Inline schema takes precedence
        if (!empty($config['output_schema']) && is_array($config['output_schema'])) {
            $inline = $config['output_schema'];
            // Allow either { name, schema } or a bare JSON Schema
            if (isset($inline['schema'])) {
                return [
                    'name' => $inline['name'] ?? 'output',
                    'description' => $inline['description'] ?? '',
                    'strict' => (bool) ($inline['strict'] ?? true),
                    'schema' => $inline['schema'],
                ];
            }
            // Bare JSON Schema (top-level type/properties)
            if (isset($inline['type']) || isset($inline['properties'])) {
                return [
                    'name' => 'output',
                    'description' => '',
                    'strict' => true,
                    'schema' => $inline,
                ];
            }
        }

        // Reference by id
        if (!empty($config['output_schema_id']) && $this->schemaRepository) {
            $schemaId = (int) $config['output_schema_id'];
            $schema = $this->schemaRepository->findById($schemaId);
            if ($schema && $schema->getUserId() === $userId) {
                return $schema->toOutputSchema();
            }
            error_log("[GraphWorkflowRunner] Output schema id {$schemaId} not found or not owned by user {$userId}");
        }

        return null;
    }

    /**
     * Execute an output node
     * Aggregates all incoming inputs (similar to merge node behavior)
     */
    private function executeOutputNode(array $node, array $edges, array $executedNodes): array
    {
        // Collect outputs from all incoming nodes
        $inputs = [];
        $inputSources = [];

        foreach ($edges as $edge) {
            if ((int)$edge['to_node_id'] === (int)$node['id']) {
                $fromNodeId = (int)$edge['from_node_id'];

                if (isset($this->nodeOutputs[$fromNodeId])) {
                    $output = $this->nodeOutputs[$fromNodeId]['output'] ?? '';
                    $sourceName = $this->nodeOutputs[$fromNodeId]['agent_name']
                        ?? $this->nodeOutputs[$fromNodeId]['type']
                        ?? "Node {$fromNodeId}";

                    $inputs[] = [
                        'source' => $sourceName,
                        'output' => $output,
                        'node_id' => $fromNodeId
                    ];
                    $inputSources[] = $sourceName;
                }
            }
        }

        // If only one input, return it directly without headers
        if (count($inputs) === 1) {
            return [
                'type' => 'output',
                'output' => $inputs[0]['output'],
            ];
        }

        // Multiple inputs: combine with headers and separators
        $combined = [];
        foreach ($inputs as $input) {
            $combined[] = "## 📄 {$input['source']}\n\n{$input['output']}";
        }

        error_log("[GraphWorkflowRunner] Output node aggregating " . count($inputs) . " inputs from: " . implode(', ', $inputSources));

        return [
            'type' => 'output',
            'inputs_count' => count($inputs),
            'input_sources' => $inputSources,
            'output' => implode("\n\n---\n\n", $combined),
        ];
    }

    /**
     * Get input for a node from its incoming edges
     * Uses the most recently executed incoming node for robustness
     */
    private function getInputForNode(int $nodeId, array $edges, array $executedNodes = []): string
    {
        $incomingOutputs = [];

        // Collect all incoming node outputs
        foreach ($edges as $edge) {
            if ((int)$edge['to_node_id'] === $nodeId) {
                $fromNodeId = (int)$edge['from_node_id'];
                if (isset($this->nodeOutputs[$fromNodeId])) {
                    $incomingOutputs[$fromNodeId] = $this->nodeOutputs[$fromNodeId];
                }
            }
        }

        if (empty($incomingOutputs)) {
            return '';
        }

        // Find the most recently executed incoming node
        if (!empty($executedNodes)) {
            $reversedExecuted = array_reverse($executedNodes);
            foreach ($reversedExecuted as $executedNodeId) {
                if (isset($incomingOutputs[$executedNodeId])) {
                    return $incomingOutputs[$executedNodeId]['output'] ?? '';
                }
            }
        }

        // Fallback: return the last incoming output
        $lastOutput = end($incomingOutputs);
        return $lastOutput['output'] ?? '';
    }

    /**
     * Build context string from previous node outputs
     *
     * @param int $nodeId The target node ID
     * @param array $edges All workflow edges
     * @param array $executedNodes List of executed node IDs
     * @param string $mergeStrategy How to merge multiple inputs: 'labeled' (default), 'concatenate', 'json', 'numbered', 'xml'
     * @return string The merged context string
     */
    private function buildContextForNode(int $nodeId, array $edges, array $executedNodes, string $mergeStrategy = 'labeled'): string
    {
        $inputs = [];
        $incomingEdgeCount = 0;

        // Log available outputs for debugging
        $availableOutputs = array_keys($this->nodeOutputs);
        error_log("[GraphWorkflowRunner] buildContextForNode({$nodeId}): Available outputs from nodes: " . json_encode($availableOutputs));

        foreach ($edges as $edge) {
            if ((int)$edge['to_node_id'] === $nodeId) {
                $incomingEdgeCount++;
                $fromNodeId = (int)$edge['from_node_id'];
                $toPort = $edge['to_port'] ?? 'input_1';

                error_log("[GraphWorkflowRunner] buildContextForNode({$nodeId}): Found incoming edge from node {$fromNodeId}");

                if (isset($this->nodeOutputs[$fromNodeId])) {
                    $output = $this->nodeOutputs[$fromNodeId];
                    $agentName = $output['agent_name'] ?? $output['type'] ?? 'Unknown';
                    error_log("[GraphWorkflowRunner] buildContextForNode({$nodeId}): Output from {$fromNodeId} ({$agentName}) exists, length: " . strlen($output['output'] ?? ''));

                    if (!empty($output['output'])) {
                        // Structured outputs get a clearly marked JSON block so the
                        // downstream agent knows the upstream result is machine-readable.
                        $content = $output['output'];
                        $isStructured = !empty($output['structured']);
                        if ($isStructured) {
                            $schemaName = $output['schema_name'] ?? 'output';
                            $content = "```json schema=\"{$schemaName}\"\n{$output['output']}\n```";
                        }

                        $inputs[] = [
                            'source' => $agentName,
                            'port' => $toPort,
                            'content' => $content,
                            'from_node_id' => $fromNodeId,
                            'structured' => $isStructured,
                        ];
                    } else {
                        error_log("[GraphWorkflowRunner] buildContextForNode({$nodeId}): WARNING - Output from {$fromNodeId} is empty!");
                    }
                } else {
                    error_log("[GraphWorkflowRunner] buildContextForNode({$nodeId}): WARNING - No output found for node {$fromNodeId}!");
                }
            }
        }

        error_log("[GraphWorkflowRunner] buildContextForNode({$nodeId}): Found {$incomingEdgeCount} incoming edges, {" . count($inputs) . "} valid inputs, strategy: {$mergeStrategy}");

        if (empty($inputs)) {
            return '';
        }

        // Single input - return as-is regardless of strategy
        if (count($inputs) === 1) {
            error_log("[GraphWorkflowRunner] buildContextForNode({$nodeId}): Single input, returning as-is");
            return $inputs[0]['content'];
        }

        // Multiple inputs - apply merge strategy
        error_log("[GraphWorkflowRunner] buildContextForNode({$nodeId}): Merging " . count($inputs) . " inputs with strategy: {$mergeStrategy}");
        return $this->applyMergeStrategy($inputs, $mergeStrategy);
    }

    /**
     * Apply merge strategy to combine multiple inputs
     *
     * @param array $inputs Array of input data with 'source', 'port', 'content' keys
     * @param string $strategy The merge strategy to use
     * @return string The merged content
     */
    private function applyMergeStrategy(array $inputs, string $strategy): string
    {
        return match ($strategy) {
            'concatenate' => implode("\n\n", array_column($inputs, 'content')),
            'json' => json_encode(
                array_map(fn($i) => ['source' => $i['source'], 'content' => $i['content']], $inputs),
                JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE
            ),
            'numbered' => $this->formatNumberedInputs($inputs),
            'xml' => $this->formatXmlInputs($inputs),
            'labeled' => $this->formatLabeledInputs($inputs),
            default => $this->formatLabeledInputs($inputs),
        };
    }

    /**
     * Format inputs with numbered sections
     */
    private function formatNumberedInputs(array $inputs): string
    {
        $parts = [];
        foreach ($inputs as $i => $input) {
            $num = $i + 1;
            $parts[] = "[Input {$num} - {$input['source']}]\n{$input['content']}";
        }
        return implode("\n\n", $parts);
    }

    /**
     * Format inputs with XML-style tags (useful for structured parsing)
     */
    private function formatXmlInputs(array $inputs): string
    {
        $parts = [];
        foreach ($inputs as $i => $input) {
            $safeName = preg_replace('/[^a-zA-Z0-9_]/', '_', $input['source']);
            $parts[] = "<input source=\"{$input['source']}\" index=\"" . ($i + 1) . "\">\n{$input['content']}\n</input>";
        }
        return implode("\n\n", $parts);
    }

    /**
     * Format inputs with labeled sections (default)
     */
    private function formatLabeledInputs(array $inputs): string
    {
        $parts = [];
        foreach ($inputs as $input) {
            $parts[] = "[{$input['source']}]:\n{$input['content']}";
        }
        return implode("\n\n", $parts);
    }

    /**
     * Collect final output at the output node
     */
    private function collectFinalOutput(int $outputNodeId, array $edges): string
    {
        return $this->nodeOutputs[$outputNodeId]['output'] ?? '';
    }

    /**
     * Create workflow execution record
     */
    private function createExecution(Workflow $workflow, int $userId, array $inputVariables): int
    {
        $stmt = $this->db->prepare(
            "INSERT INTO agent_workflow_executions (workflow_id, user_id, input_variables, status, started_at)
             VALUES (?, ?, ?, 'running', NOW())"
        );
        $stmt->execute([
            $workflow->getId(),
            $userId,
            json_encode($inputVariables),
        ]);

        return (int)$this->db->lastInsertId();
    }

    /**
     * Complete workflow execution
     */
    private function completeExecution(int $executionId, array $outputs, float $responseTime): void
    {
        $this->ensureDbConnection();
        $stmt = $this->db->prepare(
            "UPDATE agent_workflow_executions
             SET status = 'completed', output = ?, response_time_ms = ?, completed_at = NOW()
             WHERE id = ?"
        );
        $stmt->execute([
            json_encode($outputs),
            (int)$responseTime,
            $executionId,
        ]);
    }

    /**
     * Fail workflow execution
     */
    private function failExecution(int $executionId, string $error): void
    {
        $this->ensureDbConnection();
        $stmt = $this->db->prepare(
            "UPDATE agent_workflow_executions
             SET status = 'failed', error_message = ?, completed_at = NOW()
             WHERE id = ?"
        );
        $stmt->execute([$error, $executionId]);
    }

    /**
     * Ensure DB connection is alive, reconnect if needed
     */
    private function ensureDbConnection(): void
    {
        try {
            $this->db->query('SELECT 1');
        } catch (\PDOException $e) {
            // Connection lost, reconnect
            error_log("[GraphWorkflowRunner] DB connection lost, reconnecting...");
            $dbConfig = $this->config['contexts_database'] ?? $this->config['database'];
            $dsn = "mysql:host={$dbConfig['host']};dbname={$dbConfig['database']};charset={$dbConfig['charset']}";
            $this->db = new PDO($dsn, $dbConfig['username'], $dbConfig['password'], [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]);

            // Recreate repositories with new connection
            $this->graphRepository = new WorkflowGraphRepository($this->db);
            $this->agentRepository = new AgentRepository($this->db);
            // Trace store held the dead handle too — give it the fresh one.
            $this->traceStore = new ExecutionTraceStore($this->db);
            error_log("[GraphWorkflowRunner] DB reconnected successfully");
        }
    }

    /**
     * Find agent nodes from a list of node IDs
     * Used for implicit parallelism detection - when a node has multiple outgoing edges to agents
     */
    private function findAgentNodesInList(array $nodeIds, array $nodes, array $executedNodes): array
    {
        $agentNodes = [];

        foreach ($nodeIds as $nodeId) {
            // Skip if already executed
            if (in_array($nodeId, $executedNodes)) {
                continue;
            }

            $node = $nodes[$nodeId] ?? null;
            if ($node && $node['node_type'] === 'agent') {
                $agentNodes[] = $node;
            }
        }

        return $agentNodes;
    }

    /**
     * Execute multiple agent nodes in TRUE parallel with tool support
     * Uses curl_multi for parallel HTTP calls, handles tool execution in rounds
     */
    private function executeAgentsInParallel(array $agentNodes, int $userId, string $userPrompt, array $edges, array $executedNodes): array
    {
        error_log("[GraphWorkflowRunner] Executing " . count($agentNodes) . " agents in TRUE parallel with tool support");

        // Debug: Log input agent node IDs
        $inputNodeIds = array_map(fn($n) => $n['id'], $agentNodes);
        error_log("[GraphWorkflowRunner] Input agent node IDs: " . implode(',', $inputNodeIds));

        $results = [];
        $agentStates = []; // Track state for each agent: messages, tools, etc.
        $maxRounds = 10; // Prevent infinite loops

        // Initialize all agents (skip duplicates)
        $initializedNodes = [];
        foreach ($agentNodes as $node) {
            if (in_array($node['id'], $initializedNodes)) {
                error_log("[GraphWorkflowRunner] Skipping duplicate agent node: {$node['id']}");
                continue;
            }
            $initializedNodes[] = $node['id'];
            $nodeId = (int)$node['id'];

            $agentId = $node['agent_id'] ?? null;
            $config = $node['config'] ?? [];

            // Build initial context and task BEFORE emitting node_start (with merge strategy from config)
            $mergeStrategy = $config['merge_strategy'] ?? 'labeled';
            $context = $this->buildContextForNode($nodeId, $edges, $executedNodes, $mergeStrategy);
            $task = !empty($context) ? "Do your job on the following input:\n\n{$context}" : $userPrompt;

            // Emit node_start with input content
            $this->emitNodeEvent('node_start', $node, [
                'input' => $task,
            ]);

            // Build agent context for template processing
            $agentContext = [
                'agent_name' => $config['agent_name'] ?? $config['name'] ?? '',
                'node_id' => $node['id'],
                'node_name' => $config['name'] ?? "Node {$node['id']}",
            ];

            $agent = null;
            if ($agentId) {
                $agent = $this->agentRepository->findById($agentId);
                if ($agent) {
                    // Process template placeholders in agent's instructions
                    $agentContext['agent_name'] = $agent->getName();
                    $processedInstructions = $this->processPromptTemplate(
                        $agent->getInstructions(),
                        $agentContext
                    );
                    $processedDescription = $this->processPromptTemplate(
                        $agent->getDescription(),
                        $agentContext
                    );

                    // Create a copy with processed instructions
                    $agent = new \AgentTeam\Models\Agent([
                        'id' => $agent->getId(),
                        'user_id' => $agent->getUserId(),
                        'name' => $agent->getName(),
                        'description' => $processedDescription,
                        'agent_type' => $agent->getAgentType(),
                        'provider' => $agent->getProvider(),
                        'model' => $agent->getModel(),
                        'instructions' => $processedInstructions,
                        'tools' => $agent->getTools(),
                        'settings' => $agent->getSettings(),
                    ]);
                }
            } elseif (!empty($config['agent_name']) || !empty($config['instructions'])) {
                $agentName = $config['agent_name'] ?? $config['name'] ?? 'Inline Agent';
                $agentContext['agent_name'] = $agentName;

                // Process templates in instructions and description
                $processedInstructions = $this->processPromptTemplate(
                    $config['instructions'] ?? '',
                    $agentContext
                );
                $processedDescription = $this->processPromptTemplate(
                    $config['description'] ?? '',
                    $agentContext
                );

                $agent = new \AgentTeam\Models\Agent([
                    'id' => null,
                    'user_id' => $userId,
                    'name' => $agentName,
                    'description' => $processedDescription,
                    'agent_type' => $config['agent_type'] ?? 'worker',
                    'provider' => $config['agent_provider'] ?? $config['provider'] ?? 'openai',
                    'model' => $config['model'] ?? null,
                    'instructions' => $processedInstructions,
                    'tools' => $config['tools'] ?? [],
                    'settings' => $config['settings'] ?? [],
                ]);
            }

            if (!$agent) {
                $results[$nodeId] = [
                    'type' => 'agent', 'agent_id' => null, 'agent_name' => 'Unknown',
                    'output' => 'Error: No agent configuration', 'success' => false,
                ];
                $this->emitNodeEvent('node_complete', $node, [
                    'success' => false,
                    'output' => 'Error: No agent configuration',
                    'input_tokens' => 0,
                    'output_tokens' => 0,
                ]);
                continue;
            }

            // Get tools for this agent
            $toolsFilter = !empty($config['tools']) ? $config['tools'] : ($agent->getTools() ?? []);
            $tools = $this->buildToolsForParallelAgent($agent, $toolsFilter);

            // Debug: Log agent setup
            $toolNames = array_map(fn($t) => $t['name'], $tools);
            error_log("[GraphWorkflowRunner] Agent {$agent->getName()} setup: provider={$agent->getProvider()}, model={$agent->getModel()}, tools=[" . implode(',', $toolNames) . "], toolsFilter=[" . implode(',', $toolsFilter ?: []) . "]");

            // Initialize agent state
            $agentStates[$nodeId] = [
                'node' => $node,
                'agent' => $agent,
                'input' => $task,
                'messages' => [
                    ['role' => 'system', 'content' => $agent->buildSystemPrompt()],
                    ['role' => 'user', 'content' => $task],
                ],
                'tools' => $tools,
                'tools_filter' => $toolsFilter,
                'completed' => false,
                'output' => '',
                'start_time' => microtime(true),
            ];
        }

        // Execute in rounds until all agents complete
        for ($round = 0; $round < $maxRounds; $round++) {
            $pendingAgents = array_filter($agentStates, fn($s) => !$s['completed']);
            if (empty($pendingAgents)) break;

            error_log("[GraphWorkflowRunner] Parallel round {$round}: " . count($pendingAgents) . " agents pending");

            // Make parallel LLM calls
            $responses = $this->makeParallelLLMCalls($pendingAgents);

            // Process responses
            foreach ($responses as $nodeId => $response) {
                $state = &$agentStates[$nodeId];
                $agent = $state['agent'];

                if (!$response['success']) {
                    $state['completed'] = true;
                    $state['output'] = 'Error: ' . ($response['error'] ?? 'Unknown error');
                    $state['success'] = false;
                    continue;
                }

                $parsed = $response['parsed'];

                // Check for tool calls
                if (!empty($parsed['tool_calls'])) {
                    error_log("[GraphWorkflowRunner] Agent {$agent->getName()} requested " . count($parsed['tool_calls']) . " tool calls");

                    // Client-side tools (run_skill_script etc.) cannot run on
                    // the server — they execute in the browser's Pyodide. For
                    // those, assign a bridge-compatible id so the /workflows/
                    // tool-result endpoint accepts the round-trip post. Server
                    // tools keep their provider-supplied id. Other keys
                    // (incl. Gemini's thought_signature) are preserved.
                    $toolCalls = $parsed['tool_calls'];
                    foreach ($toolCalls as $i => $tc) {
                        $fn = $tc['function']['name'] ?? $tc['name'] ?? '';
                        if ($this->isClientSideToolName($fn)) {
                            $toolCalls[$i]['id'] = SkillToolBridge::generateToolCallId();
                        }
                    }

                    // Add assistant message with tool calls
                    $state['messages'][] = [
                        'role' => 'assistant',
                        'content' => $parsed['text'] ?? null,
                        'tool_calls' => $toolCalls,
                    ];

                    // Execute tools and add results. Client tools round-trip
                    // to the browser (mirrors the sequential bridge); server
                    // tools run via ToolsManager as before.
                    foreach ($toolCalls as $toolCall) {
                        $functionName = $toolCall['function']['name'] ?? $toolCall['name'] ?? 'function';
                        if ($this->isClientSideToolName($functionName)) {
                            if (!empty($state['skill_ran'])) {
                                // Run-once: the model already executed this
                                // node's skill. In AUTO mode (no forced
                                // tool_choice here) some models keep re-calling
                                // run_skill_script, burning the round budget.
                                // Nudge it to summarize from the result it
                                // already has instead of looping.
                                $toolResult = json_encode([
                                    'note' => 'You have already run this skill — its output is in the previous tool result. Do NOT call run_skill_script again. Write your final analysis now using that output.',
                                ]);
                            } else {
                                $toolResult = $this->roundTripClientToolInParallel(
                                    $toolCall,
                                    $state['node'],
                                    $parsed['text'] ?? ''
                                );
                                $state['skill_ran'] = true;
                            }
                        } else {
                            $toolResult = $this->executeToolForParallel($toolCall, $state['tools_filter']);
                        }
                        $state['messages'][] = [
                            'role' => 'tool',
                            'tool_call_id' => $toolCall['id'],
                            'name' => $functionName,  // Needed for Gemini
                            'content' => is_string($toolResult) ? $toolResult : json_encode($toolResult),
                        ];
                    }
                    // Agent needs another round
                } else {
                    // No tool calls - agent is done
                    $state['completed'] = true;
                    $state['output'] = $parsed['text'] ?? '';
                    $state['success'] = true;
                    $state['usage'] = $parsed['usage'] ?? null;

                    $responseTime = (microtime(true) - $state['start_time']) * 1000;
                    error_log("[GraphWorkflowRunner] Agent {$agent->getName()} completed in {$responseTime}ms");
                }
            }
        }

        // IMPORTANT: Unset the reference to avoid PHP reference corruption in next loop
        unset($state);

        // Collect final results
        error_log("[GraphWorkflowRunner] Final agentStates keys: " . implode(',', array_keys($agentStates)));
        foreach ($agentStates as $nodeId => $finalState) {
            $agent = $finalState['agent'];
            $usage = $finalState['usage'] ?? null;

            // Accumulate tokens
            $inputTokens = $usage['input_tokens'] ?? $usage['prompt_tokens'] ?? 0;
            $outputTokens = $usage['output_tokens'] ?? $usage['completion_tokens'] ?? 0;
            $this->totalInputTokens += $inputTokens;
            $this->totalOutputTokens += $outputTokens;

            $results[$nodeId] = [
                'type' => 'agent',
                'agent_id' => $agent->getId(),
                'agent_name' => $agent->getName(),
                'input' => $finalState['input'] ?? '',
                'output' => $finalState['output'],
                'success' => $finalState['success'] ?? false,
                'usage' => $usage,
            ];

            error_log("[GraphWorkflowRunner] EMITTING node_complete for node {$nodeId} ({$agent->getName()})");
            $this->emitNodeEvent('node_complete', $finalState['node'], [
                'agent_name' => $agent->getName(),
                'success' => $finalState['success'] ?? false,
                'output' => $finalState['output'] ?? null,
                'input_tokens' => $inputTokens,
                'output_tokens' => $outputTokens,
                'cost_usd' => $this->computeNodeCost($agent->getProvider(), $inputTokens, $outputTokens),
            ]);

            // Phase 0: record an execution trace for this parallel agent node.
            $this->recordExecutionTrace($finalState['node'], $agent->getProvider(),
                method_exists($agent, 'getModel') ? $agent->getModel() : null,
                (bool)($finalState['success'] ?? false), $finalState['output'] ?? null,
                $inputTokens, $outputTokens);
        }

        error_log("[GraphWorkflowRunner] Parallel execution complete. Results for " . count($results) . " agents");
        return $results;
    }

    /**
     * Make parallel LLM calls for multiple agents
     */
    private function makeParallelLLMCalls(array $agentStates): array
    {
        $multiHandle = curl_multi_init();
        $curlHandles = [];

        foreach ($agentStates as $nodeId => $state) {
            $request = $this->buildAgentLLMRequestWithTools($state['agent'], $state['messages'], $state['tools']);
            if (!$request) continue;

            $ch = curl_init($request['url']);
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode($request['payload']),
                CURLOPT_HTTPHEADER => $request['headers'],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 300,
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_FOLLOWLOCATION => true,
            ]);

            curl_multi_add_handle($multiHandle, $ch);
            $curlHandles[$nodeId] = ['handle' => $ch, 'provider' => $request['provider']];
        }

        // Execute all in parallel
        $running = null;
        do {
            curl_multi_exec($multiHandle, $running);
            curl_multi_select($multiHandle, 0.5);
        } while ($running > 0);

        // Collect responses
        $responses = [];
        foreach ($curlHandles as $nodeId => $info) {
            $ch = $info['handle'];
            $response = curl_multi_getcontent($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $curlError = curl_error($ch);
            $curlErrno = curl_errno($ch);

            curl_multi_remove_handle($multiHandle, $ch);
            curl_close($ch);

            // Log curl errors with more info
            if ($curlErrno !== 0) {
                $effectiveUrl = curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
                $connectTime = curl_getinfo($ch, CURLINFO_CONNECT_TIME);
                error_log("[GraphWorkflowRunner] Node {$nodeId} CURL error ({$curlErrno}): {$curlError}, URL: {$effectiveUrl}, connect_time: {$connectTime}");
                $responses[$nodeId] = ['success' => false, 'error' => "CURL error: {$curlError}"];
                continue;
            }

            // Log HTTP code for debugging
            error_log("[GraphWorkflowRunner] Node {$nodeId} HTTP {$httpCode}, response_len=" . strlen($response));

            // HTTP 0 means connection failed
            if ($httpCode === 0) {
                error_log("[GraphWorkflowRunner] Node {$nodeId} connection failed (HTTP 0)");
                $responses[$nodeId] = ['success' => false, 'error' => "Connection failed"];
                continue;
            }

            if ($httpCode >= 400) {
                error_log("[GraphWorkflowRunner] HTTP error {$httpCode}: " . substr($response, 0, 500));
                // Extract error message from API response for better debugging
                $errorMessage = "HTTP {$httpCode}";
                $decoded = json_decode($response, true);
                if ($decoded) {
                    // OpenAI/Grok/DeepSeek format
                    if (isset($decoded['error']['message'])) {
                        $errorMessage = $decoded['error']['message'];
                    }
                    // Claude format
                    elseif (isset($decoded['error']['type'])) {
                        $errorMessage = $decoded['error']['type'] . ': ' . ($decoded['error']['message'] ?? '');
                    }
                    // Gemini format
                    elseif (isset($decoded['error']['status'])) {
                        $errorMessage = $decoded['error']['status'] . ': ' . ($decoded['error']['message'] ?? '');
                    }
                }
                $responses[$nodeId] = ['success' => false, 'error' => $errorMessage];
            } else {
                $parsed = $this->parseParallelLLMResponse($response, $info['provider']);
                // Debug: Log parsed response
                $toolCallCount = count($parsed['tool_calls'] ?? []);
                $textLen = strlen($parsed['text'] ?? '');
                error_log("[GraphWorkflowRunner] Node {$nodeId} response: provider={$info['provider']}, tool_calls={$toolCallCount}, text_len={$textLen}, has_usage=" . ($parsed['usage'] ? 'yes' : 'no'));
                // If empty response, log raw response for debugging
                if ($toolCallCount === 0 && $textLen === 0) {
                    error_log("[GraphWorkflowRunner] Node {$nodeId} EMPTY response, raw: " . substr($response, 0, 1000));
                }
                $responses[$nodeId] = ['success' => true, 'parsed' => $parsed];
            }
        }

        curl_multi_close($multiHandle);
        return $responses;
    }

    /**
     * Build LLM request with tools for parallel execution
     * Supports all providers: OpenAI, Claude, Gemini, Grok, DeepSeek, Kimi
     * Uses ProviderRequestFactory for unified request building.
     */
    private function buildAgentLLMRequestWithTools(\AgentTeam\Models\Agent $agent, array $messages, array $tools): ?array
    {
        $provider = strtolower($agent->getProvider());
        $model = $agent->getModel();
        $settings = $agent->getSettings();

        $providerConfig = $this->getProviderConfigForParallel($provider);
        if (!$providerConfig || empty($providerConfig['api_key'])) {
            error_log("[GraphWorkflowRunner] Agent {$agent->getName()}: No API key for provider {$provider}");
            return null;
        }

        $maxTokens = $settings['max_tokens'] ?? ($providerConfig['max_tokens'] ?? 4096);
        $temperature = $settings['temperature'] ?? 0.7;
        $modelToUse = $model ?: ($providerConfig['model'] ?? '');

        // Debug log
        error_log("[GraphWorkflowRunner] Agent {$agent->getName()}: provider={$provider}, model={$modelToUse}");

        // Use the ProviderRequestFactory for unified request building
        return ProviderRequestFactory::buildRequest(
            $provider,
            $modelToUse,
            $messages,
            $tools,
            $providerConfig,
            $maxTokens,
            $temperature
        );
    }

    /**
     * Parse LLM response including tool_calls - handles all provider formats.
     * Uses ProviderRequestFactory for unified response parsing.
     */
    private function parseParallelLLMResponse(string $response, string $provider): array
    {
        $decoded = json_decode($response, true);
        if (!$decoded) {
            error_log("[GraphWorkflowRunner] Failed to decode response for provider {$provider}");
            return ['text' => '', 'tool_calls' => [], 'usage' => null];
        }

        // Use the ProviderRequestFactory for unified response parsing
        return ProviderRequestFactory::parseResponse($provider, $decoded);
    }

    /**
     * Whether a tool name is a client-side tool that must execute in the
     * browser (Pyodide) rather than on the server. Mirrors the static list
     * in ClientSideToolsTrait::getClientSideToolNames().
     */
    private function isClientSideToolName(string $name): bool
    {
        return in_array($name, ['run_skill_script', 'discover_skill', 'Task'], true);
    }

    /**
     * Round-trip a client-side tool call to the browser during parallel
     * (fan-out) execution. Emits a client_tool_call event and blocks on the
     * skill bridge until the frontend posts the result back. This mirrors the
     * sequential bridge in runAgentWithClientToolBridge() so the parallel
     * path can run Pyodide skills too — without it, the parallel executor
     * would server-execute run_skill_script and fail ("not registered").
     *
     * The blocking awaitResult() serialises skill execution across agents in
     * the same round, but the LLM calls themselves remain parallel.
     */
    private function roundTripClientToolInParallel(array $toolCall, array $node, string $assistantText): string
    {
        $bridge = new SkillToolBridge();
        $toolCallId = $toolCall['id']; // already a bridge-compatible hex
        $name = $toolCall['function']['name'] ?? $toolCall['name'] ?? 'run_skill_script';
        $args = $toolCall['function']['arguments'] ?? $toolCall['input'] ?? [];
        if (is_string($args)) {
            $args = json_decode($args, true) ?: [];
        }
        $config = $node['config'] ?? [];
        $dirName = $config['bound_skill']['dir_name'] ?? null;

        $this->emitNodeEvent('client_tool_call', $node, [
            'tool_call_id' => $toolCallId,
            'tool_calls' => [[
                'id' => $toolCallId,
                'name' => $name,
                'input' => $args,
            ]],
            'assistant_text' => $assistantText,
            'dir_name' => $dirName,
        ]);

        $bridgeResult = $bridge->awaitResult($toolCallId);
        if ($bridgeResult === null) {
            error_log("[GraphWorkflowRunner] parallel client-tool bridge timed out for tool_call_id={$toolCallId}");
            return json_encode(['error' => 'Browser timed out running skill script. Keep the workflow editor open during the run.']);
        }
        // Phase 0: stash the skill stdout/script/argv for the execution trace.
        $this->skillResultByNode[(int)($node['id'] ?? 0)] = [
            'output' => is_array($bridgeResult['output'] ?? null) ? $bridgeResult['output'] : [],
            'script' => $args['script'] ?? null,
            'argv'   => $args['argv'] ?? [],
        ];
        return json_encode($bridgeResult, JSON_UNESCAPED_SLASHES);
    }

    /**
     * Execute a tool call for parallel execution
     */
    private function executeToolForParallel(array $toolCall, ?array $toolsFilter): string
    {
        $functionName = $toolCall['function']['name'] ?? '';
        $arguments = json_decode($toolCall['function']['arguments'] ?? '{}', true) ?? [];

        error_log("[GraphWorkflowRunner] Executing tool: {$functionName}");

        try {
            // Use the ToolsManager to execute the tool
            $result = $this->agentRunner->getToolsManager()->execute($functionName, $arguments);
            return is_string($result) ? $result : json_encode($result);
        } catch (\Exception $e) {
            error_log("[GraphWorkflowRunner] Tool execution error: " . $e->getMessage());
            return json_encode(['error' => $e->getMessage()]);
        }
    }

    /**
     * Build tools array for parallel agent execution
     */
    private function buildToolsForParallelAgent(\AgentTeam\Models\Agent $agent, ?array $toolsFilter): array
    {
        $allTools = $this->agentRunner->getToolsManager()->getToolDefinitions();

        if (empty($toolsFilter)) {
            return $allTools;
        }

        return array_values(array_filter($allTools, function($tool) use ($toolsFilter) {
            return in_array($tool['name'], $toolsFilter, true);
        }));
    }

    /**
     * Get provider config for parallel execution
     * Handles provider aliases (anthropic/claude, google/gemini)
     */
    private function getProviderConfigForParallel(string $name): ?array
    {
        $name = strtolower($name);

        // Handle provider aliases
        $aliases = [
            'anthropic' => 'claude',
            'google' => 'gemini',
        ];
        $primaryName = $aliases[$name] ?? $name;
        $alternateName = array_search($name, $aliases) ?: null;

        // Check database first
        try {
            // Try primary name first, then alternate
            $sql = "SELECT * FROM system_llm_settings WHERE provider_key IN (:key1, :key2) AND enabled = 1 LIMIT 1";
            $stmt = $this->db->prepare($sql);
            $stmt->execute([':key1' => $primaryName, ':key2' => $alternateName ?? $primaryName]);
            $dbConfig = $stmt->fetch(\PDO::FETCH_ASSOC);

            // Get config file for API key fallback - try both names
            $configSettings = $this->config[$primaryName]
                ?? $this->config['providers'][$primaryName]
                ?? ($alternateName ? ($this->config[$alternateName] ?? $this->config['providers'][$alternateName] ?? null) : null)
                ?? null;

            if ($dbConfig) {
                $dbApiKey = $dbConfig['api_key'] ?? '';
                $configApiKey = $configSettings['api_key'] ?? '';

                return [
                    'api_key' => !empty($dbApiKey) ? $dbApiKey : $configApiKey,
                    'model' => $dbConfig['model'] ?: ($configSettings['model'] ?? ''),
                    'base_url' => $dbConfig['base_url'] ?: ($configSettings['base_url'] ?? ''),
                    'max_tokens' => (int)($dbConfig['max_tokens'] ?: ($configSettings['max_tokens'] ?? 4096)),
                    'chat_endpoint' => $dbConfig['chat_endpoint'] ?: ($configSettings['chat_endpoint'] ?? '/v1/chat/completions'),
                ];
            }

            // No DB config, try config file
            if ($configSettings) {
                return $configSettings;
            }
        } catch (\Exception $e) {
            error_log("[GraphWorkflowRunner] Error loading provider config: " . $e->getMessage());
        }

        // Fallback to config array
        return $this->config[$primaryName]
            ?? $this->config['providers'][$primaryName]
            ?? ($alternateName ? ($this->config[$alternateName] ?? $this->config['providers'][$alternateName] ?? null) : null)
            ?? null;
    }

    /**
     * [DEPRECATED] Original curl_multi parallel execution without tool support
     */
    private function executeAgentsInParallelNoTools(array $agentNodes, int $userId, string $userPrompt, array $edges, array $executedNodes): array
    {
        error_log("[GraphWorkflowRunner] Executing " . count($agentNodes) . " agents in parallel (no tools)");

        $multiHandle = curl_multi_init();
        $curlHandles = [];
        $agentContexts = [];

        // Prepare all agent requests
        foreach ($agentNodes as $index => $node) {
            $nodeId = (int)$node['id'];

            // Get agent configuration
            $agentId = $node['agent_id'] ?? null;
            $config = $node['config'] ?? [];

            // Build context from previous nodes BEFORE emitting node_start (with merge strategy from config)
            $mergeStrategy = $config['merge_strategy'] ?? 'labeled';
            $context = $this->buildContextForNode($nodeId, $edges, $executedNodes, $mergeStrategy);

            // Determine task input
            $task = !empty($context)
                ? "Do your job on the following input:\n\n{$context}"
                : $userPrompt;

            // Emit node_start event with input content
            $this->emitNodeEvent('node_start', $node, [
                'input' => $task,
            ]);

            $agent = null;
            if ($agentId) {
                $agent = $this->agentRepository->findById($agentId);
            } elseif (!empty($config['agent_name']) || !empty($config['instructions'])) {
                // Inline agent configuration
                $agent = new \AgentTeam\Models\Agent([
                    'id' => null,
                    'user_id' => $userId,
                    'name' => $config['agent_name'] ?? $config['name'] ?? 'Inline Agent',
                    'description' => $config['description'] ?? '',
                    'agent_type' => $config['agent_type'] ?? 'worker',
                    'provider' => $config['agent_provider'] ?? $config['provider'] ?? 'openai',
                    'model' => $config['model'] ?? null,
                    'instructions' => $config['instructions'] ?? '',
                    'tools' => $config['tools'] ?? [],
                    'settings' => $config['settings'] ?? [],
                ]);
            }

            if (!$agent) {
                error_log("[GraphWorkflowRunner] No agent configuration for node {$nodeId}");
                continue;
            }

            // Build LLM request
            error_log("[GraphWorkflowRunner] Building request for {$agent->getName()} - Provider: {$agent->getProvider()}, Model: {$agent->getModel()}");
            $request = $this->buildAgentLLMRequest($agent, $task, $config);

            if (!$request) {
                error_log("[GraphWorkflowRunner] Failed to build request for agent {$agent->getName()}");
                continue;
            }
            error_log("[GraphWorkflowRunner] Request URL: {$request['url']}");

            // Create curl handle
            $ch = curl_init($request['url']);
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode($request['payload']),
                CURLOPT_HTTPHEADER => $request['headers'],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 600, // 10 minutes for LLM calls
                CURLOPT_CONNECTTIMEOUT => 30,
            ]);

            curl_multi_add_handle($multiHandle, $ch);
            $curlHandles[$index] = [
                'handle' => $ch,
                'node' => $node,
                'agent' => $agent,
                'provider' => $request['provider'],
            ];

            $agentContexts[$nodeId] = [
                'agent' => $agent,
                'task' => $task,
                'start_time' => microtime(true),
            ];

            error_log("[GraphWorkflowRunner] Prepared parallel request for agent: {$agent->getName()}");
        }

        if (empty($curlHandles)) {
            return [];
        }

        // Execute all requests in parallel
        error_log("[GraphWorkflowRunner] Starting parallel execution of " . count($curlHandles) . " LLM requests");
        $running = null;
        do {
            curl_multi_exec($multiHandle, $running);
            curl_multi_select($multiHandle, 1.0);
        } while ($running > 0);

        // Collect results
        $results = [];
        foreach ($curlHandles as $index => $handleInfo) {
            $ch = $handleInfo['handle'];
            $node = $handleInfo['node'];
            $agent = $handleInfo['agent'];
            $provider = $handleInfo['provider'];
            $nodeId = (int)$node['id'];

            $response = curl_multi_getcontent($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $error = curl_error($ch);

            curl_multi_remove_handle($multiHandle, $ch);
            curl_close($ch);

            $responseTime = (microtime(true) - $agentContexts[$nodeId]['start_time']) * 1000;

            if ($error) {
                error_log("[GraphWorkflowRunner] Parallel agent error for {$agent->getName()}: {$error}");
                $results[$nodeId] = [
                    'type' => 'agent',
                    'agent_id' => $agent->getId(),
                    'agent_name' => $agent->getName(),
                    'output' => "Error: Connection failed - {$error}",
                    'success' => false,
                    'error' => $error,
                ];

                $this->emitNodeEvent('node_complete', $node, [
                    'agent_name' => $agent->getName(),
                    'success' => false,
                    'output' => "Error: Connection failed - {$error}",
                    'input_tokens' => 0,
                    'output_tokens' => 0,
                ]);
                continue;
            }

            if ($httpCode >= 400) {
                error_log("[GraphWorkflowRunner] Parallel agent HTTP error for {$agent->getName()}: {$httpCode}");
                error_log("[GraphWorkflowRunner] Error response body: " . substr($response, 0, 500));
                $results[$nodeId] = [
                    'type' => 'agent',
                    'agent_id' => $agent->getId(),
                    'agent_name' => $agent->getName(),
                    'output' => "Error: HTTP {$httpCode}",
                    'success' => false,
                    'error' => "HTTP error: {$httpCode}",
                ];

                $this->emitNodeEvent('node_complete', $node, [
                    'agent_name' => $agent->getName(),
                    'success' => false,
                    'output' => "Error: HTTP {$httpCode}",
                    'input_tokens' => 0,
                    'output_tokens' => 0,
                ]);
                continue;
            }

            // Parse response based on provider
            $parsed = $this->parseAgentLLMResponse($response, $provider);

            error_log("[GraphWorkflowRunner] Parallel agent {$agent->getName()} completed in {$responseTime}ms");

            $agentOutput = $parsed['text'] ?? '';
            $agentInput = $agentContexts[$nodeId]['task'] ?? '';
            $usage = $parsed['usage'] ?? null;
            $inputTokens = $usage['input_tokens'] ?? $usage['prompt_tokens'] ?? 0;
            $outputTokens = $usage['output_tokens'] ?? $usage['completion_tokens'] ?? 0;
            $this->totalInputTokens += $inputTokens;
            $this->totalOutputTokens += $outputTokens;

            $results[$nodeId] = [
                'type' => 'agent',
                'agent_id' => $agent->getId(),
                'agent_name' => $agent->getName(),
                'input' => $agentInput,
                'output' => $agentOutput,
                'success' => true,
                'usage' => $usage,
            ];

            $this->emitNodeEvent('node_complete', $node, [
                'agent_name' => $agent->getName(),
                'success' => true,
                'output' => $agentOutput,
                'input_tokens' => $inputTokens,
                'output_tokens' => $outputTokens,
            ]);
        }

        curl_multi_close($multiHandle);

        error_log("[GraphWorkflowRunner] Parallel execution complete. Results for " . count($results) . " agents");
        return $results;
    }

    /**
     * Build HTTP request for an agent's LLM API call
     */
    private function buildAgentLLMRequest(\AgentTeam\Models\Agent $agent, string $task, array $nodeConfig = []): ?array
    {
        $provider = $agent->getProvider();
        $model = $agent->getModel();
        $settings = $agent->getSettings();

        // Build system prompt
        $systemPrompt = $agent->buildSystemPrompt();

        // Build messages
        $messages = [
            ['role' => 'system', 'content' => $systemPrompt],
            ['role' => 'user', 'content' => $task],
        ];

        // Helper to get provider config - merges database settings with config file API keys
        $getProviderConfig = function($name) {
            // Get config file settings first (has API keys)
            $configSettings = null;
            if (isset($this->config[$name])) {
                $configSettings = $this->config[$name];
            } elseif (isset($this->config['providers'][$name])) {
                $configSettings = $this->config['providers'][$name];
            }

            // Try to get database settings (has model/display preferences)
            try {
                $sql = "SELECT * FROM system_llm_settings WHERE provider_key = :key AND enabled = 1 LIMIT 1";
                $stmt = $this->db->prepare($sql);
                $stmt->execute([':key' => $name]);
                $dbConfig = $stmt->fetch(\PDO::FETCH_ASSOC);

                if ($dbConfig) {
                    // Merge: use DB for model/settings, but prefer config file for API key if DB key is empty
                    $dbApiKey = $dbConfig['api_key'] ?? '';
                    $configApiKey = $configSettings['api_key'] ?? '';

                    return [
                        'api_key' => !empty($dbApiKey) ? $dbApiKey : $configApiKey,
                        'model' => $dbConfig['model'] ?: ($configSettings['model'] ?? ''),
                        'base_url' => $dbConfig['base_url'] ?: ($configSettings['base_url'] ?? ''),
                        'max_tokens' => (int)($dbConfig['max_tokens'] ?: ($configSettings['max_tokens'] ?? 4096)),
                        'temperature' => (float)($dbConfig['temperature'] ?? ($configSettings['temperature'] ?? 0.7)),
                        'chat_endpoint' => $dbConfig['chat_endpoint'] ?: ($configSettings['chat_endpoint'] ?? ''),
                        'api_format' => $dbConfig['api_format'] ?: ($configSettings['api_format'] ?? 'openai'),
                        'streaming' => (bool)($dbConfig['streaming'] ?? true),
                        'supports_tools' => (bool)($dbConfig['supports_tools'] ?? true),
                        'supported_models' => json_decode($dbConfig['supported_models'] ?? '[]', true),
                    ];
                }
            } catch (\Exception $e) {
                error_log("[GraphWorkflowRunner] Error loading provider from DB: " . $e->getMessage());
            }

            // Fallback to config file only
            return $configSettings;
        };

        // Get API configuration based on provider
        switch ($provider) {
            case 'openai':
                $providerConfig = $getProviderConfig('openai');
                $apiKey = $providerConfig['api_key'] ?? $_ENV['OPENAI_API_KEY'] ?? null;
                if (!$apiKey) {
                    error_log("[GraphWorkflowRunner] No OpenAI API key configured");
                    return null;
                }

                // For OpenAI reasoning models (o1, o3, gpt-5.x), use higher max_tokens
                // to allow room for both reasoning and output tokens
                $maxTokens = $settings['max_tokens'] ?? ($providerConfig['max_tokens'] ?? 16384);

                $payload = [
                    'model' => $model ?: ($providerConfig['model'] ?? 'gpt-4o'),
                    'messages' => $messages,
                    'temperature' => $settings['temperature'] ?? 0.7,
                    'max_completion_tokens' => $maxTokens,
                ];

                return [
                    'url' => 'https://api.openai.com/v1/chat/completions',
                    'headers' => [
                        'Content-Type: application/json',
                        'Authorization: Bearer ' . $apiKey,
                    ],
                    'payload' => $payload,
                    'provider' => 'openai',
                ];

            case 'claude':
            case 'anthropic':
                $providerConfig = $getProviderConfig('claude') ?? $getProviderConfig('anthropic');
                $apiKey = $providerConfig['api_key'] ?? $_ENV['ANTHROPIC_API_KEY'] ?? null;
                if (!$apiKey) {
                    error_log("[GraphWorkflowRunner] No Anthropic API key configured");
                    return null;
                }

                // Claude uses different message format
                $claudeMessages = [
                    ['role' => 'user', 'content' => $task],
                ];

                $payload = [
                    'model' => $model ?: ($providerConfig['model'] ?? 'claude-sonnet-4-20250514'),
                    'max_tokens' => $settings['max_tokens'] ?? 4096,
                    'system' => $systemPrompt,
                    'messages' => $claudeMessages,
                ];

                return [
                    'url' => 'https://api.anthropic.com/v1/messages',
                    'headers' => [
                        'Content-Type: application/json',
                        'x-api-key: ' . $apiKey,
                        'anthropic-version: 2023-06-01',
                    ],
                    'payload' => $payload,
                    'provider' => 'claude',
                ];

            case 'gemini':
            case 'google':
                $providerConfig = $getProviderConfig('gemini') ?? $getProviderConfig('google');
                $apiKey = $providerConfig['api_key'] ?? $_ENV['GEMINI_API_KEY'] ?? null;
                if (!$apiKey) {
                    error_log("[GraphWorkflowRunner] No Gemini API key configured");
                    return null;
                }

                $geminiModel = $model ?: ($providerConfig['model'] ?? 'gemini-2.0-flash');
                $payload = [
                    'contents' => [
                        ['role' => 'user', 'parts' => [['text' => $systemPrompt . "\n\n" . $task]]],
                    ],
                    'generationConfig' => [
                        'temperature' => $settings['temperature'] ?? 0.7,
                        'maxOutputTokens' => $settings['max_tokens'] ?? 4096,
                    ],
                ];

                return [
                    'url' => "https://generativelanguage.googleapis.com/v1beta/models/{$geminiModel}:generateContent?key={$apiKey}",
                    'headers' => [
                        'Content-Type: application/json',
                    ],
                    'payload' => $payload,
                    'provider' => 'gemini',
                ];

            case 'deepseek':
                $providerConfig = $getProviderConfig('deepseek');
                $apiKey = $providerConfig['api_key'] ?? $_ENV['DEEPSEEK_API_KEY'] ?? null;
                if (!$apiKey) {
                    error_log("[GraphWorkflowRunner] No DeepSeek API key configured");
                    return null;
                }

                $payload = [
                    'model' => $model ?: ($providerConfig['model'] ?? 'deepseek-chat'),
                    'messages' => $messages,
                    'temperature' => $settings['temperature'] ?? 0.7,
                    'max_tokens' => $settings['max_tokens'] ?? 4096,
                ];

                return [
                    'url' => 'https://api.deepseek.com/v1/chat/completions',
                    'headers' => [
                        'Content-Type: application/json',
                        'Authorization: Bearer ' . $apiKey,
                    ],
                    'payload' => $payload,
                    'provider' => 'deepseek',
                ];

            case 'grok':
                $providerConfig = $getProviderConfig('grok');
                $apiKey = $providerConfig['api_key'] ?? $_ENV['XAI_API_KEY'] ?? null;
                if (!$apiKey) {
                    error_log("[GraphWorkflowRunner] No Grok API key configured");
                    return null;
                }

                $payload = [
                    'model' => $model ?: ($providerConfig['model'] ?? 'grok-2-latest'),
                    'messages' => $messages,
                    'temperature' => $settings['temperature'] ?? 0.7,
                    'max_tokens' => $settings['max_tokens'] ?? 4096,
                ];

                return [
                    'url' => rtrim($providerConfig['base_url'] ?? 'https://api.x.ai', '/') . '/v1/chat/completions',
                    'headers' => [
                        'Content-Type: application/json',
                        'Authorization: Bearer ' . $apiKey,
                    ],
                    'payload' => $payload,
                    'provider' => 'grok',
                ];

            case 'kimi':
                $providerConfig = $getProviderConfig('kimi');
                $apiKey = $providerConfig['api_key'] ?? $_ENV['KIMI_API_KEY'] ?? null;
                if (!$apiKey) {
                    error_log("[GraphWorkflowRunner] No Kimi API key configured");
                    return null;
                }

                // Kimi requires temperature=1 for some models, so we don't send temperature
                $payload = [
                    'model' => $model ?: ($providerConfig['model'] ?? 'moonshot-v1-auto'),
                    'messages' => $messages,
                    'max_tokens' => $settings['max_tokens'] ?? 4096,
                ];

                return [
                    'url' => rtrim($providerConfig['base_url'] ?? 'https://api.moonshot.cn', '/') . '/v1/chat/completions',
                    'headers' => [
                        'Content-Type: application/json',
                        'Authorization: Bearer ' . $apiKey,
                    ],
                    'payload' => $payload,
                    'provider' => 'kimi',
                ];

            default:
                // Try to find provider in config
                $providerConfig = $getProviderConfig($provider);

                if (!$providerConfig) {
                    error_log("[GraphWorkflowRunner] Unknown provider: {$provider}");
                    return null;
                }

                $apiKey = $providerConfig['api_key'] ?? null;
                $baseUrl = $providerConfig['base_url'] ?? null;

                if (!$apiKey || !$baseUrl) {
                    error_log("[GraphWorkflowRunner] Missing config for provider: {$provider}");
                    return null;
                }

                $payload = [
                    'model' => $model ?: ($providerConfig['model'] ?? 'default'),
                    'messages' => $messages,
                    'temperature' => $settings['temperature'] ?? 0.7,
                    'max_tokens' => $settings['max_tokens'] ?? 4096,
                ];

                return [
                    'url' => rtrim($baseUrl, '/') . ($providerConfig['chat_endpoint'] ?? '/v1/chat/completions'),
                    'headers' => [
                        'Content-Type: application/json',
                        'Authorization: Bearer ' . $apiKey,
                    ],
                    'payload' => $payload,
                    'provider' => $provider,
                ];
        }
    }

    /**
     * Parse LLM response based on provider
     */
    private function parseAgentLLMResponse(string $response, string $provider): array
    {
        $decoded = json_decode($response, true);

        if (!$decoded) {
            error_log("[GraphWorkflowRunner] parseAgentLLMResponse: Invalid JSON response");
            return ['text' => '', 'usage' => null, 'error' => 'Invalid JSON response'];
        }

        switch ($provider) {
            case 'openai':
            case 'deepseek':
            case 'grok':
            case 'kimi':
                // OpenAI-compatible format
                $text = $decoded['choices'][0]['message']['content'] ?? '';
                $usage = $decoded['usage'] ?? null;

                // Debug: log if content is empty but we got a response
                if (empty($text) && !empty($decoded['choices'])) {
                    error_log("[GraphWorkflowRunner] OpenAI response has empty content. Message: " . json_encode($decoded['choices'][0]['message'] ?? 'no message'));
                }

                return ['text' => $text, 'usage' => $usage];

            case 'claude':
                // Anthropic format
                $text = '';
                foreach ($decoded['content'] ?? [] as $block) {
                    if (($block['type'] ?? '') === 'text') {
                        $text .= $block['text'] ?? '';
                    }
                }
                $usage = $decoded['usage'] ?? null;
                return ['text' => $text, 'usage' => $usage];

            case 'gemini':
                // Google Gemini format
                $text = $decoded['candidates'][0]['content']['parts'][0]['text'] ?? '';
                $usage = $decoded['usageMetadata'] ?? null;
                return ['text' => $text, 'usage' => $usage];

            default:
                // Try OpenAI format as fallback
                $text = $decoded['choices'][0]['message']['content'] ?? $decoded['text'] ?? '';
                return ['text' => $text, 'usage' => $decoded['usage'] ?? null];
        }
    }

    // =========================================================================
    // DOCUMENT CONTEXT BUILDING METHODS
    // =========================================================================

    private const UNIVERSALFS_PATH = '/Applications/XAMPP/xamppfiles/htdocs/universalfs';
    private const ROOT_FOLDER = 'synergyaichatroot';
    private const UNIVERSALFS_USER_ID = 'Synergyaichat';

    /**
     * Build document context string from attached documents
     */
    private function buildDocumentsContext(array $node): string
    {
        $documents = $node['config']['documents'] ?? [];
        if (empty($documents)) {
            return '';
        }

        $textParts = ["## Attached Documents\n"];
        $imageCount = 0;

        foreach ($documents as $doc) {
            if ($this->isImageFile($doc['mimeType'] ?? '')) {
                $imageCount++;
                continue; // Images are handled separately for multimodal
            }

            try {
                $content = $this->readDocumentContent($doc);
                if (!empty($content)) {
                    $textParts[] = "### {$doc['name']}\n```\n{$content}\n```\n";
                }
            } catch (\Exception $e) {
                error_log("[GraphWorkflowRunner] Error reading document {$doc['name']}: " . $e->getMessage());
                $textParts[] = "### {$doc['name']}\n[Error: Could not read document]\n";
            }
        }

        if ($imageCount > 0) {
            $textParts[] = "\n_Note: {$imageCount} image(s) attached (processed separately if model supports vision)_\n";
        }

        return count($textParts) > 1 ? implode("\n", $textParts) : '';
    }

    /**
     * Get document images for multimodal models
     * Returns array of image content blocks for API
     */
    private function getDocumentImages(array $node): array
    {
        $documents = $node['config']['documents'] ?? [];
        $images = [];

        foreach ($documents as $doc) {
            if (!$this->isImageFile($doc['mimeType'] ?? '')) {
                continue;
            }

            // Skip locally stored images (cannot be accessed by backend)
            $storage = $doc['storage'] ?? 'remote';
            if ($storage === 'local') {
                error_log("[GraphWorkflowRunner] Skipping local image: {$doc['name']} (stored on user's machine)");
                continue;
            }

            try {
                $imageData = $this->readFileRaw($doc);
                if ($imageData) {
                    $images[] = [
                        'type' => 'image',
                        'source' => [
                            'type' => 'base64',
                            'media_type' => $doc['mimeType'],
                            'data' => base64_encode($imageData)
                        ]
                    ];
                }
            } catch (\Exception $e) {
                error_log("[GraphWorkflowRunner] Error reading image {$doc['name']}: " . $e->getMessage());
            }
        }

        return $images;
    }

    /**
     * Read document content as text
     */
    private function readDocumentContent(array $doc): string
    {
        // Check if this is a locally stored document (File System Access API)
        $storage = $doc['storage'] ?? 'remote';
        if ($storage === 'local') {
            $docId = (string) ($doc['id'] ?? '');

            // Bound-skill workflow: the browser pre-stashed the file
            // body for Pyodide /scratch/<name>. Tell the agent where to
            // find it via run_skill_script instead of inlining ~14K
            // tokens of body it would just hand back to the script
            // anyway. Mirrors the chat B3 pre-write pattern.
            if ($docId !== '' && isset($this->scratchFilesByDocId[$docId])) {
                $sf = $this->scratchFilesByDocId[$docId];
                $path = (string) ($sf['path'] ?? '');
                $mime = (string) ($sf['mime_type'] ?? 'application/octet-stream');
                $size = (int) ($sf['size'] ?? 0);
                error_log("[GraphWorkflowRunner] Using scratch reference for {$doc['name']} → {$path} ({$size} bytes)");
                return "[Pre-loaded into the script runtime at `{$path}` ({$mime}, {$size} bytes). "
                    . "When you call run_skill_script, reference this path in argv (e.g. `argv: [\"-i\", \"{$path}\", \"-o\", \"/outputs/<name>\"]`). "
                    . "Do not paste or restate the file content — the script will read it directly.]";
            }

            // Non-skill workflow: ship the body inline so generic
            // agents can see it. Without inline content, fall back to
            // the legacy "stored locally" message (scheduled cron runs
            // and browsers without the bridge can't reach the file).
            error_log("[GraphWorkflowRunner] readDocumentContent local doc id={$docId} name={$doc['name']} inlineKeys=" . json_encode(array_keys($this->inlineDocuments)));
            if ($docId !== '' && isset($this->inlineDocuments[$docId]) && is_string($this->inlineDocuments[$docId])) {
                error_log("[GraphWorkflowRunner] Using inline content for {$doc['name']} (" . strlen($this->inlineDocuments[$docId]) . " chars)");
                return $this->inlineDocuments[$docId];
            }
            error_log("[GraphWorkflowRunner] Skipping local document: {$doc['name']} (stored on user's machine, no inline content shipped)");
            return "[Document '{$doc['name']}' is stored locally on user's machine and cannot be accessed during server-side execution. Please use cloud storage for scheduled workflows.]";
        }

        $mimeType = $doc['mimeType'] ?? 'application/octet-stream';

        // PDF: extract text
        if ($mimeType === 'application/pdf') {
            return $this->extractPdfText($doc);
        }

        // Text files: read directly
        $content = $this->readFileRaw($doc);
        if ($content === null) {
            return '';
        }

        // Ensure content is valid UTF-8
        if (!mb_check_encoding($content, 'UTF-8')) {
            $content = mb_convert_encoding($content, 'UTF-8', 'auto');
        }

        return $content;
    }

    /**
     * Read raw file content from storage
     */
    private function readFileRaw(array $doc): ?string
    {
        $storagePath = $doc['path'] ?? '';
        $fullPath = $doc['fullPath'] ?? '';

        if (empty($storagePath) && empty($fullPath)) {
            return null;
        }

        // Try universalFS first
        $adapter = $this->getDocumentStorageAdapter();
        if ($adapter) {
            try {
                $path = '/' . ltrim($fullPath ?: (self::ROOT_FOLDER . '/' . $storagePath), '/');
                $stream = $adapter->readStream($path);
                $content = stream_get_contents($stream);
                fclose($stream);
                return $content;
            } catch (\Exception $e) {
                error_log("[GraphWorkflowRunner] universalFS read error: " . $e->getMessage());
            }
        }

        // Fallback to local storage
        $localPath = $this->getDocumentLocalPath($fullPath ?: $storagePath);
        if (file_exists($localPath)) {
            return file_get_contents($localPath);
        }

        return null;
    }

    /**
     * Extract text from PDF file
     */
    private function extractPdfText(array $doc): string
    {
        // Read raw PDF content
        $pdfContent = $this->readFileRaw($doc);
        if (!$pdfContent) {
            return '[PDF content could not be read]';
        }

        // Create temp file for pdftotext
        $tmpFile = tempnam(sys_get_temp_dir(), 'pdf_');
        file_put_contents($tmpFile, $pdfContent);

        try {
            // Try pdftotext (from poppler-utils)
            $output = shell_exec("pdftotext -layout '{$tmpFile}' - 2>/dev/null");

            if ($output !== null && !empty(trim($output))) {
                return trim($output);
            }

            // Fallback: basic text extraction from PDF
            return $this->basicPdfTextExtract($pdfContent);

        } finally {
            if (file_exists($tmpFile)) {
                unlink($tmpFile);
            }
        }
    }

    /**
     * Basic PDF text extraction (fallback when pdftotext not available)
     */
    private function basicPdfTextExtract(string $pdfContent): string
    {
        // Simple regex-based text extraction
        $text = '';

        // Extract text between stream markers
        if (preg_match_all('/stream\s*(.*?)\s*endstream/s', $pdfContent, $matches)) {
            foreach ($matches[1] as $stream) {
                // Try to decode if compressed
                $decoded = @gzuncompress($stream);
                if ($decoded !== false) {
                    $stream = $decoded;
                }

                // Extract text objects
                if (preg_match_all('/\((.*?)\)/', $stream, $textMatches)) {
                    $text .= implode(' ', $textMatches[1]) . "\n";
                }
            }
        }

        return !empty(trim($text)) ? trim($text) : '[PDF text extraction limited - install pdftotext for better results]';
    }

    /**
     * Check if MIME type is an image
     */
    private function isImageFile(string $mimeType): bool
    {
        return str_starts_with($mimeType, 'image/');
    }

    /**
     * Get universalFS adapter for document storage
     */
    private function getDocumentStorageAdapter(?int $userId = null): ?object
    {
        static $adapters = [];

        // Use current user ID if not provided
        if ($userId === null) {
            $userId = $this->currentUserId;
        }

        if (!$userId) {
            error_log("[GraphWorkflowRunner] No user ID available for document storage");
            return null;
        }

        // Return cached adapter for this user
        if (isset($adapters[$userId])) {
            return $adapters[$userId];
        }

        $autoloadPath = self::UNIVERSALFS_PATH . '/vendor/autoload.php';

        if (!file_exists($autoloadPath)) {
            $adapters[$userId] = null;
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
            $adapters[$userId] = $adapterFactory->connect(self::UNIVERSALFS_USER_ID, $provider);

            return $adapters[$userId];

        } catch (\Exception $e) {
            error_log("[GraphWorkflowRunner] universalFS adapter error: " . $e->getMessage());
            $adapters[$userId] = null;
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
     * Get local storage path for document
     */
    private function getDocumentLocalPath(string $relativePath): string
    {
        $basePath = $this->config['storage_path'] ?? __DIR__ . '/../../../../storage';
        return $basePath . '/' . ltrim($relativePath, '/');
    }

    /**
     * Archive a completed workflow run into conversation_contexts so it
     * appears in the chat sidebar and is searchable via session_search.
     *
     * Shape of the stored row (mirrors a two-turn chat):
     *   context_data = {"messages":[{"role":"user","content":<prompt>},
     *                               {"role":"assistant","content":<output>}]}
     *   provider     = "workflow:<workflowId>"
     *   title        = <first ~60 chars of the prompt>
     *
     * The `provider` prefix is the machine-readable marker used by the
     * chat sidebar to render workflow runs distinctly from chat sessions.
     *
     * Archive content: we pull the raw text from $this->nodeOutputs[$id]['output']
     * (same field shown in each agent's "Output Response" tab) rather than the
     * final workflow response. When the last agent formats content as HTML, the
     * final response is an HTML document that the chat renderer can't display
     * and carries prompt-injection risk. The markdown output of the upstream
     * agent has all the information and renders cleanly via marked.js.
     */
    private function archiveRunToConversationContexts(
        int $userId,
        int $workflowId,
        string $workflowName,
        string $userPrompt,
        string $finalOutput
    ): void {
        if ($userId <= 0) {
            return;
        }

        // Preferred: take the End node's final output (the fully integrated
        // result, including any work the formatter agent did). If it's HTML,
        // convert to markdown so the chat renders cleanly and search stays
        // clean. On conversion failure, fall back to the walk-back heuristic
        // that picks the most recent non-HTML agent output.
        $archiveOutput = $this->buildArchiveOutput($finalOutput);
        if ($archiveOutput === '' && trim($userPrompt) === '') {
            return; // nothing worth archiving
        }

        $contextsPdo = SessionSearchService::connectFromConfig($this->config);

        $messages = [
            ['role' => 'user', 'content' => $userPrompt],
            ['role' => 'assistant', 'content' => $archiveOutput],
        ];
        $contextData = json_encode(['messages' => $messages], JSON_UNESCAPED_UNICODE);

        $title = trim($userPrompt);
        if ($title === '') {
            $title = '(no prompt) — ' . $workflowName;
        }
        if (mb_strlen($title) > 60) {
            $title = mb_substr($title, 0, 60) . '…';
        }

        $provider = 'workflow:' . $workflowId;
        $messageCount = count($messages);

        $stmt = $contextsPdo->prepare('
            INSERT INTO conversation_contexts
              (user_id, title, context_data, provider, message_count)
            VALUES
              (:user_id, :title, :context_data, :provider, :message_count)
        ');
        $stmt->execute([
            'user_id' => $userId,
            'title' => $title,
            'context_data' => $contextData,
            'provider' => $provider,
            'message_count' => $messageCount,
        ]);

        error_log(sprintf(
            '[GraphWorkflowRunner] Archived workflow %d (%s) to conversation_contexts id=%s',
            $workflowId,
            $workflowName,
            $contextsPdo->lastInsertId()
        ));
    }

    /**
     * Build the content written to the archive row.
     *
     * Strategy:
     *   1. Start from $finalOutput (the End node's integrated final result).
     *   2. If it's markdown-ish (not HTML-shaped): archive it as-is.
     *   3. If it's HTML: convert to markdown via league/html-to-markdown.
     *   4. If conversion fails / returns empty: fall back to
     *      pickMarkdownAgentOutput() — walk back through nodeOutputs and
     *      use the most recent non-HTML agent output.
     */
    private function buildArchiveOutput(string $finalOutput): string
    {
        $finalOutput = trim($finalOutput);
        if ($finalOutput === '') {
            return $this->pickMarkdownAgentOutput();
        }

        if (!$this->isHtmlShaped($finalOutput)) {
            return $finalOutput;
        }

        // HTML-shaped: convert to markdown.
        if (class_exists(\League\HTMLToMarkdown\HtmlConverter::class)) {
            try {
                $converter = new \League\HTMLToMarkdown\HtmlConverter([
                    'header_style' => 'atx',    // ## Heading rather than underline
                    'strip_tags' => true,       // drop unknown tags rather than keep them
                    'hard_break' => true,       // <br> → line break
                    // Never carry executable/style/meta content into the archive.
                    // `head` subsumes title/meta/link; scripts/styles stripped too.
                    'remove_nodes' => 'script style head title meta link noscript',
                ]);
                $md = trim((string) $converter->convert($finalOutput));
                if ($md !== '') {
                    return $md;
                }
            } catch (\Throwable $e) {
                error_log('[GraphWorkflowRunner] HTML→markdown conversion failed: ' . $e->getMessage());
            }
        } else {
            error_log('[GraphWorkflowRunner] league/html-to-markdown not installed; falling back to walk-back heuristic');
        }

        // Fallback: the pre-existing walk-back picks the most recent
        // agent output that isn't HTML-shaped.
        return $this->pickMarkdownAgentOutput();
    }

    /**
     * Walk $this->nodeOutputs in reverse insertion order and return the
     * most recent agent output that is plain markdown (not HTML-shaped).
     *
     * Used as a fallback when the End node's output is HTML and conversion
     * fails, or when $finalOutput is empty.
     */
    private function pickMarkdownAgentOutput(): string
    {
        $reversed = array_reverse($this->nodeOutputs, true);

        foreach ($reversed as $nodeOutput) {
            $text = is_array($nodeOutput) ? (string) ($nodeOutput['output'] ?? '') : '';
            $text = trim($text);
            if ($text === '' || $this->isHtmlShaped($text)) {
                continue;
            }
            return $text;
        }

        // Fallback: every output looked HTML-ish. Return the most recent
        // non-empty one so we still archive something meaningful.
        foreach ($reversed as $nodeOutput) {
            $text = is_array($nodeOutput) ? (string) ($nodeOutput['output'] ?? '') : '';
            $text = trim($text);
            if ($text !== '') {
                return $text;
            }
        }

        return '';
    }

    /**
     * Heuristic: does this content contain HTML that should be converted?
     *
     * Matches against markers ANYWHERE in the content — agents often
     * write a plain-text preamble ("I'll format this as HTML...") followed
     * by a full HTML document, so a start-of-string check isn't enough.
     */
    private function isHtmlShaped(string $content): bool
    {
        if (trim($content) === '') {
            return false;
        }

        // Definite HTML markers anywhere in the content.
        if (stripos($content, '<!DOCTYPE') !== false) {
            return true;
        }
        if (stripos($content, '<html') !== false) {
            return true;
        }
        if (stripos($content, '<body') !== false) {
            return true;
        }
        if (stripos($content, '<head>') !== false) {
            return true;
        }

        // No document-level markers — fall back to tag-density check for
        // fragments like "<div><h1>Title</h1><p>...". Plain markdown with
        // an occasional inline <b> / <a> stays under the threshold.
        if (preg_match_all('/<[a-z][^>]*>/i', $content, $matches)) {
            $tagChars = 0;
            foreach ($matches[0] as $tag) {
                $tagChars += strlen($tag);
            }
            $total = strlen($content);
            return $total > 0 && ($tagChars / $total) > 0.15;
        }

        return false;
    }
}
