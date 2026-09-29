<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\DispatchRouting;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;

/**
 * LangGraph compiler: a dispatcher asks TypeSafe's Jev before spending an LLM
 * turn, the same way GraphWorkflowRunner does (JevRouter + "Dispatcher, fast
 * path"). Checked in every LangGraph mode that runs a dispatcher (single
 * script, modular package, A2A agent server), and the emitted runtime itself is
 * exercised by tests/fixtures/jev_dispatch_harness.py with a fake HTTP layer.
 */
class LangGraphJevDispatchTest extends TestCase
{
    private const BLOCK_START = '# TypeSafe Jev (twin of JevRouter.php)';
    private const BLOCK_END = '    return {"node_outputs": {n: {"source": ad["display"], "text": text}}, "routes": {n: chosen["id"]}}';

    private static function graph(): array
    {
        $agent = fn(string $name, string $type = 'standard', array $extra = []) => [
            'type' => 'agent-template', 'agent_name' => $name, 'agent_type' => $type,
            'instructions' => "You are {$name}.", 'agent_provider' => 'claude', 'model' => 'claude-sonnet-4-5',
            'tools' => [], 'settings' => ['temperature' => 0.7, 'max_tokens' => 4096],
        ] + $extra;
        return [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'My laptop will not boot']],
                ['id' => '2', 'node_type' => '', 'config' => $agent('techBuddy', 'dispatcher', ['description' => 'the front desk'])],
                ['id' => '3', 'node_type' => '', 'config' => $agent('IT claims', 'standard', ['description' => 'Laptops and VPN.'])],
                ['id' => '4', 'node_type' => '', 'config' => $agent('Human resources')],
                ['id' => '5', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [
                ['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3'], ['from' => '2', 'to' => '4'],
                ['from' => '3', 'to' => '5'], ['from' => '4', 'to' => '5'],
            ],
        ];
    }

    private function generator(?array $graph = null, $agentRecord = null): LangGraphGenerator
    {
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Dispatcher demo', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph ?? self::graph());
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn($agentRecord);
        return new LangGraphGenerator(LangGraphA2AGeneratorTest::pdo(), $wfRepo, $graphRepo, $agentRepo);
    }

    /** mode => [runtime file (carries dispatchBlock), node file (carries the dispatcher's data)] */
    private function modes(): array
    {
        $gen = $this->generator();
        $single = $gen->generate(44, '3')['code'];
        $byPath = fn(array $m) => array_column($m['files'], 'code', 'path');
        $mod = $byPath($gen->generate(44, '3', ['modular' => true]));
        $a2a = $byPath($gen->generate(44, '3', ['a2a' => true]));
        return [
            'single' => [$single, $single],
            'modular' => [$mod['common.py'] ?? '', $mod['agents/techbuddy.py'] ?? ''],
            'a2a' => [$a2a['agents/2_techbuddy.py'] ?? '', $a2a['agents/2_techbuddy.py'] ?? ''],
        ];
    }

    public function testEveryModeEmitsTheJevFastPathAndItsData(): void
    {
        // What the interpreter asks Jev for this dispatcher.
        $question = DispatchRouting::defaultInstructions('techBuddy', 'the front desk', 'Dispatcher demo');
        $this->assertSame('You are "techBuddy", the front desk, an agent in the workflow "Dispatcher demo". '
            . 'Handle the request you receive directly and completely, in the role your name implies.', $question);
        foreach ($this->modes() as $mode => [$runtime, $node]) {
            $this->assertNotSame('', $runtime, "{$mode}: runtime file missing");
            foreach (['def _jev_route(request, targets, question):', 'JEV_URL = "https://api.typesafe.ai/v1/systemone"',
                      'JEV_MODEL = "jev-latest"', 'JEV_CONFIDENCE_FLOOR = 0.6', 'JEV_TIMEOUT_S = 10',
                      'if _jev_available():', 'asyncio.to_thread(_jev_route, task, targets, ad.get("jev_question", "")), JEV_TIMEOUT_S + 1)', 'jev = await asyncio.wait_for(', 'ctx.load_verify_locations(certifi.where())',
                      'Jev routed to', '— asking the model'] as $needle) {
                $this->assertStringContainsString($needle, $runtime, "{$mode}: {$needle}");
            }
            // The Jev path runs BEFORE the forced route_to turn.
            $this->assertLessThan(strpos($runtime, 'llm = llm.bind_tools([route_tool], tool_choice="any")'),
                strpos($runtime, 'if _jev_available():'), "{$mode}: Jev must be asked first");
            // Target descriptions mirror the interpreter: DispatchRouting::targets()
            // carries none, so Jev judges every option by its name there -- and here.
            $this->assertStringContainsString(
                '"dispatch": [{"id": "3", "name": "IT claims", "description": ""}, {"id": "4", "name": "Human resources", "description": ""}]',
                $node, "{$mode}: menu");
            $this->assertStringContainsString('"jev_question": ' . json_encode($question, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ',',
                $node, "{$mode}: question");
            $this->assertStringContainsString('TYPESAFE_API_KEY (TypeSafe Jev)', $node, "{$mode}: TO RUN note");
        }
    }

    public function testSavedAgentRecordNamesTheJevQuestion(): void
    {
        // A dispatcher that references a saved agent: GraphWorkflowRunner asks Jev
        // with $agent->getName()/getDescription(), so the compiled question must
        // come from that record, not the node's own label/description.
        $graph = self::graph();
        $graph['nodes'][1]['config']['agent_id'] = 77;
        $record = $this->createMock(\AgentTeam\Models\Agent::class);
        $record->method('toArray')->willReturn(['id' => 77, 'name' => 'Front Desk', 'description' => 'routes every ticket',
            'agent_type' => 'dispatcher', 'instructions' => '', 'provider' => 'claude', 'model' => 'claude-sonnet-4-5']);
        $blank = $this->createMock(\AgentTeam\Models\Agent::class);
        $blank->method('toArray')->willReturn(['id' => 78, 'name' => '', 'description' => '', 'agent_type' => 'dispatcher']);
        foreach ([[$record, DispatchRouting::defaultInstructions('Front Desk', 'routes every ticket', 'Dispatcher demo')],
                  // A record with no name/description falls back to the node config.
                  [$blank, DispatchRouting::defaultInstructions('techBuddy', 'the front desk', 'Dispatcher demo')]] as [$agent, $want]) {
            $code = $this->generator($graph, $agent)->generate(44, '3')['code'];
            $this->assertStringContainsString('"jev_question": ' . json_encode($want, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ',', $code);
        }
    }

    public function testInterpreterTargetsCarryNoDescription(): void
    {
        // The premise of the empty "description" above. If the interpreter
        // starts sending the child's role, this fails and the generator must
        // follow (LangGraphGenerator: dispatcher targets 'description').
        $nodes = [2 => ['node_type' => 'agent', 'config' => ['agent_name' => 'A', 'description' => 'role']],
                  3 => ['node_type' => 'agent', 'config' => ['agent_name' => 'B']]];
        $edges = [['from_node_id' => 1, 'to_node_id' => 2], ['from_node_id' => 1, 'to_node_id' => 3]];
        foreach (DispatchRouting::targets(1, $edges, $nodes) as $t) {
            $this->assertArrayNotHasKey('description', $t);
        }
    }

    public function testEveryModeCompiles(): void
    {
        foreach ($this->modes() as $mode => [$runtime, $node]) {
            foreach (array_unique([$runtime, $node]) as $i => $code) {
                $this->assertCompiles($code, "{$mode}#{$i}");
            }
        }
    }

    public function testEmittedRuntimeRoutesAndFallsBack(): void
    {
        exec('python3 -c "import sys; assert sys.version_info >= (3, 9)" 2>&1', $o, $rc);
        if ($rc !== 0) {
            $this->markTestSkipped('python3 >= 3.9 not available');
        }
        foreach ($this->modes() as $mode => [$runtime, $node]) {
            // A2A agent / modular module: also slice the _run_dispatcher_kind wrapper.
            $kindFile = null;
            $k = strpos($node, 'async def _run_dispatcher_kind(');
            if ($mode !== 'single') {
                $this->assertNotFalse($k, "{$mode}: _run_dispatcher_kind");
                $kEnd = strpos($node, "\n\n\nasync def ", $k + 10);
                $kindFile = tempnam(sys_get_temp_dir(), 'jevk') . '.py';
                file_put_contents($kindFile, substr($node, $k, $kEnd === false ? null : $kEnd - $k) . "\n");
            }
            $a = strpos($runtime, self::BLOCK_START);
            $b = strpos($runtime, self::BLOCK_END);
            $this->assertNotFalse($a, "{$mode}: block start");
            $this->assertNotFalse($b, "{$mode}: block end");
            $block = substr($runtime, $a, $b - $a + strlen(self::BLOCK_END)) . "\n";
            $base = tempnam(sys_get_temp_dir(), 'jev');
            file_put_contents($base . '.py', $block);
            $out = [];
            exec('env -u TYPESAFE_API_KEY python3 ' . escapeshellarg(dirname(__DIR__) . '/fixtures/jev_dispatch_harness.py')
                . ' ' . escapeshellarg($base . '.py') . ($kindFile ? ' ' . escapeshellarg($kindFile) : '') . ' 2>&1', $out, $rc);
            @unlink($base . '.py');
            if ($kindFile) @unlink($kindFile);
            @unlink($base);
            $this->assertSame(0, $rc, "{$mode}: " . implode("\n", $out));
            $this->assertSame($kindFile ? 'OK 10 cases' : 'OK 9 cases', end($out), $mode);
        }
    }

    private function assertCompiles(string $code, string $label): void
    {
        $base = tempnam(sys_get_temp_dir(), 'jevc');
        $tmp = $base . '.py';
        file_put_contents($tmp, $code);
        exec('python3 -m py_compile ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
        @unlink($tmp);
        @unlink($base);
        $this->assertSame(0, $rc, "{$label}: " . implode("\n", $out));
    }
}
