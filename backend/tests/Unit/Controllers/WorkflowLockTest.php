<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use AgentTeam\Controllers\ScheduledWorkflowController;
use AgentTeam\Controllers\WorkflowController;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\CodeComponentsController;
use Quantis\AIPortfolioAssistant\Services\RobotAccount;
use Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam\RobotSchema;

/** A robot workflow with an active row is locked: edits, runs and schedule writes answer 423. */
final class WorkflowLockTest extends TestCase
{
    private const CONFIG = ['edition' => 'corporate'];
    private PDO $db;
    private int $robot;
    private array $ids;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->ids = RobotSchema::create($this->db);
        $have = array_column($this->db->query('PRAGMA table_info(agent_workflows)')->fetchAll(), 'name');
        foreach (['description' => 'TEXT', 'steps' => 'TEXT', 'triggers' => 'TEXT', 'variables' => 'TEXT', 'enabled' => 'INTEGER DEFAULT 1',
                  'workspace_id' => 'INTEGER', 'output_storage_enabled' => 'INTEGER DEFAULT 0', 'output_folder' => 'TEXT', 'orchestration' => 'TEXT'] as $c => $t) {
            if (!in_array($c, $have, true)) {
                $this->db->exec("ALTER TABLE agent_workflows ADD COLUMN $c $t");
            }
        }
        $this->robot = RobotAccount::ensure($this->db);
        $this->db->exec("UPDATE agent_workflows SET user_id = {$this->robot} WHERE id = 75");
        $this->db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, 3, 'Mine')");
        $this->db->exec("INSERT INTO active_workflows (user_id, workflow_id, mode, activated_at) VALUES ({$this->robot}, 75, 'event', '2026-10-29 09:00:00'), (3, 9, 'event', '2026-10-29 09:00:00')");
    }

    private function req(int $u, array $body = [], array $params = []): array
    {
        return ['user_id' => $u, 'body' => $body, 'params' => $params];
    }

    private function assertLocked(array $r): void
    {
        $this->assertSame([false, 'locked', 423, 'Mail to PDF is running as the robot. Unlock it first.'],
            [$r['success'], $r['error_code'] ?? null, $r['status_code'], $r['error'] ?? null]);
    }

    public function test_locked_workflow_refuses_edits_and_runs(): void
    {
        $wf = new WorkflowController($this->db, self::CONFIG);
        $p = ['id' => 75];
        $this->assertLocked($wf->update($this->req(2, ['name' => 'X'], $p)));
        $this->assertLocked($wf->destroy($this->req(2, [], $p)));
        $this->assertLocked($wf->toggle($this->req(2, [], $p)));
        $this->assertLocked($wf->run($this->req(2, [], $p)));
        $this->assertLocked($wf->uploadNodeDocument($this->req(2, [], $p + ['nodeId' => 1])));
        $this->assertLocked($wf->saveDocumentMetadata($this->req(2, [], $p + ['nodeId' => 1])));
        $this->assertLocked($wf->deleteNodeDocument($this->req(2, [], $p + ['nodeId' => 1, 'docId' => 'd'])));
        $this->assertSame('Mail to PDF', $this->db->query('SELECT name FROM agent_workflows WHERE id = 75')->fetchColumn());
    }

    public function test_locked_workflow_refuses_schedule_writes(): void
    {
        $sc = new ScheduledWorkflowController($this->db, self::CONFIG);
        $this->assertLocked($sc->create($this->req(2, ['workflow_id' => 75, 'scheduled_time' => '2026-11-01 10:00:00'])));
        $sid = (int) $this->db->query('SELECT id FROM scheduled_workflows WHERE workflow_id = 75')->fetchColumn();
        $p = ['id' => $sid];
        foreach (['update', 'destroy', 'pause', 'resume'] as $m) {
            $this->assertLocked($sc->$m($this->req(2, ['scheduled_time' => '2026-11-01 10:00:00'], $p)));
        }
    }

    public function test_locked_start_option_refuses_component_changes(): void
    {
        $cc = new CodeComponentsController($this->db, self::CONFIG);
        $p = ['id' => $this->ids['Poll Drop']];
        $this->assertLocked($cc->setStartOption($this->req(2, [], $p)));
        $this->assertLocked($cc->clearStartOption($this->req(2, [], $p)));
    }

    public function test_unlocking_allows_the_edit(): void
    {
        $wf = new WorkflowController($this->db, self::CONFIG);
        $this->db->exec('DELETE FROM active_workflows WHERE workflow_id = 75');
        $r = $wf->update($this->req(2, ['name' => 'Renamed'], ['id' => 75]));
        $this->assertTrue($r['success'], json_encode($r));
        $this->assertSame('Renamed', $this->db->query('SELECT name FROM agent_workflows WHERE id = 75')->fetchColumn());
    }

    public function test_personal_active_workflow_is_not_locked(): void
    {
        $r = (new WorkflowController($this->db, self::CONFIG))->update($this->req(3, ['name' => 'Mine2'], ['id' => 9]));
        $this->assertTrue($r['success'], json_encode($r));
    }

    public function test_caller_without_access_gets_404_not_the_lock(): void
    {
        // user 1 has no robot permission and owns nothing here
        $sc = new ScheduledWorkflowController($this->db, self::CONFIG);
        $sid = (int) $this->db->query('SELECT id FROM scheduled_workflows WHERE workflow_id = 75')->fetchColumn();
        $rs = [$sc->create($this->req(1, ['workflow_id' => 75, 'scheduled_time' => '2026-11-01 10:00:00']))];
        foreach (['update', 'destroy', 'pause', 'resume'] as $m) {
            $rs[] = $sc->$m($this->req(1, ['scheduled_time' => '2026-11-01 10:00:00'], ['id' => $sid]));
        }
        $rs[] = (new CodeComponentsController($this->db, self::CONFIG))->setStartOption($this->req(1, [], ['id' => $this->ids['Poll Drop']]));
        $rs[] = (new CodeComponentsController($this->db, self::CONFIG))->clearStartOption($this->req(1, [], ['id' => $this->ids['Poll Drop']]));
        foreach ($rs as $r) {
            $this->assertSame(404, $r['status_code'], json_encode($r));
            $this->assertStringNotContainsString('Mail to PDF', json_encode($r));
            $this->assertArrayNotHasKey('error_code', $r);
        }
    }
}
