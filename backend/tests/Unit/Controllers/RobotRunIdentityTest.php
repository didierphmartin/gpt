<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use AgentTeam\Controllers\CodeNodeController;
use AgentTeam\Controllers\ScheduledWorkflowController;
use AgentTeam\Controllers\WorkflowController;
use AgentTeam\Services\GraphWorkflowRunner;
use PDO;
use PHPUnit\Framework\TestCase;
use AgentTeam\Services\PlaybookNodeRunner;
use Quantis\AIPortfolioAssistant\Controllers\ChatController;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;
use Quantis\AIPortfolioAssistant\Services\RobotAccount;
use Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam\RobotSchema;

/** Every run of a robot workflow is the robot's: its servers, its executions, its schedule rows. */
final class RobotRunIdentityTest extends TestCase
{
    private const CONFIG = ['edition' => 'corporate'];
    private PDO $db;
    private int $robot;
    private array $ids;
    private int $baseLevel;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->ids = RobotSchema::create($this->db);
        $have = array_column($this->db->query('PRAGMA table_info(agent_workflows)')->fetchAll(), 'name');
        foreach (['description' => 'TEXT', 'steps' => 'TEXT', 'triggers' => 'TEXT', 'variables' => 'TEXT', 'enabled' => 'INTEGER DEFAULT 1',
                  'workspace_id' => 'INTEGER', 'output_storage_enabled' => 'INTEGER DEFAULT 0', 'output_folder' => 'TEXT', 'orchestration' => 'TEXT'] as $c => $t) {
            if (!in_array($c, $have, true)) {
                $this->db->exec("ALTER TABLE agent_workflows ADD COLUMN $c $t");
            }
        }
        // user 3 may use the robot; user 1 may not
        $this->db->exec("UPDATE users SET role = 'ops' WHERE id = 3");
        $this->db->exec("INSERT INTO users (id, email, role) VALUES (119, 'filler@x.test', 'user')");
        $this->robot = RobotAccount::ensure($this->db);
        $this->db->exec("UPDATE agent_workflows SET user_id = {$this->robot} WHERE id = 75");
        $this->db->exec("DROP TABLE mcp_servers");   // MySQL keeps user_id as text
        $this->db->exec("CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, headers TEXT, transport TEXT, enabled INTEGER)");
        $this->db->exec("CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, tool_description TEXT, input_schema TEXT, has_ui INTEGER, ui_resource_uri TEXT)");
        $this->db->exec("INSERT INTO mcp_servers VALUES (5, '3', 'Outlook', 'http://mcp.test/u3-outlook', '{\"Authorization\":\"Bearer u3\"}', 'http', 1)");
        $this->db->exec("INSERT INTO mcp_servers VALUES (6, '3', 'Converter', 'http://mcp.test/u3-conv', NULL, 'http', 1)");
        $this->db->exec("INSERT INTO mcp_servers VALUES (7, '{$this->robot}', 'Outlook', 'http://mcp.test/robot-outlook', '{\"Authorization\":\"Bearer robot\"}', 'http', 1)");
        $this->db->exec("INSERT INTO mcp_server_tools (server_id, tool_name) VALUES (5, 'list_mail'), (6, 'convert'), (7, 'list_mail')");
        $this->db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, 3, 'Mine')");
        $this->baseLevel = ob_get_level();
    }

    public function test_robot_is_user_120(): void
    {
        $this->assertSame(120, $this->robot);
    }

    private function codeNode(array &$seen): CodeNodeController
    {
        return new CodeNodeController($this->db, self::CONFIG, function (int $userId) use (&$seen): \Closure {
            $seen[] = (string) $userId;   // what MCPToolsLoader::loadToolsForUser receives
            return fn(string $server, string $tool, array $args): array => ['ok' => true, 'result' => []];
        });
    }

    public function test_code_node_tool_call_of_a_robot_workflow_loads_the_robots_servers(): void
    {
        $seen = [];
        $body = ['server' => 'outlook', 'tool' => 'list_mail', 'args' => []];
        $this->codeNode($seen)->toolCall(['user_id' => 3, 'body' => $body + ['workflow_id' => 75]]);
        $this->codeNode($seen)->toolCall(['user_id' => 3, 'body' => $body]);
        $this->assertSame(['120', '3'], $seen);
    }

    public function test_code_node_tool_call_never_escalates(): void
    {
        $seen = [];
        $body = ['server' => 'outlook', 'tool' => 'list_mail', 'args' => []];
        // user 1 may not use the robot; wf 9 is a personal workflow
        $this->codeNode($seen)->toolCall(['user_id' => 1, 'body' => $body + ['workflow_id' => 75]]);
        $this->codeNode($seen)->toolCall(['user_id' => 3, 'body' => $body + ['workflow_id' => 9]]);
        $this->assertSame(['1', '3'], $seen);
    }

    /** /chat with the MCP loader recorded: the user whose servers it loads, and the answer. */
    private function chat(int $userId, array $body, array &$loaded): array
    {
        $c = new RunIdentityChat($this->db, self::CONFIG + ['database' => []]);
        $c->loaded = &$loaded;
        $log = ini_set('error_log', '/dev/null');   // the chat path logs freely
        try {
            return $c->chat(['user_id' => $userId, 'body' => $body + ['message' => 'hi', 'streaming' => false, 'memory' => false]]);
        } catch (\Throwable $e) {
            return ['thrown' => $e->getMessage()];   // past the MCP load, the provider (none here) may fail
        } finally {
            ini_set('error_log', (string) $log);
        }
    }

    public function test_chat_of_a_robot_workflows_node_loads_the_robots_servers(): void
    {
        $tools = ['tools' => ['mcp_list_mail']];
        foreach ([[3, ['workflow_id' => 75], '120'], [3, [], '3'], [1, ['workflow_id' => 75], '1'], [3, ['workflow_id' => 9], '3']] as [$u, $extra, $want]) {
            $loaded = [];
            $this->chat($u, $tools + $extra, $loaded);
            $this->assertSame([$want], $loaded, "user $u " . json_encode($extra));
        }
    }

    public function test_chat_refuses_a_tool_whose_server_the_robot_lacks(): void
    {
        $loaded = [];
        $r = $this->chat(3, ['tools' => ['mcp_convert'], 'workflow_id' => 75], $loaded);
        $this->assertSame([false, 422, 'robot_server_missing', 'Converter'],
            [$r['success'] ?? null, $r['status_code'] ?? null, $r['error_code'] ?? null, $r['server'] ?? null]);
        $this->assertSame([], $loaded);
    }

    public function test_playbook_node_of_a_robot_workflow_takes_the_robots_tools(): void
    {
        foreach ([[3, ['workflow_id' => 75], 120], [3, [], 3], [1, ['workflow_id' => 75], 1], [3, ['workflow_id' => 9], 3]] as [$u, $extra, $want]) {
            $wf = new RunIdentityWorkflows($this->db, self::CONFIG);
            ob_start();
            ob_start();   // runPlaybookNode closes one buffer level
            $wf->runPlaybookNode(['user_id' => $u, 'body' => ['node_config' => ['playbook' => "Title: T\nInstructions: Do #Leave Internal Note."], 'prompt' => 'go'] + $extra]);
            while (ob_get_level() > $this->baseLevel) {
                ob_end_clean();
            }
            $this->assertSame([$want], $wf->mcpUsers, "user $u " . json_encode($extra));
        }
    }

    public function test_schedule_of_a_robot_workflow_is_the_robots(): void
    {
        $this->db->exec("UPDATE code_components SET user_id = {$this->robot}");
        $sc = new ScheduledWorkflowController($this->db, self::CONFIG);
        $r = $sc->create(['user_id' => 3, 'body' => ['workflow_id' => 75, 'scheduled_time' => '2026-11-01 10:00:00',
            'trigger_component_id' => $this->ids['Poll Drop']]]);
        $this->assertTrue($r['success'], json_encode($r));
        $this->assertSame(120, (int) $r['data']['user_id']);
        $this->assertSame($this->ids['Poll Drop'], (int) $r['data']['trigger_component_id']);

        $u = $sc->update(['user_id' => 3, 'params' => ['id' => (int) $r['data']['id']], 'body' => ['input_prompt' => 'go']]);
        $this->assertTrue($u['success'], json_encode($u));
        $this->assertSame(120, (int) $u['data']['user_id']);

        // not robot-permitted: the robot workflow is not found
        $this->assertSame(404, $sc->create(['user_id' => 1, 'body' => ['workflow_id' => 75, 'scheduled_time' => '2026-11-01 10:00:00']])['status_code']);
    }

    public function test_run_executes_as_the_robot(): void
    {
        $runner = $this->createMock(GraphWorkflowRunner::class);
        $runner->expects($this->once())->method('run')->with($this->anything(), 120)->willReturn(['success' => true]);
        $wf = new WorkflowController($this->db, self::CONFIG);
        (new \ReflectionProperty(WorkflowController::class, 'graphWorkflowRunner'))->setValue($wf, $runner);
        $r = $wf->run(['user_id' => 3, 'params' => ['id' => 75], 'body' => []]);
        $this->assertTrue($r['success'], json_encode($r));
    }

    public function test_run_by_name_finds_robot_workflows_and_the_callers_own_wins(): void
    {
        $wf = new WorkflowController($this->db, self::CONFIG);
        $this->db->exec("UPDATE agent_workflows SET orchestration = 'swarm' WHERE id = 75");
        $byName = fn(int $u) => $wf->runByName(['user_id' => $u, 'body' => ['workflow' => 'Mail to PDF']]);
        $this->assertStringContainsString('swarm', $byName(3)['error']);   // the robot's, found by name
        $this->assertSame(404, $byName(1)['status_code']);                  // not robot-permitted
        $this->db->exec("UPDATE agent_workflows SET name = 'Mail to PDF', enabled = 0 WHERE id = 9");
        $this->assertSame('Workflow is disabled', $byName(3)['error']);     // the caller's own wins
    }
}

/** ChatController with the MCP loader recorded (no MCP server is reached). */
class RunIdentityChat extends ChatController
{
    public array $loaded = [];

    protected function newMcpToolsLoader(): MCPToolsLoader
    {
        $loaded = &$this->loaded;
        return new class($loaded) extends MCPToolsLoader {
            public function __construct(private array &$loaded) {}
            public function loadToolsForUser(?string $userId = null, ?array $allowedServerNames = null): array
            {
                $this->loaded[] = $userId;
                return [];
            }
        };
    }
}

/** WorkflowController whose playbook node runner records the MCP user and stops there (no LLM, no contexts DB). */
class RunIdentityWorkflows extends WorkflowController
{
    public array $mcpUsers = [];

    protected function playbookNodeRunner(): PlaybookNodeRunner
    {
        return new PlaybookNodeRunner([],
            llmFactory: fn(array $cfg) => fn() => ['text' => '', 'tool_calls' => []],
            mcpFactory: function (PDO $pdo, int $userId): never {
                $this->mcpUsers[] = $userId;
                throw new \RuntimeException('stop');
            },
            pdoFactory: fn() => new PDO('sqlite::memory:'));
    }
}
