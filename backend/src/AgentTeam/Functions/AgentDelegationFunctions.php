<?php

declare(strict_types=1);

namespace AgentTeam\Functions;

use AgentTeam\Models\Agent;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\AgentRunner;
use AgentTeam\Services\StreamContext;

/**
 * Agent Delegation Functions
 *
 * Provides tools for manager agents to delegate tasks to worker agents.
 * These functions are registered with ToolsManager and can be called by LLMs.
 *
 * Tools provided:
 * - delegate_to_agent: Delegate a task to a specific agent
 * - list_available_agents: List agents that can be delegated to
 * - run_agents_parallel: Run multiple agents in parallel
 *
 * @see docs/agentDesign.md
 */
class AgentDelegationFunctions
{
    private AgentRepository $repository;
    private AgentRunner $runner;

    public function __construct(AgentRepository $repository, AgentRunner $runner)
    {
        $this->repository = $repository;
        $this->runner = $runner;
    }

    /**
     * Get the names of all delegation tools (static method for use without instantiation)
     *
     * @return array Array of tool names
     */
    public static function getToolNames(): array
    {
        return [
            'delegate_to_agent',
            'list_available_agents',
            'run_agents_parallel',
        ];
    }

    /**
     * Get all delegation functions with their handlers and schemas
     *
     * @return array Function definitions keyed by function name
     */
    public function getAllFunctions(): array
    {
        return [
            'delegate_to_agent' => [
                'handler' => [$this, 'delegateToAgent'],
                'schema' => [
                    'description' => 'Delegate a task to a specialized sub-agent. The sub-agent will execute the task and return results. Use this to break down complex tasks and assign them to specialists. You can specify the agent by ID or name.',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'agent_id' => [
                                'type' => 'integer',
                                'description' => 'ID of the agent to delegate to (use either agent_id or agent_name)',
                            ],
                            'agent_name' => [
                                'type' => 'string',
                                'description' => 'Name of the agent to delegate to (use either agent_id or agent_name)',
                            ],
                            'task' => [
                                'type' => 'string',
                                'description' => 'The task description to send to the sub-agent. Be specific and clear about what you need.',
                            ],
                            'context' => [
                                'type' => 'string',
                                'description' => 'Optional additional context from previous agent outputs or research to help the sub-agent.',
                            ],
                        ],
                        'required' => ['task'],
                    ],
                ],
            ],

            'list_available_agents' => [
                'handler' => [$this, 'listAvailableAgents'],
                'schema' => [
                    'description' => 'List all agents that this manager can delegate tasks to. Returns agent names, descriptions, and capabilities. Use this to understand your team before delegating.',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'agent_type' => [
                                'type' => 'string',
                                'description' => 'Optional filter by agent type: worker, standard, or all',
                                'enum' => ['worker', 'standard', 'all'],
                            ],
                        ],
                        'required' => [],
                    ],
                ],
            ],

            'run_agents_parallel' => [
                'handler' => [$this, 'runAgentsParallel'],
                'schema' => [
                    'description' => 'Run multiple agents in parallel and collect their results. Useful for gathering information from multiple specialists simultaneously. Results are returned together once all agents complete.',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'delegations' => [
                                'type' => 'array',
                                'description' => 'Array of delegation objects, each with agent_name and task',
                                'items' => [
                                    'type' => 'object',
                                    'properties' => [
                                        'agent_name' => [
                                            'type' => 'string',
                                            'description' => 'Name of the agent to delegate to',
                                        ],
                                        'task' => [
                                            'type' => 'string',
                                            'description' => 'The task for this agent',
                                        ],
                                        'context' => [
                                            'type' => 'string',
                                            'description' => 'Optional context for this agent',
                                        ],
                                    ],
                                    'required' => ['agent_name', 'task'],
                                ],
                            ],
                        ],
                        'required' => ['delegations'],
                    ],
                ],
            ],

            'complete_task' => [
                'handler' => [$this, 'completeTask'],
                'schema' => [
                    'description' => 'Signal that the workflow is complete and you are ready to provide your final response to the user. Call this ONLY when you have gathered all necessary information from your agents and are ready to synthesize the final answer. After calling this, respond directly to the user with your findings.',
                    'input_schema' => [
                        'type' => 'object',
                        'properties' => [
                            'reason' => [
                                'type' => 'string',
                                'description' => 'Brief explanation of why the workflow is complete (e.g., "All research gathered and verified", "User question fully answered")',
                            ],
                            'summary' => [
                                'type' => 'string',
                                'description' => 'Optional brief summary of what was accomplished during the workflow',
                            ],
                        ],
                        'required' => ['reason'],
                    ],
                ],
            ],
        ];
    }

    /**
     * Delegate a task to another agent
     *
     * @param array $params Function parameters
     * @param mixed $context Execution context (user_id, current_agent_id, etc.)
     * @return array Result from the delegated agent
     */
    public function delegateToAgent(array $params, $context = null): array
    {
        // DEBUG: Log delegation attempt
        error_log("[DELEGATION] delegateToAgent called with params: " . json_encode($params));
        error_log("[DELEGATION] Context received: " . json_encode($context));

        // Extract context
        $userId = $this->extractUserId($context);
        $currentAgentId = $this->extractCurrentAgentId($context);
        $parentExecutionId = $this->extractParentExecutionId($context);

        error_log("[DELEGATION] Extracted: userId=$userId, currentAgentId=$currentAgentId, parentExecutionId=$parentExecutionId");

        // Validate task
        $task = trim($params['task'] ?? '');
        if (empty($task)) {
            error_log("[DELEGATION] EARLY RETURN: empty task");
            return [
                'success' => false,
                'error' => 'Task description is required',
            ];
        }

        // Find the agent to delegate to
        $agentId = $params['agent_id'] ?? null;
        $agentName = $params['agent_name'] ?? null;

        if (!$agentId && !$agentName) {
            error_log("[DELEGATION] EARLY RETURN: no agent_id or agent_name");
            return [
                'success' => false,
                'error' => 'Either agent_id or agent_name is required',
            ];
        }

        error_log("[DELEGATION] Looking for agent: id=" . ($agentId ?? 'null') . ", name=" . ($agentName ?? 'null'));

        try {
            // Get fresh repository with valid DB connection
            // This handles cases where connection went stale during long-running operations
            $freshRepo = $this->runner->getFreshRepository();
            $agent = $agentId
                ? $freshRepo->findById((int) $agentId)
                : $freshRepo->findByName($agentName, $userId);
        } catch (\PDOException $e) {
            error_log("[DELEGATION] DATABASE ERROR in findByName: " . $e->getMessage());
            return [
                'success' => false,
                'error' => 'Database connection error while finding agent. Please retry.',
                'retry' => true,
            ];
        } catch (\Exception $e) {
            error_log("[DELEGATION] ERROR in findByName: " . $e->getMessage());
            return [
                'success' => false,
                'error' => 'Error finding agent: ' . $e->getMessage(),
            ];
        }

        error_log("[DELEGATION] Agent found: " . ($agent ? $agent->getName() . " (id=" . $agent->getId() . ")" : "NULL"));

        if (!$agent) {
            // Get list of available agents to help LLM self-correct
            $availableAgents = [];
            if ($currentAgentId) {
                $freshRepo = $this->runner->getFreshRepository();
                $workers = $freshRepo->findWorkerAgents($currentAgentId);
                foreach ($workers as $worker) {
                    $availableAgents[] = $worker->getName();
                }
            }

            $errorMsg = "Agent not found: " . ($agentName ?? "ID {$agentId}");
            if (!empty($availableAgents)) {
                $errorMsg .= ". Available agents you can delegate to: " . implode(', ', array_map(fn($n) => '"' . $n . '"', $availableAgents));
            }

            error_log("[DELEGATION] Agent not found. Available: " . json_encode($availableAgents));

            return [
                'success' => false,
                'error' => $errorMsg,
                'available_agents' => $availableAgents,
            ];
        }

        // Check if agent is enabled
        if (!$agent->isEnabled()) {
            error_log("[DELEGATION] EARLY RETURN: agent '{$agent->getName()}' is disabled");
            return [
                'success' => false,
                'error' => "Agent '{$agent->getName()}' is disabled",
            ];
        }

        error_log("[DELEGATION] Agent enabled check passed");

        // Check delegation permission (use fresh repo to avoid stale connection)
        if ($currentAgentId) {
            try {
                $manager = $freshRepo->findById($currentAgentId);
                if ($manager && !$manager->canDelegateToAgent($agent->getId())) {
                    error_log("[DELEGATION] EARLY RETURN: Manager cannot delegate to agent '{$agent->getName()}'");
                    return [
                        'success' => false,
                        'error' => "Manager cannot delegate to agent '{$agent->getName()}'",
                    ];
                }
            } catch (\PDOException $e) {
                error_log("[DELEGATION] DB ERROR in delegation permission check: " . $e->getMessage());
                // Re-fetch fresh repo and retry once
                $freshRepo = $this->runner->getFreshRepository();
                $manager = $freshRepo->findById($currentAgentId);
                if ($manager && !$manager->canDelegateToAgent($agent->getId())) {
                    return [
                        'success' => false,
                        'error' => "Manager cannot delegate to agent '{$agent->getName()}'",
                    ];
                }
            }
        }

        error_log("[DELEGATION] Delegation permission check passed");

        // Build input with context
        $input = $task;
        $additionalContext = trim($params['context'] ?? '');
        if (!empty($additionalContext)) {
            $input = "## Context from Previous Analysis\n{$additionalContext}\n\n## Your Task\n{$task}";
        }

        // Get stream context from execution context for real-time events
        $streamContext = $this->extractStreamContext($context);
        error_log("[DELEGATION] StreamContext extracted: " . ($streamContext ? 'YES' : 'NO'));

        // Emit agent_delegate event
        if ($streamContext) {
            $managerAgent = $currentAgentId ? $freshRepo->findById($currentAgentId) : null;
            $streamContext->emitAgentDelegate(
                $currentAgentId ?? 0,
                $managerAgent ? $managerAgent->getName() : 'Unknown',
                $agent->getId(),
                $agent->getName(),
                $task
            );
        }

        // Pass stream context to runner for nested agent events
        if ($streamContext) {
            $this->runner->setStreamContext($streamContext);
        }

        // Execute the agent
        error_log("[DELEGATION] About to call runner->run() for '{$agent->getName()}'");
        try {
            $result = $this->runner->run(
                $agent,
                $input,
                [], // Fresh conversation for sub-agent
                $userId,
                [
                    'parent_execution_id' => $parentExecutionId,
                    'parent_agent_id' => $currentAgentId,
                ]
            );

            error_log("[DELEGATION] runner->run() returned for '{$agent->getName()}', success=" . ($result['success'] ? 'YES' : 'NO'));

            if ($result['success']) {
                $responseText = $result['text'] ?? '';
                $responseLength = strlen($responseText);
                error_log("[DELEGATION] SUCCESS from '{$agent->getName()}': response length={$responseLength} chars, tools_used=" . json_encode($result['tools_used'] ?? []));
                error_log("[DELEGATION] Response preview: " . substr($responseText, 0, 200) . ($responseLength > 200 ? '...' : ''));

                // Get available workers for manager's next decision
                $availableWorkers = $currentAgentId ? $this->runner->getAvailableWorkers($currentAgentId) : [];

                return [
                    'success' => true,
                    'delegated_to' => $agent->getName(),
                    'agent_id' => $agent->getId(),
                    'agent_type' => $agent->getAgentType(),
                    'status' => 'completed',
                    'result' => $responseText,
                    'result_word_count' => str_word_count($responseText),
                    'tools_used' => $result['tools_used'] ?? [],
                    'execution_id' => $result['execution_id'] ?? null,
                    'available_agents' => array_map(fn($w) => $w['name'], $availableWorkers),
                    'hint' => 'Based on this result, decide: delegate to another agent, or call complete_task to finish and respond to user.',
                ];
            } else {
                error_log("[DELEGATION] FAILED from '{$agent->getName()}': " . ($result['error'] ?? 'Unknown error'));

                return [
                    'success' => false,
                    'agent_name' => $agent->getName(),
                    'error' => $result['error'] ?? 'Unknown error',
                ];
            }
        } catch (\Exception $e) {
            error_log("[DELEGATION] EXCEPTION in delegation to '{$agent->getName()}': " . $e->getMessage());
            error_log("[DELEGATION] Exception trace: " . $e->getTraceAsString());
            return [
                'success' => false,
                'agent_name' => $agent->getName(),
                'error' => "Delegation failed: " . $e->getMessage(),
            ];
        }
    }

    /**
     * List agents available for delegation
     *
     * @param array $params Function parameters
     * @param mixed $context Execution context
     * @return array List of available agents
     */
    public function listAvailableAgents(array $params, $context = null): array
    {
        $userId = $this->extractUserId($context);
        $currentAgentId = $this->extractCurrentAgentId($context);
        $typeFilter = $params['agent_type'] ?? 'all';

        $agents = [];

        // Use fresh repository to avoid stale DB connection
        $freshRepo = $this->runner->getFreshRepository();

        // If we have a current manager agent, get its allowed workers
        if ($currentAgentId) {
            $workers = $freshRepo->findWorkerAgents($currentAgentId);
            foreach ($workers as $agent) {
                if ($typeFilter === 'all' || $agent->getAgentType() === $typeFilter) {
                    $agents[] = $this->formatAgentInfo($agent);
                }
            }
        } else {
            // Otherwise get all accessible agents
            $filters = [];
            if ($typeFilter !== 'all') {
                $filters['agent_type'] = $typeFilter;
            }

            $accessibleAgents = $freshRepo->findAccessibleByUser($userId, $filters);
            foreach ($accessibleAgents as $agent) {
                // Exclude manager agents from the list (they shouldn't be delegated to)
                if ($agent->getAgentType() !== 'manager') {
                    $agents[] = $this->formatAgentInfo($agent);
                }
            }
        }

        return [
            'success' => true,
            'count' => count($agents),
            'agents' => $agents,
            'message' => count($agents) > 0
                ? "Found " . count($agents) . " agents available for delegation"
                : "No agents available for delegation",
        ];
    }

    /**
     * Run multiple agents in parallel
     *
     * @param array $params Function parameters with delegations array
     * @param mixed $context Execution context
     * @return array Combined results from all agents
     */
    public function runAgentsParallel(array $params, $context = null): array
    {
        $delegations = $params['delegations'] ?? [];
        if (empty($delegations) || !is_array($delegations)) {
            return ['success' => false, 'error' => 'No delegations provided'];
        }

        $userId = $this->extractUserId($context);
        $currentAgentId = $this->extractCurrentAgentId($context);
        $streamContext = $this->extractStreamContext($context);

        if ($streamContext) {
            $streamContext->emit([
                'type' => 'parallel_start',
                'count' => count($delegations),
                'agents' => array_map(fn($d) => $d['agent_name'] ?? 'unknown', $delegations),
                'timestamp' => microtime(true),
            ]);
        }

        $repo = $this->runner->getFreshRepository();
        $executor = $this->runner->createParallelExecutor(true); // record executions; no observer/bridge
        $manager = $currentAgentId ? $repo->findById($currentAgentId) : null;

        // Build one state per valid delegation; collect index errors separately.
        $states = [];
        $indexByKey = [];
        $errors = [];
        foreach ($delegations as $index => $d) {
            $agentName = $d['agent_name'] ?? null;
            $task = $d['task'] ?? null;
            if (!$agentName || !$task) {
                $errors[$index] = ['index' => $index, 'agent' => $agentName ?? 'unknown',
                    'success' => false, 'error' => 'Missing agent_name or task', 'execution_id' => null];
                continue;
            }
            $agent = $repo->findByName($agentName, $userId);
            if (!$agent || !$agent->isEnabled()) {
                $errors[$index] = ['index' => $index, 'agent' => $agentName,
                    'success' => false, 'error' => "Agent not found or disabled: {$agentName}", 'execution_id' => null];
                continue;
            }
            if ($agent->isManager()) {
                $errors[$index] = ['index' => $index, 'agent' => $agentName,
                    'success' => false, 'error' => 'Cannot run a manager agent in a parallel batch', 'execution_id' => null];
                continue;
            }
            if ($manager && !$manager->canDelegateToAgent($agent->getId())) {
                $errors[$index] = ['index' => $index, 'agent' => $agentName,
                    'success' => false, 'error' => "Manager cannot delegate to '{$agentName}'", 'execution_id' => null];
                continue;
            }

            $input = $task;
            $ctx = trim($d['context'] ?? '');
            if ($ctx !== '') $input = "## Context from Previous Analysis\n{$ctx}\n\n## Your Task\n{$task}";

            $states[] = [
                'key' => $index,
                'agent' => $agent,
                'input' => $input,
                'user_id' => $userId,
                'messages' => [
                    ['role' => 'system', 'content' => $agent->buildSystemPrompt()],
                    ['role' => 'user', 'content' => $input],
                ],
                'tools' => $executor->buildToolsFor($agent, $agent->getTools() ?: null),
                'tools_filter' => $agent->getTools() ?: null,
            ];
            $indexByKey[$index] = $task;
        }

        $execResults = !empty($states) ? $executor->run($states) : [];

        // Merge executor results with pre-flight errors, preserving delegation order.
        $results = [];
        $successCount = 0;
        $failCount = 0;
        foreach ($delegations as $index => $d) {
            if (isset($errors[$index])) {
                $results[] = $errors[$index];
                $failCount++;
                continue;
            }
            $r = $execResults[$index] ?? ['success' => false, 'output' => null, 'execution_id' => null];
            $ok = (bool) ($r['success'] ?? false);
            $results[] = [
                'index' => $index,
                'agent' => $d['agent_name'],
                'task' => $indexByKey[$index] ?? ($d['task'] ?? ''),
                'success' => $ok,
                'result' => $r['output'] ?? null,
                'error' => $ok ? null : ($r['error'] ?? 'Agent did not complete'),
                'execution_id' => $r['execution_id'] ?? null,
            ];
            $ok ? $successCount++ : $failCount++;
        }

        if ($streamContext) {
            $streamContext->emit(['type' => 'parallel_complete',
                'successful' => $successCount, 'failed' => $failCount, 'timestamp' => microtime(true)]);
        }

        return [
            'success' => $failCount === 0,
            'total_agents' => count($delegations),
            'successful' => $successCount,
            'failed' => $failCount,
            'results' => $results,
            'message' => "Completed {$successCount} of " . count($delegations) . " delegations",
        ];
    }

    /**
     * Format agent info for listing
     */
    private function formatAgentInfo(Agent $agent): array
    {
        return [
            'id' => $agent->getId(),
            'name' => $agent->getName(),
            'description' => $agent->getDescription(),
            'type' => $agent->getAgentType(),
            'provider' => $agent->getProvider(),
            'tools' => $agent->getTools(),
        ];
    }

    /**
     * Extract user ID from context
     */
    private function extractUserId($context): int
    {
        if (is_array($context)) {
            return (int) ($context['user_id'] ?? 0);
        }
        if (is_int($context)) {
            return $context;
        }
        return 0;
    }

    /**
     * Extract current agent ID from context
     */
    private function extractCurrentAgentId($context): ?int
    {
        if (is_array($context) && isset($context['current_agent_id'])) {
            return (int) $context['current_agent_id'];
        }
        return null;
    }

    /**
     * Extract parent execution ID from context
     */
    private function extractParentExecutionId($context): ?int
    {
        if (is_array($context) && isset($context['execution_id'])) {
            return (int) $context['execution_id'];
        }
        return null;
    }

    /**
     * Extract stream context from execution context
     */
    private function extractStreamContext($context): ?StreamContext
    {
        if (is_array($context) && isset($context['stream_context'])) {
            return $context['stream_context'] instanceof StreamContext
                ? $context['stream_context']
                : null;
        }
        return null;
    }

    /**
     * Complete the workflow and allow manager to respond to user
     *
     * Managers call this when they've finished delegating and want to
     * synthesize results and respond to the user. This returns a special
     * marker that tells the provider to switch from tool_choice='required'
     * to tool_choice='auto', allowing a text response.
     *
     * @param array $params Function parameters (reason: why completing now)
     * @param mixed $context Execution context
     * @return array Completion response with marker
     */
    public function completeTask(array $params, $context = null): array
    {
        $reason = $params['reason'] ?? 'Workflow complete';
        $summary = $params['summary'] ?? '';

        error_log("[DELEGATION] complete_task called: reason={$reason}");

        return [
            'success' => true,
            'status' => 'workflow_complete',
            'marker' => '___WORKFLOW_COMPLETE___',
            'reason' => $reason,
            'summary' => $summary,
            'instruction' => 'You may now synthesize all results and respond to the user with your final answer.',
        ];
    }
}
