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
 * The LangGraph compiler's output as a whole -- single file, modular package, A2A --
 * checked statically (names, imports, docstrings, readability), for the documentation
 * it must keep, and by running the emitted code against a stub chat model.
 * Spec: docs/superpowers/specs/2026-09-30-langgraph-oo-output-design.md.
 */
class LangGraphOutputStructureTest extends TestCase
{
    private const FIXTURES = __DIR__ . '/../fixtures';
    private const DOC_BASELINE = self::FIXTURES . '/lg_doc_baseline';

    /** name => graph: the Dispatcher demo, a plain chain (no dispatcher, no playbook), a playbook-only flow. */
    public static function graphs(): array
    {
        $agent = fn(string $name) => [
            'type' => 'agent-template', 'agent_name' => $name, 'agent_type' => 'standard',
            'instructions' => "You are {$name}.", 'agent_provider' => 'claude', 'model' => 'claude-sonnet-4-5',
            'tools' => [], 'settings' => ['temperature' => 0.7, 'max_tokens' => 4096],
        ];
        return [
            'dispatcher_demo' => LangGraphA2AGeneratorTest::graph(),
            'linear' => [
                'nodes' => [
                    ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'write something']],
                    ['id' => '2', 'node_type' => '', 'config' => $agent('Researcher')],
                    ['id' => '3', 'node_type' => '', 'config' => $agent('Writer')],
                    ['id' => '4', 'node_type' => 'output', 'config' => ['type' => 'output']],
                ],
                'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3'], ['from' => '3', 'to' => '4']],
            ],
            'playbook_only' => [
                'nodes' => [
                    ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'I want to take some vacations']],
                    ['id' => '2', 'node_type' => 'playbook', 'config' => ['type' => 'playbook', 'name' => 'Playbook HR',
                        'playbook' => LangGraphA2AGeneratorTest::PLAYBOOK, 'agent_provider' => 'deepseek',
                        'model' => 'deepseek-v4-flash', 'writes_enabled' => true]],
                    ['id' => '3', 'node_type' => 'output', 'config' => ['type' => 'output']],
                ],
                'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3']],
            ],
        ];
    }

    private function generator(array $graph): LangGraphGenerator
    {
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Dispatcher demo', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph);
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        return new LangGraphGenerator(LangGraphA2AGeneratorTest::pdo(), $wfRepo, $graphRepo, $agentRepo);
    }

    /** path => code for one mode. api.py is left out unless asked: RunServerEmitter (shared) writes most of it. */
    private function files(array $graph, string $mode, bool $withApi = false): array
    {
        $gen = $this->generator($graph);
        if ($mode === 'single') {
            $r = $gen->generate(44, '3');
            return [$r['filename'] => $r['code']];
        }
        $out = [];
        foreach ($gen->generate(44, '3', [$mode => true])['files'] as $f) {
            if ($withApi || $f['path'] !== 'api.py') {
                $out[$f['path']] = $f['code'];
            }
        }
        return $out;
    }

    /**
     * Write $files under a fresh temp root. The root sits at <tmp>/lgos_<hex>/python/scripts/wf, the
     * runner's layout, so what the code writes next to its runner folder (RUNNER_DIR, e.g. the
     * agents' outputs/_debug dumps) stays inside lgos_<hex>. @return array{root: string, paths: array<string,string>}
     */
    private static function write(array $files): array
    {
        $root = sys_get_temp_dir() . '/lgos_' . bin2hex(random_bytes(6)) . '/python/scripts/wf';
        $paths = [];
        foreach ($files as $rel => $code) {
            $paths[$rel] = $root . '/' . $rel;
            @mkdir(dirname($paths[$rel]), 0777, true);
            file_put_contents($paths[$rel], $code);
        }
        return ['root' => $root, 'paths' => $paths];
    }

    /** Output lines of lg_static_checks.py <check> over $paths (stdlib python3 suffices). */
    private function staticCheck(string $check, array $paths): array
    {
        exec('python3 ' . escapeshellarg(self::FIXTURES . '/lg_static_checks.py') . ' ' . $check . ' '
            . implode(' ', array_map('escapeshellarg', array_values($paths))) . ' 2>&1', $out, $rc);
        $this->assertSame(0, $rc, implode("\n", $out));
        return array_values(array_filter($out, fn($l) => $l !== ''));
    }

    /**
     * Documentation is never cut (spec, readability rule). The baseline is the documentation
     * inventory of the Dispatcher demo in each mode as generated at 038f6e1; a line may leave
     * only through reworded.json: {"<old line>": {"now": "<new line>" | null, "why": "..."}}.
     * "now": null is for documentation of code that was deleted, and needs a "why".
     */
    public function testEveryBaselineDocumentationLineSurvives(): void
    {
        $reworded = json_decode((string) file_get_contents(self::DOC_BASELINE . '/reworded.json'), true) ?? [];
        foreach (['single', 'modular', 'a2a'] as $mode) {
            $now = $this->staticCheck('docs', self::write($this->files(self::graphs()['dispatcher_demo'], $mode))['paths']);
            $file = self::DOC_BASELINE . "/{$mode}.txt";
            if (getenv('LG_DOC_BASELINE_WRITE') === '1') {   // Preparation only; never again
                file_put_contents($file, implode("\n", $now) . "\n");
                continue;
            }
            $this->assertFileExists($file, "{$mode}: documentation baseline missing");
            $baseline = file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
            $this->assertNotEmpty($baseline, "{$mode}: documentation baseline is empty, so it would pass vacuously");
            $have = array_flip($now);
            $lost = [];
            foreach ($baseline as $line) {
                $r = $reworded[$line] ?? null;
                $ok = isset($have[$line])
                    || ($r !== null && array_key_exists('now', $r)
                        && ($r['now'] === null ? trim((string) ($r['why'] ?? '')) !== '' : isset($have[$r['now']])));
                if (!$ok) {
                    $lost[] = $line;
                }
            }
            $this->assertSame([], $lost, "{$mode}: documentation lost -- move it with its code, or record the rewording in reworded.json");
        }
        if (getenv('LG_DOC_BASELINE_WRITE') === '1') {
            $this->markTestSkipped('baseline written');
        }
    }

    /**
     * A NameError is a runtime failure py_compile never sees. GeneratedDocParityTest scans only
     * the single files of the four targets; this scans every LangGraph file of every mode, for
     * three workflow shapes. The allowlist is the set of names the playbook runtime deliberately
     * probes for (try/except NameError); Task 7b empties it. Module dunders such as __file__ are
     * allowed by lg_static_checks.py itself, not here.
     */
    public function testNoLangGraphFileReferencesAnUndefinedGlobal(): void
    {
        // PlaybookEmit's runtime probes for the event sink (try/except NameError) so it runs
        // with or without one: in a file without the sink these four are unbound on purpose.
        $allowed = ['_SINK', 'emit_event', 'open_gate', 'take_gate_answer'];
        foreach (self::graphs() as $name => $graph) {
            foreach (['single', 'modular', 'a2a'] as $mode) {
                $w = self::write($this->files($graph, $mode, true));
                $found = array_filter($this->staticCheck('undefined', $w['paths']),
                    fn($l) => !in_array(substr($l, strrpos($l, ' ') + 1), $allowed, true));
                $this->assertSame([], array_values($found), "{$name}/{$mode}");
            }
        }
    }

    public function testNoLangGraphFileImportsAnUnusedName(): void
    {
        foreach (self::graphs() as $name => $graph) {
            foreach (['single', 'modular', 'a2a'] as $mode) {
                $this->assertSame([], $this->staticCheck('unused', self::write($this->files($graph, $mode))['paths']), "{$name}/{$mode}");
            }
        }
    }

    /** Every class and public function the LangGraph target emits says why it exists. */
    public function testEveryLangGraphClassAndPublicFunctionHasADocstring(): void
    {
        $allowed = ['def _PlaybookRun.emit has no docstring'];   // PlaybookEmit's; Task 7b replaces it
        foreach (self::graphs() as $name => $graph) {
            foreach (['single', 'modular', 'a2a'] as $mode) {
                $found = array_filter($this->staticCheck('docstrings', self::write($this->files($graph, $mode))['paths']),
                    fn($l) => !in_array(substr($l, strpos($l, ': ') + 2), $allowed, true));
                $this->assertSame([], array_values($found), "{$name}/{$mode}");
            }
        }
    }

    /** Same-variable if/elif chains on ntype and routing mode are match statements (spec step 2). */
    public function testNodeTypeAndRoutingModeAreMatchStatements(): void
    {
        foreach (['single', 'modular', 'a2a'] as $mode) {
            $all = implode("\n", $this->files(self::graphs()['dispatcher_demo'], $mode));
            $this->assertStringContainsString('match ntype:', $all, $mode);
            $this->assertStringNotContainsString('if ntype == "start":', $all, $mode);
            $this->assertStringContainsString('        match self.mode():', $all, $mode);
            $this->assertStringNotContainsString('    if mode == "jev":', $all, $mode);
        }
    }

    /** The runner venv's interpreter (langchain/langgraph/a2a installed), or skip. */
    private function venvPython(): string
    {
        $py = getenv('LANGGRAPH_TEST_PYTHON') ?: (getenv('HOME') . '/Documents/synergyAI/python/.venv/bin/python');
        exec(escapeshellarg($py) . ' -c "import langchain_core, langgraph" 2>&1', $o, $rc);
        if ($rc !== 0) {
            $this->markTestSkipped("runner venv python not usable: {$py}");
        }
        return $py;
    }

    /** Run lg_run_probe.py; returns [decoded RESULT, full console]. */
    private function probe(array $args, array $env = []): array
    {
        $prefix = 'env -u TYPESAFE_API_KEY -u MODEL_NAME -u PLAYBOOK_GATE_MODE';
        foreach ($env as $k => $v) {
            $prefix .= ' ' . $k . '=' . escapeshellarg($v);
        }
        exec($prefix . ' ' . escapeshellarg($this->venvPython()) . ' ' . escapeshellarg(self::FIXTURES . '/lg_run_probe.py')
            . ' ' . implode(' ', array_map('escapeshellarg', $args)) . ' 2>&1', $out, $rc);
        $console = implode("\n", $out);
        $this->assertSame(0, $rc, $console);
        $line = (string) end($out);
        $this->assertStringStartsWith('RESULT ', $line, $console);
        return [json_decode(substr($line, 7), true), $console];
    }

    public function testEveryNodeKindRunsThroughMakeNode(): void
    {
        $files = $this->files(self::graphs()['dispatcher_demo'], 'modular');
        $this->assertStringContainsString('class Node(ABC):', $files['common.py']);
        $this->assertStringContainsString('def make_node(cfg: dict) -> Node:', $files['common.py']);
        foreach (['agents/techbuddy.py', 'agents/it_claims.py', 'agents/playbook_hr.py'] as $p) {
            $this->assertStringContainsString("run_node = make_node(NODE).run", $files[$p], $p);
            $this->assertStringNotContainsString('async def ', $files[$p], "{$p}: node logic lives in common.py");
        }
        $root = self::write($files)['root'];
        [$r] = $this->probe(['node', 'module', $root, 'agents.techbuddy', 'my laptop will not boot'], ['STUB_ROUTE_TO' => 'IT claims']);
        $this->assertSame(['text' => 'my laptop will not boot', 'route' => '3', 'notes' => '', 'status' => 'ok'], $r);
        [$r, $log] = $this->probe(['node', 'module', $root, 'agents.human_resources', 'two days off']);
        $this->assertSame('ok', $r['status']);
        $this->assertStringContainsString('answer to: two days off', $r['text']);
        $this->assertStringContainsString("inputs: system=", $log);
        [$r] = $this->probe(['node', 'module', $root, 'agents.playbook_hr', 'two days off'], ['PLAYBOOK_GATE_MODE' => 'auto']);
        $this->assertStringStartsWith('# Playbook: Time Off (', $r['text']);
    }

    public function testPlaybookOnlyWorkflowRunsInEveryMode(): void          // Review Focus 2
    {
        $graph = self::graphs()['playbook_only'];
        $single = self::write($this->files($graph, 'single'));
        [$r] = $this->probe(['workflow', 'single', array_values($single['paths'])[0], 'I want two days off'], ['PLAYBOOK_GATE_MODE' => 'auto']);
        $this->assertStringStartsWith('# Playbook: Time Off (', $r['output']);
        [$r] = $this->probe(['workflow', 'modular', self::write($this->files($graph, 'modular'))['root'], 'I want two days off'], ['PLAYBOOK_GATE_MODE' => 'auto']);
        $this->assertStringStartsWith('# Playbook: Time Off (', $r['output']);
        $a2a = self::write($this->files($graph, 'a2a'));
        [$r] = $this->probe(['node', 'a2a', $a2a['paths']['agents/2_playbook-hr.py'], 'I want two days off'], ['PLAYBOOK_GATE_MODE' => 'auto']);
        $this->assertStringStartsWith('# Playbook: Time Off (', $r['text']);
    }

    public function testMissingProviderPackageFailsOnlyThatNode(): void     // Review Focus 3
    {
        $path = array_values(self::write($this->files(self::graphs()['linear'], 'single'))['paths'])[0];
        $cfg = json_encode(['id' => '9', 'kind' => 'agent', 'display' => 'G', 'provider' => 'gemini', 'model' => 'gemini-x',
            'temperature' => 0.7, 'max_tokens' => 100, 'thinking' => null, 'system_prompt' => 'x', 'tool_names' => [], 'skills' => []]);
        [$r] = $this->probe(['llm', $path, $cfg], ['STUB_BLOCK_IMPORT' => 'langchain_google_genai']);
        $this->assertStringStartsWith('ImportError', (string) $r['error'], 'import and make_node() succeed; only .llm fails');
        // Built lazily, so the failure comes mid-run: it names the node and its provider (ruling OQ3).
        $this->assertStringContainsString("node 9 'G'", (string) $r['error']);
        $this->assertStringContainsString("'gemini'", (string) $r['error']);
        // Any other build failure (here: no model name) names them too.
        [$r] = $this->probe(['llm', $path, str_replace('"gemini-x"', '""', $cfg)]);
        $this->assertStringStartsWith('RuntimeError', (string) $r['error']);
        $this->assertStringContainsString("node 9 'G'", (string) $r['error']);
        $this->assertStringContainsString("'gemini'", (string) $r['error']);
    }

    public function testA2AAgentFilesRunTheirNodeThroughMakeNode(): void    // Review Focus 4
    {
        $a2a = self::write($this->files(self::graphs()['dispatcher_demo'], 'a2a'));
        [$r] = $this->probe(['node', 'a2a', $a2a['paths']['agents/2_techbuddy.py'], 'I need vacation'], ['STUB_ROUTE_TO' => 'Human resources']);
        $this->assertSame('4', $r['route']);
        [$r] = $this->probe(['node', 'a2a', $a2a['paths']['agents/4_human-resources.py'], 'I need vacation']);
        $this->assertSame(['route' => '', 'notes' => '', 'status' => 'ok'], array_diff_key($r, ['text' => 1]));
        [$r] = $this->probe(['node', 'a2a', $a2a['paths']['agents/5_playbook-hr.py'], 'I need vacation'], ['PLAYBOOK_GATE_MODE' => 'auto']);
        $this->assertStringStartsWith('# Playbook: Time Off (', $r['text']);
    }

    /** The emitted classes follow the spec's readability rule (checked from Task 3 on). */
    public function testEmittedClassesFollowTheReadabilityRule(): void
    {
        foreach (self::graphs() as $name => $graph) {
            foreach (['single', 'modular', 'a2a'] as $mode) {
                $this->assertSame([], $this->staticCheck('readability', self::write($this->files($graph, $mode))['paths']), "{$name}/{$mode}");
            }
        }
    }

    /** The dispatcher runtime is JevRouter + Dispatcher; the parents() stubs and the fake graph state are gone (analysis D6). */
    public function testDispatcherIsAClassAndTheFakeStateIsGone(): void
    {
        foreach (['single', 'modular', 'a2a'] as $mode) {
            $all = implode("\n", $this->files(self::graphs()['dispatcher_demo'], $mode));
            $this->assertStringContainsString('class JevRouter:', $all, $mode);
            $this->assertStringContainsString('class Dispatcher:', $all, $mode);
            foreach (['def parents(_n)', 'state = {"node_outputs": {}, "user_prompt": request}', 'def _jev_route('] as $gone) {
                $this->assertStringNotContainsString($gone, $all, "{$mode}: {$gone}");
            }
        }
    }

    public function testSingleFileAndPackageSendTheSamePromptsAndSaveUnderTheSameName(): void
    {
        $graph = self::graphs()['dispatcher_demo'];
        $long = str_repeat('Always answer politely and route vacation requests to Human resources. ', 3);
        $graph['nodes'][2]['config']['instructions'] = $long;        // one line longer than 80 columns
        $graph['nodes'][0]['config']['prompt'] = $long;
        $single = implode("\n", $this->files($graph, 'single'));
        $pkg = $this->files($graph, 'modular');
        $this->assertStringContainsString(rtrim($long), $single, 'single file: system prompt and DEFAULT_PROMPT verbatim');
        $this->assertStringContainsString(rtrim($long), $pkg['agents/it_claims.py']);
        $this->assertStringContainsString('def save_output(', $single);
        $this->assertStringContainsString('def save_output(', $pkg['common.py']);
        $root = sys_get_temp_dir() . '/lgsave_' . bin2hex(random_bytes(4));
        $names = [];
        foreach (['single' => array_values(self::write($this->files($graph, 'single'))['paths'])[0],
                  'modular' => self::write($pkg)['root']] as $mode => $target) {
            [$r] = $this->probe(['save', $target, 'hello'], ['SYNERGYAI_OUTPUT_ROOT' => $root]);
            $names[$mode] = preg_replace('/_\d{8}-\d{6}\./', '_<ts>.', basename((string) $r['path']));
        }
        $this->assertSame(['single' => '44-dispatcher-demo_<ts>.md', 'modular' => '44-dispatcher-demo_<ts>.md'], $names);
    }

    public function testLinearWorkflowRunsTheSameInSingleAndModular(): void    // Review Focus 1
    {
        $graph = self::graphs()['linear'];
        $single = $this->files($graph, 'single');
        $this->assertStringContainsString('class WorkflowGraph:', implode("\n", $single));
        [$a, $logA] = $this->probe(['workflow', 'single', array_values(self::write($single)['paths'])[0], 'write something']);
        [$b] = $this->probe(['workflow', 'modular', self::write($this->files($graph, 'modular'))['root'], 'write something']);
        $this->assertSame($a['output'], $b['output']);
        $this->assertStringStartsWith('answer to:', $a['output']);
        $this->assertStringContainsString('[node] [4] output -- ', $logA);
    }

    public function testOneGraphImplementationInEveryMode(): void
    {
        foreach (['single', 'modular', 'a2a'] as $mode) {
            $all = implode("\n", $this->files(self::graphs()['dispatcher_demo'], $mode));
            $this->assertSame(1, substr_count($all, 'class WorkflowGraph:'), $mode);
            $this->assertSame(0, substr_count($all, 'def make_start('), $mode);
            $this->assertSame(0, substr_count($all, "def _save_output("), $mode);
        }
    }

    public function testSkillStepOutputBecomesTheNodeOutput(): void            // Review Focus 5
    {
        $base = sys_get_temp_dir() . '/lgskill_' . bin2hex(random_bytes(4));
        @mkdir("{$base}/skills/lgtest/scripts", 0777, true);
        file_put_contents("{$base}/skills/lgtest/SKILL.md", "---\nname: lgtest\n---\nRender the input with scripts/make.py.\n");
        file_put_contents("{$base}/skills/lgtest/scripts/make.py",
            "import sys\nopen(sys.argv[1], 'w', encoding='utf-8').write('<html>made by the skill</html>')\nprint('ok')\n");
        $graph = self::graphs()['linear'];
        $graph['nodes'][2]['config']['bound_skill'] = ['dir_name' => 'lgtest'];
        $root = self::write($this->files($graph, 'modular'))['root'];
        [$r, $log] = $this->probe(['node', 'module', $root, 'agents.writer', 'write something'], [
            'SYNERGYAI_SKILLS_DIR' => "{$base}/skills", 'SYNERGYAI_OUTPUT_ROOT' => "{$base}/outputs",
            'STUB_SKILL_CALL' => json_encode(['script' => 'scripts/make.py', 'argv' => ['/outputs/report.html'], 'read_outputs' => ['/outputs/report.html']]),
        ]);
        $this->assertSame('<html>made by the skill</html>', $r['text'], $log);
        $this->assertStringContainsString("after skill 'lgtest'", $log);
    }

    public function testToolsAndSkillsAreLangGraphOwnedClasses(): void
    {
        foreach (['single', 'modular', 'a2a'] as $mode) {
            $all = implode("\n", $this->files(self::graphs()['dispatcher_demo'], $mode));
            foreach (['class ToolCatalog:', 'class SkillRuntime:', 'TOOLS = ToolCatalog(TOOL_CATALOG)', 'SKILLS = SkillRuntime('] as $n) {
                $this->assertStringContainsString($n, $all, "{$mode}: {$n}");
            }
            foreach (['def build_tools_from_catalog', 'def _run_skill_script(', 'RUN_SKILL_SCRIPT_TOOL', 'def _summarize_tool_result'] as $gone) {
                $this->assertStringNotContainsString($gone, $all, "{$mode}: {$gone}");
            }
        }
    }
}
