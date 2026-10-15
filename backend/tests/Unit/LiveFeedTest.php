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

    /** A bare node_start/node_complete stands for a work node's event; an array is appended as given. */
    private function startRun(string $id, array $types): void
    {
        $this->log->markCurrent(64, $id);
        $this->append($id, $types);
    }

    private function append(string $id, array $types): void
    {
        foreach ($types as $t) {
            $this->log->append($id, is_array($t) ? $t : (in_array($t, ['node_start', 'node_complete'], true)
                ? ['type' => $t, 'node_id' => 2598, 'node_type' => 'agent', 'drawflow_id' => '18']
                : ['type' => $t]));
        }
    }

    /** What a quiet poll writes before its .jsonl is unlinked: Start, then the Start option's trigger node. */
    private static function quiet(): array
    {
        return [
            ['type' => 'workflow_start', 'workflow_id' => 64],
            ['type' => 'node_start', 'node_id' => 2597, 'node_type' => 'start', 'drawflow_id' => '17'],
            ['type' => 'node_complete', 'node_id' => 2597, 'node_type' => 'start', 'drawflow_id' => '17'],
            ['type' => 'node_start', 'node_id' => '1000002597', 'node_type' => 'code', 'drawflow_id' => null],
            ['type' => 'node_log', 'node_id' => '1000002597', 'message' => 'outlook.poll_new_mail ok=true (218 ms)'],
            ['type' => 'node_complete', 'node_id' => '1000002597', 'node_type' => 'code', 'drawflow_id' => null],
        ];
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
        $this->startRun(self::A, ['workflow_start', 'node_start']);
        file_put_contents($this->log->pathFor(self::A), '{"type":"node_co', FILE_APPEND);
        $r = LiveFeed::next($this->log, 64, null);
        self::assertSame(['workflow_start', 'node_start'], self::types($r));
        self::assertSame(self::A . ':2', $r['cursor']);
    }

    public function testABadCursorCountsAsAFirstConnect(): void
    {
        $this->startRun(self::A, ['workflow_start', 'node_start']);
        self::assertSame(['workflow_start', 'node_start'], self::types(LiveFeed::next($this->log, 64, 'nonsense')));
    }

    public function testAQuietRunIsHeldBack(): void
    {
        $this->startRun(self::A, ['workflow_start', 'node_start', 'workflow_complete']);
        $this->startRun(self::B, self::quiet());
        self::assertSame(['events' => [], 'cursor' => self::A . ':3'], LiveFeed::next($this->log, 64, self::A . ':3'));
        self::assertSame(['events' => [], 'cursor' => null], LiveFeed::next($this->log, 64, null));
    }

    public function testAHeldBackRunIsReturnedFromItsFirstLineOnceAWorkNodeRuns(): void
    {
        $this->startRun(self::A, ['workflow_start', 'node_start', 'workflow_complete']);
        $this->startRun(self::B, self::quiet());
        LiveFeed::next($this->log, 64, self::A . ':3');
        $this->append(self::B, ['node_start']);
        $r = LiveFeed::next($this->log, 64, self::A . ':3');
        self::assertCount(7, $r['events']);
        self::assertSame('workflow_start', $r['events'][0]['type']);
        self::assertSame(2598, $r['events'][6]['node_id']);
        self::assertSame(self::B . ':7', $r['cursor']);
    }

    public function testARunThatFailsAfterTheTriggerIsReturned(): void
    {
        $this->startRun(self::A, ['workflow_start', 'node_start', 'workflow_complete']);
        $this->startRun(self::B, self::quiet());
        $this->append(self::B, [['type' => 'workflow_error', 'error' => 'boom']]);
        $r = LiveFeed::next($this->log, 64, self::A . ':3');
        self::assertCount(7, $r['events']);
        self::assertSame('workflow_error', $r['events'][6]['type']);
        self::assertSame(self::B . ':7', $r['cursor']);
    }

    public function testTheTailOfTheCursorsRunIsSentBeforeTheNextRun(): void
    {
        $this->startRun(self::A, ['workflow_start', 'node_start']);
        $this->append(self::A, [['type' => 'workflow_complete', 'output' => 'the answer']]);
        $this->startRun(self::B, ['workflow_start', 'node_start']);
        $r = LiveFeed::next($this->log, 64, self::A . ':2');
        self::assertSame(['workflow_complete', 'workflow_start', 'node_start'], self::types($r));
        self::assertSame('the answer', $r['events'][0]['output']);
        self::assertSame(self::B . ':2', $r['cursor']);
    }

    public function testTheTailOfTheCursorsRunIsSentWhileTheNextRunIsHeldBack(): void
    {
        $this->startRun(self::A, ['workflow_start', 'node_start', 'workflow_complete']);
        $this->startRun(self::B, self::quiet());
        $r = LiveFeed::next($this->log, 64, self::A . ':2');
        self::assertSame(['workflow_complete'], self::types($r));
        self::assertSame(self::A . ':3', $r['cursor']);
    }
}
