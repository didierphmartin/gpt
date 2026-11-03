<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Controllers\ActiveWorkflowController;
use AgentTeam\Controllers\WorkflowController;
use AgentTeam\Services\ActiveWorkflowService;
use AgentTeam\Services\WorkflowOwnerTransfer;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\SkillStoreController;
use Quantis\AIPortfolioAssistant\Services\PrivateSkillsRefused;
use Quantis\AIPortfolioAssistant\Services\RobotAccount;
use Quantis\AIPortfolioAssistant\Services\RobotOwnership;
use Quantis\AIPortfolioAssistant\Services\RobotSkillPolicy;
use Quantis\AIPortfolioAssistant\Services\SkillInUse;
use Quantis\AIPortfolioAssistant\Services\SkillStore;
use Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam\RobotSchema;

/** The corporate robot uses public skills only: private bindings are refused, bound public skills are pinned. */
final class RobotSkillPolicyTest extends TestCase
{
    private const WF = RobotSchema::WF;
    private const OWNER = RobotSchema::OWNER;

    private PDO $db;
    private int $robot;
    private string $root;

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/robotskills_' . bin2hex(random_bytes(6));
        mkdir($this->root);
        $this->db = new PDO('sqlite::memory:');
        RobotSchema::create($this->db);
        RobotSchema::agentsAndPlaybooks($this->db);
        $this->robot = RobotAccount::ensure($this->db);
        $this->db->exec("UPDATE users SET first_name = 'Olga', last_name = 'Ops' WHERE id = 2");
        // wf 75 binds the private skill "secret" (user 2's) and the public skill "shared"
        $node = $this->db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)');
        $node->execute([self::WF, 'agent', json_encode(['type' => 'agent', 'bound_skill' => ['dir_name' => 'tools/secret']])]);
        $node->execute([self::WF, 'agent', json_encode(['type' => 'agent', 'bound_skill' => ['dir_name' => 'shared']])]);
        $s = $this->store();
        $s->import(self::OWNER, 'tools/secret', $this->files('secret'), 'private');
        $s->import(self::OWNER, 'shared', $this->files('shared'), 'public');
    }

    protected function tearDown(): void
    {
        exec('rm -rf ' . escapeshellarg($this->root));
        unset($_ENV['SKILLS_DIR']);
    }

    private function files(string $name): array
    {
        return ['SKILL.md' => "---\nname: $name\ndescription: d\n---\nbody\n"];
    }

    private function store(string $edition = 'corporate'): SkillStore
    {
        return new SkillStore($this->root, $edition, fn(string $leaf) => $this->policy()->robotWorkflowsUsing($leaf));
    }

    private function policy(string $edition = 'corporate', ?SkillStore $store = null): RobotSkillPolicy
    {
        return new RobotSkillPolicy($this->db, ['edition' => $edition], $store ?? new SkillStore($this->root, $edition));
    }

    private function toRobot(): void
    {
        (new WorkflowOwnerTransfer($this->db, new RobotOwnership($this->db, ['edition' => 'corporate'])))->toRobot(self::OWNER, self::WF);
    }

    private function secret(): array
    {
        return [['path' => 'tools/secret', 'owner_id' => self::OWNER, 'owner_name' => 'Olga Ops']];
    }

    public function test_private_skills_listed_in_corporate(): void
    {
        $this->assertSame($this->secret(), $this->policy()->privateSkills(self::WF));
    }

    public function test_unknown_skill_is_listed_without_owner(): void
    {
        $this->db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)')
            ->execute([self::WF, 'agent', json_encode(['bound_skill' => ['dir_name' => 'ghost']])]);
        $this->assertContains(['path' => 'ghost', 'owner_id' => 0, 'owner_name' => '', 'missing' => true], $this->policy()->privateSkills(self::WF));
    }

    public function test_none_in_individual(): void
    {
        $this->assertSame([], $this->policy('individual')->privateSkills(self::WF));
    }

    public function test_none_in_folder_mode(): void
    {
        $p = new RobotSkillPolicy($this->db, ['edition' => 'corporate'], null);
        $this->assertSame([], $p->privateSkills(self::WF));
    }

    public function test_transfer_refused_with_private_skills(): void
    {
        $t = new WorkflowOwnerTransfer($this->db, new RobotOwnership($this->db, ['edition' => 'corporate']), $this->policy());
        foreach (['preview', 'toRobot'] as $method) {
            try {
                $t->$method(self::OWNER, self::WF);
                $this->fail('expected PrivateSkillsRefused');
            } catch (PrivateSkillsRefused $e) {
                $this->assertSame($this->secret(), $e->skills);
            }
        }
        $this->assertSame(self::OWNER, (int) $this->db->query('SELECT user_id FROM agent_workflows WHERE id = ' . self::WF)->fetchColumn());
    }

    public function test_refusal_shape(): void
    {
        $this->assertSame(['success' => false, 'code' => 'private_skills',
            'message' => 'This workflow uses private skills. The robot can only use public skills.',
            'error' => 'This workflow uses private skills. The robot can only use public skills.',
            'data' => ['skills' => $this->secret()], 'status_code' => 409], RobotSkillPolicy::refusal($this->secret()));
    }

    public function test_transfer_route_answers_409(): void
    {
        $_ENV['SKILLS_DIR'] = $this->root;
        $r = (new WorkflowController($this->db, ['edition' => 'corporate']))
            ->owner(['user_id' => self::OWNER, 'body' => ['owner' => 'robot', 'confirm' => true], 'params' => ['id' => self::WF]]);
        $this->assertSame(RobotSkillPolicy::refusal($this->secret()), $r);
    }

    public function test_activate_refused_with_private_skills(): void
    {
        $this->toRobot();
        $svc = new ActiveWorkflowService($this->db, $this->policy());
        $this->expectException(PrivateSkillsRefused::class);
        $svc->activate($this->robot, self::WF);
    }

    public function test_activate_route_answers_409_and_passes_once_public(): void
    {
        $this->toRobot();
        $_ENV['SKILLS_DIR'] = $this->root;
        $c = new ActiveWorkflowController($this->db, ['edition' => 'corporate']);
        $req = ['user_id' => self::OWNER, 'params' => ['id' => self::WF]];
        $this->assertSame(RobotSkillPolicy::refusal($this->secret()), $c->activate($req));
        $this->store()->setVisibility(self::OWNER, 'tools/secret', 'public');
        $this->assertNotSame(409, $c->activate($req)['status_code']);
    }

    public function test_robot_run_refused_with_private_skills(): void
    {
        $this->toRobot();
        $_ENV['SKILLS_DIR'] = $this->root;
        $r = (new WorkflowController($this->db, ['edition' => 'corporate']))
            ->run(['user_id' => self::OWNER, 'params' => ['id' => self::WF], 'body' => []]);
        $this->assertSame(RobotSkillPolicy::refusal($this->secret()), $r);
    }

    public function test_a_persons_own_workflow_is_not_checked_on_run(): void
    {
        $_ENV['SKILLS_DIR'] = $this->root;
        $r = (new WorkflowController($this->db, ['edition' => 'corporate']))
            ->run(['user_id' => self::OWNER, 'params' => ['id' => self::WF], 'body' => []]);
        $this->assertNotSame('private_skills', $r['code'] ?? null);
    }

    /** Task 13: compiling a corporate robot workflow that binds a private skill is refused, for every target. */
    public function test_robot_compile_refused_with_private_skills(): void
    {
        $this->toRobot();
        $_ENV['SKILLS_DIR'] = $this->root;
        $c = new WorkflowController($this->db, ['edition' => 'corporate']);
        $req = ['user_id' => self::OWNER, 'params' => ['id' => self::WF], 'query' => ['modular' => '1']];
        foreach (['generatePython', 'generateAdk', 'generateMaf', 'generateNooa'] as $route) {
            $this->assertSame(RobotSkillPolicy::refusal($this->secret()), $c->$route($req), $route);
        }
    }

    /** The tables and rows the compile path reads, and the two skill-bound nodes as agents between the Start and the Output. */
    private function compilable(): void
    {
        $this->db->exec('ALTER TABLE users ADD COLUMN storage_folder TEXT');   // the Start documents' store reads it
        $this->db->exec('CREATE TABLE IF NOT EXISTS mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT,
            description TEXT, input_schema TEXT)');
        foreach (['Outlook', 'Converter', 'SharePoint'] as $i => $name) {   // the code nodes' MCP servers
            $this->db->prepare('INSERT INTO mcp_servers (user_id, name, url) VALUES (?, ?, ?)')
                ->execute([self::OWNER, $name, 'http://127.0.0.1:' . (8770 + $i) . '/mcp']);
            $this->db->prepare("INSERT INTO mcp_server_tools (server_id, tool_name, description, input_schema) VALUES (?, 'ping', 'Ping', '{}')")
                ->execute([(int) $this->db->lastInsertId()]);
        }
        // The two skill-bound nodes become agents between the Start and the Output.
        $ids = fn(string $type) => $this->db->query("SELECT id FROM workflow_nodes WHERE workflow_id = 75 AND node_type = '$type' ORDER BY id")
            ->fetchAll(PDO::FETCH_COLUMN);
        $edge = $this->db->prepare("INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port) VALUES (75, ?, ?, 'output_1')");
        foreach ($ids('agent') as $i => $id) {
            $cfg = json_decode((string) $this->db->query("SELECT config FROM workflow_nodes WHERE id = $id")->fetchColumn(), true);
            $cfg = ['type' => 'agent-template', 'agent_name' => "Agent $i", 'agent_type' => 'standard', 'instructions' => 'x',
                'agent_provider' => 'claude', 'model' => 'claude-sonnet-4-5', 'tools' => []] + $cfg;
            $this->db->prepare('UPDATE workflow_nodes SET config = ? WHERE id = ?')->execute([json_encode($cfg), $id]);
            $edge->execute([$ids('start')[0], $id]);
            $edge->execute([$id, $ids('output')[0]]);
        }
    }

    /** Task 13: a robot workflow in the individual edition sees every skill, a user's private one included. */
    public function test_individual_robot_compile_reads_a_users_skill(): void
    {
        $this->compilable();
        $this->toRobot();
        $_ENV['SKILLS_DIR'] = $this->root;
        $r = (new WorkflowController($this->db, ['edition' => 'individual']))
            ->generateAdk(['user_id' => self::OWNER, 'params' => ['id' => self::WF], 'query' => ['modular' => '1']]);
        $this->assertTrue($r['success'], $r['error'] ?? '');
        $this->assertContains('skills/tools/secret/SKILL.md', array_column($r['data']['files'], 'path'));   // user 2's private area
    }

    /** Task 13: in the Docker app a compile reads each skill from the store, with the workflow owner's visibility. */
    public function test_compile_reads_skills_from_the_store(): void
    {
        $this->compilable();
        $_ENV['SKILLS_DIR'] = $this->root;
        $c = new WorkflowController($this->db, ['edition' => 'corporate']);
        $req = ['user_id' => self::OWNER, 'params' => ['id' => self::WF], 'query' => ['modular' => '1']];
        foreach (['generatePython', 'generateAdk'] as $route) {
            $r = $c->$route($req);
            $this->assertTrue($r['success'], $route . ': ' . ($r['error'] ?? ''));
            $paths = array_column($r['data']['files'], 'path');
            $this->assertContains('skills/tools/secret/SKILL.md', $paths, $route);   // the owner's private skill
            $this->assertContains('skills/shared/SKILL.md', $paths, $route);          // a public one
        }
    }

    public function test_robot_workflows_using_matches_the_leaf(): void
    {
        $this->assertSame([], $this->policy()->robotWorkflowsUsing('shared'));   // wf 75 is still the owner's
        $this->toRobot();
        $this->assertSame([['id' => self::WF, 'name' => 'Mail to PDF']], $this->policy()->robotWorkflowsUsing('shared'));
        $this->assertSame([], $this->policy()->robotWorkflowsUsing('other'));
    }

    public function test_make_private_refused_when_robot_workflow_binds_it(): void
    {
        $this->toRobot();
        try {
            $this->store()->setVisibility(self::OWNER, 'shared', 'private');
            $this->fail('expected SkillInUse');
        } catch (SkillInUse $e) {
            $this->assertSame([['id' => self::WF, 'name' => 'Mail to PDF']], $e->workflows());
            $this->assertSame(409, $e->statusCode());
        }
        $this->assertDirectoryExists("{$this->root}/public/shared");
        $this->assertDirectoryDoesNotExist("{$this->root}/users/" . self::OWNER . '/shared');
    }

    public function test_delete_refused_when_robot_workflow_binds_it(): void
    {
        $this->toRobot();
        $_ENV['SKILLS_DIR'] = $this->root;
        $c = new SkillStoreController($this->db, ['edition' => 'corporate']);
        $r = $c->delete(['user_id' => self::OWNER, 'query' => ['path' => 'shared']]);
        $this->assertSame([409, [['id' => self::WF, 'name' => 'Mail to PDF']]], [$r['status_code'], $r['data']['robot_workflows']]);
        $this->assertDirectoryExists("{$this->root}/public/shared");
        $r = $c->visibility(['user_id' => self::OWNER, 'body' => ['path' => 'shared', 'visibility' => 'private']]);
        $this->assertSame([409, 'Mail to PDF'], [$r['status_code'], $r['data']['robot_workflows'][0]['name']]);
    }

    public function test_rename_refused_but_regroup_allowed(): void
    {
        $this->toRobot();
        $s = $this->store();
        $s->move(self::OWNER, 'shared', 'grp/shared');   // same leaf: still found by the robot
        $this->expectException(SkillInUse::class);
        $s->move(self::OWNER, 'grp/shared', 'grp/renamed');
    }

    public function test_unbound_skills_are_free(): void
    {
        $this->toRobot();
        $s = $this->store();
        $s->import(self::OWNER, 'free', $this->files('free'), 'public');
        $s->setVisibility(self::OWNER, 'free', 'private');
        $this->assertDirectoryExists("{$this->root}/users/" . self::OWNER . '/free');
        $s->delete(self::OWNER, 'free');
        $this->assertDirectoryDoesNotExist("{$this->root}/users/" . self::OWNER . '/free');
    }

    public function test_bound_skill_stays_free_in_individual(): void
    {
        $this->toRobot();
        $root = $this->root . '_ind';
        mkdir($root);
        $s = new SkillStore($root, 'individual', fn(string $leaf) => $this->policy()->robotWorkflowsUsing($leaf));
        $s->import(self::OWNER, 'shared', $this->files('shared'));
        $s->setVisibility(self::OWNER, 'shared', 'private');   // no public area; and no pin on a bound skill
        $s->delete(self::OWNER, 'shared');
        $this->assertSame([], $s->list(self::OWNER));
        exec('rm -rf ' . escapeshellarg($root));
    }

    public function test_scheduled_robot_run_refused_and_runner_not_invoked(): void
    {
        $this->toRobot();
        $wf = $this->createMock(\AgentTeam\Services\WorkflowRepository::class);
        $workflow = $this->createMock(\AgentTeam\Models\Workflow::class);
        $workflow->method('isEnabled')->willReturn(true);
        $wf->method('findById')->willReturn($workflow);
        $graph = $this->createMock(\AgentTeam\Services\GraphWorkflowRunner::class);
        $graph->expects($this->never())->method('run');
        $linear = $this->createMock(\AgentTeam\Services\WorkflowRunner::class);
        $linear->expects($this->never())->method('run');
        $run = \AgentTeam\Services\ScheduleTick::workflowRunner($wf, null, $graph, $linear, $this->policy());
        $r = $run(['workflow_id' => self::WF, 'user_id' => $this->robot]);
        $this->assertSame([false, 'private_skills', $this->secret()], [$r['success'], $r['code'], $r['skills']]);
    }
}
