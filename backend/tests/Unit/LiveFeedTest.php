<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\LiveFeed;
use AgentTeam\Services\WorkflowRunLog;
use PHPUnit\Framework\TestCase;

final class LiveFeedTest extends TestCase
{
    private string $dir;
    private WorkflowRunLog $log;
    private const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    private const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/livefeed_' . bin2hex(random_bytes(4));
        mkdir($this->dir);
        $this->log = new WorkflowRunLog($this->dir);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/*') ?: [] as $f) {
            @unlink($f);
        }
        @rmdir($this->dir);
    }

    private function startRun(string $id, array $types): void
    {
        $this->log->markCurrent(64, $id);
        foreach ($types as $t) {
            $this->log->append($id, ['type' => $t]);
        }
    }

    private static function types(array $r): array
    {
        return array_column($r['events'], 'type');
    }

    public function testThePointerNamesTheLatestRun(): void
    {
        self::assertNull($this->log->current(64));
        $this->log->markCurrent(64, self::A);
        $this->log->markCurrent(64, self::B);
        self::assertSame(self::B, $this->log->current(64));
        self::assertNull($this->log->current(65));
    }

    public function testNoPointerNoEvents(): void
    {
        self::assertSame(['events' => [], 'cursor' => null], LiveFeed::next($this->log, 64, null));
    }

    public function testFirstConnectSkipsAFinishedRun(): void
    {
        $this->startRun(self::A, ['workflow_start', 'node_start', 'workflow_complete']);
        $r = LiveFeed::next($this->log, 64, null);
        self::assertSame([], $r['events']);
        self::assertSame(self::A . ':3', $r['cursor']);
    }

    public function testFirstConnectReplaysARunInProgress(): void
    {
        $this->startRun(self::A, ['workflow_start', 'node_start']);
        $r = LiveFeed::next($this->log, 64, null);
        self::assertSame(['workflow_start', 'node_start'], self::types($r));
        self::assertSame(self::A . ':2', $r['cursor']);
    }

    public function testFollowsTheLinesAfterTheCursor(): void
    {
        $this->startRun(self::A, ['workflow_start', 'node_start']);
        $this->log->append(self::A, ['type' => 'node_complete']);
        $r = LiveFeed::next($this->log, 64, self::A . ':2');
        self::assertSame(['node_complete'], self::types($r));
        self::assertSame(self::A . ':3', $r['cursor']);
        self::assertSame([], LiveFeed::next($this->log, 64, $r['cursor'])['events']);
    }

    public function testANewRunIsReadFromTheStart(): void
    {
        $this->startRun(self::A, ['workflow_start', 'workflow_complete']);
        $this->startRun(self::B, ['workflow_start', 'node_start', 'workflow_complete']);
        $r = LiveFeed::next($this->log, 64, self::A . ':2');
        self::assertSame(['workflow_start', 'node_start', 'workflow_complete'], self::types($r));
        self::assertSame(self::B . ':3', $r['cursor']);
    }

    public function testAFailedRunIsFinished(): void
    {
        $this->startRun(self::A, ['workflow_start', 'workflow_error']);
        self::assertSame([], LiveFeed::next($this->log, 64, null)['events']);
    }

    public function testADeletedQuietRunIsSkipped(): void
    {
        $this->startRun(self::A, ['workflow_start', 'workflow_complete']);
        $this->log->markCurrent(64, self::B);   // its .jsonl was never kept (a quiet poll)
        $r = LiveFeed::next($this->log, 64, self::A . ':2');
        self::assertSame(['events' => [], 'cursor' => self::A . ':2'], $r);
    }

    public function testAPartialLastLineWaits(): void
    {
        $this->startRun(self::A, ['workflow_start']);
        file_put_contents($this->log->pathFor(self::A), '{"type":"node_st', FILE_APPEND);
        $r = LiveFeed::next($this->log, 64, null);
        self::assertSame(['workflow_start'], self::types($r));
        self::assertSame(self::A . ':1', $r['cursor']);
    }

    public function testABadCursorCountsAsAFirstConnect(): void
    {
        $this->startRun(self::A, ['workflow_start']);
        self::assertSame(['workflow_start'], self::types(LiveFeed::next($this->log, 64, 'nonsense')));
    }
}
