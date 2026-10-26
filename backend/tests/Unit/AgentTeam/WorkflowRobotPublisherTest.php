<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use AgentTeam\Services\ActiveWorkflowService;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowPublishError;
use AgentTeam\Services\WorkflowRobotPublisher;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentStore;
use Quantis\AIPortfolioAssistant\Services\RobotAccount;
use Quantis\AIPortfolioAssistant\Tests\Unit\EventWorker\EventWorkerSchema;

/** Task B2: a frozen copy of a workflow (graph, code components, Start option, schedule) under the robot. */
final class WorkflowRobotPublisherTest extends TestCase
{
    public const POLL = ['name' => 'Poll Drop', 'code' => 'def run(input, call_tool): pass', 'exits' => ['new_mail', 'no_mail'],
        'mcp_servers' => ['Outlook'], 'timeout_s' => 20];
    public const PDF = ['name' => 'To PDF', 'code' => 'v1', 'exits' => ['done'], 'mcp_servers' => ['Converter']];
    public const SP = ['name' => 'Store SharePoint', 'code' => 'sp', 'exits' => ['done'], 'mcp_servers' => ['SharePoint', 'Outlook']];
    public const WF = 75;
    public const OWNER = 2;

    private PDO $db;
    private CodeComponentStore $store;
    private int $robot;
    /** name => the owner's component id */
    private array $src = [];

    /**
     * EventWorkerSchema plus the users/packages the robot needs (RobotControllerTest's), an empty LLM settings
     * table (WorkflowController reads it), and wf 75 of user 2: Start on "Poll Drop" -> To PDF -> Store SharePoint -> Output,
     * with its event schedule row. Returns the owner's component ids by name.
     */
    public static function schema(PDO $db): array
    {
        EventWorkerSchema::create($db, fn() => '2026-10-26 09:00:00');
        $db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT,
            first_name TEXT, last_name TEXT, role TEXT, provider TEXT, kind TEXT NOT NULL DEFAULT 'person', email_verified INTEGER DEFAULT 0)");
        $db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)');
        $db->exec("INSERT INTO packages (role, name, builtin, capabilities) VALUES ('user', 'User', 1, '{}'), ('admin', 'Admin', 1, '{}'), ('ops', 'Ops', 0, '{\"use_robot\": true}')");
        $db->exec("INSERT INTO users (id, email, role) VALUES (1, 'u@x.test', 'user'), (2, 'o@x.test', 'ops'), (3, 'a@x.test', 'admin')");
        $db->exec('CREATE TABLE system_llm_settings (provider_key TEXT, enabled INTEGER)');

        $store = new CodeComponentStore($db);
        $ids = [];
        foreach ([self::POLL, self::PDF, self::SP] as $c) {
            $ids[$c['name']] = $store->save(self::OWNER, null, $c)['id'];
        }
        $store->setStartTrigger(self::OWNER, $ids['Poll Drop'],
            ['label' => 'New drop', 'watch' => EventWorkerSchema::WATCH, 'work_exit' => 'new_mail']);
        $db->prepare('INSERT INTO agent_workflows (id, user_id, name) VALUES (?, ?, ?)')->execute([self::WF, self::OWNER, 'Mail to PDF']);
        $node = function (string $type, array $cfg) use ($db): int {
            $db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)')
                ->execute([self::WF, $type, json_encode(['type' => $type] + $cfg)]);
            return (int) $db->lastInsertId();
        };
        $start = $node('start', ['start_option' => $ids['Poll Drop'], 'start_args' => ['tag' => 'vip']]);
        $pdf = $node('code', ['name' => 'PDF', 'code_component_id' => $ids['To PDF']]);
        $sp = $node('code', ['name' => 'SP', 'code_component_id' => $ids['Store SharePoint']]);
        $out = $node('output', []);
        $edge = $db->prepare('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port) VALUES (?, ?, ?, ?)');
        $edge->execute([self::WF, $start, $pdf, 'output_1']);
        $edge->execute([self::WF, $pdf, $sp, 'output_1']);
        $edge->execute([self::WF, $sp, $out, 'output_1']);
        EventWorkerSchema::row($db, self::WF, self::OWNER, 'event', $ids['Poll Drop']);
        return $ids;
    }

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->src = self::schema($this->db);
        $this->store = new CodeComponentStore($this->db);
        $this->robot = RobotAccount::ensure($this->db);
    }

    private function publish(bool $confirm = false, int $user = self::OWNER): array
    {
        return (new WorkflowRobotPublisher($this->db, $this->store))->publish($user, self::WF, $this->robot, $confirm);
    }

    private function error(callable $fn): WorkflowPublishError
    {
        try { $fn(); } catch (WorkflowPublishError $e) { return $e; }
        $this->fail('expected WorkflowPublishError');
    }

    /** The workflow's graph as [type, config] per node and [from type/name, port, to type/name] per edge. */
    private function shape(int $wf): array
    {
        $nodes = $this->db->query("SELECT id, node_type, config FROM workflow_nodes WHERE workflow_id = $wf ORDER BY id")->fetchAll();
        $label = [];
        foreach ($nodes as $n) {
            $label[$n['id']] = $n['node_type'] . ':' . (json_decode($n['config'], true)['name'] ?? '');
        }
        $edges = $this->db->query("SELECT from_node_id, from_port, to_node_id FROM workflow_edges WHERE workflow_id = $wf ORDER BY id")->fetchAll();
        return [array_values($label), array_map(fn($e) => [$label[$e['from_node_id']] ?? '?', $e['from_port'], $label[$e['to_node_id']] ?? '?'], $edges)];
    }

    private function config(int $wf, string $type, ?string $name = null): array
    {
        foreach ($this->db->query("SELECT node_type, config FROM workflow_nodes WHERE workflow_id = $wf ORDER BY id") as $n) {
            $cfg = json_decode($n['config'], true);
            if ($n['node_type'] === $type && ($name === null || ($cfg['name'] ?? null) === $name)) {
                return $cfg;
            }
        }
        $this->fail("no $type node $name");
    }

    public function test_publish_copies_graph_components_and_trigger(): void
    {
        $r = $this->publish();
        $copy = $r['robot_workflow_id'];
        $this->assertFalse($r['replaced']);
        $this->assertNotSame(self::WF, $copy);
        $row = $this->db->query("SELECT * FROM agent_workflows WHERE id = $copy")->fetch();
        $this->assertSame([$this->robot, 'Mail to PDF', self::WF, self::OWNER],
            [(int) $row['user_id'], $row['name'], (int) $row['source_id'], (int) $row['published_by']]);
        $this->assertNotNull($row['published_at']);
        $this->assertSame($this->shape(self::WF), $this->shape($copy));

        $mine = $this->store->getByName($this->robot, 'To PDF');
        $this->assertNotNull($mine);
        $this->assertNotSame($this->src['To PDF'], $mine['id']);
        $this->assertSame(['v1', ['done'], ['Converter']], [$mine['code'], $mine['exits'], $mine['mcp_servers']]);
        $this->assertSame($mine['id'], $this->config($copy, 'code', 'PDF')['code_component_id']);
        $poll = $this->store->getByName($this->robot, 'Poll Drop');
        $this->assertSame($poll['id'], $this->config($copy, 'start')['start_option']);
        $this->assertSame(['tag' => 'vip'], $this->config($copy, 'start')['start_args']);
        $this->assertSame(['New drop', 'new_mail'], [$poll['start_trigger']['label'], $poll['start_trigger']['work_exit']]);

        $sched = $this->db->query("SELECT * FROM scheduled_workflows WHERE workflow_id = $copy")->fetchAll();
        $this->assertCount(1, $sched);
        $orig = $this->db->query('SELECT * FROM scheduled_workflows WHERE workflow_id = ' . self::WF)->fetch();
        $this->assertSame([$this->robot, 'event', $poll['id'], $orig['event_trigger']],
            [(int) $sched[0]['user_id'], $sched[0]['repeat_type'], (int) $sched[0]['trigger_component_id'], $sched[0]['event_trigger']]);
        $this->assertSame('option', (new ActiveWorkflowService($this->db))->mode($copy)['mode']);
        // the source is untouched
        $this->assertSame($this->src['To PDF'], $this->config(self::WF, 'code', 'PDF')['code_component_id']);
    }

    public function test_republish_updates_in_place_and_remaps_components(): void
    {
        $old = $this->store->save($this->robot, null, ['name' => 'To PDF', 'code' => 'robot old', 'exits' => ['done', 'failed']]);
        $first = $this->publish();
        $this->assertSame($old['id'], $this->store->getByName($this->robot, 'To PDF')['id']);   // overwritten, not added

        $this->store->save(self::OWNER, $this->src['To PDF'], ['code' => 'v2'] + self::PDF);
        $this->db->exec("DELETE FROM workflow_edges WHERE workflow_id = 75 AND to_node_id = (SELECT id FROM workflow_nodes WHERE node_type = 'output' AND workflow_id = 75)");
        $count = fn() => (int) $this->db->query('SELECT COUNT(*) FROM code_components WHERE user_id = ' . $this->robot)->fetchColumn();
        $before = $count();

        $again = $this->publish();
        $copy = $again['robot_workflow_id'];
        $this->assertSame([$first['robot_workflow_id'], true], [$copy, $again['replaced']]);
        $this->assertSame(1, (int) $this->db->query("SELECT COUNT(*) FROM agent_workflows WHERE user_id = {$this->robot}")->fetchColumn());
        $this->assertSame($before, $count());
        $this->assertSame($this->shape(self::WF), $this->shape($copy));
        $this->assertCount(1, $this->db->query("SELECT id FROM scheduled_workflows WHERE workflow_id = $copy")->fetchAll());

        // Review Focus 4: the robot's copy loads with its components' bodies, from the robot's own rows
        $nodes = (new WorkflowGraphRepository($this->db))->getNodes($copy);
        $pdf = array_values(array_filter($nodes, fn($n) => ($n['config']['name'] ?? null) === 'PDF'))[0]['config'];
        $this->assertArrayNotHasKey('code_component_missing', $pdf);
        $this->assertSame(['v2', $old['id']], [$pdf['code'], $pdf['code_component_id']]);
        foreach ($nodes as $n) {
            $this->assertArrayNotHasKey('code_component_missing', $n['config']);
            $this->assertArrayNotHasKey('start_option_missing', $n['config']);
        }
    }

    public function test_republish_of_active_copy_needs_confirm(): void
    {
        $copy = $this->publish()['robot_workflow_id'];
        (new ActiveWorkflowService($this->db))->activate($this->robot, $copy);
        $e = $this->error(fn() => $this->publish());
        $this->assertSame(['replaces', 409], [$e->kind, $e->status]);
        $r = $this->publish(true);
        $this->assertSame([$copy, true], [$r['robot_workflow_id'], $r['replaced']]);
        $this->assertSame($copy, (int) (new ActiveWorkflowService($this->db))->get($this->robot)['workflow_id']);
    }

    public function test_confirmed_republish_reactivates_the_copy_on_its_new_mode(): void
    {
        $copy = $this->publish()['robot_workflow_id'];
        $active = new ActiveWorkflowService($this->db);
        $active->activate($this->robot, $copy);
        $this->assertSame('option', $active->get($this->robot)['mode']);
        // The source moves from its code option to a daily schedule; the confirmed republish carries that over.
        $this->db->exec('DELETE FROM scheduled_workflows WHERE workflow_id = ' . self::WF);
        EventWorkerSchema::row($this->db, self::WF, self::OWNER, 'daily');
        $this->publish(true);
        $row = $active->get($this->robot);
        $this->assertSame([$copy, 'schedule', null], [(int) $row['workflow_id'], $row['mode'],
            $row['trigger_component_id'] === null ? null : (int) $row['trigger_component_id']]);
        // A copy republished without any trigger can no longer be active: it is stopped, not left on its old mode.
        $this->db->exec('DELETE FROM scheduled_workflows WHERE workflow_id = ' . self::WF);
        $this->publish(true);
        $this->assertNull($active->get($this->robot));
    }

    public function test_configs_without_links_are_copied_verbatim(): void
    {
        $this->db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)')
            ->execute([self::WF, 'agent', '{}']);
        $this->db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)')
            ->execute([self::WF, 'agent', '{"name":"Café","url":"http://x/y"}']);
        $copy = $this->publish()['robot_workflow_id'];
        $configs = $this->db->query("SELECT config FROM workflow_nodes WHERE workflow_id = $copy AND node_type = 'agent' ORDER BY id")
            ->fetchAll(PDO::FETCH_COLUMN);
        $this->assertSame(['{}', '{"name":"Café","url":"http://x/y"}'], $configs);
        // A remapped link is re-encoded without escaping unicode or slashes.
        $this->db->exec("UPDATE workflow_nodes SET config = json_set(config, '$.note', 'é/x') WHERE workflow_id = " . self::WF . " AND node_type = 'code'");
        $copy = $this->publish()['robot_workflow_id'];
        $pdf = $this->db->query("SELECT config FROM workflow_nodes WHERE workflow_id = $copy AND node_type = 'code' ORDER BY id")->fetchColumn();
        $this->assertStringContainsString('"note":"é/x"', $pdf);
    }

    public function test_needs_servers_lists_missing_robot_servers(): void
    {
        $add = $this->db->prepare('INSERT INTO mcp_servers (user_id, name, url, enabled) VALUES (?, ?, ?, ?)');
        $add->execute([(string) $this->robot, 'outlook', 'http://o', 1]);      // matches "Outlook" by slug
        $add->execute([(string) $this->robot, 'SharePoint', 'http://s', 0]);   // disabled: still needed
        $add->execute([(string) self::OWNER, 'Converter', 'http://c', 1]);     // the publisher's, not the robot's
        $this->assertSame(['Converter', 'SharePoint'], $this->publish()['needs_servers']);
    }

    public function test_not_owner_404(): void
    {
        $e = $this->error(fn() => $this->publish(false, 1));
        $this->assertSame(['not_found', 404], [$e->kind, $e->status]);
        $this->assertSame(0, (int) $this->db->query("SELECT COUNT(*) FROM agent_workflows WHERE user_id = {$this->robot}")->fetchColumn());
        $this->assertSame(0, (int) $this->db->query("SELECT COUNT(*) FROM code_components WHERE user_id = {$this->robot}")->fetchColumn());
    }
}
