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
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * Create a new scheduled workflow
     */
    public function create(array $data): array
    {
        $stmt = $this->db->prepare("
            INSERT INTO scheduled_workflows
            (user_id, workflow_id, input_prompt, scheduled_time, status, repeat_type, repeat_interval, next_run, created_at)
            VALUES
            (:user_id, :workflow_id, :input_prompt, :scheduled_time, 'pending', :repeat_type, :repeat_interval, :next_run, NOW())
        ");

        $scheduledTime = $data['scheduled_time'];
        $nextRun = $scheduledTime; // First run is the scheduled time

        $stmt->execute([
            'user_id' => $data['user_id'],
            'workflow_id' => $data['workflow_id'],
            'input_prompt' => $data['input_prompt'] ?? null,
            'scheduled_time' => $scheduledTime,
            'repeat_type' => $data['repeat_type'] ?? 'none',
            'repeat_interval' => $data['repeat_interval'] ?? 1,
            'next_run' => $nextRun
        ]);

        $id = (int) $this->db->lastInsertId();
        return $this->findById($id);
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

    /**
     * Get all due schedules (ready to execute)
     */
    public function getDueSchedules(): array
    {
        $stmt = $this->db->prepare("
            SELECT sw.*, w.name as workflow_name, u.email as user_email
            FROM scheduled_workflows sw
            LEFT JOIN agent_workflows w ON sw.workflow_id = w.id
            LEFT JOIN users u ON sw.user_id = u.id
            WHERE sw.status = 'pending'
              AND sw.next_run <= NOW()
            ORDER BY sw.next_run ASC
            LIMIT 50
        ");
        $stmt->execute();
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
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
                SET status = 'completed', last_run = NOW()
                WHERE id = :id
            ");
            $stmt->execute(['id' => $id]);
        } else {
            // Recurring - calculate next run and reset to pending
            $nextRun = $this->calculateNextRun($schedule['next_run'], $repeatType, $repeatInterval);
            $stmt = $this->db->prepare("
                UPDATE scheduled_workflows
                SET status = 'pending', last_run = NOW(), next_run = :next_run
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
                SET status = 'failed', error_message = :error, last_run = NOW()
                WHERE id = :id
            ");
            $stmt->execute(['id' => $id, 'error' => $errorMessage]);
        } else {
            // Recurring - reset to pending for next attempt, but log the error
            $repeatInterval = (int) $schedule['repeat_interval'];
            $nextRun = $this->calculateNextRun($schedule['next_run'], $repeatType, $repeatInterval);
            $stmt = $this->db->prepare("
                UPDATE scheduled_workflows
                SET status = 'pending', error_message = :error, last_run = NOW(), next_run = :next_run
                WHERE id = :id
            ");
            $stmt->execute(['id' => $id, 'error' => $errorMessage, 'next_run' => $nextRun]);
        }
    }

    /**
     * Calculate the next run time based on repeat settings
     */
    private function calculateNextRun(string $currentRun, string $repeatType, int $interval): string
    {
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
