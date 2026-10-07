<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * One scheduler tick: run every due schedule once, or, for a run that did work after a code node
 * (drain), again at once until it reports nothing to do, at most MAX_RUNS_PER_TICK times.
 * Shared by SchedulerController (HTTP) and scheduler/run-scheduled-workflows.php (cron CLI).
 */
final class ScheduleTick
{
    public const MAX_RUNS_PER_TICK = 20;

    /** @var callable(array): array */
    private $runSchedule;
    /** @var callable(string): void */
    private $log;

    public function __construct(private ScheduledWorkflowService $schedules, callable $runSchedule, ?callable $log = null)
    {
        $this->runSchedule = $runSchedule;
        $this->log = $log ?? static fn(string $line) => null;
    }

    public function run(): array
    {
        $due = $this->schedules->getDueSchedules();
        $results = ['timestamp' => date('Y-m-d H:i:s'), 'due_count' => count($due),
            'executed' => [], 'failed' => [], 'quiet_count' => 0];
        ($this->log)('Found ' . count($due) . ' due schedule(s)');

        foreach ($due as $schedule) {
            $id = (int) $schedule['id'];
            if (!$this->schedules->claim($id)) {
                continue;   // another tick took it
            }
            try {
                $runs = 0;
                do {
                    $result = ($this->runSchedule)($schedule);
                    $runs++;
                    if (empty($result['success'])) {
                        throw new \RuntimeException($result['error'] ?? 'Workflow execution failed');
                    }
                    $quiet = !empty($result['quiet']);
                    if ($quiet) {
                        $results['quiet_count']++;
                    } else {
                        $results['executed'][] = ['schedule_id' => $id, 'workflow_id' => (int) $schedule['workflow_id'],
                            'workflow_name' => $schedule['workflow_name'] ?? null, 'execution_id' => $result['execution_id'] ?? null];
                    }
                    // Drain only when a code node ran and the run found work.
                } while (!$quiet && !empty($result['drain']) && $runs < self::MAX_RUNS_PER_TICK);
                $this->schedules->markCompleted($id);
                ($this->log)("✓ Schedule #{$id}: {$runs} run(s)");
            } catch (\Throwable $e) {
                $this->schedules->markFailed($id, $e->getMessage());
                $results['failed'][] = ['schedule_id' => $id, 'workflow_id' => (int) $schedule['workflow_id'],
                    'workflow_name' => $schedule['workflow_name'] ?? 'Unknown', 'error' => $e->getMessage()];
                ($this->log)("✗ Schedule #{$id} failed: " . $e->getMessage());
                error_log("Scheduled workflow failed: Schedule #{$id}, Workflow #{$schedule['workflow_id']}: " . $e->getMessage());
            }
        }

        $results['executed_count'] = count($results['executed']);
        $results['failed_count'] = count($results['failed']);
        return $results;
    }

    /** The runSchedule callable both entry points use: load the workflow and run it once. */
    public static function workflowRunner(WorkflowRepository $workflows, $graphRepository,
                                          GraphWorkflowRunner $graphRunner, WorkflowRunner $linearRunner): callable
    {
        return static function (array $schedule) use ($workflows, $graphRepository, $graphRunner, $linearRunner): array {
            $workflowId = (int) $schedule['workflow_id'];
            $workflow = $workflows->findById($workflowId);
            if (!$workflow) {
                return ['success' => false, 'error' => "Workflow #{$workflowId} not found"];
            }
            if (!$workflow->isEnabled()) {
                return ['success' => false, 'error' => "Workflow #{$workflowId} is disabled"];
            }
            $input = [];
            if (!empty($schedule['input_prompt'])) {
                $input['user_prompt'] = $schedule['input_prompt'];
                $input['prompt'] = $schedule['input_prompt'];
            }
            $userId = (int) $schedule['user_id'];
            return !empty($graphRepository->getNodes($workflowId))
                ? $graphRunner->run($workflow, $userId, $input)
                : $linearRunner->run($workflow, $userId, $input);
        };
    }
}
