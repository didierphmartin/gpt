<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Services;

use AgentTeam\Controllers\AgentController;
use AgentTeam\Services\WorkflowGraphRepository;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentStore;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookStore;
use Quantis\AIPortfolioAssistant\Tests\Unit\Playbook\PlaybookStoreTest;

/** Components, playbooks and agents owned by the robot are shared with every robot-permitted user. */
final class RobotSharedItemsTest extends TestCase
{
    private PDO $db;

    protected function tearDown(): void
    {
        unset($_ENV['GPT_EDITION']);
    }

    protected function setUp(): void
    {
        $_ENV['GPT_EDITION'] = 'individual';
        $db = $this->db = new PDO('sqlite::memory:');
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT, role TEXT, kind TEXT NOT NULL DEFAULT 'person')");
        $db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)');
        $db->exec("INSERT INTO packages (role, name, builtin, capabilities) VALUES ('user', 'User', 1, '{}')");
        $db->exec("INSERT INTO users (id, email, role, kind) VALUES (3, 'p@x.test', 'user', 'person'), (4, 'q@x.test', 'user', 'person'), (120, 'r@x.test', 'robot', 'service')");
        $db->exec('CREATE TABLE code_components (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
            description TEXT, code TEXT NOT NULL, exits TEXT NOT NULL, mcp_servers TEXT NOT NULL, timeout_s INTEGER NOT NULL DEFAULT 30,
            start_trigger TEXT, args TEXT, provides TEXT, created_at TEXT, updated_at TEXT, UNIQUE (user_id, name))');
        $db->exec('CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, pkey TEXT NOT NULL,
            title TEXT NOT NULL, text TEXT NOT NULL, automation_id INTEGER, published_by INTEGER, published_at TEXT, source_id INTEGER,
            created_at TEXT, updated_at TEXT, UNIQUE (user_id, pkey))');
        $db->exec('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT)');
        $db->exec('CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, node_type TEXT, agent_id INTEGER, config TEXT, pos_x INTEGER, pos_y INTEGER, drawflow_node_id TEXT)');
        $db->exec("CREATE TABLE workflow_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, from_node_id INTEGER,
            to_node_id INTEGER, from_port TEXT DEFAULT 'output_1', to_port TEXT DEFAULT 'input_1', condition_expr TEXT, created_at TEXT)");
        $db->exec("CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, team_id INTEGER,
            category TEXT, name TEXT NOT NULL, description TEXT, agent_type TEXT DEFAULT 'standard', parent_agent_id INTEGER,
            can_delegate_to TEXT, display_order INTEGER DEFAULT 0, provider TEXT DEFAULT 'claude', model TEXT, instructions TEXT,
            playbook_id INTEGER, tools TEXT, visibility TEXT DEFAULT 'personal', enabled INTEGER DEFAULT 1, settings TEXT,
            created_at TEXT, updated_at TEXT, UNIQUE (user_id, name))");
    }

    private function component(int $owner, string $name): int
    {
        return (new CodeComponentStore($this->db))->save($owner, null,
            ['name' => $name, 'code' => 'def run(i, c): return "ok"', 'exits' => ['done'], 'mcp_servers' => []])['id'];
    }

    public function testPersonalWorkflowKeepsLinkedRobotComponentAndPlaybook(): void
    {
        $cid = $this->component(120, 'robot_comp');
        $pid = (new PlaybookStore($this->db))->save(120, null, PlaybookStoreTest::OKTA, 'okta-reset')['id'];
        $this->db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, '3', 'Mine')");
        $this->db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (9, ?, ?)')
            ->execute(['code', json_encode(['type' => 'code', 'code_component_id' => $cid])]);
        $this->db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (9, ?, ?)')
            ->execute(['playbook', json_encode(['type' => 'playbook', 'playbook_id' => $pid])]);
        $nodes = (new WorkflowGraphRepository($this->db))->getGraph(9)['nodes'];
        $this->assertSame('def run(i, c): return "ok"', $nodes[0]['config']['code']);
        $this->assertArrayNotHasKey('code_component_missing', $nodes[0]['config']);
        $this->assertArrayNotHasKey('playbook_missing', $nodes[1]['config']);
        $this->assertNotEmpty($nodes[1]['config']['playbook']);
    }

    public function testListIncludesRobotRowsOnlyWhenTheRobotIdIsGiven(): void
    {
        $this->component(120, 'robot_comp');
        $this->component(3, 'mine');
        $store = new CodeComponentStore($this->db);
        $with = $store->list(3, 120);
        $this->assertSame(['mine', 'robot_comp'], array_column($with, 'name'));
        $this->assertSame([false, true], array_column($with, 'is_robot'));
        $this->assertSame(['mine'], array_column($store->list(3), 'name'));
        $this->assertSame([], $store->list(4));
    }

    public function testPlaybookListAndGetCarryRobotRows(): void
    {
        $pid = (new PlaybookStore($this->db))->save(120, null, PlaybookStoreTest::OKTA, 'okta-reset')['id'];
        $s = new PlaybookStore($this->db);
        $this->assertTrue($s->list(3, 120)[0]['is_robot']);
        $this->assertTrue($s->get(3, $pid, 120)['is_robot']);
        $this->assertSame([], $s->list(3));
        $this->assertNull($s->get(3, $pid));
    }

    public function testSavingARobotComponentUpdatesTheRobotsRow(): void
    {
        $cid = $this->component(120, 'robot_comp');
        $store = new CodeComponentStore($this->db);
        $row = $store->save(3, $cid, ['name' => 'robot_comp', 'code' => 'x = 1', 'exits' => ['done'], 'mcp_servers' => []], 120);
        $this->assertSame($cid, $row['id']);
        $this->assertTrue($row['is_robot']);
        $this->assertSame('x = 1', $row['code']);
        $this->assertSame(1, (int) $this->db->query('SELECT COUNT(*) FROM code_components')->fetchColumn());
        $new = $store->save(3, null, ['name' => 'fresh', 'code' => '', 'exits' => ['done'], 'mcp_servers' => []], 120);
        $this->assertFalse($new['is_robot']);
    }

    public function testUsedByFindsTheRobotsWorkflowsToo(): void
    {
        $cid = $this->component(3, 'mine');
        $this->db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (75, '120', 'Robot wf')");
        $this->db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (75, ?, ?)')
            ->execute(['code', json_encode(['type' => 'code', 'code_component_id' => $cid])]);
        $store = new CodeComponentStore($this->db);
        $this->assertCount(0, $store->usedBy(3, $cid));
        $this->assertCount(1, $store->usedBy(3, $cid, 120));
    }

    private function agentUpdate(int $user, string $edition, int $id, array $body): array
    {
        return (new AgentController($this->db, ['edition' => $edition]))
            ->update(['user_id' => $user, 'params' => ['id' => $id], 'agent_id' => $id, 'body' => $body]);
    }

    public function testRobotPermittedUserUpdatesARobotAgentInPlace(): void
    {
        $this->db->exec("INSERT INTO agents (id, user_id, name, instructions) VALUES (50, 120, 'Robot agent', 'old')");
        $r = $this->agentUpdate(3, 'individual', 50, ['instructions' => 'new']);
        $this->assertTrue($r['success'], json_encode($r));
        $row = $this->db->query('SELECT user_id, instructions FROM agents WHERE id = 50')->fetch();
        $this->assertSame(120, (int) $row['user_id']);
        $this->assertSame('new', $row['instructions']);
        $this->assertSame(1, (int) $this->db->query('SELECT COUNT(*) FROM agents')->fetchColumn());
    }

    public function testUserWithoutRobotPermissionGets404(): void
    {
        $this->db->exec("INSERT INTO agents (id, user_id, name, instructions) VALUES (50, 120, 'Robot agent', 'old')");
        $r = $this->agentUpdate(4, 'corporate', 50, ['instructions' => 'new']);
        $this->assertSame(404, $r['status_code']);
        $this->assertSame('old', $this->db->query('SELECT instructions FROM agents WHERE id = 50')->fetchColumn());
    }

    private function linkFromPersonalWorkflow(int $cid): void
    {
        $this->db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, '3', 'Mine')");
        $this->db->prepare('INSERT INTO workflow_nodes (id, workflow_id, node_type, config) VALUES (1, 9, ?, ?)')
            ->execute(['code', json_encode(['type' => 'code', 'code_component_id' => $cid])]);
    }

    public function testARobotComponentLinkedByAPersonalWorkflowCannotBeDeleted(): void
    {
        $cid = $this->component(120, 'robot_comp');
        $this->linkFromPersonalWorkflow($cid);
        $store = new CodeComponentStore($this->db);
        $this->assertCount(1, $store->usedBy(3, $cid, 120));
        try {
            $store->delete(3, $cid, 120);
            $this->fail('delete should be refused');
        } catch (\Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentError $e) {
            $this->assertSame('in_use', $e->kind);
        }
    }

    public function testExitChangeOnARobotComponentRemapsPersonalWorkflowEdges(): void
    {
        $store = new CodeComponentStore($this->db);
        $cid = $store->save(120, null, ['name' => 'rc', 'code' => '', 'exits' => ['a', 'b'], 'mcp_servers' => []])['id'];
        $this->linkFromPersonalWorkflow($cid);
        $this->db->exec("INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port) VALUES (9, 1, 2, 'output_2')");
        $store->save(3, $cid, ['name' => 'rc', 'code' => '', 'exits' => ['b', 'c'], 'mcp_servers' => [], 'confirm_drop_links' => true], 120);
        $this->assertSame('output_1', $this->db->query('SELECT from_port FROM workflow_edges')->fetchColumn());
    }

    public function testAWorkflowOfAUserWithoutRobotPermissionNeverResolvesRobotRows(): void
    {
        $_ENV['GPT_EDITION'] = 'corporate';
        $cid = $this->component(120, 'robot_comp');
        $this->linkFromPersonalWorkflow($cid);
        $cfg = (new WorkflowGraphRepository($this->db))->getGraph(9)['nodes'][0]['config'];
        $this->assertTrue($cfg['code_component_missing']);
        $this->assertArrayNotHasKey('code', $cfg);
    }

    public function testRobotPermittedUserEditsAndDeletesARobotPlaybookInPlace(): void
    {
        $s = new PlaybookStore($this->db);
        $pid = $s->save(120, null, PlaybookStoreTest::OKTA, 'okta-reset')['id'];
        $row = $s->save(3, $pid, PlaybookStoreTest::OKTA, null, 120);
        $this->assertSame($pid, $row['id']);
        $this->assertTrue($row['is_robot']);
        $this->assertSame(1, (int) $this->db->query('SELECT COUNT(*) FROM playbooks')->fetchColumn());
        $this->assertFalse($s->save(3, null, PlaybookStoreTest::OKTA, 'mine', 120)['is_robot']);
        $s->delete(3, $pid, 120);
        $this->assertSame(1, (int) $this->db->query('SELECT COUNT(*) FROM playbooks')->fetchColumn());
        $this->expectException(\Quantis\AIPortfolioAssistant\Playbook\PlaybookStoreError::class);
        $s->delete(4, $pid);
    }

    /** A playbook of user 3 published to the robot: the robot's copy (source_id set), the ServiceNow bridge's. Returns its id. */
    private function publishedCopy(): int
    {
        $s = new PlaybookStore($this->db);
        $src = $s->save(3, null, PlaybookStoreTest::OKTA, 'okta-reset')['id'];
        return $s->publish(3, $src, 120, false)['id'];
    }

    public function testTheRobotsPublishedCopiesAreNotSharedRows(): void
    {
        $copy = $this->publishedCopy();
        $s = new PlaybookStore($this->db);
        $this->assertSame([], array_values(array_filter($s->list(4, 120), fn($r) => $r['id'] === $copy)));
        $this->assertNull($s->get(4, $copy, 120));
        foreach ([fn() => $s->save(4, $copy, PlaybookStoreTest::OKTA, null, 120), fn() => $s->delete(4, $copy, 120)] as $write) {
            try {
                $write();
                $this->fail('a published copy is not editable as a shared robot row');
            } catch (\Quantis\AIPortfolioAssistant\Playbook\PlaybookStoreError $e) {
                $this->assertSame('not_found', $e->kind);
            }
        }
        // the publish mechanism still sees it
        $this->assertSame([$copy], array_column($s->robotList(120), 'id'));
        $this->assertSame([1 => 'published'], $s->publishStatus(3, 120));
        $this->assertNotNull($s->get(120, $copy));
    }

    public function testLinksNeverResolveToAPublishedCopy(): void
    {
        $copy = $this->publishedCopy();
        $this->db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, '4', 'Theirs')");
        $this->db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (9, ?, ?)')
            ->execute(['playbook', json_encode(['type' => 'playbook', 'playbook_id' => $copy])]);
        $this->assertTrue((new WorkflowGraphRepository($this->db))->getGraph(9)['nodes'][0]['config']['playbook_missing']);
        try {
            (new \AgentTeam\Services\WorkflowRefResolver($this->db))->resolve(4, [['id' => '1', 'config' => ['playbook_ref' => 'okta-reset']]], [], 120);
            $this->fail('the published copy must not resolve');
        } catch (\AgentTeam\Services\UnresolvedRefsException $e) {
            $this->assertSame(["playbook 'okta-reset'"], $e->missing);
        }
        // usedBy of the copy is not the robot fallback's every-user scan
        $this->assertSame([], (new PlaybookStore($this->db))->usedBy(3, $copy, 120)['nodes']);
    }

    /** A robot component (exits a, b, c) linked from user 3's wf 9, user 4's wf 10 and the robot's wf 75, each with an edge on b. */
    private function linkedEverywhere(): int
    {
        $cid = (new CodeComponentStore($this->db))->save(120, null, ['name' => 'rc', 'code' => '', 'exits' => ['a', 'b', 'c'], 'mcp_servers' => []])['id'];
        $this->db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, '3', 'Mine'), (10, '4', 'Secret of 4'), (75, '120', 'Robot wf')");
        foreach ([9, 10, 75] as $wf) {
            $this->db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)')
                ->execute([$wf, 'code', json_encode(['type' => 'code', 'name' => "N$wf", 'code_component_id' => $cid])]);
            $this->db->prepare("INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port) VALUES (?, ?, 99, 'output_2')")
                ->execute([$wf, (int) $this->db->lastInsertId()]);
        }
        return $cid;
    }

    public function testOtherUsersWorkflowsAreCountedNotNamed(): void
    {
        $cid = $this->linkedEverywhere();
        $store = new CodeComponentStore($this->db);
        $used = $store->usedBy(3, $cid, 120);
        $this->assertSame(['Mine', 'Robot wf'], array_column(array_slice($used, 0, 2), 'workflow_name'));
        $this->assertSame(['others' => 1], $used[2]);
        $this->assertStringNotContainsString('Secret', json_encode($used));
        $this->assertSame(3, $store->list(3, 120)[0]['used_by']);   // the count is every link
        try {
            $store->delete(3, $cid, 120);
            $this->fail('in use');
        } catch (\Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentError $e) {
            $this->assertSame('in_use', $e->kind);
            $this->assertStringContainsString('"Mine"', $e->getMessage());
            $this->assertStringContainsString('1 other workflow', $e->getMessage());
            $this->assertStringNotContainsString('Secret', $e->getMessage());
        }
        try {
            $store->save(3, $cid, ['name' => 'rc', 'code' => '', 'exits' => ['a', 'c'], 'mcp_servers' => []], 120);
            $this->fail('links dropped');
        } catch (\Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentError $e) {
            $this->assertSame('links_dropped', $e->kind);
            $this->assertSame(['Mine', 'Robot wf'], array_column(array_slice($e->data, 0, 2), 'workflow_name'));
            $this->assertSame(['others' => 1, 'count' => 1], $e->data[2]);
            $this->assertStringNotContainsString('Secret', $e->getMessage() . json_encode($e->data));
        }
    }

    public function testStartOptionImpactCountsOtherUsersWorkflows(): void
    {
        $this->db->exec("CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, workflow_id INTEGER,
            event_trigger TEXT, trigger_component_id INTEGER)");
        $store = new CodeComponentStore($this->db);
        $cid = $store->save(120, null, ['name' => 'poll', 'code' => '', 'exits' => ['new_mail', 'none'], 'mcp_servers' => ['Outlook']])['id'];
        $store->setStartTrigger(120, $cid, ['label' => 'New', 'work_exit' => 'new_mail',
            'watch' => ['server' => 'Outlook', 'tool' => 'wait_for_new', 'args' => []]]);
        $this->db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, '3', 'Mine'), (10, '4', 'Secret of 4')");
        $this->db->exec("INSERT INTO scheduled_workflows (user_id, workflow_id, trigger_component_id) VALUES (4, 10, $cid)");
        $this->db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (9, ?, ?)')
            ->execute(['start', json_encode(['type' => 'start', 'start_option' => $cid])]);
        $impact = $store->startTriggerImpact(3, $cid, 120);
        $this->assertSame([['workflow_id' => 9, 'workflow_name' => 'Mine'], ['others' => 1]], $impact);
    }

    public function testPlaybookUsedByCountsOtherUsersLinks(): void
    {
        $s = new PlaybookStore($this->db);
        $pid = $s->save(120, null, PlaybookStoreTest::OKTA, 'okta-reset')['id'];
        $this->db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, '3', 'Mine'), (10, '4', 'Secret of 4')");
        foreach ([9, 10] as $wf) {
            $this->db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)')
                ->execute([$wf, 'playbook', json_encode(['type' => 'playbook', 'name' => "P$wf", 'playbook_id' => $pid])]);
        }
        $this->db->exec("INSERT INTO agents (user_id, name, playbook_id) VALUES (4, 'Secret agent', $pid), (3, 'My agent', $pid)");
        $used = $s->usedBy(3, $pid, 120);
        $this->assertSame([['My agent'], ['Mine'], 2], [array_column($used['agents'], 'name'), array_column($used['nodes'], 'workflow_name'), $used['others']]);
        $this->assertSame(4, $s->list(3, 120)[0]['used_by']);
        try {
            $s->delete(3, $pid, 120);
            $this->fail('in use');
        } catch (\Quantis\AIPortfolioAssistant\Playbook\PlaybookStoreError $e) {
            $this->assertStringContainsString('"Mine"', $e->getMessage());
            $this->assertStringContainsString('1 other workflow', $e->getMessage());
            $this->assertStringContainsString('1 other agent', $e->getMessage());
            $this->assertStringNotContainsString('Secret', $e->getMessage());
        }
    }
}
