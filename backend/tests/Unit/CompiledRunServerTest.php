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
 * The compiled package's run server: event sink, server gate mode, api.py.
 * Each test writes the generated package to a temp dir and runs a Python
 * probe against it, so these assert BEHAVIOUR of the emitted code, not text.
 */
class CompiledRunServerTest extends TestCase
{
    /** Write the modular manifest for workflow 44 to a fresh temp dir; returns the package root. */
    public static function writePackage(): string
    {
        $m = LangGraphA2AGeneratorTest::generator()->generate(44, '3', ['modular' => true]);
        $root = sys_get_temp_dir() . '/compiled_' . bin2hex(random_bytes(6));
        foreach ($m['files'] as $f) {
            $path = $root . '/' . $f['path'];
            @mkdir(dirname($path), 0777, true);
            file_put_contents($path, $f['code']);
        }
        return $root;
    }

    /**
     * Write a PLAIN two-agent package: start -> Researcher -> Writer -> output.
     *
     * The workflow-44 fixture is a dispatcher demo -- it routes to one child, so
     * a run of it never visits two agent nodes in a row, and its playbook node
     * streams a transcript of its own. This graph has neither: no dispatcher,
     * no playbook, no tools. Every frame a run of it produces therefore comes
     * from _run_node_module itself, which is exactly what node_events_probe.py
     * needs to assert.
     */
    public static function writeLinearPackage(): string
    {
        $agent = fn(string $name) => [
            'type' => 'agent-template', 'agent_name' => $name, 'agent_type' => 'standard',
            'instructions' => "You are {$name}.", 'agent_provider' => 'claude', 'model' => 'claude-sonnet-4-5',
            'tools' => [], 'settings' => ['temperature' => 0.7, 'max_tokens' => 4096],
        ];
        $graph = [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'write something']],
                ['id' => '2', 'node_type' => '', 'config' => $agent('Researcher')],
                ['id' => '3', 'node_type' => '', 'config' => $agent('Writer')],
                ['id' => '4', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3'], ['from' => '3', 'to' => '4']],
        ];
        $t = new self('x');
        $wfRepo = $t->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 77, 'name' => 'Linear demo', 'user_id' => '3']));
        $graphRepo = $t->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph);
        $agentRepo = $t->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        $gen = new LangGraphGenerator(LangGraphA2AGeneratorTest::pdo(), $wfRepo, $graphRepo, $agentRepo);

        $root = sys_get_temp_dir() . '/compiled_linear_' . bin2hex(random_bytes(6));
        foreach ($gen->generate(77, '3', ['modular' => true])['files'] as $f) {
            $path = $root . '/' . $f['path'];
            @mkdir(dirname($path), 0777, true);
            file_put_contents($path, $f['code']);
        }
        return $root;
    }

    /** Run a probe script from tests/fixtures/compiled/ with the package root as argv[1]. */
    protected function probe(string $name, string $root): array
    {
        $probe = __DIR__ . '/../fixtures/compiled/' . $name;
        exec('python3 ' . escapeshellarg($probe) . ' ' . escapeshellarg($root) . ' 2>&1', $out, $rc);
        return [$rc, implode("\n", $out)];
    }

    public function testEventSinkIsInertUntilInstalledThenReceivesPlaybookEvents(): void
    {
        [$rc, $out] = $this->probe('sink_probe.py', self::writePackage());
        $this->assertSame(0, $rc, $out);
        $this->assertStringContainsString('OK', $out);
    }

    public function testServerGateModeBlocksUntilAnsweredAndFallsBackOnTimeout(): void
    {
        [$rc, $out] = $this->probe('gate_probe.py', self::writePackage());
        $this->assertSame(0, $rc, $out);
        $this->assertStringContainsString('OK', $out);
    }

    public function testApiFileIsEmittedIntoTheModularPackage(): void
    {
        $m = LangGraphA2AGeneratorTest::generator()->generate(44, '3', ['modular' => true]);
        $this->assertSame([
            'workflow.py', 'common.py', 'api.py', 'agents/__init__.py',
            'agents/techbuddy.py', 'agents/it_claims.py', 'agents/human_resources.py', 'agents/playbook_hr.py',
        ], array_column($m['files'], 'path'));
        $api = $m['files'][2]['code'];
        foreach (['"""Run server for workflow "Dispatcher demo"', 'PROVENANCE', 'GRAPH EDGES',
                  'from fastapi import FastAPI', 'from workflow import run as run_workflow',
                  'from common import set_event_sink, resolve_gate', 'class RunState',
                  '@app.post("/runs")', '@app.get("/runs/{run_id}/events")',
                  '@app.post("/runs/{run_id}/tool-result")', '@app.get("/.well-known/workflow.json")',
                  'uvicorn.run(', 'WORKFLOW_API_PORT'] as $needle) {
            $this->assertStringContainsString($needle, $api, "missing: {$needle}");
        }
        $this->assertStringNotContainsString('Authorization', $api, 'the run server has no auth');
    }

    public function testApiServesARunEndToEnd(): void
    {
        [$rc, $out] = $this->probe('api_probe.py', self::writePackage());
        $this->assertSame(0, $rc, $out);
        $this->assertStringContainsString('OK', $out);
    }

    public function testAReconnectingClientReplaysMissedEvents(): void
    {
        [$rc, $out] = $this->probe('replay_probe.py', self::writePackage());
        $this->assertSame(0, $rc, $out);
        $this->assertStringContainsString('OK', $out);
    }

    public function testApiActuallyStreamsFramesBeforeTheRunCompletes(): void
    {
        [$rc, $out] = $this->probe('stream_probe.py', self::writePackage());
        $this->assertSame(0, $rc, $out);
        $this->assertStringContainsString('OK', $out);
    }

    /**
     * The regression guard for "no per-node progress reaches the browser":
     * a real compiled graph, only the chat model stubbed, must put at least
     * one frame per node on the stream before the terminal done.
     */
    public function testARealGraphStreamsAFramePerNode(): void
    {
        [$rc, $out] = $this->probe('node_events_probe.py', self::writeLinearPackage());
        $this->assertSame(0, $rc, $out);
        $this->assertStringContainsString('OK', $out);
    }

    public function testA2AManifestCarriesTheSameRunServer(): void
    {
        $m = LangGraphA2AGeneratorTest::generator()->generate(44, '3', ['a2a' => true]);
        $paths = array_column($m['files'], 'path');
        $this->assertContains('api.py', $paths);
        $api = $m['files'][array_search('api.py', $paths, true)]['code'];
        foreach (['@app.post("/runs")', '@app.get("/runs/{run_id}/events")',
                  '@app.get("/.well-known/workflow.json")', 'AgentSupervisor',
                  'from orchestrator import run as run_workflow'] as $needle) {
            $this->assertStringContainsString($needle, $api, "missing: {$needle}");
        }
    }
}
