<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;

/**
 * LangGraph compiler, A2A mode: one self-contained A2A agent server per
 * agent/playbook node under agents/, one orchestrator.py driving them.
 */
class LangGraphA2AGeneratorTest extends TestCase
{
    public const PLAYBOOK = "Title: Time Off\n\nTrigger: PTO.\n\nInstructions:\n1. #Get PTO Balance for the requester.\n2. #Request Approval from the manager then #Resolve Request.\n\nTools used: Workday\n\nActions used: #Get PTO Balance; #Request Approval; #Resolve Request\n";

    public static function pdo(): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (85, '3', 'Workday', 'http://localhost/mockstack/index.php/workday', 1)");
        $pdo->exec("INSERT INTO mcp_servers VALUES (9, NULL, 'News', 'http://localhost/news/', 1)");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 85, 'get_pto_balance', 'Get balances', '{\"type\":\"object\",\"properties\":{\"email\":{\"type\":\"string\"}}}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (2, 9, 'get_news', 'News', '{}')");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)");
        return $pdo;
    }

    /** Dispatcher-demo shape: start -> dispatcher -> {IT claims, Human resources -> playbook} -> output. */
    public static function graph(): array
    {
        $agent = fn(string $name, string $type = 'standard', array $tools = []) => [
            'type' => 'agent-template', 'agent_name' => $name, 'agent_type' => $type,
            'instructions' => "You are {$name}.", 'agent_provider' => 'claude', 'model' => 'claude-sonnet-4-5',
            'tools' => $tools, 'settings' => ['temperature' => 0.7, 'max_tokens' => 4096],
        ];
        return [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'I want to take some vacations']],
                ['id' => '2', 'node_type' => '', 'config' => $agent('techBuddy', 'dispatcher')],
                ['id' => '3', 'node_type' => '', 'config' => $agent('IT claims', 'standard', ['mcp_get_news'])],
                ['id' => '4', 'node_type' => '', 'config' => $agent('Human resources')],
                ['id' => '5', 'node_type' => 'playbook', 'config' => ['type' => 'playbook', 'name' => 'Playbook HR',
                    'playbook' => self::PLAYBOOK, 'agent_provider' => 'deepseek', 'model' => 'deepseek-v4-flash', 'writes_enabled' => true]],
                ['id' => '6', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [
                ['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3'], ['from' => '2', 'to' => '4'],
                ['from' => '3', 'to' => '6'], ['from' => '4', 'to' => '5'], ['from' => '5', 'to' => '6'],
            ],
        ];
    }

    public static function generator(): LangGraphGenerator
    {
        $t = new self('x');
        $wfRepo = $t->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Dispatcher demo', 'user_id' => '3']));
        $graphRepo = $t->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn(self::graph());
        $agentRepo = $t->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        return new LangGraphGenerator(self::pdo(), $wfRepo, $graphRepo, $agentRepo);
    }

    /** Facts as analyzeForEmit() returns them (private): reached through reflection. */
    public static function facts(): array
    {
        $gen = self::generator();
        $m = new \ReflectionMethod($gen, 'analyzeForEmit');
        $m->setAccessible(true);
        return $m->invoke($gen, 44, '3');
    }

    public function testLayoutNamesOneAgentFilePerAgentOrPlaybookNode(): void
    {
        $layout = LangGraphGenerator::a2aLayout(self::facts());
        $this->assertSame('dispatcher_demo_a2a', $layout['root']);
        // PHP coerces canonical-decimal string keys ("2", "3", ...) to int on array
        // assignment, so array_keys() always returns ints here regardless of how
        // a2aLayout() builds the array; normalise before the strict comparison.
        $this->assertSame(['2', '3', '4', '5'], array_map('strval', array_keys($layout['agents'])), 'ORDER order, no start/output');
        $this->assertSame('agents/2_techbuddy.py', $layout['agents']['2']['file']);
        $this->assertSame('agents/4_human-resources.py', $layout['agents']['4']['file']);
        $this->assertSame('agents/5_playbook-hr.py', $layout['agents']['5']['file']);
        $this->assertSame([8701, 8702, 8703, 8704], array_column($layout['agents'], 'port'));
        $this->assertSame('dispatcher', $layout['agents']['2']['kind']);
        $this->assertSame('agent', $layout['agents']['3']['kind']);
        $this->assertSame('playbook', $layout['agents']['5']['kind']);
    }

    public function testSingleFileOutputUnchangedWithoutOption(): void
    {
        $code = self::generator()->generate(44, '3')['code'];
        $this->assertStringContainsString('"""Standalone LangGraph workflow: Dispatcher demo', $code);
        $this->assertStringContainsString('PLAYBOOKS = {', $code);
    }
}
