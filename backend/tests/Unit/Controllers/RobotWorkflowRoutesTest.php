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

/** Task B2: POST /workflows/{id}/publish, GET /robot/workflows, DELETE /robot/workflows/{id}. */
final class RobotWorkflowRoutesTest extends TestCase
{
    private const CONFIG = ['edition' => 'corporate'];
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        RobotSchema::create($this->db);
    }

    private function req(int $u, array $body = [], array $params = []): array
    {
        return ['user_id' => $u, 'body' => $body, 'params' => $params];
    }

    private function publish(int $u, array $body = []): array
    {
        return (new WorkflowController($this->db, self::CONFIG))->publish($this->req($u, $body, ['id' => RobotSchema::WF]));
    }

    private function robot(): RobotController
    {
        return new RobotController($this->db, self::CONFIG);
    }

    public function test_without_use_robot_403(): void
    {
        // Review Focus 5: user 1's role has no use_robot; each route refuses with the same message
        $msg = "Your role can't publish to the robot";
        $this->db->exec('UPDATE agent_workflows SET user_id = 1 WHERE id = 75');
        foreach ([$this->publish(1), $this->robot()->workflows($this->req(1)),
                  $this->robot()->unpublishWorkflow($this->req(1, [], ['id' => 75]))] as $r) {
            $this->assertSame([false, 403, $msg], [$r['success'], $r['status_code'], $r['error']]);
        }
        $this->assertSame(0, (int) $this->db->query('SELECT COUNT(*) FROM agent_workflows WHERE source_id IS NOT NULL')->fetchColumn());
        $this->assertSame(401, $this->publish(0)['status_code']);
    }

    public function test_publish_and_list(): void
    {
        $r = $this->publish(2);
        $this->assertTrue($r['success']);
        $copy = $r['data']['robot_workflow_id'];
        $this->assertFalse($r['data']['replaced']);
        $list = $this->robot()->workflows($this->req(2))['data'];
        $this->assertCount(1, $list);
        $this->assertSame([$copy, 'Mail to PDF', 75, 2, false],
            [$list[0]['id'], $list[0]['name'], $list[0]['source_id'], $list[0]['published_by'], $list[0]['active']]);
        $this->assertNotNull($list[0]['published_at']);

        (new ActiveWorkflowService($this->db))->activate(RobotAccount::id($this->db), $copy);
        $this->assertTrue($this->robot()->workflows($this->req(2))['data'][0]['active']);
        $r = $this->publish(2);
        $this->assertSame([false, 409, 'replaces'], [$r['success'], $r['status_code'], $r['kind']]);
        $this->assertTrue($this->publish(2, ['confirm_replace' => true])['success']);
        $this->db->exec("UPDATE users SET role = 'ops' WHERE id = 3");
        $this->assertSame([404, 'not_found'], [$this->publish(3)['status_code'], $this->publish(3)['kind']]);   // may use the robot, not the owner
    }

    public function test_unpublish_deactivates_and_deletes(): void
    {
        $copy = $this->publish(2)['data']['robot_workflow_id'];
        $robotId = RobotAccount::id($this->db);
        (new ActiveWorkflowService($this->db))->activate($robotId, $copy);
        $r = $this->robot()->unpublishWorkflow($this->req(2, [], ['id' => $copy]));
        $this->assertTrue($r['success']);
        $this->assertNull((new ActiveWorkflowService($this->db))->get($robotId));
        foreach (['agent_workflows WHERE id', 'workflow_nodes WHERE workflow_id', 'workflow_edges WHERE workflow_id',
                  'scheduled_workflows WHERE workflow_id'] as $where) {
            $this->assertSame(0, (int) $this->db->query("SELECT COUNT(*) FROM $where = $copy")->fetchColumn(), $where);
        }
        $this->assertSame([], $this->robot()->workflows($this->req(2))['data']);
        $this->assertSame(1, (int) $this->db->query('SELECT COUNT(*) FROM agent_workflows WHERE id = 75')->fetchColumn());
        // only the robot's workflows can be unpublished
        $this->assertSame(404, $this->robot()->unpublishWorkflow($this->req(2, [], ['id' => 75]))['status_code']);
    }
}
