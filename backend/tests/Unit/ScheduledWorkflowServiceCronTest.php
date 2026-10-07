<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\ScheduledWorkflowService;
use PHPUnit\Framework\TestCase;

final class ScheduledWorkflowServiceCronTest extends TestCase
{
    private \PDO $pdo;
    private \DateTimeImmutable $clock;

    protected function setUp(): void
    {
        $this->clock = new \DateTimeImmutable('2026-10-07 10:42:30');
        $this->pdo = new \PDO('sqlite::memory:');
        $this->pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $this->pdo->sqliteCreateFunction('NOW', fn() => $this->clock->format('Y-m-d H:i:s'), 0);
        $this->pdo->exec("CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
            workflow_id INTEGER, input_prompt TEXT, scheduled_time TEXT, status TEXT DEFAULT 'pending',
            repeat_type TEXT DEFAULT 'none', repeat_interval INTEGER DEFAULT 1, cron TEXT, last_run TEXT,
            next_run TEXT, running_since TEXT, created_at TEXT, error_message TEXT)");
        $this->pdo->exec('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, name TEXT)');
        $this->pdo->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
    }

    private function svc(): ScheduledWorkflowService
    {
        return new ScheduledWorkflowService($this->pdo, fn() => $this->clock);
    }

    private function cronSchedule(string $cron = '*/2 * * * *'): array
    {
        return $this->svc()->create(['user_id' => 3, 'workflow_id' => 44, 'scheduled_time' => '2026-10-07 10:00:00',
            'repeat_type' => 'cron', 'cron' => $cron]);
    }

    /** A cron schedule whose next_run has already passed, so claim() may take it. */
    private function dueCronSchedule(): array
    {
        $s = $this->cronSchedule();
        $this->pdo->exec("UPDATE scheduled_workflows SET next_run = '2026-10-07 10:42:00' WHERE id = " . (int) $s['id']);
        return $s;
    }

    public function testCreateCronComputesNextRunFromNow(): void
    {
        $s = $this->cronSchedule();
        self::assertSame('cron', $s['repeat_type']);
        self::assertSame('*/2 * * * *', $s['cron']);
        self::assertSame('2026-10-07 10:44:00', $s['next_run']);
    }

    public function testCreateRejectsBadCron(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->cronSchedule('61 * * * *');
    }

    public function testCompletedCronRunSchedulesFromNowNotFromLastNextRun(): void
    {
        $s = $this->cronSchedule();
        $this->clock = new \DateTimeImmutable('2026-10-07 11:30:10');   // the tick ran late
        $this->svc()->markCompleted((int) $s['id']);
        $row = $this->svc()->findById((int) $s['id']);
        self::assertSame('2026-10-07 11:32:00', $row['next_run']);
        self::assertSame('pending', $row['status']);
        self::assertNull($row['running_since']);
    }

    public function testFailedCronRunStaysRecurring(): void
    {
        $s = $this->cronSchedule();
        $this->svc()->markFailed((int) $s['id'], 'boom');
        $row = $this->svc()->findById((int) $s['id']);
        self::assertSame('pending', $row['status']);
        self::assertSame('2026-10-07 10:44:00', $row['next_run']);
    }

    public function testClaimIsExclusive(): void
    {
        $s = $this->dueCronSchedule();
        self::assertTrue($this->svc()->claim((int) $s['id']));
        self::assertFalse($this->svc()->claim((int) $s['id']), 'a second tick must not claim a running schedule');
    }

    public function testStaleRunningIsReclaimed(): void
    {
        $s = $this->dueCronSchedule();
        self::assertTrue($this->svc()->claim((int) $s['id']));
        $this->clock = $this->clock->modify('+61 minutes');
        $due = $this->svc()->getDueSchedules();
        self::assertSame([(int) $s['id']], array_map(fn($r) => (int) $r['id'], $due));
        self::assertTrue($this->svc()->claim((int) $s['id']));
    }

    public function testRunningWithinWindowIsNotDue(): void
    {
        $s = $this->dueCronSchedule();
        self::assertTrue($this->svc()->claim((int) $s['id']));
        $this->clock = $this->clock->modify('+10 minutes');
        self::assertSame([], $this->svc()->getDueSchedules());
    }

    public function testHourlyScheduleUnchanged(): void
    {
        $s = $this->svc()->create(['user_id' => 3, 'workflow_id' => 44, 'scheduled_time' => '2026-10-07 10:00:00',
            'repeat_type' => 'hourly', 'repeat_interval' => 2]);
        $this->svc()->markCompleted((int) $s['id']);
        self::assertSame('2026-10-07 12:00:00', $this->svc()->findById((int) $s['id'])['next_run']);
    }

    public function testUpdateToCronRecomputesNextRun(): void
    {
        $s = $this->svc()->create(['user_id' => 3, 'workflow_id' => 44, 'scheduled_time' => '2026-10-08 10:00:00']);
        $u = $this->svc()->update((int) $s['id'], 3, ['repeat_type' => 'cron', 'cron' => '*/15 * * * *',
            'scheduled_time' => '2026-10-08 10:00:00']);
        self::assertSame('2026-10-07 10:45:00', $u['next_run']);
    }

    public function testDefaultClockReadsDbNow(): void
    {
        $svc = new ScheduledWorkflowService($this->pdo);   // no injected clock
        $s = $svc->create(['user_id' => 3, 'workflow_id' => 44, 'repeat_type' => 'cron', 'cron' => '*/2 * * * *']);
        self::assertSame('2026-10-07 10:44:00', $s['next_run']);
    }

    public function testRunningWithNullRunningSinceCountsAsStale(): void
    {
        $s = $this->cronSchedule();
        $this->pdo->exec("UPDATE scheduled_workflows SET status = 'running', running_since = NULL WHERE id = " . (int) $s['id']);
        $due = $this->svc()->getDueSchedules();
        self::assertSame([(int) $s['id']], array_map(fn($r) => (int) $r['id'], $due));
        self::assertTrue($this->svc()->claim((int) $s['id']));
    }

    public function testClockIsReadOncePerMethod(): void
    {
        $reads = 0;
        $svc = new ScheduledWorkflowService($this->pdo, function () use (&$reads) {
            $reads++;
            return $this->clock;
        });
        $s = $this->cronSchedule();
        $reads = 0;
        $svc->getDueSchedules();
        self::assertSame(1, $reads, 'getDueSchedules reads the clock once');
        $reads = 0;
        $svc->claim((int) $s['id']);
        self::assertSame(1, $reads, 'claim reads the clock once');
    }

    public function testClaimRefusesAPendingScheduleEditedIntoTheFuture(): void
    {
        $s = $this->cronSchedule();
        $this->pdo->exec("UPDATE scheduled_workflows SET next_run = '2026-10-07 11:00:00' WHERE id = " . (int) $s['id']);
        self::assertFalse($this->svc()->claim((int) $s['id']));
    }
}
