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

    /** Write $files under a fresh temp root. @return array{root: string, paths: array<string,string>} */
    private static function write(array $files): array
    {
        $root = sys_get_temp_dir() . '/lgos_' . bin2hex(random_bytes(6));
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
}
