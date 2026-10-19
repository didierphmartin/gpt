<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Models\Workflow;
use AgentTeam\Services\ADKGenerator;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\MAFGenerator;
use AgentTeam\Services\NOOAGenerator;
use Quantis\AIPortfolioAssistant\Tests\Unit\Playbook\PlaybookStoreTest;
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
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('deepseek', 'deepseek-flash', 1)");
        return $pdo;
    }

    private function generate(array $graph, ?string $userId = '3', ?\PDO $pdo = null, string $target = 'langgraph', array $options = []): string
    {
        $pdo ??= $this->pdo();
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Dispatcher demo', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph);
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        if ($target !== 'langgraph') {
            $class = ['adk' => ADKGenerator::class, 'maf' => MAFGenerator::class, 'nooa' => NOOAGenerator::class][$target];
            return (new $class($pdo, $wfRepo, $graphRepo, $agentRepo))->generate(44, $userId)['code'];
        }
        $gen = new LangGraphGenerator($pdo, $wfRepo, $graphRepo, $agentRepo);
        $res = $gen->generate(44, $userId, $options);
        return $res['code'] ?? implode("\n", array_map(fn($f) => "### {$f['path']}\n" . $f['code'], $res['files']));
    }

    /** The test pdo plus a robot (users.kind = 'service') owning the published playbook "test", and a draft "draft" of user 3. */
    private function robotPdo(): \PDO
    {
        $pdo = $this->pdo();
        PlaybookStoreTest::schema($pdo);
        $pdo->exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT)");
        $pdo->exec("INSERT INTO users (id, kind) VALUES (3, 'user'), (7, 'service')");
        $ins = $pdo->prepare('INSERT INTO playbooks (user_id, pkey, title, text) VALUES (?, ?, ?, ?)');
        $ins->execute([7, 'test', 'Time Off & Leave', self::PLAYBOOK]);
        $ins->execute([3, 'draft', 'Draft only', "Title: Draft only\n\nInstructions:\n1. #Resolve Request.\n"]);
        return $pdo;
    }

    /** Start -> Playbook (from input, exits done/failed) -> Done (output_1) / Failed (output_2). */
    private function fromInputGraph(): array
    {
        return [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => '{"playbook":"test"}']],
                ['id' => '2', 'node_type' => 'playbook', 'config' => [
                    'type' => 'playbook', 'name' => 'Run job playbook', 'playbook_source' => 'input',
                    'playbook_input_field' => 'playbook', 'exits' => ['done', 'failed'],
                    'agent_provider' => 'deepseek', 'model' => 'deepseek-flash', 'writes_enabled' => true,
                ]],
                ['id' => '3', 'node_type' => 'output', 'config' => ['type' => 'output']],
                ['id' => '4', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3', 'from_port' => 'output_1'],
                        ['from' => '2', 'to' => '4', 'from_port' => 'output_2']],
        ];
    }

    private static function pyCompiles(string $code): array
    {
        $tmp = tempnam(sys_get_temp_dir(), 'lg') . '.py';
        file_put_contents($tmp, $code);
        exec('python3 -m py_compile ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
        @unlink($tmp);
        return [$rc, implode("\n", $out)];
    }

    public function testFromInputBakesPublishedPlaybooks(): void
    {
        $code = $this->generate($this->fromInputGraph(), '3', $this->robotPdo());
        $this->assertStringContainsString('PUBLISHED_PLAYBOOKS = {', $code);
        $this->assertStringContainsString('    "test": {', $code);
        $this->assertStringNotContainsString('"draft"', $code, 'only the robot\'s published copies are baked');
        // The published copy is bound against the registry like a fixed playbook.
        $this->assertStringContainsString('"workday__get_pto_balance"', $code);
        $this->assertStringContainsString('http://localhost/mockstack/index.php/workday', $code);
        // The node: from input, its exits and their children.
        $this->assertStringContainsString('"source": "input",', $code);
        $this->assertStringContainsString('"input_field": "playbook",', $code);
        $this->assertStringContainsString('"published": PUBLISHED_PLAYBOOKS,', $code);
        $this->assertStringContainsString('"exits": ["done","failed"],', $code);
        $this->assertStringContainsString('"exit_targets": {"done":["3"],"failed":["4"]},', $code);
        $this->assertLessThan(strpos($code, 'PLAYBOOKS = {' . "\n" . '    # '), strpos($code, 'PUBLISHED_PLAYBOOKS = {'));
        // A --watch run is unattended (per run, not process-wide) unless PLAYBOOK_GATE_MODE says otherwise.
        $this->assertStringContainsString('loop_mode=mode != "once", unattended=mode == "watch")', $code);
        $this->assertStringContainsString('            graph.unattended = unattended', $code);
        $this->assertStringNotContainsString('os.environ["PLAYBOOK_GATE_MODE"] =', $code);
        [$rc, $out] = self::pyCompiles($code);
        $this->assertSame(0, $rc, $out);
    }

    public function testUnbakeablePublishedPlaybookIsAWarning(): void
    {
        $pdo = $this->robotPdo();
        $pdo->prepare('INSERT INTO playbooks (user_id, pkey, title, text) VALUES (?, ?, ?, ?)')
            ->execute([7, 'broken', 'Broken', '']);
        $code = $this->generate($this->fromInputGraph(), '3', $pdo);
        $this->assertMatchesRegularExpression('~^# WARNING: published playbook "broken" not baked: [^\n]+$~m', $code);
        $this->assertStringContainsString('    "test": {', $code);
        [$rc, $out] = self::pyCompiles($code);
        $this->assertSame(0, $rc, $out);
    }

    public function testModularListenRunsAreUnattendedPerRun(): void
    {
        $code = $this->generate($this->fromInputGraph(), '3', $this->robotPdo(), 'langgraph', ['modular' => true]);
        $this->assertStringContainsString('run_once = make_run_once(DEFAULT_PROMPT or "Hello", runs, view, recorder, loop_mode=True, unattended=True)', $code);
        $this->assertStringContainsString('loop_mode=mode != "once", unattended=mode == "watch")', $code);
        $this->assertStringNotContainsString('os.environ["PLAYBOOK_GATE_MODE"] =', $code);
    }

    /** A fixed playbook with exits; $failedWired adds an edge leaving its failed port (output_2). */
    private function fixedExitsGraph(bool $failedWired): array
    {
        $g = $this->playbookGraph();
        $g['nodes'][1]['config']['exits'] = ['done', 'failed'];
        $g['edges'][1]['from_port'] = 'output_1';
        if ($failedWired) {
            $g['nodes'][] = ['id' => '4', 'node_type' => 'output', 'config' => ['type' => 'output']];
            $g['edges'][] = ['from' => '2', 'to' => '4', 'from_port' => 'output_2'];
        }
        return $g;
    }

    public function testWiredFailedExitRefusedOnOtherTargets(): void
    {
        foreach (['adk', 'maf', 'nooa'] as $target) {
            try {
                $this->generate($this->fixedExitsGraph(true), '3', null, $target);
                $this->fail("{$target} compiled a wired failed exit");
            } catch (\RuntimeException $e) {
                $this->assertSame('Playbook node "Playbook HR": the "failed" exit is supported by the LangGraph target only.',
                    $e->getMessage(), $target);
            }
            // Only "done" wired: compiles as before.
            $this->assertNotSame('', $this->generate($this->fixedExitsGraph(false), '3', null, $target), $target);
        }
        // LangGraph routes it.
        $this->assertStringContainsString('"exit_targets": {"done":["3"],"failed":["4"]},', $this->generate($this->fixedExitsGraph(true)));
    }

    public function testFromInputWithoutRobotBakesAnEmptyDict(): void
    {
        $pdo = $this->robotPdo();
        $pdo->exec("DELETE FROM users WHERE kind = 'service'");
        $code = $this->generate($this->fromInputGraph(), '3', $pdo);
        $this->assertStringContainsString('PUBLISHED_PLAYBOOKS = {}', $code);
        [$rc, $out] = self::pyCompiles($code);
        $this->assertSame(0, $rc, $out);
    }

    public function testPublishedPlaybooksOmittedWithoutFromInputNodes(): void
    {
        $code = $this->generate($this->playbookGraph());
        $this->assertStringNotContainsString('PUBLISHED_PLAYBOOKS = ', $code);
        $this->assertStringNotContainsString('"exit_targets": {', $code);
    }

    public function testFromInputModularModuleBakesPublishedPlaybooks(): void
    {
        $code = $this->generate($this->fromInputGraph(), '3', $this->robotPdo(), 'langgraph', ['modular' => true]);
        $this->assertMatchesRegularExpression('~PUBLISHED_PLAYBOOKS = \{\n    "test": \{.*?\nNODE = \{.*?"published": PUBLISHED_PLAYBOOKS,~s', $code);
    }

    public function testFromInputRefusedOnA2A(): void
    {
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('A2A');
        $this->generate($this->fromInputGraph(), '3', $this->robotPdo(), 'langgraph', ['a2a' => true]);
    }

    public function testFromInputRefusedOnOtherTargets(): void
    {
        foreach (['adk', 'maf', 'nooa'] as $target) {
            try {
                $this->generate($this->fromInputGraph(), '3', $this->robotPdo(), $target);
                $this->fail("{$target} compiled a from-input playbook node");
            } catch (\RuntimeException $e) {
                $this->assertSame('Playbook node "Run job playbook": "from input" is supported by the LangGraph target only.',
                    $e->getMessage(), $target);
            }
        }
    }

    private function playbookGraph(): array
    {
        return [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'I want to take some vacations']],
                ['id' => '2', 'node_type' => 'playbook', 'config' => [
                    'type' => 'playbook', 'name' => 'Playbook HR', 'playbook' => self::PLAYBOOK,
                    'agent_provider' => 'deepseek', 'model' => 'deepseek-flash', 'writes_enabled' => true,
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
        $this->assertStringContainsString('"model": "deepseek-flash"', $code);
        // deepseek-flash (the renamed deepseek-v4-flash) keeps the V4 thinking rules.
        $this->assertStringContainsString('if model.startswith(("deepseek-v4", "deepseek-flash")):', $code);
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
        foreach (['class PlaybookToolset:', '    def transcript(self, title: str, final: str) -> str:', '    def gate(self',
                  'case NodeKind.PLAYBOOK:', 'PLAYBOOK_SYSTEM_PROMPT', 'writes disabled by policy',
                  '"resolve_request"', '"request_approval"', '"prompt_handoff"'] as $needle) {
            $this->assertStringContainsString($needle, $code, "missing: {$needle}");
        }
        // Playbook nodes get their own Node (and so their own LLM) like agents do.
        $this->assertStringContainsString('NODES = {nid: make_node(cfg) for nid, cfg in {**AGENTS, **PLAYBOOKS, **CODE_NODES}.items()}', $code);
    }

    public function testPlaybookRuntimeOmittedWithoutPlaybookNodes(): void
    {
        $code = $this->generate($this->dispatcherGraph());
        $this->assertStringContainsString('PLAYBOOKS = {}', $code);
        $this->assertStringNotContainsString('class PlaybookToolset:', $code);
    }

    public function testDispatcherAgentGetsRouteMenuAndConditionalEdge(): void
    {
        $code = $this->generate($this->dispatcherGraph());
        $this->assertStringContainsString('"dispatch": [{"id": "3", "name": "IT claims", "description": ""}, {"id": "4", "name": "Human resources", "description": ""}]', $code);
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
        $this->assertSame(1, substr_count($code, '"dispatch": [{'), 'only the dispatcher carries a menu');
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
