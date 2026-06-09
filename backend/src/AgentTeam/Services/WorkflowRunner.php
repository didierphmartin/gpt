<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use AgentTeam\Models\Workflow;
use AgentTeam\Models\Agent;
use PDO;

/**
 * Workflow Runner
 *
 * Executes multi-step workflows that orchestrate agents.
 * Supports sequential, conditional, and transform steps.
 * Note: For parallel execution, use GraphWorkflowRunner with multiple outgoing edges.
 *
 * @see docs/agentDesign.md
 */
class WorkflowRunner
{
    private PDO $db;
    private AgentRepository $agentRepository;
    private AgentRunner $agentRunner;
    private array $config;

    /**
     * Execution context - stores outputs from previous steps
     */
    private array $stepOutputs = [];

    /**
     * Current workflow execution ID
     */
    private ?int $executionId = null;

    public function __construct(
        PDO $db,
        AgentRepository $agentRepository,
        AgentRunner $agentRunner,
        array $config = []
    ) {
        $this->db = $db;
        $this->agentRepository = $agentRepository;
        $this->agentRunner = $agentRunner;
        $this->config = $config;
    }

    /**
     * Run a workflow with given input variables
     */
    public function run(Workflow $workflow, int $userId, array $inputVariables = []): array
    {
        // Reset state
        $this->stepOutputs = [];

        // Merge input variables with workflow variables
        $variables = array_merge($workflow->getVariables(), $inputVariables);

        // Create execution record
        $this->executionId = $this->createExecution($workflow, $userId, $inputVariables);

        $startTime = microtime(true);

        try {
            // Validate workflow
            $errors = $workflow->validateSteps();
            if (!empty($errors)) {
                throw new \InvalidArgumentException('Invalid workflow: ' . implode(', ', $errors));
            }

            // Get entry steps (no dependencies)
            $entrySteps = $workflow->getEntrySteps();
            if (empty($entrySteps)) {
                throw new \InvalidArgumentException('Workflow has no entry steps');
            }

            // Execute steps in dependency order
            $completedSteps = [];
            $pendingSteps = $workflow->getSteps();

            while (!empty($pendingSteps)) {
                $executed = false;

                foreach ($pendingSteps as $index => $step) {
                    $dependsOn = $step['depends_on'] ?? [];

                    // Check if all dependencies are satisfied
                    $canExecute = empty($dependsOn) ||
                        count(array_intersect($dependsOn, $completedSteps)) === count($dependsOn);

                    if ($canExecute) {
                        // Execute step
                        $output = $this->executeStep($step, $workflow, $userId, $variables);

                        // Store output
                        $outputKey = $step['output_key'] ?? $step['id'];
                        $this->stepOutputs[$outputKey] = $output;
                        $variables[$outputKey] = $output;

                        // Mark as completed
                        $completedSteps[] = $step['id'];
                        unset($pendingSteps[$index]);
                        $executed = true;
                    }
                }

                // Prevent infinite loop
                if (!$executed && !empty($pendingSteps)) {
                    throw new \RuntimeException('Workflow has unresolvable dependencies');
                }
            }

            $responseTime = (microtime(true) - $startTime) * 1000;

            // Complete execution
            $this->completeExecution($this->executionId, $this->stepOutputs, $responseTime);

            return [
                'success' => true,
                'execution_id' => $this->executionId,
                'workflow' => [
                    'id' => $workflow->getId(),
                    'name' => $workflow->getName(),
                ],
                'outputs' => $this->stepOutputs,
                'steps_completed' => $completedSteps,
                'response_time_ms' => round($responseTime, 2),
            ];

        } catch (\Exception $e) {
            $this->failExecution($this->executionId, $e->getMessage());

            return [
                'success' => false,
                'error' => $e->getMessage(),
                'execution_id' => $this->executionId,
                'workflow' => [
                    'id' => $workflow->getId(),
                    'name' => $workflow->getName(),
                ],
                'partial_outputs' => $this->stepOutputs,
            ];
        }
    }

    /**
     * Execute a single workflow step
     */
    private function executeStep(array $step, Workflow $workflow, int $userId, array $variables): mixed
    {
        $stepType = $step['type'] ?? 'agent';

        return match ($stepType) {
            'agent' => $this->executeAgentStep($step, $workflow, $userId, $variables),
            'condition' => $this->executeConditionStep($step, $workflow, $userId, $variables),
            'transform' => $this->executeTransformStep($step, $variables),
            default => throw new \InvalidArgumentException("Unknown step type: {$stepType}"),
        };
    }

    /**
     * Execute a single agent step
     */
    private function executeAgentStep(array $step, Workflow $workflow, int $userId, array $variables): array
    {
        $agentName = $step['agent'] ?? null;
        $agentId = $step['agent_id'] ?? null;
        $taskTemplate = $step['task_template'] ?? $step['task'] ?? '';

        // Find agent
        $agent = null;
        if ($agentId) {
            $agent = $this->agentRepository->findById($agentId);
        } elseif ($agentName) {
            $agent = $this->agentRepository->findByName($agentName, $userId);
        }

        if (!$agent) {
            throw new \RuntimeException("Agent not found: " . ($agentName ?? $agentId));
        }

        // Interpolate variables in task
        $task = $workflow->interpolateVariables($taskTemplate, $variables);

        // Run agent
        $result = $this->agentRunner->run($agent, $task, [], $userId, [
            'workflow_execution_id' => $this->executionId,
            'step_id' => $step['id'],
        ]);

        return [
            'agent' => $agent->getName(),
            'agent_id' => $agent->getId(),
            'task' => $task,
            'result' => $result['text'] ?? $result['output'] ?? '',
            'success' => $result['success'] ?? true,
            'usage' => $result['usage'] ?? null,
        ];
    }

    /**
     * Execute a conditional step
     */
    private function executeConditionStep(array $step, Workflow $workflow, int $userId, array $variables): array
    {
        $condition = $step['condition'] ?? '';
        $thenStep = $step['then'] ?? null;
        $elseStep = $step['else'] ?? null;

        // Evaluate condition (simple variable check)
        $conditionMet = $this->evaluateCondition($condition, $variables);

        if ($conditionMet && $thenStep) {
            return [
                'condition' => $condition,
                'result' => true,
                'branch' => 'then',
                'output' => $this->executeStep($thenStep, $workflow, $userId, $variables),
            ];
        } elseif (!$conditionMet && $elseStep) {
            return [
                'condition' => $condition,
                'result' => false,
                'branch' => 'else',
                'output' => $this->executeStep($elseStep, $workflow, $userId, $variables),
            ];
        }

        return [
            'condition' => $condition,
            'result' => $conditionMet,
            'branch' => 'none',
            'output' => null,
        ];
    }

    /**
     * Execute a data transformation step
     */
    private function executeTransformStep(array $step, array $variables): array
    {
        $transform = $step['transform'] ?? '';
        $input = $step['input'] ?? null;
        $inputData = $input ? ($variables[$input] ?? null) : $variables;

        // Simple transformations
        $output = match ($transform) {
            'json_encode' => json_encode($inputData),
            'json_decode' => is_string($inputData) ? json_decode($inputData, true) : $inputData,
            'combine' => $this->combineOutputs($step['inputs'] ?? [], $variables),
            'extract' => $this->extractField($inputData, $step['field'] ?? ''),
            'summarize' => $this->summarizeOutputs($step['inputs'] ?? [], $variables),
            default => $inputData,
        };

        return [
            'transform' => $transform,
            'output' => $output,
        ];
    }

    /**
     * Evaluate a simple condition
     */
    private function evaluateCondition(string $condition, array $variables): bool
    {
        // Support simple conditions: "varname", "!varname", "varname == value"
        $condition = trim($condition);

        // Negation
        if (str_starts_with($condition, '!')) {
            $varName = substr($condition, 1);
            return empty($variables[$varName]);
        }

        // Equality check
        if (str_contains($condition, '==')) {
            [$left, $right] = array_map('trim', explode('==', $condition, 2));
            $leftValue = $variables[$left] ?? $left;
            $rightValue = $variables[$right] ?? $right;
            return $leftValue == $rightValue;
        }

        // Inequality check
        if (str_contains($condition, '!=')) {
            [$left, $right] = array_map('trim', explode('!=', $condition, 2));
            $leftValue = $variables[$left] ?? $left;
            $rightValue = $variables[$right] ?? $right;
            return $leftValue != $rightValue;
        }

        // Simple truthiness check
        return !empty($variables[$condition]);
    }

    /**
     * Combine multiple outputs into one
     */
    private function combineOutputs(array $inputKeys, array $variables): array
    {
        $combined = [];
        foreach ($inputKeys as $key) {
            if (isset($variables[$key])) {
                $combined[$key] = $variables[$key];
            }
        }
        return $combined;
    }

    /**
     * Extract a field from data
     */
    private function extractField($data, string $field): mixed
    {
        if (!is_array($data)) {
            return null;
        }

        $parts = explode('.', $field);
        $current = $data;

        foreach ($parts as $part) {
            if (!isset($current[$part])) {
                return null;
            }
            $current = $current[$part];
        }

        return $current;
    }

    /**
     * Summarize multiple outputs into a text summary
     */
    private function summarizeOutputs(array $inputKeys, array $variables): string
    {
        $summaries = [];
        foreach ($inputKeys as $key) {
            if (isset($variables[$key])) {
                $value = $variables[$key];
                if (is_array($value)) {
                    $summaries[] = "{$key}: " . ($value['result'] ?? json_encode($value));
                } else {
                    $summaries[] = "{$key}: {$value}";
                }
            }
        }
        return implode("\n\n", $summaries);
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

        return (int) $this->db->lastInsertId();
    }

    /**
     * Complete workflow execution
     */
    private function completeExecution(int $executionId, array $outputs, float $responseTime): void
    {
        $stmt = $this->db->prepare(
            "UPDATE agent_workflow_executions
             SET status = 'completed', output = ?, response_time_ms = ?, completed_at = NOW()
             WHERE id = ?"
        );
        $stmt->execute([
            json_encode($outputs),
            (int) $responseTime,
            $executionId,
        ]);
    }

    /**
     * Fail workflow execution
     */
    private function failExecution(int $executionId, string $error): void
    {
        $stmt = $this->db->prepare(
            "UPDATE agent_workflow_executions
             SET status = 'failed', error_message = ?, completed_at = NOW()
             WHERE id = ?"
        );
        $stmt->execute([$error, $executionId]);
    }

    /**
     * Get workflow execution history
     */
    public function getExecutionHistory(int $workflowId, int $limit = 50, int $offset = 0): array
    {
        $stmt = $this->db->prepare(
            "SELECT * FROM agent_workflow_executions
             WHERE workflow_id = ?
             ORDER BY started_at DESC
             LIMIT ? OFFSET ?"
        );
        $stmt->execute([$workflowId, $limit, $offset]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }
}
