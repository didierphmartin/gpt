<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Services;

use PDO;

/** A workflow owned by the robot is shared with every user who may use the robot; its runs are the robot's. */
final class RobotOwnership
{
    private ?int $robotId = null;
    private bool $robotLoaded = false;
    private RobotPolicy $policy;

    public function __construct(private readonly PDO $db, array $config)
    {
        $this->policy = new RobotPolicy($db, $config);
    }

    public function robotId(): ?int
    {
        if (!$this->robotLoaded) {
            $this->robotId = RobotAccount::id($this->db);
            $this->robotLoaded = true;
        }
        return $this->robotId;
    }

    /** The robot's id when the caller may use the robot, else null. */
    public function robotFor(int $callerId): ?int
    {
        return $this->policy->canUse($callerId) ? $this->robotId() : null;
    }

    /** The robot rows a workflow owned by $ownerId may link: the robot's when the owner is the robot or may use it, else null. */
    public function linkRobotFor(int $ownerId): ?int
    {
        return $this->robotId() === $ownerId ? $ownerId : $this->robotFor($ownerId);
    }

    public function isRobotOwned(int $workflowId): bool
    {
        $robot = $this->robotId();
        if ($robot === null) {
            return false;
        }
        $stmt = $this->db->prepare('SELECT 1 FROM agent_workflows WHERE id = ? AND user_id = ?');
        $stmt->execute([$workflowId, $robot]);
        return $stmt->fetchColumn() !== false;
    }

    /** Who a run of this workflow executes as: the robot for a robot workflow the caller may use, else the caller. */
    public function runAs(int $callerId, int $workflowId): int
    {
        $robot = $this->robotFor($callerId);
        return $robot !== null && $this->isRobotOwned($workflowId) ? $robot : $callerId;
    }

    /**
     * The workflow's name when the caller would run it as the robot (they may use the robot and it is robot-owned)
     * and it is locked, else null: a browser run door's refusal, checked only after access so it reveals nothing.
     */
    public function lockedRunName(int $callerId, int $workflowId): ?string
    {
        if ($this->runAs($callerId, $workflowId) === $callerId || !$this->isLocked($workflowId)) {
            return null;
        }
        $st = $this->db->prepare('SELECT name FROM agent_workflows WHERE id = ?');
        $st->execute([$workflowId]);
        return (string) $st->fetchColumn();
    }

    /** Robot-owned and active: nobody edits it until it is unlocked. */
    public function isLocked(int $workflowId): bool
    {
        if (!$this->isRobotOwned($workflowId)) {
            return false;
        }
        $stmt = $this->db->prepare('SELECT 1 FROM active_workflows WHERE workflow_id = ?');
        $stmt->execute([$workflowId]);
        return $stmt->fetchColumn() !== false;
    }
}
