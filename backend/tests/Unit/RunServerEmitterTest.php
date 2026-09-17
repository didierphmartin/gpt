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
        $out = RunServerEmitter::emit('Demo', 'doc body', 'from workflow import run_workflow');
        $this->assertStringContainsString('@app.post("/runs")', $out);
        $this->assertStringContainsString('@app.get("/runs/{run_id}/events")', $out);
        $this->assertStringContainsString('@app.get("/.well-known/workflow.json")', $out);
    }

    public function testCarriesTheCallersImportLineVerbatim(): void
    {
        $line = 'from workflow import run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME';
        $out = RunServerEmitter::emit('Demo', 'doc body', $line);
        $this->assertStringContainsString($line, $out);
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
}
