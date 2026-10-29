<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use AgentTeam\Controllers\WorkflowController;
use AgentTeam\Services\ActiveWorkflowService;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\RobotController;
use Quantis\AIPortfolioAssistant\Services\RobotAccount;
use Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam\RobotSchema;

/** Task B4: activate / stop the robot's workflow and read its runs. */
final class RobotActivationTest extends TestCase
{
    private const CONFIG = ['edition' => 'corporate'];
    private PDO $db;
    private int $robotId;
    private int $copy;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        RobotSchema::create($this->db);
        $this->db->exec('CREATE TABLE IF NOT EXISTS agent_workflow_executions (id INTEGER PRIMARY KEY AUTOINCREMENT,
            workflow_id INTEGER, status TEXT, started_at TEXT)');
        $this->robotId = RobotAccount::ensure($this->db);
        $this->copy = (new WorkflowController($this->db, self::CONFIG))
            ->publish(['user_id' => 2, 'body' => [], 'params' => ['id' => RobotSchema::WF]])['data']['robot_workflow_id'];
    }

    private function req(int $u, int $id): array
    {
        return ['user_id' => $u, 'body' => [], 'params' => ['id' => $id], 'query' => []];
    }

    private function robot(): RobotController
    {
        return new RobotController($this->db, self::CONFIG);
    }

    public function test_activate_robot_copy_creates_robot_active_row(): void
    {
        $svc = new ActiveWorkflowService($this->db);
        $svc->activate(RobotSchema::OWNER, RobotSchema::WF);
        $r = $this->robot()->activateWorkflow($this->req(2, $this->copy));
        $this->assertTrue($r['success']);
        $this->assertSame($this->copy, (int) $svc->get($this->robotId)['workflow_id']);
        $this->assertSame(RobotSchema::WF, (int) $svc->get(RobotSchema::OWNER)['workflow_id']);
    }

    public function test_stop_robot_copy(): void
    {
        $svc = new ActiveWorkflowService($this->db);
        $this->robot()->activateWorkflow($this->req(2, $this->copy));
        $this->assertTrue($this->robot()->deactivateWorkflow($this->req(2, $this->copy))['success']);
        $this->assertNull($svc->get($this->robotId));
    }

    public function test_executions_of_robot_workflow(): void
    {
        $this->db->exec("INSERT INTO agent_workflow_executions (workflow_id, status, started_at) VALUES
            ({$this->copy}, 'completed', '2026-10-26 10:00:00'), (" . RobotSchema::WF . ", 'completed', '2026-10-26 11:00:00')");
        $r = $this->robot()->workflowExecutions($this->req(2, $this->copy));
        $this->assertTrue($r['success']);
        $this->assertSame(1, $r['count']);
        $this->assertSame($this->copy, (int) $r['data'][0]['workflow_id']);
    }

    public function test_person_workflow_id_rejected_on_robot_routes(): void
    {
        $wf = RobotSchema::WF;
        foreach ([$this->robot()->activateWorkflow($this->req(2, $wf)), $this->robot()->workflowExecutions($this->req(2, $wf))] as $r) {
            $this->assertSame([false, 404], [$r['success'], $r['status_code']]);
        }
        $this->assertNull((new ActiveWorkflowService($this->db))->get($this->robotId));
    }

    public function test_403_without_use_robot(): void
    {
        foreach ([$this->robot()->activateWorkflow($this->req(1, $this->copy)), $this->robot()->deactivateWorkflow($this->req(1, $this->copy)),
                  $this->robot()->workflowExecutions($this->req(1, $this->copy)), $this->robot()->workflowLive($this->req(1, $this->copy))] as $r) {
            $this->assertSame([false, 403], [$r['success'], $r['status_code']]);
        }
    }
}
