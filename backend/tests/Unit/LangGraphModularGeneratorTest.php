<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\LangGraphGenerator;

/**
 * LangGraph compiler, modular mode ("agents in separate files"): one Python
 * package per workflow -- workflow.py (the graph), common.py (the shared
 * runtime) and one importable module per agent/playbook node under agents/.
 *
 * Unlike A2A, the files run in ONE process and link by `import`, so the tests
 * below check both the split (what lives where) and the seam (every imported
 * name is actually defined by the module it is imported from).
 *
 * Fixture (workflow 44, "Dispatcher demo") is shared with the A2A test:
 * start -> dispatcher techBuddy -> {IT claims, Human resources -> playbook} -> output.
 */
class LangGraphModularGeneratorTest extends TestCase
{
    private static function facts(): array
    {
        return LangGraphA2AGeneratorTest::facts();
    }

    private static function generator(): LangGraphGenerator
    {
        return LangGraphA2AGeneratorTest::generator();
    }

    private static function manifest(): array
    {
        return self::generator()->generate(44, '3', ['modular' => true]);
    }

    /** @return array<string,string> path => code */
    private static function files(): array
    {
        $out = [];
        foreach (self::manifest()['files'] as $f) {
            $out[$f['path']] = $f['code'];
        }
        return $out;
    }

    private function assertCompiles(string $code, string $label): void
    {
        $base = tempnam(sys_get_temp_dir(), 'mod');
        $tmp = $base . '.py';
        file_put_contents($tmp, $code);
        exec('python3 -m py_compile ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
        @unlink($tmp);
        @unlink($base);
        $this->assertSame(0, $rc, "{$label}: " . implode("\n", $out));
    }

    /**
     * Every top-level name a module binds: definitions (def/class/assignment)
     * AND names pulled in by its own imports, since `from common import X` is
     * legal for anything bound in common's namespace.
     *
     * @return string[]
     */
    private static function boundNames(string $code): array
    {
        $names = [];
        foreach (explode("\n", $code) as $line) {
            if (preg_match('/^(?:async\s+)?def\s+(\w+)/', $line, $m)) {
                $names[] = $m[1];
            } elseif (preg_match('/^class\s+(\w+)/', $line, $m)) {
                $names[] = $m[1];
            } elseif (preg_match('/^(\w+)\s*(?::[^=]+)?=[^=]/', $line, $m)) {
                $names[] = $m[1];
            } elseif (preg_match('/^from\s+[\w.]+\s+import\s+(.+)$/', $line, $m)) {
                foreach (explode(',', $m[1]) as $n) {
                    $n = trim($n);
                    if ($n === '' || $n === '(') {
                        continue;
                    }
                    $names[] = preg_match('/\s+as\s+(\w+)/', $n, $a) ? $a[1] : trim($n, '()');
                }
            } elseif (preg_match('/^import\s+(\w+)/', $line, $m)) {
                $names[] = $m[1];
            }
        }
        return array_values(array_unique($names));
    }

    public function testLayoutNamesOneImportableModulePerAgentOrPlaybookNode(): void
    {
        $layout = LangGraphGenerator::modularLayout(self::facts());
        $this->assertSame('dispatcher_demo_modular', $layout['root']);
        $this->assertSame(['2', '3', '4', '5'], array_map('strval', array_keys($layout['agents'])), 'ORDER order, no start/output');
        // Module names must be importable: no leading digit, no hyphen (this is
        // the concrete difference from the A2A layout's "3_it-claims.py").
        $this->assertSame('agents/techbuddy.py', $layout['agents']['2']['file']);
        $this->assertSame('agents/it_claims.py', $layout['agents']['3']['file']);
        $this->assertSame('agents/human_resources.py', $layout['agents']['4']['file']);
        $this->assertSame('agents/playbook_hr.py', $layout['agents']['5']['file']);
        $this->assertSame('agents.it_claims', $layout['agents']['3']['module']);
        foreach ($layout['agents'] as $e) {
            $this->assertMatchesRegularExpression('/^[a-z_][a-z0-9_]*$/', basename($e['file'], '.py'), 'valid module name');
        }
    }

    public function testModuleNamesFallBackWhenTheDisplayNameIsNotAnIdentifier(): void
    {
        $facts = self::facts();
        $facts['agentData']['3']['display'] = '2024 Réview!';   // digits first, accents, punctuation
        $facts['agentData']['4']['display'] = '2024 Review';    // collides after slugging
        $layout = LangGraphGenerator::modularLayout($facts);
        $this->assertSame('agents/node_3_2024_review.py', $layout['agents']['3']['file']);
        $this->assertSame('agents/node_4_2024_review.py', $layout['agents']['4']['file']);
    }

    public function testModularOptionReturnsAManifest(): void
    {
        $m = self::manifest();
        $this->assertSame('dispatcher_demo_modular', $m['root']);
        $this->assertSame([
            'workflow.py', 'common.py', 'api.py', 'agents/__init__.py',
            'agents/techbuddy.py', 'agents/it_claims.py', 'agents/human_resources.py', 'agents/playbook_hr.py',
        ], array_column($m['files'], 'path'));
        foreach ($m['files'] as $f) {
            $this->assertCompiles($f['code'], $f['path']);
            if ($f['path'] === 'agents/__init__.py') {
                continue;   // package marker: docstring only
            }
            $this->assertStringContainsString('PROVENANCE', $f['code'], $f['path']);
            $this->assertStringContainsString('GRAPH EDGES', $f['code'], $f['path']);
        }
    }

    public function testCommonModuleHoldsTheSharedRuntimeAndNoGraph(): void
    {
        $code = self::files()['common.py'];
        foreach (['"""Shared runtime for workflow "Dispatcher demo"', 'def _make_llm(', 'def _call_mcp_tool(',
                  'def build_tools_from_catalog', 'RUN_SKILL_SCRIPT_TOOL', 'async def _run_skill_step(',
                  'async def _run_dispatcher(', 'def inject_datetime(', 'def build_context(',
                  'def _convert_doc_to_markdown(', 'class WFState(', 'def build_playbook_tools(',
                  'def _playbook_gate(', 'NODE_DURATIONS = {}'] as $needle) {
            $this->assertStringContainsString($needle, $code, "missing: {$needle}");
        }
        // The whole catalog lives here once; the agent modules only name their tools.
        $this->assertStringContainsString('"get_news"', $code);
        // No graph and no node definitions: those belong to workflow.py / agents/*.
        foreach (['EDGES = ', 'ORDER = ', 'NODE_TYPES = ', 'async def run(', 'NODE = {', 'AGENTS = {'] as $needle) {
            $this->assertStringNotContainsString($needle, $code, "common.py must not carry: {$needle}");
        }
    }

    public function testAgentModuleImportsTheRuntimeAndBakesOnlyItsOwnNode(): void
    {
        $code = self::files()['agents/it_claims.py'];
        foreach (['"""Agent module "IT claims" -- node 3 of workflow "Dispatcher demo"',
                  'from common import', 'async def run_node(', 'NODE = {', '"kind": "agent"',
                  '# ---- node 3: IT claims (agent-template)', '<== this module'] as $needle) {
            $this->assertStringContainsString($needle, $code, "missing: {$needle}");
        }
        $this->assertStringContainsString('"tool_names": ["get_news","run_skill_script"]', $code);
        $this->assertStringContainsString('"skills": [{"dir":"html"}]', $code);
        // The shared runtime is imported, never duplicated (the A2A trade, reversed).
        foreach (['def _call_mcp_tool(', 'def build_tools_from_catalog', 'def _make_llm(',
                  'TOOL_CATALOG = ', 'def build_agent_card', 'uvicorn'] as $needle) {
            $this->assertStringNotContainsString($needle, $code, "agent module must not carry: {$needle}");
        }
    }

    public function testDispatcherModuleCarriesItsMenu(): void
    {
        $code = self::files()['agents/techbuddy.py'];
        $this->assertStringContainsString('"kind": "dispatcher"', $code);
        $this->assertStringContainsString('"dispatch": [{"id": "3", "name": "IT claims"}, {"id": "4", "name": "Human resources"}]', $code);
        $this->assertStringContainsString('_run_dispatcher', $code);
    }

    public function testPlaybookModuleKeepsConsoleGates(): void
    {
        $code = self::files()['agents/playbook_hr.py'];
        $this->assertStringContainsString('"kind": "playbook"', $code);
        $this->assertStringContainsString('"instructions": """', $code);
        $this->assertStringContainsString('build_playbook_tools', $code);
        // The playbook's bound MCP action travels in NODE["actions"], not in the shared catalog.
        $this->assertStringContainsString('"workday__get_pto_balance"', $code);
        // Gates stay the single-file console/PLAYBOOK_GATE_MODE ones: no A2A bridge.
        $this->assertStringNotContainsString('_a2a_gate', $code);
        $this->assertStringNotContainsString('requires_input(', $code);
    }

    public function testWorkflowModuleWiresTheGraphOverTheAgentModules(): void
    {
        $code = self::files()['workflow.py'];
        foreach (['"""LangGraph workflow: Dispatcher demo', 'from agents.techbuddy import run_node as techbuddy_run',
                  'from agents.playbook_hr import run_node as playbook_hr_run', 'from common import',
                  'EDGES = ', 'ORDER = ', 'NODE_TYPES = ', 'def parents(', 'def children(',
                  'StateGraph(WFState)', 'add_conditional_edges', 'async def run(', 'def _save_output(',
                  'RUN SUMMARY', 'if __name__ == "__main__":', 'AGENT MODULES'] as $needle) {
            $this->assertStringContainsString($needle, $code, "missing: {$needle}");
        }
        // The graph calls the modules; it never re-implements a node itself.
        foreach (['def build_playbook_tools(', 'def build_tools_from_catalog', 'create_react_agent(',
                  'PLAYBOOK_SYSTEM_PROMPT = '] as $needle) {
            $this->assertStringNotContainsString($needle, $code, "workflow.py must not carry: {$needle}");
        }
    }

    /** The seam: every `from common import X` / `from agents.y import Z` resolves to a name that module binds. */
    public function testEveryCrossModuleImportResolves(): void
    {
        $files = self::files();
        $bound = [];
        foreach ($files as $path => $code) {
            $mod = $path === 'workflow.py' ? 'workflow' : ($path === 'common.py' ? 'common' : 'agents.' . basename($path, '.py'));
            $bound[$mod] = self::boundNames($code);
        }
        $checked = 0;
        foreach ($files as $path => $code) {
            if (!preg_match_all('/^from\s+(common|agents\.\w+)\s+import\s+(.+)$/m', $code, $ms, PREG_SET_ORDER)) {
                continue;
            }
            foreach ($ms as $m) {
                $this->assertArrayHasKey($m[1], $bound, "{$path} imports unknown module {$m[1]}");
                foreach (explode(',', $m[2]) as $name) {
                    $name = trim($name);
                    $symbol = preg_match('/^(\w+)\s+as\s+\w+$/', $name, $a) ? $a[1] : $name;
                    $this->assertContains($symbol, $bound[$m[1]], "{$path}: {$m[1]} does not define {$symbol}");
                    $checked++;
                }
            }
        }
        $this->assertGreaterThan(10, $checked, 'expected the modules to actually import from each other');
    }

    public function testSingleFileOutputUnchangedWithoutTheOption(): void
    {
        $code = self::generator()->generate(44, '3')['code'];
        $this->assertStringContainsString('"""Standalone LangGraph workflow: Dispatcher demo', $code);
        $this->assertStringContainsString('PLAYBOOKS = {', $code);
        $this->assertStringNotContainsString('from common import', $code);
    }
}
