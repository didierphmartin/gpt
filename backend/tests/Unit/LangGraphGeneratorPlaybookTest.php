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
 * LangGraph compiler: playbook nodes and dispatcher agents.
 *
 * - A playbook node compiles to a PLAYBOOKS entry whose #Actions are bound
 *   against the user's MCP registry at generation time (mirrors the browser
 *   runner's PlaybookAnalyzer binding) and runs through the emitted playbook
 *   runtime (native verbs, gates, write policy, transcript output).
 * - A dispatcher agent's fan-out is a MENU: the agent gets route_to over its
 *   children and the graph wires a conditional edge, so exactly one child runs.
 */
class LangGraphGeneratorPlaybookTest extends TestCase
{
    private const PLAYBOOK = <<<'TXT'
Title: Time Off & Leave

Trigger: Requester asks for PTO.

Instructions:
1. #Get PTO Balance for the requester.
2. #Request Approval from the manager.
3. On approval: #Submit Time Off with the dates. #Frobnicate the record.
4. #Leave Internal Note then #Resolve Request.

Tools used: Workday

Actions used: #Get PTO Balance; #Request Approval; #Submit Time Off; #Frobnicate; #Leave Internal Note; #Resolve Request
TXT;

    private function pdo(): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (85, '3', 'Workday', 'http://localhost/mockstack/index.php/workday', 1)");
        $pdo->exec("INSERT INTO mcp_servers VALUES (9, NULL, 'Global News', 'http://localhost/news/', 1)");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 85, 'get_pto_balance', 'Get balances', '{\"type\":\"object\",\"properties\":{\"email\":{\"type\":\"string\"}},\"required\":[\"email\"]}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (2, 85, 'submit_time_off', 'Submit', '{\"type\":\"object\",\"properties\":{\"start\":{\"type\":\"string\"}}}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (3, 9, 'get_news', 'News', '{}')");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('deepseek', 'deepseek-v4-flash', 1)");
        return $pdo;
    }

    private function generate(array $graph, ?string $userId = '3'): string
    {
        $pdo = $this->pdo();
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Dispatcher demo', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph);
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        $gen = new LangGraphGenerator($pdo, $wfRepo, $graphRepo, $agentRepo);
        return $gen->generate(44, $userId)['code'];
    }

    private function playbookGraph(): array
    {
        return [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'I want to take some vacations']],
                ['id' => '2', 'node_type' => 'playbook', 'config' => [
                    'type' => 'playbook', 'name' => 'Playbook HR', 'playbook' => self::PLAYBOOK,
                    'agent_provider' => 'deepseek', 'model' => 'deepseek-v4-flash', 'writes_enabled' => true,
                ]],
                ['id' => '3', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3']],
        ];
    }

    private function dispatcherGraph(): array
    {
        $agent = fn(string $name, string $type = 'standard') => [
            'type' => 'agent-template', 'agent_name' => $name, 'agent_type' => $type,
            'instructions' => "You are {$name}.", 'agent_provider' => 'claude', 'tools' => [],
        ];
        return [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'node_type' => '', 'config' => $agent('techBuddy', 'dispatcher')],
                ['id' => '3', 'node_type' => '', 'config' => $agent('IT claims')],
                ['id' => '4', 'node_type' => '', 'config' => $agent('Human resources')],
                ['id' => '5', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [
                ['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3'], ['from' => '2', 'to' => '4'],
                ['from' => '3', 'to' => '5'], ['from' => '4', 'to' => '5'],
            ],
        ];
    }

    public function testPlaybookNodeBindsActionsAgainstUserRegistry(): void
    {
        $code = $this->generate($this->playbookGraph());
        $this->assertStringContainsString('PLAYBOOKS = {', $code);
        $this->assertStringContainsString('"2": "playbook"', $code, 'NODE_TYPES carries the playbook type');
        // Bound MCP actions keep the runtime's llm tool naming (server__tool).
        $this->assertStringContainsString('"workday__get_pto_balance"', $code);
        $this->assertStringContainsString('"workday__submit_time_off"', $code);
        $this->assertStringContainsString('"action_name": "#Get PTO Balance"', $code);
        // Unbound action becomes a stub the model can call (on_unbound policy).
        $this->assertStringContainsString('"unbound__frobnicate"', $code);
        // Native verbs are not baked as MCP actions.
        $this->assertStringNotContainsString('"#Request Approval"', $code);
        // Node settings.
        $this->assertStringContainsString('"provider": "deepseek"', $code);
        $this->assertStringContainsString('"model": "deepseek-v4-flash"', $code);
        $this->assertStringContainsString('"writes_enabled": True', $code);
        $this->assertStringContainsString('"display": "Playbook HR"', $code);
        // Title and the instructions travel verbatim.
        $this->assertStringContainsString('"title": "Time Off & Leave"', $code);
        $this->assertStringContainsString('1. #Get PTO Balance for the requester.', $code);
        // The user's own MCP server is baked into the registry (not only global ones).
        $this->assertStringContainsString('http://localhost/mockstack/index.php/workday', $code);
    }

    public function testPlaybookRuntimeEmitted(): void
    {
        $code = $this->generate($this->playbookGraph());
        foreach (['def build_playbook_tools', 'def render_playbook_transcript', 'def _playbook_gate',
                  'elif ntype == "playbook":', 'PLAYBOOK_SYSTEM_PROMPT', 'writes disabled by policy',
                  '"resolve_request"', '"request_approval"', '"prompt_handoff"'] as $needle) {
            $this->assertStringContainsString($needle, $code, "missing: {$needle}");
        }
        // Playbook nodes get their own LLM like agents do.
        $this->assertStringContainsString('for nid, ad in {**AGENTS, **PLAYBOOKS}.items()', $code);
    }

    public function testPlaybookRuntimeOmittedWithoutPlaybookNodes(): void
    {
        $code = $this->generate($this->dispatcherGraph());
        $this->assertStringContainsString('PLAYBOOKS = {}', $code);
        $this->assertStringNotContainsString('def build_playbook_tools', $code);
    }

    public function testDispatcherAgentGetsRouteMenuAndConditionalEdge(): void
    {
        $code = $this->generate($this->dispatcherGraph());
        $this->assertStringContainsString('"dispatch": [{"id": "3", "name": "IT claims"}, {"id": "4", "name": "Human resources"}]', $code);
        $this->assertStringContainsString('## Routing', $code, 'dispatcher prompt carries the routing block');
        $this->assertStringContainsString('  - IT claims', $code);
        $this->assertStringContainsString('## Routed request', $code, 'children carry the routed-to fragment');
        $this->assertSame(2, substr_count($code, '## Routed request'), 'both menu children are routed-to');
        $this->assertStringContainsString('The dispatcher "techBuddy" reviewed this request', $code);
        $this->assertStringContainsString('add_conditional_edges', $code);
        $this->assertStringContainsString('"route_to"', $code);
        $this->assertStringContainsString('routes: Annotated[dict[str, str], _merge]', $code);
    }

    public function testNonDispatcherAgentHasNoDispatchEntry(): void
    {
        $code = $this->generate($this->dispatcherGraph());
        $this->assertSame(1, substr_count($code, '"dispatch": ['), 'only the dispatcher carries a menu');
    }

    public function testEmittedScriptIsValidPython(): void
    {
        foreach ([$this->playbookGraph(), $this->dispatcherGraph()] as $graph) {
            $code = $this->generate($graph);
            $tmp = tempnam(sys_get_temp_dir(), 'lg') . '.py';
            file_put_contents($tmp, $code);
            exec('python3 -m py_compile ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
            @unlink($tmp);
            $this->assertSame(0, $rc, implode("\n", $out));
        }
    }
}
