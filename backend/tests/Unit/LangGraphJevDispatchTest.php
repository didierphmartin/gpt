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
 * LangGraph compiler: a dispatcher routes with a decision model (a provider
 * row, e.g. TypeSafe's Jev) or with the model, never both, the same way
 * GraphWorkflowRunner does. Each dispatcher carries its candidate providers
 * and their env names; an unset mode is resolved at run time (the first
 * candidate whose key is set, else the model).
 * Checked in every LangGraph mode that runs a dispatcher (single
 * script, modular package, A2A agent server), and the emitted runtime itself is
 * exercised by tests/fixtures/jev_dispatch_harness.py with a fake HTTP layer.
 */
class LangGraphJevDispatchTest extends TestCase
{
    private const BLOCK_START = '# Decision-model routing (twin of DecisionProtocols.php';
    private const BLOCK_END = '        return RouteDecision(text=text, route=chosen["id"], notes=notes, status="ok")';
    private const NODE_START = 'class Node(ABC):';
    private const NODE_END = '            raise ValueError(f"unknown node kind: {cfg[\'kind\']!r}")';

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
        return $this->generatorWithPdo(LangGraphA2AGeneratorTest::pdo(), $graph ?? self::graph(), $agentRecord);
    }

    private function generatorWithPdo(\PDO $pdo, array $graph, $agentRecord = null): LangGraphGenerator
    {
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Dispatcher demo', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph);
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn($agentRecord);
        return new LangGraphGenerator($pdo, $wfRepo, $graphRepo, $agentRepo);
    }

    /** mode => [runtime file (carries dispatcherBlock), node file (carries the dispatcher's data)] */
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
            foreach (['    def route(self, request: str, targets: list[dict], question: str, floor: float = CONFIDENCE_FLOOR) -> DecisionResult:',
                      '    URL = "https://api.typesafe.ai/v1/systemone"', '    MODEL = "jev-latest"', '    CONFIDENCE_FLOOR = 0.6', '    TIMEOUT_S = 10',
                      '    LEGACY_KEY_ENV = "TYPESAFE_API_KEY"', 'DECISION_ADAPTERS = {"typesafe": JevRouter}',
                      '        match self.cfg.get("routing_mode", ""):', '        match self.mode():',
                      'self.cfg.get("decision_question", "")',
                      'ctx.load_verify_locations(certifi.where())',
                      '{key} routed to {chosen[\'name\']!r}', 'decision-model dispatcher, no model fallback'] as $needle) {
                $this->assertStringContainsString($needle, $runtime, "{$mode}: {$needle}");
            }
            // No hybrid: a Jev decline never falls through to the model.
            $this->assertStringNotContainsString('asking the model', $runtime, "{$mode}: no hybrid");
            $this->assertStringNotContainsString('Jev declined', $runtime, "{$mode}: no hybrid");
            // The Jev path returns BEFORE the forced route_to turn.
            $this->assertLessThan(strpos($runtime, 'llm = make_llm().bind_tools([self._route_tool()], tool_choice="any")'),
                strpos($runtime, 'return await self._via_decision(key, task)'), "{$mode}: the mode is decided first");
            // techBuddy has no routing_mode saved: '' (resolved at run time), at the default floor.
            $this->assertStringContainsString('"routing_mode": "",', $node, "{$mode}: routing_mode");
            $this->assertStringContainsString('"min_confidence": 0.6,', $node, "{$mode}: floor");
            // Unset: every usable decision provider, in admin order, with its env names.
            $this->assertStringContainsString('"decision": [{"provider": "jev", "protocol": "typesafe", "url": "https://api.typesafe.ai/v1/systemone", '
                . '"model": "jev-latest", "key_env": "JEV_API_KEY", "url_env": "JEV_BASE_URL"}],', $node, "{$mode}: decision");
            // Target descriptions mirror the interpreter: DispatchRouting::targets()
            // carries none, so Jev judges every option by its name there -- and here.
            $this->assertStringContainsString(
                '"dispatch": [{"id": "3", "name": "IT claims", "description": ""}, {"id": "4", "name": "Human resources", "description": ""}]',
                $node, "{$mode}: menu");
            $this->assertStringContainsString('"decision_question": ' . json_encode($question, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ',',
                $node, "{$mode}: question");
            $this->assertStringContainsString('# Optional: JEV_API_KEY for dispatchers', $node, "{$mode}: TO RUN note");
        }
    }

    /** The dispatcher's routing data as every mode emits it: [routing_mode literal, floor literal]. */
    private function routingData(array $graph, $agentRecord = null): array
    {
        $gen = $this->generator($graph, $agentRecord);
        $byPath = fn(array $m) => array_column($m['files'], 'code', 'path');
        $files = [
            'single' => $gen->generate(44, '3')['code'],
            'modular' => $byPath($gen->generate(44, '3', ['modular' => true]))['agents/techbuddy.py'] ?? '',
            'a2a' => $byPath($gen->generate(44, '3', ['a2a' => true]))['agents/2_techbuddy.py'] ?? '',
        ];
        $got = [];
        foreach ($files as $mode => $code) {
            $this->assertMatchesRegularExpression('/"routing_mode": "[a-z-]*",/', $code, "{$mode}: routing_mode");
            preg_match('/"routing_mode": ("[a-z-]*"),/', $code, $m1);
            preg_match('/"min_confidence": ([0-9.]+),/', $code, $m2);
            $got[$mode] = [$m1[1] ?? null, $m2[1] ?? null];
        }
        return $got;
    }

    private static function withSettings(array $settings): array
    {
        $graph = self::graph();
        $graph['nodes'][1]['config']['settings'] = $settings + $graph['nodes'][1]['config']['settings'];
        return $graph;
    }

    public function testRoutingModeAndFloorAreEmittedInEveryMode(): void
    {
        // [node settings, expected routing_mode literal, expected floor literal]
        $cases = [
            [['routing_mode' => 'jev', 'jev_min_confidence' => 0.85], '"jev"', '0.85'],
            [['routing_mode' => 'llm'], '"llm"', '0.6'],
            // Any other value names a decision provider (kept verbatim, like the
            // interpreter); blank is unset (''), resolved at run time.
            [['routing_mode' => 'bogus'], '"bogus"', '0.6'],
            [['routing_mode' => ' jev '], '"jev"', '0.6'],
            [['routing_mode' => ''], '""', '0.6'],
            // min_confidence wins over the legacy jev_min_confidence.
            [['routing_mode' => 'jev', 'min_confidence' => 0.8, 'jev_min_confidence' => 0.3], '"jev"', '0.8'],
            [['routing_mode' => 'jev', 'min_confidence' => 0.75], '"jev"', '0.75'],
            // jev_min_confidence: numeric -> clamped to [0, 1]; otherwise 0.6.
            [['routing_mode' => 'jev', 'jev_min_confidence' => 1.7], '"jev"', '1.0'],
            [['routing_mode' => 'jev', 'jev_min_confidence' => -2], '"jev"', '0.0'],
            [['routing_mode' => 'jev', 'jev_min_confidence' => '0.7'], '"jev"', '0.7'],
            [['routing_mode' => 'jev', 'jev_min_confidence' => 'high'], '"jev"', '0.6'],
            [['routing_mode' => 'jev', 'jev_min_confidence' => null], '"jev"', '0.6'],
        ];
        foreach ($cases as [$settings, $mode, $floor]) {
            foreach ($this->routingData(self::withSettings($settings)) as $m => $got) {
                $this->assertSame([$mode, $floor], $got, $m . ': ' . json_encode($settings));
            }
        }
    }

    public function testSavedAgentRecordSettingsDecideTheRoutingMode(): void
    {
        // GraphWorkflowRunner reads routing_mode from $agent->getSettings() when the
        // node references a saved agent -- the record, not the node config.
        $graph = self::withSettings(['routing_mode' => 'jev', 'jev_min_confidence' => 0.9]);
        $graph['nodes'][1]['config']['agent_id'] = 77;
        $record = function (array $settings) {
            $r = $this->createMock(\AgentTeam\Models\Agent::class);
            $r->method('toArray')->willReturn(['id' => 77, 'name' => 'techBuddy', 'description' => 'the front desk',
                'agent_type' => 'dispatcher', 'instructions' => '', 'provider' => 'claude',
                'model' => 'claude-sonnet-4-5', 'settings' => $settings]);
            return $r;
        };
        foreach ([[['routing_mode' => 'llm', 'jev_min_confidence' => 0.75], ['"llm"', '0.75']],
                  // A record without the setting is unset, whatever the node says.
                  [[], ['""', '0.6']]] as [$settings, $want]) {
            foreach ($this->routingData($graph, $record($settings)) as $m => $got) {
                $this->assertSame($want, $got, $m . ': ' . json_encode($settings));
            }
        }
        // A reference whose record is gone falls back to the node config.
        foreach ($this->routingData($graph, null) as $m => $got) {
            $this->assertSame(['"jev"', '0.9'], $got, $m);
        }
    }

    public function testDispatcherWithNoRouteReachesEndInEveryGraph(): void
    {
        // The graph-level half of the harness's "no branch runs": a dispatcher
        // result whose route is not a menu id takes the conditional edge to END
        // (WorkflowGraph, the same code in the single script and the modular /
        // A2A orchestrators).
        $gen = $this->generator(self::withSettings(['routing_mode' => 'jev']));
        $byPath = fn(array $m) => array_column($m['files'], 'code', 'path');
        $graphs = [
            'single' => $gen->generate(44, '3')['code'],
            'modular' => $byPath($gen->generate(44, '3', ['modular' => true]))['common.py'] ?? '',   // WorkflowGraph lives here
            'a2a' => $byPath($gen->generate(44, '3', ['a2a' => true]))['orchestrator.py'] ?? '',
        ];
        foreach ($graphs as $mode => $code) {
            $this->assertStringContainsString('return lambda state: state.get("routes", {}).get(nid) or END', $code, $mode);
            $this->assertStringContainsString('sg.add_conditional_edges(nid, router, {t: t for t in menu} | {END: END})', $code, $mode);
            $this->assertStringContainsString('route = out["route"] if out["route"] in {t["id"] for t in ad["dispatch"]} else END', $code, $mode);
        }
    }

    public function testToRunNoteFollowsTheRoutingMode(): void
    {
        $doc = fn(array $settings) => $this->generator(self::withSettings($settings))->generate(44, '3')['code'];
        // Unset: the first decision model whose key is set, else the model -- never both.
        $unset = $doc([]);
        $this->assertStringContainsString('# Optional: JEV_API_KEY for dispatchers with no routing mode saved (techBuddy):', $unset);
        $this->assertStringContainsString('#   the first decision model whose key is set routes (else the model); once one is chosen, a request it cannot decide stops the run there (no model fallback).', $unset);
        $this->assertStringContainsString('TypeSafe rows also read the legacy TYPESAFE_API_KEY / TYPESAFE_BASE_URL.', $unset);
        $this->assertStringNotContainsString('# Required: JEV_API_KEY', $unset);
        // A named provider: required.
        $jev = $doc(['routing_mode' => 'jev']);
        $this->assertStringContainsString('# Required: JEV_API_KEY for dispatchers (techBuddy);', $jev);
        $this->assertStringNotContainsString('# Optional: JEV_API_KEY', $jev);
        // LLM only: no decision model, so no key is asked for.
        $llm = $doc(['routing_mode' => 'llm']);
        $this->assertStringNotContainsString('JEV_API_KEY', $llm);
        $this->assertStringNotContainsString('TYPESAFE_API_KEY', $llm);
        $this->assertStringContainsString('"decision": [],', $llm);
    }

    public function testCommonPyProvidesListsTheDecisionRuntime(): void
    {
        $common = array_column($this->generator()->generate(44, '3', ['modular' => true])['files'], 'code', 'path')['common.py'] ?? '';
        $this->assertStringContainsString("  DecisionResult, JevRouter,\n  DECISION_ADAPTERS, RouteDecision,\n  Dispatcher ", $common);
        $this->assertStringNotContainsString('JevRouter, Dispatcher ', $common);
        foreach (['class DecisionResult', 'class JevRouter', 'DECISION_ADAPTERS = {', 'class RouteDecision', 'class Dispatcher'] as $def) {
            $this->assertStringContainsString($def, $common, 'PROVIDES lists only what is emitted');
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
            $this->assertStringContainsString('"decision_question": ' . json_encode($want, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ',', $code);
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

    public function testEmittedRuntimeRoutesOrStops(): void
    {
        exec('python3 -c "import sys; assert sys.version_info >= (3, 10)" 2>&1', $o, $rc);
        if ($rc !== 0) {
            $this->markTestSkipped('python3 >= 3.10 not available');
        }
        foreach ($this->modes() as $mode => [$runtime]) {
            // The dispatch block, and the Node classes that run a dispatcher node in every
            // mode (class Node through make_node()), both sliced from the runtime file.
            $a = strpos($runtime, self::BLOCK_START);
            $b = strpos($runtime, self::BLOCK_END);
            $this->assertNotFalse($a, "{$mode}: block start");
            $this->assertNotFalse($b, "{$mode}: block end");
            $block = substr($runtime, $a, $b - $a + strlen(self::BLOCK_END)) . "\n";
            $k = strpos($runtime, self::NODE_START);
            $kEnd = strpos($runtime, self::NODE_END);
            $this->assertNotFalse($k, "{$mode}: Node classes start");
            $this->assertNotFalse($kEnd, "{$mode}: Node classes end");
            $classes = substr($runtime, $k, $kEnd - $k + strlen(self::NODE_END)) . "\n";
            $base = tempnam(sys_get_temp_dir(), 'jev');
            file_put_contents($base . '.py', $block);
            file_put_contents($base . '_nodes.py', $classes);
            $out = [];
            exec('env -u TYPESAFE_API_KEY -u TYPESAFE_BASE_URL -u JEV_API_KEY -u JEV_BASE_URL python3 ' . escapeshellarg(dirname(__DIR__) . '/fixtures/jev_dispatch_harness.py')
                . ' ' . escapeshellarg($base . '.py') . ' ' . escapeshellarg($base . '_nodes.py') . ' 2>&1', $out, $rc);
            @unlink($base . '.py');
            @unlink($base . '_nodes.py');
            @unlink($base);
            $this->assertSame(0, $rc, "{$mode}: " . implode("\n", $out));
            $this->assertSame('OK 29 cases', end($out), $mode);
        }
    }

    public function testEachDispatcherCarriesItsProviderAndEnvNames(): void
    {
        $pdo = LangGraphA2AGeneratorTest::pdo();
        $pdo->exec("INSERT INTO system_llm_settings (provider_key, display_name, model, base_url, api_format, protocol, enabled, sort_order)
            VALUES ('jev-eu', 'Jev EU', 'jev-latest', 'https://gw.corp/jev', 'router', 'typesafe', 1, 50)");
        $graph = self::graph();
        $graph['nodes'][1]['config']['settings']['routing_mode'] = 'jev-eu';
        $code = $this->generatorWithPdo($pdo, $graph)->generate(44)['code'];
        $this->assertStringContainsString('"routing_mode": "jev-eu"', $code);
        $this->assertStringContainsString('"key_env": "JEV_EU_API_KEY"', $code);
        $this->assertStringContainsString('"url": "https://gw.corp/jev"', $code);
        $this->assertSame(1, substr_count($code, 'class JevRouter'), 'one adapter per protocol used');
        $this->assertStringContainsString('JEV_EU_API_KEY', $code, 'the TO RUN note names the per-row env var');
    }

    public function testAnUnsetDispatcherListsEveryProviderInAdminOrder(): void
    {
        $pdo = LangGraphA2AGeneratorTest::pdo();
        $pdo->exec("INSERT INTO system_llm_settings (provider_key, display_name, model, base_url, api_format, protocol, enabled, sort_order)
            VALUES ('acme', 'Acme', 'jev-latest', NULL, 'router', 'typesafe', 1, 50)");
        $code = $this->generatorWithPdo($pdo, self::graph())->generate(44)['code'];
        $this->assertLessThan(strpos($code, '"provider": "jev"'), strpos($code, '"provider": "acme"'));
    }

    public function testANodeNamingAMissingProviderCompilesWithNoCandidate(): void
    {
        $graph = self::graph();
        $graph['nodes'][1]['config']['settings']['routing_mode'] = 'gone';
        $code = $this->generator($graph)->generate(44)['code'];
        $this->assertStringContainsString('"routing_mode": "gone"', $code);
        $this->assertStringContainsString('"decision": []', $code);
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
