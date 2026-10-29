<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\EventWorker;

use AgentTeam\Controllers\ActiveWorkflowController;
use AgentTeam\Controllers\ScheduledWorkflowController;
use AgentTeam\Services\ActiveWorkflowService;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\RobotAccount;
use Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam\RobotSchema;

/** spec 2026-10-14 event-worker §2: the activation API and the server-side deactivation on a mode change. */
final class ActiveWorkflowControllerTest extends TestCase
{
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        EventWorkerSchema::create($this->db, fn() => '2026-10-14 09:00:00');
        $this->db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT, kind TEXT NOT NULL DEFAULT 'person')");   // the schedule writes look for the robot and the caller's package
        $this->db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)');
        $this->db->exec("INSERT INTO packages (role, name, builtin, capabilities) VALUES ('user', 'User', 1, '{}')");
        $this->db->exec("INSERT INTO users (id, role) VALUES (3, 'user')");
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

    /** RobotSchema's wf 75 owned by the robot; user 3 may use the robot, user 1 may not. Returns the robot's id. */
    private function robotFixture(): int
    {
        $this->db = new PDO('sqlite::memory:');
        RobotSchema::create($this->db);
        $this->db->exec("UPDATE users SET role = 'ops' WHERE id = 3");
        $robot = RobotAccount::ensure($this->db);
        $this->db->exec("UPDATE agent_workflows SET user_id = $robot WHERE id = 75");
        return $robot;
    }

    private function rc(): ActiveWorkflowController { return new ActiveWorkflowController($this->db, ['edition' => 'corporate']); }

    public function testAPermittedUserActivatesAndUnlocksARobotWorkflow(): void
    {
        $robot = $this->robotFixture();
        $r = $this->rc()->activate(['user_id' => 3, 'params' => ['id' => 75]]);
        $this->assertSame([true, 200, $robot, 75], [$r['success'], $r['status_code'], (int) $r['data']['active']['user_id'],
            (int) $r['data']['active']['workflow_id']]);
        $this->assertNull($this->rc()->show(['user_id' => 3])['data']);              // the row is the robot's, not the caller's
        $f = $this->rc()->forWorkflow(['user_id' => 3, 'params' => ['id' => 75]]);
        $this->assertSame([true, 200, $robot], [$f['success'], $f['status_code'], (int) $f['data']['user_id']]);
        $this->assertSame(200, $this->rc()->deactivate(['user_id' => 3, 'params' => ['id' => 75]])['status_code']);
        $this->assertSame(0, (int) $this->db->query('SELECT COUNT(*) FROM active_workflows')->fetchColumn());
        $this->assertNull($this->rc()->forWorkflow(['user_id' => 3, 'params' => ['id' => 75]])['data']);
    }

    public function testACallerWithoutAccessGetsNotFound(): void
    {
        $robot = $this->robotFixture();
        $r = $this->rc()->activate(['user_id' => 1, 'params' => ['id' => 75]]);
        $this->assertSame([false, 'not_found', 404, 'Workflow not found'], [$r['success'], $r['kind'], $r['status_code'], $r['error']]);
        (new ActiveWorkflowService($this->db))->activate($robot, 75);
        foreach (['deactivate', 'forWorkflow'] as $m) {
            $r = $this->rc()->$m(['user_id' => 1, 'params' => ['id' => 75]]);
            $this->assertSame([false, 404, 'Workflow not found'], [$r['success'], $r['status_code'], $r['error']]);
            $this->assertArrayNotHasKey('data', $r);
        }
        $this->assertSame(1, (int) $this->db->query('SELECT COUNT(*) FROM active_workflows')->fetchColumn());   // still active
    }

    public function testForWorkflowOfAPersonalWorkflow(): void
    {
        EventWorkerSchema::row($this->db, 64, 3, 'event', 1);
        $this->assertNull($this->c()->forWorkflow(['user_id' => 3, 'params' => ['id' => 64]])['data']);
        $this->c()->activate(['user_id' => 3, 'params' => ['id' => 64]]);
        $this->assertSame(64, (int) $this->c()->forWorkflow(['user_id' => 3, 'params' => ['id' => 64]])['data']['workflow_id']);
        $this->assertSame(404, $this->c()->forWorkflow(['user_id' => 4, 'params' => ['id' => 64]])['status_code']);
        $this->assertSame(401, $this->c()->forWorkflow(['params' => ['id' => 64]])['status_code']);
    }
}
