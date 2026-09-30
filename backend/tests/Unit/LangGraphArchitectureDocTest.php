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
 * ARCHITECTURE.md: the LangGraph compiler describes the package it emits --
 * its files, the classes actually present, this workflow's graph, how a run
 * flows and how to change it -- for the single file, modular and A2A modes.
 */
class LangGraphArchitectureDocTest extends TestCase
{
    private function generate(string|array $graph, string $mode): array
    {
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Dispatcher demo', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn(is_array($graph) ? $graph : LangGraphOutputStructureTest::graphs()[$graph]);
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        $gen = new LangGraphGenerator(LangGraphA2AGeneratorTest::pdo(), $wfRepo, $graphRepo, $agentRepo);
        return $gen->generate(44, '3', $mode === 'single' ? [] : [$mode => true]);
    }

    /** The two ```mermaid blocks, keyed by their first line (the diagram type). */
    private static function mermaidBlocks(string $doc): array
    {
        preg_match_all('/```mermaid\n(.*?)```/s', $doc, $m);
        $out = [];
        foreach ($m[1] as $body) {
            $out[strtok($body, "\n")] = $body;
        }
        return $out;
    }

    public function testEveryModeExposesTheDocAndKeepsItsExistingKeys(): void
    {
        $single = $this->generate('dispatcher_demo', 'single');
        $this->assertSame(['filename', 'code', 'architecture'], array_keys($single));
        foreach (['modular', 'a2a'] as $mode) {
            $r = $this->generate('dispatcher_demo', $mode);
            $this->assertSame(['root', 'files', 'architecture'], array_keys($r), $mode);
            $last = end($r['files']);
            $this->assertSame('ARCHITECTURE.md', $last['path'], "{$mode}: written beside the code, last");
            $this->assertSame($r['architecture'], $last['code'], $mode);
        }
    }

    public function testDocHasBothDiagramsAndEverySection(): void
    {
        foreach (['single', 'modular', 'a2a'] as $mode) {
            $doc = $this->generate('dispatcher_demo', $mode)['architecture'];
            $this->assertStringStartsWith('# Dispatcher demo', $doc, $mode);
            foreach (['## Files', '## Class diagram', '## Workflow diagram', '## Classes', '## How a run flows', '## How to change it'] as $h) {
                $this->assertStringContainsString("\n{$h}\n", $doc, "{$mode}: {$h}");
            }
            $blocks = self::mermaidBlocks($doc);
            $this->assertSame(['classDiagram', 'flowchart LR'], array_keys($blocks), $mode);
        }
    }

    public function testFilesTableNamesTheRealFilesOfEachMode(): void
    {
        $single = $this->generate('dispatcher_demo', 'single')['architecture'];
        $this->assertStringContainsString('| `dispatcher_demo_langgraph.py` |', $single);

        $modular = $this->generate('dispatcher_demo', 'modular');
        foreach ($modular['files'] as $f) {
            $this->assertStringContainsString("| `{$f['path']}` |", $modular['architecture'], $f['path']);
        }
        $this->assertStringContainsString('`run_node = make_node(NODE).run`', $modular['architecture']);

        $a2a = $this->generate('dispatcher_demo', 'a2a');
        foreach ($a2a['files'] as $f) {
            $this->assertStringContainsString("| `{$f['path']}` |", $a2a['architecture'], $f['path']);
        }
    }

    public function testClassDiagramListsOnlyTheClassesPresent(): void
    {
        $base = ['Node', 'AgentNode', 'DispatcherNode', 'NodeKind', 'Dispatcher', 'JevRouter', 'JevResult',
            'RouteDecision', 'RoutingMode', 'WorkflowGraph', 'ToolCatalog', 'McpClient', 'SkillRuntime',
            'RunEvents', 'DocumentConverter'];
        $playbook = ['PlaybookNode', 'PlaybookRun', 'PlaybookToolset'];
        $a2aOnly = ['AgentSupervisor', 'NodeExecutor'];

        $cases = [
            ['dispatcher_demo', 'modular', array_merge($base, $playbook), $a2aOnly],
            ['dispatcher_demo', 'a2a', array_merge($base, $playbook, $a2aOnly), []],
            ['linear', 'single', $base, array_merge($playbook, $a2aOnly)],
        ];
        foreach ($cases as [$graph, $mode, $present, $absent]) {
            $r = $this->generate($graph, $mode);
            $doc = $r['architecture'];
            $diagram = self::mermaidBlocks($doc)['classDiagram'];
            $code = $mode === 'single' ? $r['code'] : implode("\n", array_column($r['files'], 'code'));
            foreach ($present as $cls) {
                $this->assertMatchesRegularExpression('/\b' . $cls . '\b/', $diagram, "{$graph}/{$mode}: {$cls} in the diagram");
                $this->assertStringContainsString("### {$cls}\n", $doc, "{$graph}/{$mode}: {$cls} described");
                $this->assertMatchesRegularExpression('/^class ' . $cls . '\b/m', $code, "{$graph}/{$mode}: {$cls} really emitted");
            }
            foreach ($absent as $cls) {
                $this->assertDoesNotMatchRegularExpression('/\b' . $cls . '\b/', $diagram, "{$graph}/{$mode}: no {$cls}");
                $this->assertStringNotContainsString("### {$cls}", $doc, "{$graph}/{$mode}: no {$cls} section");
            }
        }
    }

    public function testNoPlaybookSectionWithoutAPlaybook(): void
    {
        $doc = $this->generate('linear', 'modular')['architecture'];
        $this->assertStringNotContainsString('Playbook', $doc);
        $this->assertStringNotContainsString('PLAYBOOK_GATE_MODE', $doc);
    }

    public function testWorkflowDiagramNamesEveryNodeAndLabelsDispatcherChoices(): void
    {
        $flow = self::mermaidBlocks($this->generate('dispatcher_demo', 'modular')['architecture'])['flowchart LR'];
        foreach (['Start', 'techBuddy', 'IT claims', 'Human resources', 'Playbook HR', 'Output'] as $name) {
            $this->assertStringContainsString("\"{$name}", $flow, $name);
        }
        $this->assertStringContainsString('n1 --> n2', $flow);
        $this->assertStringContainsString('n2 -.->|choice| n3', $flow);
        $this->assertStringContainsString('n2 -.->|choice| n4', $flow);
        $this->assertStringContainsString('n4 --> n5', $flow);
        $this->assertStringNotContainsString('n1 -.->', $flow);

        $linear = self::mermaidBlocks($this->generate('linear', 'single')['architecture'])['flowchart LR'];
        foreach (['Start', 'Researcher', 'Writer', 'Output'] as $name) {
            $this->assertStringContainsString("\"{$name}", $linear, $name);
        }
        $this->assertStringNotContainsString('choice', $linear);
    }

    /** An ingestion pipeline is not an agent graph: its single-file result carries no architecture doc (null, key kept). */
    public function testIngestionWorkflowGetsNoArchitectureDoc(): void
    {
        $r = $this->generate([
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start']],
                ['id' => '2', 'node_type' => 'loader', 'config' => ['type' => 'loader']],
                ['id' => '3', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3']],
        ], 'single');
        $this->assertSame(['filename', 'code', 'architecture'], array_keys($r));
        $this->assertNull($r['architecture']);
        $this->assertNotSame('', $r['code'], 'the script itself is still generated');
    }

    /**
     * The doc is a companion: when it cannot be built, a modular/A2A package
     * still returns every code file, without ARCHITECTURE.md (architecture null,
     * key kept), and its zip carries the code alone.
     */
    public function testADocFailureStillReturnsTheCodeFiles(): void
    {
        $facts = LangGraphA2AGeneratorTest::facts();
        $facts['workflow'] = null;   // build() calls $facts['workflow']->isOutputStorageEnabled(): throws
        $with = new \ReflectionMethod(LangGraphGenerator::class, 'withArchitecture');
        $with->setAccessible(true);
        foreach (['modular', 'a2a'] as $mode) {
            $code = [['path' => 'workflow.py', 'code' => 'print(1)'], ['path' => 'agents/a.py', 'code' => 'NODE = {}']];
            $r = $with->invoke(null, ['root' => "demo_{$mode}", 'files' => $code], $facts, $mode);
            $this->assertSame($code, $r['files'], "{$mode}: the code files, nothing added");
            $this->assertArrayHasKey('architecture', $r, $mode);
            $this->assertNull($r['architecture'], $mode);
            $zip = \AgentTeam\Controllers\WorkflowController::langGraphZipResponse($r, $mode);
            $tmp = tempnam(sys_get_temp_dir(), 'lgzip');
            file_put_contents($tmp, $zip['raw_body']);
            $z = new \ZipArchive();
            $z->open($tmp);
            $names = [];
            for ($i = 0; $i < $z->numFiles; $i++) {
                $names[] = $z->getNameIndex($i);
            }
            $z->close();
            unlink($tmp);
            $this->assertSame(["demo_{$mode}/workflow.py", "demo_{$mode}/agents/a.py"], $names, $mode);
        }
    }

    /** An ingestion pipeline gets no doc in the multi-file modes either. */
    public function testIngestionPackageGetsNoArchitectureDoc(): void
    {
        $facts = LangGraphA2AGeneratorTest::facts();
        $facts['byId']['99'] = ['id' => '99', 'node_type' => 'loader', 'config' => ['type' => 'loader']];
        $with = new \ReflectionMethod(LangGraphGenerator::class, 'withArchitecture');
        $with->setAccessible(true);
        $r = $with->invoke(null, ['root' => 'feed_modular', 'files' => [['path' => 'workflow.py', 'code' => '']]], $facts, 'modular');
        $this->assertSame(['workflow.py'], array_column($r['files'], 'path'));
        $this->assertNull($r['architecture']);
    }

    public function testRunFlowAndChangeSectionsFollowTheMode(): void
    {
        $single = $this->generate('dispatcher_demo', 'single')['architecture'];
        $this->assertStringContainsString('`_run_local_node`', $single);
        $modular = $this->generate('dispatcher_demo', 'modular')['architecture'];
        $this->assertStringContainsString('`_run_node_module`', $modular);
        $this->assertStringContainsString('python workflow.py', $modular);
        $a2a = $this->generate('dispatcher_demo', 'a2a')['architecture'];
        $this->assertStringContainsString('`_run_remote_node`', $a2a);
        $this->assertStringContainsString('python orchestrator.py', $a2a);
        foreach ([$single, $modular, $a2a] as $doc) {
            $this->assertStringContainsString('WorkflowGraph.run(prompt)', $doc);
            $this->assertStringContainsString('save_output', $doc);
            $this->assertStringContainsString('RUN SUMMARY', $doc);
            $this->assertStringContainsString('ANTHROPIC_API_KEY', $doc);
            $this->assertStringContainsString('DEEPSEEK_API_KEY', $doc);
            $this->assertStringContainsString('TYPESAFE_API_KEY', $doc);
        }
    }
}
