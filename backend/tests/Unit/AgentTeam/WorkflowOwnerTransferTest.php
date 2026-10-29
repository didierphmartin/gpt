<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use AgentTeam\Controllers\WorkflowController;
use AgentTeam\Services\ActiveWorkflowService;
use AgentTeam\Services\WorkflowOwnerTransfer;
use AgentTeam\Services\WorkflowTransferError;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentStore;
use Quantis\AIPortfolioAssistant\Services\RobotAccount;
use Quantis\AIPortfolioAssistant\Services\RobotOwnership;

/** Owner -> Robot: wf 75 keeps its id and graph; what it uses and its schedule move to the robot, nothing is copied. */
final class WorkflowOwnerTransferTest extends TestCase
{
    private const CONFIG = ['edition' => 'corporate'];
    private const WF = RobotSchema::WF;
    private const OWNER = RobotSchema::OWNER;
    private const TABLES = ['agent_workflows', 'workflow_nodes', 'workflow_edges', 'code_components', 'playbooks', 'agents',
        'scheduled_workflows', 'active_workflows'];

    private PDO $db;
    private int $robot;
    /** name => the owner's component id */
    private array $ids;

    /**
     * RobotSchema's wf 75 plus a playbook node on playbook 5, an agent node on the owner's agent 31 (whose own playbook
     * is 6), an agent node on user 1's public agent 32, the schedule row as id 40, and the owner's wf 64 linking To PDF.
     */
    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->ids = RobotSchema::create($this->db);
        RobotSchema::agentsAndPlaybooks($this->db);
        $this->robot = RobotAccount::ensure($this->db);
        $db = $this->db;
        $db->exec("INSERT INTO playbooks (id, user_id, pkey, title, text) VALUES (5, 2, 'mail-pdf', 'Mail', 't'), (6, 2, 'filing', 'Filing', 't')");
        $db->exec("INSERT INTO agents (id, user_id, name, playbook_id) VALUES (31, 2, 'Filer', 6)");
        $db->exec("INSERT INTO agents (id, user_id, name, visibility) VALUES (32, 1, 'Public helper', 'public')");
        $node = $db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, agent_id, config) VALUES (?, ?, ?, ?)');
        $node->execute([self::WF, 'playbook', null, json_encode(['type' => 'playbook', 'playbook_id' => 5])]);
        $node->execute([self::WF, 'agent', 31, json_encode(['type' => 'agent', 'name' => 'Filer'])]);
        $node->execute([self::WF, 'agent', 32, json_encode(['type' => 'agent', 'name' => 'Helper'])]);
        $db->exec('UPDATE scheduled_workflows SET id = 40 WHERE workflow_id = 75');
        $db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (64, 2, 'Other'), (66, 2, 'Unrelated')");
        $node->execute([64, 'code', null, json_encode(['type' => 'code', 'code_component_id' => $this->ids['To PDF']])]);
    }

    private function transfer(): WorkflowOwnerTransfer
    {
        return new WorkflowOwnerTransfer($this->db, new RobotOwnership($this->db, self::CONFIG));
    }

    private function error(callable $fn): WorkflowTransferError
    {
        try { $fn(); } catch (WorkflowTransferError $e) { return $e; }
        $this->fail('expected WorkflowTransferError');
    }

    /** Every row of every table the transfer touches. */
    private function snapshot(): array
    {
        $all = [];
        foreach (self::TABLES as $t) {
            $all[$t] = $this->db->query("SELECT * FROM $t ORDER BY 1")->fetchAll();
        }
        return $all;
    }

    private function owner(string $table, int $id): int
    {
        return (int) $this->db->query("SELECT user_id FROM $table WHERE id = $id")->fetchColumn();
    }

    public function test_transfer_moves_the_workflow_and_everything_it_uses(): void
    {
        $before = $this->snapshot();
        $r = $this->transfer()->toRobot(self::OWNER, self::WF);
        $components = array_values($this->ids);
        sort($components);
        $this->assertSame(['workflow_id' => self::WF, 'moved' => ['components' => $components, 'playbooks' => [5, 6],
            'agents' => [31], 'schedules' => [40]]], $r);

        $after = $this->snapshot();
        foreach (self::TABLES as $t) {
            $this->assertCount(count($before[$t]), $after[$t], "no new or deleted $t rows");
        }
        $this->assertSame($before['workflow_nodes'], $after['workflow_nodes']);
        $this->assertSame($before['workflow_edges'], $after['workflow_edges']);
        $this->assertSame($this->robot, $this->owner('agent_workflows', self::WF));
        foreach ($components as $id) {
            $this->assertSame($this->robot, $this->owner('code_components', $id));
        }
        $this->assertSame([$this->robot, $this->robot], [$this->owner('playbooks', 5), $this->owner('playbooks', 6)]);
        $this->assertSame([$this->robot, 1], [$this->owner('agents', 31), $this->owner('agents', 32)]);   // another user's agent stays
        $this->assertSame($this->robot, $this->owner('scheduled_workflows', 40));
        $this->assertSame([self::OWNER, self::OWNER], [$this->owner('agent_workflows', 64), $this->owner('agent_workflows', 66)]);
    }

    public function test_clash_refuses_and_changes_nothing(): void
    {
        (new CodeComponentStore($this->db))->save($this->robot, null, ['name' => 'Store SharePoint', 'code' => 'x', 'exits' => ['done']]);
        $this->db->exec("INSERT INTO agents (user_id, name) VALUES ({$this->robot}, 'Filer')");
        $this->db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (90, {$this->robot}, 'Mail to PDF')");
        $before = $this->snapshot();
        $e = $this->error(fn() => $this->transfer()->toRobot(self::OWNER, self::WF));
        $clashes = [['kind' => 'workflow', 'name' => 'Mail to PDF'], ['kind' => 'component', 'name' => 'Store SharePoint'],
            ['kind' => 'agent', 'name' => 'Filer']];
        $this->assertSame(['clash', 409, $clashes], [$e->kind, $e->status, $e->clashes]);
        $this->assertSame($before, $this->snapshot());
        $this->assertSame($clashes, $this->transfer()->preview(self::OWNER, self::WF)['clashes']);
    }

    public function test_playbook_clash_is_by_key(): void
    {
        $this->db->exec("INSERT INTO playbooks (user_id, pkey, title, text) VALUES ({$this->robot}, 'filing', 'Other title', 't')");
        $e = $this->error(fn() => $this->transfer()->toRobot(self::OWNER, self::WF));
        $this->assertSame([['kind' => 'playbook', 'name' => 'filing']], $e->clashes);
    }

    public function test_a_clash_with_a_published_robot_copy_says_unpublish_first(): void
    {
        $this->db->exec("INSERT INTO playbooks (user_id, pkey, title, text, source_id) VALUES ({$this->robot}, 'filing', 'Filing', 't', 6)");
        $e = $this->error(fn() => $this->transfer()->toRobot(self::OWNER, self::WF));
        $this->assertSame([['kind' => 'playbook', 'name' => 'filing', 'published' => true]], $e->clashes);
        $this->assertStringContainsString('playbook "filing" is published to the robot: unpublish it first', $e->getMessage());
        $this->assertSame($e->clashes, $this->transfer()->preview(self::OWNER, self::WF)['clashes']);
    }

    public function test_preview_lists_shared_workflows_and_missing_servers(): void
    {
        $add = $this->db->prepare('INSERT INTO mcp_servers (user_id, name, url, enabled) VALUES (?, ?, ?, ?)');
        $add->execute([(string) $this->robot, 'outlook', 'http://o', 1]);      // matches "Outlook" by slug
        $add->execute([(string) self::OWNER, 'Converter', 'http://c', 1]);     // the owner's, not the robot's
        $before = $this->snapshot();
        $p = $this->transfer()->preview(self::OWNER, self::WF);
        $this->assertSame(['needs_servers' => ['Converter', 'SharePoint'], 'shared_with' => [['id' => 64, 'name' => 'Other']],
            'clashes' => []], $p);
        $this->assertSame($before, $this->snapshot());
    }

    public function test_the_owners_active_workflow_is_deactivated(): void
    {
        (new ActiveWorkflowService($this->db))->activate(self::OWNER, self::WF);
        $this->transfer()->toRobot(self::OWNER, self::WF);
        $this->assertSame(0, (int) $this->db->query('SELECT COUNT(*) FROM active_workflows')->fetchColumn());
    }

    public function test_transfer_is_idempotent_and_repairs_schedules(): void
    {
        $this->transfer()->toRobot(self::OWNER, self::WF);
        $this->db->exec('UPDATE scheduled_workflows SET user_id = 2 WHERE id = 40');
        $r = $this->transfer()->toRobot(self::OWNER, self::WF);
        $this->assertSame(['workflow_id' => self::WF, 'moved' => ['components' => [], 'playbooks' => [], 'agents' => [],
            'schedules' => [40]]], $r);
        $this->assertSame($this->robot, $this->owner('scheduled_workflows', 40));
        $this->assertSame(['needs_servers' => ['Converter', 'Outlook', 'SharePoint'], 'shared_with' => [], 'clashes' => []],
            $this->transfer()->preview(self::OWNER, self::WF));
    }

    public function test_access(): void
    {
        $e = $this->error(fn() => $this->transfer()->toRobot(1, self::WF));   // role without use_robot
        $this->assertSame(['forbidden', 403], [$e->kind, $e->status]);
        $this->db->exec("UPDATE users SET role = 'ops' WHERE id = 3");      // may use the robot, not the owner
        $e = $this->error(fn() => $this->transfer()->preview(3, self::WF));
        $this->assertSame(['not_found', 404], [$e->kind, $e->status]);
        $this->assertSame(self::OWNER, $this->owner('agent_workflows', self::WF));
    }

    private function route(int $user, array $body): array
    {
        return (new WorkflowController($this->db, self::CONFIG))->owner(['user_id' => $user, 'body' => $body, 'params' => ['id' => self::WF]]);
    }

    public function test_owner_route(): void
    {
        $this->assertSame(422, $this->route(2, ['owner' => 'me', 'confirm' => true])['status_code']);
        $this->assertSame(403, $this->route(1, ['owner' => 'robot'])['status_code']);
        $this->assertSame(401, $this->route(0, ['owner' => 'robot'])['status_code']);
        $r = $this->route(2, ['owner' => 'robot', 'confirm' => false]);
        $this->assertSame([true, 200, [['id' => 64, 'name' => 'Other']]], [$r['success'], $r['status_code'], $r['data']['shared_with']]);
        $this->assertSame(self::OWNER, $this->owner('agent_workflows', self::WF));

        $this->db->exec("INSERT INTO agents (user_id, name) VALUES ({$this->robot}, 'Filer')");
        $r = $this->route(2, ['owner' => 'robot', 'confirm' => true]);
        $this->assertSame([false, 409, 'clash', [['kind' => 'agent', 'name' => 'Filer']]],
            [$r['success'], $r['status_code'], $r['error_code'], $r['clashes']]);
        $this->assertStringContainsString('Filer', $r['error']);

        $this->db->exec("DELETE FROM agents WHERE user_id = {$this->robot}");
        $r = $this->route(2, ['owner' => 'robot', 'confirm' => true]);
        $this->assertSame([true, 200, self::WF], [$r['success'], $r['status_code'], $r['data']['workflow_id']]);
        $this->assertSame($this->robot, $this->owner('agent_workflows', self::WF));

        $this->db->exec("INSERT INTO active_workflows (user_id, workflow_id, mode, activated_at) VALUES ({$this->robot}, 75, 'event', '2026-10-29 09:00:00')");
        $r = $this->route(2, ['owner' => 'robot', 'confirm' => true]);
        $this->assertSame([423, 'locked'], [$r['status_code'], $r['error_code']]);
    }
}
