<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\LiveStream;
use PHPUnit\Framework\TestCase;

final class LiveStreamTest extends TestCase
{
    /** A fake clock that advances by each sleep; $feeds is what next() returns per call (then nothing). */
    private function drive(array $feeds, ?string $cursor = null, float $max = 50.0, ?callable $aborted = null): array
    {
        $t = 0.0;
        $out = [];
        $calls = [];
        $final = LiveStream::run(
            function (?string $c) use (&$feeds, &$calls) {
                $calls[] = $c;
                return array_shift($feeds) ?? ['events' => [], 'cursor' => $c];
            },
            fn() => ['workflow_id' => 64, 'watch_state' => 'waiting'],
            function (string $event, array $data) use (&$out, &$t) { $out[] = [$event, $data, $t]; },
            function (float $s) use (&$t) { $t += $s; },
            function () use (&$t) { return $t; },
            $aborted ?? fn() => false,
            $cursor,
            $max
        );
        return ['out' => $out, 'final' => $final, 'calls' => $calls];
    }

    public function testEventsCarryTheCursorAndTheLoopEndsWithBye(): void
    {
        $r = $this->drive([['events' => [['type' => 'workflow_start'], ['type' => 'node_start']], 'cursor' => 'c2']], null, 2.0);
        $run = array_values(array_filter($r['out'], fn($o) => $o[0] === 'run'));
        self::assertSame([['cursor' => 'c2', 'event' => ['type' => 'workflow_start']], ['cursor' => 'c2', 'event' => ['type' => 'node_start']]],
            array_column($run, 1));
        self::assertSame(['bye', ['cursor' => 'c2']], array_slice(end($r['out']), 0, 2));
        self::assertSame('c2', $r['final']);
        self::assertSame([null, 'c2'], array_slice($r['calls'], 0, 2));   // the cursor is carried into the next read
    }

    public function testStateFirstThenEveryFiveSecondsAndPingsEveryFifteen(): void
    {
        $r = $this->drive([], 'c0', 31.0);
        $state = array_column(array_values(array_filter($r['out'], fn($o) => $o[0] === 'state')), 2);
        $ping = array_column(array_values(array_filter($r['out'], fn($o) => $o[0] === 'ping')), 2);
        self::assertSame([0.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0], $state);
        self::assertSame([15.0, 30.0], $ping);
        self::assertSame(['active' => ['workflow_id' => 64, 'watch_state' => 'waiting']], $r['out'][0][1]);
    }

    public function testAnAbortedClientEndsTheLoopWithoutBye(): void
    {
        $n = 0;
        $r = $this->drive([], 'c0', 50.0, function () use (&$n) { return ++$n > 3; });
        self::assertNotContains('bye', array_column($r['out'], 0));
        self::assertLessThan(3.0, end($r['out'])[2] ?? 0.0);
    }
}
