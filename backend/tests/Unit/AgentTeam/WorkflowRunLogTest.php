<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\WorkflowRunLog;

class WorkflowRunLogTest extends TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/wrl-' . bin2hex(random_bytes(6));
    }

    protected function tearDown(): void
    {
        if (is_dir($this->dir)) {
            foreach (glob($this->dir . '/*') ?: [] as $f) { @unlink($f); }
            @rmdir($this->dir);
        }
    }

    private function validRunId(): string
    {
        return bin2hex(random_bytes(16)); // 32 hex chars
    }

    public function testAppendThenReadRoundTripsEvents(): void
    {
        $log = new WorkflowRunLog($this->dir);
        $runId = $this->validRunId();

        $log->append($runId, ['type' => 'workflow_start', 'run_id' => $runId]);
        $log->append($runId, ['type' => 'node_start', 'node_id' => 5, 'input' => 'hello']);
        $log->append($runId, ['type' => 'node_complete', 'node_id' => 5, 'output' => 'world']);

        $events = $log->read($runId);
        $this->assertIsArray($events);
        $this->assertCount(3, $events);
        $this->assertSame('node_start', $events[1]['type']);
        $this->assertSame('hello', $events[1]['input']);
        $this->assertSame('world', $events[2]['output']);
    }

    public function testReadMissingRunReturnsNull(): void
    {
        $log = new WorkflowRunLog($this->dir);
        $this->assertNull($log->read($this->validRunId()));
    }

    public function testReadInvalidRunIdReturnsNull(): void
    {
        $log = new WorkflowRunLog($this->dir);
        $this->assertNull($log->read('../etc/passwd'));
    }

    public function testAppendInvalidRunIdIsNoOp(): void
    {
        $log = new WorkflowRunLog($this->dir);
        $log->append('not-a-valid-id', ['type' => 'x']); // must not throw
        $this->assertFalse(is_dir($this->dir) && count(glob($this->dir . '/*') ?: []) > 0);
    }

    public function testDefaultDirFromConfigOverride(): void
    {
        $this->assertSame('/custom/runs', WorkflowRunLog::defaultDir(['workflow_runs_dir' => '/custom/runs']));
    }
}
