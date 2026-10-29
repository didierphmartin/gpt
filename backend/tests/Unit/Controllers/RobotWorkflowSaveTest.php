<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use AgentTeam\Controllers\AgentController;
use AgentTeam\Controllers\AgentMCPController;
use AgentTeam\Controllers\WorkflowController;
use AgentTeam\Services\AgentRepository;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentStore;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookStore;
use Quantis\AIPortfolioAssistant\Services\RobotAccount;
use Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam\RobotSchema;
use Quantis\AIPortfolioAssistant\Tests\Unit\Playbook\PlaybookStoreTest;

/** Saving a robot workflow or a robot agent: links resolve against the robot, never the editor's own rows; names stay unique. */
final class RobotWorkflowSaveTest extends TestCase
{
    private const CONFIG = ['edition' => 'corporate'];
    private PDO $db;
    private int $robot;
    private array $ids;

    protected function setUp(): void
    {
        $_ENV['GPT_EDITION'] = 'corporate';
        $this->db = new PDO('sqlite::memory:');
        $this->ids = RobotSchema::create($this->db);
        RobotSchema::agentsAndPlaybooks($this->db);
        $have = array_column($this->db->query('PRAGMA table_info(agent_workflows)')->fetchAll(), 'name');
        foreach (['description' => 'TEXT', 'steps' => 'TEXT', 'triggers' => 'TEXT', 'variables' => 'TEXT', 'enabled' => 'INTEGER DEFAULT 1',
                  'workspace_id' => 'INTEGER', 'output_storage_enabled' => 'INTEGER DEFAULT 0', 'output_folder' => 'TEXT', 'orchestration' => 'TEXT'] as $c => $t) {
            if (!in_array($c, $have, true)) {
                $this->db->exec("ALTER TABLE agent_workflows ADD COLUMN $c $t");
            }
        }
        foreach (['pos_x' => 'INTEGER', 'pos_y' => 'INTEGER', 'drawflow_node_id' => 'TEXT'] as $c => $t) {
            $this->db->exec("ALTER TABLE workflow_nodes ADD COLUMN $c $t");
        }
        $this->db->exec("ALTER TABLE workflow_edges ADD COLUMN condition_expr TEXT");
        $this->db->exec('CREATE UNIQUE INDEX uq_workflows_user_name ON agent_workflows (user_id, name)');
        // user 3 may use the robot; user 1 may not
        $this->db->exec("UPDATE users SET role = 'ops' WHERE id = 3");
        $this->db->exec("INSERT INTO users (id, email, role) VALUES (119, 'filler@x.test', 'user')");
        $this->robot = RobotAccount::ensure($this->db);
        $this->db->exec("UPDATE agent_workflows SET user_id = {$this->robot} WHERE id = 75");
        $this->db->exec("UPDATE code_components SET user_id = {$this->robot}");
        $this->db->exec("UPDATE scheduled_workflows SET user_id = {$this->robot}");
    }

    protected function tearDown(): void
    {
        unset($_ENV['GPT_EDITION']);
    }

    private function update(int $user, int $wf, array $body): array
    {
        return (new WorkflowController($this->db, self::CONFIG))->update(['user_id' => $user, 'params' => ['id' => $wf], 'body' => $body]);
    }

    private function linkedComponentIds(int $wf): array
    {
        $st = $this->db->prepare("SELECT config FROM workflow_nodes WHERE workflow_id = ? AND node_type = 'code' ORDER BY id");
        $st->execute([$wf]);
        return array_map(fn($c) => json_decode((string) $c, true)['code_component_id'] ?? null, $st->fetchAll(PDO::FETCH_COLUMN));
    }

    public function test_dsl_save_of_a_robot_workflow_links_the_robots_component_not_the_editors(): void
    {
        $mine = (new CodeComponentStore($this->db))->save(3, null, RobotSchema::SP)['id'];   // user 3's own "Store SharePoint"
        $r = $this->update(3, 75, ['definition' => ['nodes' => [
            ['id' => '1', 'node_type' => 'code', 'config' => ['type' => 'code', 'name' => 'SP', 'code_component_ref' => 'Store SharePoint']],
        ], 'edges' => []]]);
        $this->assertTrue($r['success'], json_encode($r));
        $this->assertNotSame($mine, $this->ids['Store SharePoint']);
        $this->assertSame([$this->ids['Store SharePoint']], $this->linkedComponentIds(75));
    }

    public function test_editor_save_linking_a_personal_component_into_a_robot_workflow_is_refused(): void
    {
        $mine = (new CodeComponentStore($this->db))->save(3, null, ['name' => 'Mine', 'code' => '', 'exits' => ['done'], 'mcp_servers' => []])['id'];
        $before = $this->linkedComponentIds(75);
        $r = $this->update(3, 75, ['name' => 'Renamed', 'definition' => ['nodes' => [
            ['id' => '1', 'node_type' => 'code', 'config' => ['type' => 'code', 'name' => 'X', 'code_component_id' => $mine]],
            ['id' => '2', 'node_type' => 'code', 'config' => ['type' => 'code', 'name' => 'PDF', 'code_component_id' => $this->ids['To PDF']]],
        ], 'edges' => []]]);
        $this->assertSame([false, 422, 'unknown_references'], [$r['success'], $r['status_code'], $r['error_code'] ?? null], json_encode($r));
        $this->assertSame(["code component #$mine"], $r['missing']);
        $this->assertSame($before, $this->linkedComponentIds(75));
        $this->assertSame('Mail to PDF', $this->db->query('SELECT name FROM agent_workflows WHERE id = 75')->fetchColumn());
    }

    public function test_robot_workflow_refuses_personal_playbooks_agents_and_start_options(): void
    {
        $pb = (new PlaybookStore($this->db))->save(3, null, PlaybookStoreTest::OKTA, 'okta-reset')['id'];
        $this->db->exec("INSERT INTO agents (id, user_id, name) VALUES (40, 3, 'Mine'), (41, 1, 'Shared'), (42, {$this->robot}, 'Robots')");
        $this->db->exec("UPDATE agents SET visibility = 'public' WHERE id = 41");
        $opt = (new CodeComponentStore($this->db))->save(3, null, RobotSchema::POLL + ['name' => 'My poll'])['id'];
        $r = $this->update(3, 75, ['definition' => ['nodes' => [
            ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'start_option' => $opt]],
            ['id' => '2', 'node_type' => 'playbook', 'config' => ['type' => 'playbook', 'playbook_id' => $pb]],
            ['id' => '3', 'node_type' => 'agent', 'agent_id' => 40, 'config' => ['type' => 'agent']],
            ['id' => '4', 'node_type' => 'agent', 'agent_id' => 41, 'config' => ['type' => 'agent']],
            ['id' => '5', 'node_type' => 'agent', 'agent_id' => 42, 'config' => ['type' => 'agent']],
        ], 'edges' => []]]);
        $this->assertSame(422, $r['status_code'], json_encode($r));
        $this->assertSame(["start option component #$opt", "playbook #$pb", 'agent #40'], $r['missing']);
    }

    public function test_a_personal_workflow_still_links_its_owners_rows(): void
    {
        $this->db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, 3, 'Mine')");
        $mine = (new CodeComponentStore($this->db))->save(3, null, RobotSchema::SP)['id'];
        $r = $this->update(3, 9, ['definition' => ['nodes' => [
            ['id' => '1', 'node_type' => 'code', 'config' => ['type' => 'code', 'name' => 'SP', 'code_component_ref' => 'Store SharePoint']],
            ['id' => '2', 'node_type' => 'code', 'config' => ['type' => 'code', 'name' => 'PDF', 'code_component_id' => $this->ids['To PDF']]],
        ], 'edges' => []]]);
        $this->assertTrue($r['success'], json_encode($r));
        $this->assertSame([$mine, $this->ids['To PDF']], $this->linkedComponentIds(9));
    }

    public function test_renaming_a_robot_workflow_to_a_name_the_robot_has_is_409(): void
    {
        $this->db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (80, {$this->robot}, 'Other')");
        $r = $this->update(3, 75, ['name' => 'Other']);
        $this->assertSame([false, 409, 'name_taken'], [$r['success'], $r['status_code'], $r['error_code'] ?? null], json_encode($r));
        $this->assertSame('Mail to PDF', $this->db->query('SELECT name FROM agent_workflows WHERE id = 75')->fetchColumn());
    }

    private function agents(int $user, string $method, int $id, array $body = []): array
    {
        return (new AgentController($this->db, self::CONFIG))->$method(['user_id' => $user, 'params' => ['id' => $id], 'body' => $body]);
    }

    public function test_robot_agent_takes_only_a_robot_playbook(): void
    {
        $s = new PlaybookStore($this->db);
        $mine = $s->save(3, null, PlaybookStoreTest::OKTA, 'mine')['id'];
        $robots = $s->save($this->robot, null, PlaybookStoreTest::OKTA, 'robots')['id'];
        $this->db->exec("INSERT INTO agents (id, user_id, name, agent_type) VALUES (50, {$this->robot}, 'Robot agent', 'playbook')");
        $this->assertSame(404, $this->agents(3, 'update', 50, ['playbook_id' => $mine])['status_code']);
        $this->assertNull($this->db->query('SELECT playbook_id FROM agents WHERE id = 50')->fetchColumn());
        $r = $this->agents(3, 'update', 50, ['playbook_id' => $robots]);
        $this->assertTrue($r['success'], json_encode($r));
        $this->assertSame($robots, (int) $this->db->query('SELECT playbook_id FROM agents WHERE id = 50')->fetchColumn());
    }

    public function test_renaming_a_robot_agent_to_a_name_the_robot_has_is_409(): void
    {
        $this->db->exec("INSERT INTO agents (id, user_id, name) VALUES (50, {$this->robot}, 'A'), (51, {$this->robot}, 'B')");
        $r = $this->agents(3, 'update', 50, ['name' => 'B']);
        $this->assertSame([false, 409, 'name_taken'], [$r['success'], $r['status_code'], $r['error_code'] ?? null], json_encode($r));
        $this->assertSame('A', $this->db->query('SELECT name FROM agents WHERE id = 50')->fetchColumn());
    }

    public function test_robot_agents_are_deleted_moved_and_duplicated_by_permitted_users(): void
    {
        $this->db->exec("INSERT INTO agents (id, user_id, name) VALUES (50, {$this->robot}, 'Robot agent'), (51, {$this->robot}, 'Keep')");
        $this->assertSame(404, $this->agents(1, 'destroy', 50)['status_code']);
        $dup = $this->agents(3, 'duplicate', 51, ['name' => 'My copy']);
        $this->assertTrue($dup['success'], json_encode($dup));
        $this->assertSame(3, (int) $this->db->query("SELECT user_id FROM agents WHERE name = 'My copy'")->fetchColumn());
        $this->assertSame(400, $this->agents(3, 'moveUp', 50)['status_code']);     // found (not 404); no team to move in
        $this->assertSame(400, $this->agents(3, 'moveDown', 50)['status_code']);
        $r = $this->agents(3, 'destroy', 50);
        $this->assertTrue($r['success'], json_encode($r));
        $this->assertFalse($this->db->query('SELECT 1 FROM agents WHERE id = 50')->fetchColumn());
    }

    private function mcp(int $user, string $method, array $params): array
    {
        $ref = new \ReflectionClass(AgentMCPController::class);
        $c = $ref->newInstanceWithoutConstructor();
        foreach (['db' => $this->db, 'config' => self::CONFIG, 'repository' => new AgentRepository($this->db)] as $k => $v) {
            $ref->getProperty($k)->setValue($c, $v);
        }
        return $c->handle(['user_id' => $user, 'body' => ['jsonrpc' => '2.0', 'id' => 1, 'method' => $method, 'params' => $params]]);
    }

    public function test_agent_mcp_updates_and_deletes_robot_agents_for_permitted_users(): void
    {
        $this->db->exec("INSERT INTO agents (id, user_id, name, instructions) VALUES (50, {$this->robot}, 'Robot agent', 'old')");
        $this->assertArrayHasKey('error', $this->mcp(1, 'agents/update', ['id' => 50, 'instructions' => 'x']));
        $r = $this->mcp(3, 'agents/update', ['id' => 50, 'instructions' => 'new']);
        $this->assertArrayHasKey('result', $r, json_encode($r));
        $this->assertSame([(string) $this->robot, 'new'],
            array_map('strval', array_values($this->db->query('SELECT user_id, instructions FROM agents WHERE id = 50')->fetch())));
        $this->assertArrayHasKey('error', $this->mcp(1, 'agents/delete', ['id' => 50]));
        $this->assertArrayHasKey('result', $this->mcp(3, 'agents/delete', ['id' => 50]));
        $this->assertFalse($this->db->query('SELECT 1 FROM agents WHERE id = 50')->fetchColumn());
    }

    public function test_index_marks_robot_and_locked_rows(): void
    {
        $this->db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, 3, 'Mine')");
        $this->db->exec("INSERT INTO active_workflows (user_id, workflow_id, mode, activated_at) VALUES ({$this->robot}, 75, 'event', '2026-10-29 09:00:00'), (3, 9, 'event', '2026-10-29 09:00:00')");
        $r = (new WorkflowController($this->db, self::CONFIG))->index(['user_id' => 3]);
        $rows = array_column(array_map(fn($w) => [$w['id'], [$w['is_robot'], $w['locked']]], $r['data']), 1, 0);
        $this->assertSame([75 => [true, true], 9 => [false, false]], $rows);
        $r = (new WorkflowController($this->db, self::CONFIG))->index(['user_id' => 1]);
        $this->assertSame([], $r['data']);
    }
}
