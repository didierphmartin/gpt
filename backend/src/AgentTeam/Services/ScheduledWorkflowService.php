<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;
use DateTime;
use DateInterval;

/**
 * Service for managing scheduled workflows
 *
 * Handles CRUD operations and scheduling logic for workflow schedules.
 */
class ScheduledWorkflowService
{
    public const REPEAT_TYPES = ['none', 'hourly', 'daily', 'weekly', 'monthly', 'cron'];
    /** A run 'running' for longer than this is treated as crashed and may be claimed again. */
    public const STALE_RUNNING_MINUTES = 60;

    private PDO $db;
    private \Closure $now;

    /**
     * @param \Closure|null $now returns the current server time as a DateTimeImmutable. The default
     *                           reads the DB connection's NOW(), so "server time" matches the NOW()
     *                           used elsewhere in this service (PHP CLI may be in another timezone).
     */
    public function __construct(PDO $db, ?\Closure $now = null)
    {
        $this->db = $db;
        $this->now = $now ?? fn() => new \DateTimeImmutable((string) $this->db->query('SELECT NOW()')->fetchColumn());
    }

    private function now(): \DateTimeImmutable
    {
        return ($this->now)();
    }

    private function stamp(?string $modify = null): string
    {
        $t = $this->now();
        return ($modify ? $t->modify($modify) : $t)->format('Y-m-d H:i:s');
    }

    private function nextCronRun(string $cron): string
    {
        return (new CronExpression($cron))->nextAfter($this->now())->format('Y-m-d H:i:s');
    }

    /**
     * Create a new scheduled workflow
     */
    public function create(array $data): array
    {
        $repeatType = $data['repeat_type'] ?? 'none';
        $cron = $repeatType === 'cron' ? trim((string) ($data['cron'] ?? '')) : null;
        if ($repeatType === 'cron' && !CronExpression::isValid($cron)) {
            throw new \InvalidArgumentException('Invalid cron expression');
        }
        $scheduledTime = $data['scheduled_time'] ?? $this->stamp();
        // A cron schedule first fires on its next cron minute; others at the scheduled time.
        $nextRun = $cron !== null ? $this->nextCronRun($cron) : $scheduledTime;

        $stmt = $this->db->prepare("
            INSERT INTO scheduled_workflows
            (user_id, workflow_id, input_prompt, scheduled_time, status, repeat_type, repeat_interval, cron, next_run, created_at)
            VALUES
            (:user_id, :workflow_id, :input_prompt, :scheduled_time, 'pending', :repeat_type, :repeat_interval, :cron, :next_run, NOW())
        ");
        $stmt->execute([
            'user_id' => $data['user_id'],
            'workflow_id' => $data['workflow_id'],
            'input_prompt' => $data['input_prompt'] ?? null,
            'scheduled_time' => $scheduledTime,
            'repeat_type' => $repeatType,
            'repeat_interval' => $data['repeat_interval'] ?? 1,
            'cron' => $cron,
            'next_run' => $nextRun,
        ]);

        return $this->findById((int) $this->db->lastInsertId());
    }

    /**
     * Update a scheduled workflow
     */
    public function update(int $id, int $userId, array $data): ?array
    {
        // First verify ownership
        $schedule = $this->findById($id);
        if (!$schedule || $schedule['user_id'] !== $userId) {
            return null;
        }

        $fields = [];
        $params = ['id' => $id];

        if (isset($data['scheduled_time'])) {
            $fields[] = 'scheduled_time = :scheduled_time';
            $fields[] = 'next_run = :next_run';
            $params['scheduled_time'] = $data['scheduled_time'];
            $params['next_run'] = $data['scheduled_time'];
        }

        if (isset($data['input_prompt'])) {
            $fields[] = 'input_prompt = :input_prompt';
            $params['input_prompt'] = $data['input_prompt'];
        }

        if (isset($data['repeat_type'])) {
            $fields[] = 'repeat_type = :repeat_type';
            $params['repeat_type'] = $data['repeat_type'];
        }

        if (isset($data['repeat_interval'])) {
            $fields[] = 'repeat_interval = :repeat_interval';
            $params['repeat_interval'] = $data['repeat_interval'];
        }

        $repeatType = $data['repeat_type'] ?? $schedule['repeat_type'];
        if (array_key_exists('cron', $data) || $repeatType === 'cron') {
            $cron = $repeatType === 'cron' ? trim((string) ($data['cron'] ?? $schedule['cron'] ?? '')) : null;
            if ($repeatType === 'cron' && !CronExpression::isValid($cron)) {
                throw new \InvalidArgumentException('Invalid cron expression');
            }
            $fields[] = 'cron = :cron';
            $params['cron'] = $cron;
            if ($cron !== null) {
                // The cron decides the next run; replace any scheduled_time-derived next_run.
                $fields = array_values(array_filter($fields, fn($f) => $f !== 'next_run = :next_run'));
                $fields[] = 'next_run = :next_run';
                $params['next_run'] = $this->nextCronRun($cron);
            }
        }

        if (isset($data['status'])) {
            $fields[] = 'status = :status';
            $params['status'] = $data['status'];
        }

        if (empty($fields)) {
            return $schedule;
        }

        $sql = "UPDATE scheduled_workflows SET " . implode(', ', $fields) . " WHERE id = :id";
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);

        return $this->findById($id);
    }

    /**
     * Delete a scheduled workflow
     */
    public function delete(int $id, int $userId): bool
    {
        $stmt = $this->db->prepare("
            DELETE FROM scheduled_workflows
            WHERE id = :id AND user_id = :user_id
        ");
        $stmt->execute(['id' => $id, 'user_id' => $userId]);
        return $stmt->rowCount() > 0;
    }

    /**
     * Find a schedule by ID
     */
    public function findById(int $id): ?array
    {
        $stmt = $this->db->prepare("
            SELECT sw.*, w.name as workflow_name
            FROM scheduled_workflows sw
            LEFT JOIN agent_workflows w ON sw.workflow_id = w.id
            WHERE sw.id = :id
        ");
        $stmt->execute(['id' => $id]);
        $result = $stmt->fetch(PDO::FETCH_ASSOC);
        return $result ?: null;
    }

    /**
     * Find all schedules for a user
     */
    public function findByUser(int $userId): array
    {
        $stmt = $this->db->prepare("
            SELECT sw.*, w.name as workflow_name
            FROM scheduled_workflows sw
            LEFT JOIN agent_workflows w ON sw.workflow_id = w.id
            WHERE sw.user_id = :user_id
            ORDER BY sw.next_run ASC
        ");
        $stmt->execute(['user_id' => $userId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Find all schedules for a specific workflow
     */
    public function findByWorkflow(int $workflowId, int $userId): array
    {
        $stmt = $this->db->prepare("
            SELECT sw.*, w.name as workflow_name
            FROM scheduled_workflows sw
            LEFT JOIN agent_workflows w ON sw.workflow_id = w.id
            WHERE sw.workflow_id = :workflow_id AND sw.user_id = :user_id
            ORDER BY sw.next_run ASC
        ");
        $stmt->execute(['workflow_id' => $workflowId, 'user_id' => $userId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /** Due schedules: pending and due, or 'running' for longer than STALE_RUNNING_MINUTES (a crashed run). */
    public function getDueSchedules(): array
    {
        $stmt = $this->db->prepare("
            SELECT sw.*, w.name as workflow_name, u.email as user_email
            FROM scheduled_workflows sw
            LEFT JOIN agent_workflows w ON sw.workflow_id = w.id
            LEFT JOIN users u ON sw.user_id = u.id
            WHERE (sw.status = 'pending' AND sw.next_run <= :now)
               OR (sw.status = 'running' AND sw.running_since < :stale)
            ORDER BY sw.next_run ASC
            LIMIT 50
        ");
        $stmt->execute(['now' => $this->stamp(), 'stale' => $this->stamp('-' . self::STALE_RUNNING_MINUTES . ' minutes')]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Take a due schedule for this tick. Atomic: of two overlapping ticks, only one gets true.
     * A 'running' row older than STALE_RUNNING_MINUTES can be taken again.
     */
    public function claim(int $id): bool
    {
        $stmt = $this->db->prepare("
            UPDATE scheduled_workflows
            SET status = 'running', running_since = :now
            WHERE id = :id
              AND (status = 'pending' OR (status = 'running' AND running_since < :stale))
        ");
        $stmt->execute(['id' => $id, 'now' => $this->stamp(),
            'stale' => $this->stamp('-' . self::STALE_RUNNING_MINUTES . ' minutes')]);
        return $stmt->rowCount() > 0;
    }

    /**
     * Mark a schedule as running
     */
    public function markRunning(int $id): void
    {
        $stmt = $this->db->prepare("
            UPDATE scheduled_workflows
            SET status = 'running'
            WHERE id = :id
        ");
        $stmt->execute(['id' => $id]);
    }

    /**
     * Mark a schedule as completed and calculate next run if recurring
     */
    public function markCompleted(int $id, ?string $executionId = null): void
    {
        $schedule = $this->findById($id);
        if (!$schedule) {
            return;
        }

        $repeatType = $schedule['repeat_type'];
        $repeatInterval = (int) $schedule['repeat_interval'];

        if ($repeatType === 'none') {
            // One-time schedule - mark as completed
            $stmt = $this->db->prepare("
                UPDATE scheduled_workflows
                SET status = 'completed', last_run = NOW(), running_since = NULL
                WHERE id = :id
            ");
            $stmt->execute(['id' => $id]);
        } else {
            // Recurring - calculate next run and reset to pending
            $nextRun = $this->calculateNextRun($schedule['next_run'], $repeatType, $repeatInterval, $schedule['cron'] ?? null);
            $stmt = $this->db->prepare("
                UPDATE scheduled_workflows
                SET status = 'pending', last_run = NOW(), running_since = NULL, next_run = :next_run
                WHERE id = :id
            ");
            $stmt->execute(['id' => $id, 'next_run' => $nextRun]);
        }
    }

    /**
     * Mark a schedule as failed
     */
    public function markFailed(int $id, string $errorMessage): void
    {
        $schedule = $this->findById($id);
        if (!$schedule) {
            return;
        }

        $repeatType = $schedule['repeat_type'];

        if ($repeatType === 'none') {
            // One-time - mark as failed permanently
            $stmt = $this->db->prepare("
                UPDATE scheduled_workflows
                SET status = 'failed', error_message = :error, last_run = NOW(), running_since = NULL
                WHERE id = :id
            ");
            $stmt->execute(['id' => $id, 'error' => $errorMessage]);
        } else {
            // Recurring - reset to pending for next attempt, but log the error
            $repeatInterval = (int) $schedule['repeat_interval'];
            $nextRun = $this->calculateNextRun($schedule['next_run'], $repeatType, $repeatInterval, $schedule['cron'] ?? null);
            $stmt = $this->db->prepare("
                UPDATE scheduled_workflows
                SET status = 'pending', error_message = :error, last_run = NOW(), running_since = NULL, next_run = :next_run
                WHERE id = :id
            ");
            $stmt->execute(['id' => $id, 'error' => $errorMessage, 'next_run' => $nextRun]);
        }
    }

    /**
     * Calculate the next run time based on repeat settings
     */
    private function calculateNextRun(string $currentRun, string $repeatType, int $interval, ?string $cron = null): string
    {
        if ($repeatType === 'cron') {
            // From now, not from the last next_run: a late tick must not replay missed minutes.
            return $this->nextCronRun((string) $cron);
        }
        $date = new DateTime($currentRun);

        switch ($repeatType) {
            case 'hourly':
                $date->add(new DateInterval("PT{$interval}H"));
                break;
            case 'daily':
                $date->add(new DateInterval("P{$interval}D"));
                break;
            case 'weekly':
                $days = $interval * 7;
                $date->add(new DateInterval("P{$days}D"));
                break;
            case 'monthly':
                $date->add(new DateInterval("P{$interval}M"));
                break;
            default:
                // No repeat
                break;
        }

        return $date->format('Y-m-d H:i:s');
    }

    /**
     * Pause a schedule (set to pending but won't run until resumed)
     */
    public function pause(int $id, int $userId): bool
    {
        $stmt = $this->db->prepare("
            UPDATE scheduled_workflows
            SET status = 'paused'
            WHERE id = :id AND user_id = :user_id
        ");
        $stmt->execute(['id' => $id, 'user_id' => $userId]);
        return $stmt->rowCount() > 0;
    }

    /**
     * Resume a paused schedule
     */
    public function resume(int $id, int $userId): bool
    {
        $stmt = $this->db->prepare("
            UPDATE scheduled_workflows
            SET status = 'pending'
            WHERE id = :id AND user_id = :user_id AND status = 'paused'
        ");
        $stmt->execute(['id' => $id, 'user_id' => $userId]);
        return $stmt->rowCount() > 0;
    }

    /**
     * Get schedule statistics for a user
     */
    public function getStats(int $userId): array
    {
        $stmt = $this->db->prepare("
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
                SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused
            FROM scheduled_workflows
            WHERE user_id = :user_id
        ");
        $stmt->execute(['user_id' => $userId]);
        return $stmt->fetch(PDO::FETCH_ASSOC);
    }
}
