<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;

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
