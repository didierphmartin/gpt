<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\RunServerEmitter;

/**
 * The run server is emitted for four targets from one place. These pin the
 * pieces every target depends on; the byte-identity of LangGraph's own output
 * is pinned by the existing generator tests and is the real proof the
 * extraction was inert.
 */
final class RunServerEmitterTest extends TestCase
{
    public function testEmitsTheRunProtocolRoutes(): void
    {
        $out = RunServerEmitter::emit('Demo', 'doc body', 'from workflow import run_workflow', 'WORKFLOW_VERSION = "1"');
        $this->assertStringContainsString('@app.post("/runs")', $out);
        $this->assertStringContainsString('@app.get("/runs/{run_id}/events")', $out);
        $this->assertStringContainsString('@app.get("/.well-known/workflow.json")', $out);
    }

    public function testCarriesTheCallersImportLineVerbatim(): void
    {
        $line = 'from workflow import run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME';
        $out = RunServerEmitter::emit('Demo', 'doc body', $line, 'WORKFLOW_VERSION = "1"');
        $this->assertStringContainsString($line, $out);
    }

    public function testTheVersionLineIsAlwaysDefined(): void
    {
        // Not decoration: the __main__ startup print reads WORKFLOW_VERSION
        // BEFORE uvicorn.run, so a server emitted without it raises NameError
        // and exits before binding a port. The parameter is required for that
        // reason -- this pins that every emitted server defines the name the
        // runtime block reads.
        $out = RunServerEmitter::emit('Demo', 'doc body', 'from workflow import run_workflow', 'WORKFLOW_VERSION = "1"');
        $this->assertStringContainsString("\nWORKFLOW_VERSION = \"1\"\n", $out);
        $this->assertStringContainsString('{WORKFLOW_VERSION}', $out);
    }

    public function testCommonBlockGivesTheSinkApiPyImports(): void
    {
        $common = RunServerEmitter::commonBlock();
        $this->assertStringContainsString('def set_event_sink(', $common);
        $this->assertStringContainsString('def emit_event(', $common);
        // api.py does `from common import set_event_sink, resolve_gate`, so a
        // target emitting this block satisfies that import without a gate
        // implementation of its own.
        $this->assertStringContainsString('def resolve_gate(', $common);
    }

    /**
     * The one pin that covers ADK, MAF and NOOA at once: before package()
     * existed, the file set, the api.py import line and the version literal
     * were written out three times and nothing compared the copies.
     */
    public function testPackageEmitsTheSameFourFilesForEveryTarget(): void
    {
        foreach (['adk', 'maf', 'nooa'] as $suffix) {
            $pkg = RunServerEmitter::package(['code' => '# workflow'], 'Dispatcher demo', $suffix, "{$suffix} run server");
            $this->assertSame("dispatcher_demo_{$suffix}", $pkg['root']);

            $files = array_column($pkg['files'], 'code', 'path');
            $this->assertSame(['__init__.py', 'workflow.py', 'common.py', 'api.py'], array_keys($files));
            $this->assertSame('# workflow', $files['workflow.py']);
            $this->assertStringContainsString('import threading', $files['common.py']);
            // api.py imports run_workflow (the contract), not a target-specific
            // entry point, and defines the version its runtime block reads.
            $this->assertStringContainsString(
                'from workflow import run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME',
                $files['api.py']
            );
            $this->assertStringContainsString('WORKFLOW_VERSION = "1"', $files['api.py']);
            $this->assertStringContainsString("{$suffix} run server", $files['api.py']);
        }
    }
}
