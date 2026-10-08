<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\ScheduledWorkflowService;
use AgentTeam\Services\ScheduleTick;
use PHPUnit\Framework\TestCase;

final class ScheduleTickTest extends TestCase
{
    private \PDO $pdo;
    private ScheduledWorkflowService $svc;

    protected function setUp(): void
    {
        $clock = new \DateTimeImmutable('2026-10-07 10:42:30');
        $this->pdo = new \PDO('sqlite::memory:');
        $this->pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $this->pdo->sqliteCreateFunction('NOW', fn() => $clock->format('Y-m-d H:i:s'), 0);
        $this->pdo->exec("CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
            workflow_id INTEGER, input_prompt TEXT, scheduled_time TEXT, status TEXT DEFAULT 'pending',
            repeat_type TEXT DEFAULT 'none', repeat_interval INTEGER DEFAULT 1, cron TEXT, last_run TEXT,
            next_run TEXT, running_since TEXT, created_at TEXT, error_message TEXT)");
        $this->pdo->exec('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, name TEXT)');
        $this->pdo->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
        $this->svc = new ScheduledWorkflowService($this->pdo, fn() => $clock);
        // A due cron schedule (next_run in the past).
        $this->pdo->exec("INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, cron, next_run, status)
            VALUES (3, 44, 'cron', '*/2 * * * *', '2026-10-07 10:42:00', 'pending')");
    }

    /** @param list<array> $results returned in order, the last one repeated */
    private function tick(array $results, ?int &$calls = 0): array
    {
        $calls = 0;
        $runner = function (array $s) use ($results, &$calls) {
            return $results[min($calls++, count($results) - 1)];
        };
        return (new ScheduleTick($this->svc, $runner))->run();
    }

    public function testQuietRunIsNotListedAndDoesNotDrain(): void
    {
        $r = $this->tick([['success' => true, 'quiet' => true, 'drain' => false]], $calls);
        self::assertSame(1, $calls);
        self::assertSame([], $r['executed']);
        self::assertSame(1, $r['quiet_count']);
        self::assertSame('pending', $this->svc->findById(1)['status']);
    }

    public function testWorkRunDrainsUntilQuiet(): void
    {
        $work = ['success' => true, 'quiet' => false, 'drain' => true, 'execution_id' => 9];
        $quiet = ['success' => true, 'quiet' => true, 'drain' => false];
        $r = $this->tick([$work, $work, $work, $quiet], $calls);
        self::assertSame(4, $calls);
        self::assertCount(3, $r['executed']);
    }

    public function testDrainIsCappedAtTwenty(): void
    {
        $this->tick([['success' => true, 'quiet' => false, 'drain' => true]], $calls);
        self::assertSame(ScheduleTick::MAX_RUNS_PER_TICK, $calls);
    }

    public function testEachDrainRunRefreshesRunningSince(): void
    {
        // A drain longer than the stale window must not be reclaimed by another tick mid-way.
        $clock = new \DateTimeImmutable('2026-10-07 10:42:30');
        $svc = new ScheduledWorkflowService($this->pdo, function () use (&$clock) { return $clock; });
        $seen = [];
        $calls = 0;
        $runner = function (array $s) use ($svc, &$clock, &$seen, &$calls) {
            $seen[] = $svc->findById(1)['running_since'];
            $clock = $clock->modify('+40 minutes');
            return ++$calls < 3 ? ['success' => true, 'quiet' => false, 'drain' => true] : ['success' => true, 'quiet' => true];
        };
        (new ScheduleTick($svc, $runner))->run();
        self::assertSame(['2026-10-07 10:42:30', '2026-10-07 11:22:30', '2026-10-07 12:02:30'], $seen);
    }

    public function testPlainCronWorkflowDoesNotDrain(): void
    {
        // No code node ran: the runner reports drain=false although the run did work.
        $this->tick([['success' => true, 'quiet' => false, 'drain' => false]], $calls);
        self::assertSame(1, $calls);
    }

    public function testQuietRunNeverDrainsEvenIfRunnerSaysDrain(): void
    {
        $this->tick([['success' => true, 'quiet' => true, 'drain' => true]], $calls);
        self::assertSame(1, $calls);
    }

    public function testFailureStopsDrainAndIsRecorded(): void
    {
        $log = tempnam(sys_get_temp_dir(), 'tick');
        $prev = ini_set('error_log', $log);
        try {
            $r = $this->tick([['success' => true, 'drain' => true], ['success' => false, 'error' => 'reconnect_needed']], $calls);
        } finally {
            ini_set('error_log', (string) $prev);
            @unlink($log);
        }
        self::assertSame(2, $calls);
        self::assertSame('reconnect_needed', $r['failed'][0]['error']);
        $row = $this->svc->findById(1);
        self::assertSame('pending', $row['status']);
        self::assertSame('reconnect_needed', $row['error_message']);
    }

    public function testAScheduleClaimedByAnOverlappingTickIsSkipped(): void
    {
        $this->pdo->exec("INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, cron, next_run, status)
            VALUES (3, 45, 'cron', '*/2 * * * *', '2026-10-07 10:42:00', 'pending')");
        $calls = 0;
        $runner = function (array $s) use (&$calls) {
            $calls++;
            $this->svc->claim(2);   // an overlapping tick takes row 2 while we run row 1
            return ['success' => true, 'quiet' => true];
        };
        (new ScheduleTick($this->svc, $runner))->run();
        self::assertSame(1, $calls);
        self::assertSame('running', $this->svc->findById(2)['status']);
    }
}
