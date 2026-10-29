<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\EventWorker;

use AgentTeam\Controllers\ActiveWorkflowController;
use AgentTeam\Controllers\ScheduledWorkflowController;
use AgentTeam\Services\ActiveWorkflowService;
use PDO;
use PHPUnit\Framework\TestCase;

/** spec 2026-10-14 event-worker §2: the activation API and the server-side deactivation on a mode change. */
final class ActiveWorkflowControllerTest extends TestCase
{
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        EventWorkerSchema::create($this->db, fn() => '2026-10-14 09:00:00');
        $this->db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'person')");   // the schedule writes look for the robot
        EventWorkerSchema::option($this->db, 1, 3);
        EventWorkerSchema::workflow($this->db, 64, 3, 1);
    }

    private function c(): ActiveWorkflowController { return new ActiveWorkflowController($this->db, []); }

    public function testActivateGetDeactivate(): void
    {
        EventWorkerSchema::row($this->db, 64, 3, 'event', 1);
        $r = $this->c()->activate(['user_id' => 3, 'params' => ['id' => 64]]);
        $this->assertSame([true, 200, 64], [$r['success'], $r['status_code'], (int) $r['data']['active']['workflow_id']]);
        $this->assertSame(64, (int) $this->c()->show(['user_id' => 3])['data']['workflow_id']);
        $this->assertSame(200, $this->c()->deactivate(['user_id' => 3, 'params' => ['id' => 64]])['status_code']);
        $this->assertNull($this->c()->show(['user_id' => 3])['data']);
    }

    public function testARefusalCarriesItsKind(): void
    {
        $r = $this->c()->activate(['user_id' => 3, 'params' => ['id' => 64]]);
        $this->assertSame([false, 'no_trigger', 422], [$r['success'], $r['kind'], $r['status_code']]);
    }

    public function testAuthenticationIsRequired(): void
    {
        $this->assertSame(401, $this->c()->show([])['status_code']);
    }

    public function testDeletingTheEventRowDeactivates(): void
    {
        $row = EventWorkerSchema::row($this->db, 64, 3, 'event', 1);
        (new ActiveWorkflowService($this->db))->activate(3, 64);
        $r = (new ScheduledWorkflowController($this->db, []))->destroy(['user_id' => 3, 'params' => ['id' => $row]]);
        $this->assertTrue($r['success']);
        $this->assertNull((new ActiveWorkflowService($this->db))->get(3));
    }

    public function testAFailingSweepDoesNotFailTheWrite(): void
    {
        $row = EventWorkerSchema::row($this->db, 64, 3, 'event', 1);
        $this->db->exec('DROP TABLE active_workflows');   // the table is not migrated yet
        $prev = ini_set('error_log', '/dev/null');
        try {
            $r = (new ScheduledWorkflowController($this->db, []))->destroy(['user_id' => 3, 'params' => ['id' => $row]]);
        } finally {
            ini_set('error_log', (string) $prev);
        }
        $this->assertTrue($r['success']);
        $this->assertSame(0, (int) $this->db->query("SELECT COUNT(*) FROM scheduled_workflows WHERE id = $row")->fetchColumn());
    }
}
