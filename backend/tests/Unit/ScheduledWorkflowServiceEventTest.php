<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\ScheduledWorkflowService;
use PHPUnit\Framework\TestCase;

/** spec 2026-10-12 mail/drive events §8: 'event' schedules carry a trigger and are never claimed by a tick. */
final class ScheduledWorkflowServiceEventTest extends TestCase
{
    private \PDO $pdo;
    private \DateTimeImmutable $clock;

    protected function setUp(): void
    {
        $this->clock = new \DateTimeImmutable('2026-10-12 10:42:30');
        $this->pdo = new \PDO('sqlite::memory:');
        $this->pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $this->pdo->sqliteCreateFunction('NOW', fn() => $this->clock->format('Y-m-d H:i:s'), 0);
        $this->pdo->exec("CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
            workflow_id INTEGER, input_prompt TEXT, scheduled_time TEXT, status TEXT DEFAULT 'pending',
            repeat_type TEXT DEFAULT 'none', repeat_interval INTEGER DEFAULT 1, cron TEXT, event_trigger TEXT,
            last_run TEXT, next_run TEXT, running_since TEXT, created_at TEXT, error_message TEXT)");
        $this->pdo->exec('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, name TEXT)');
        $this->pdo->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
    }

    private function svc(): ScheduledWorkflowService
    {
        return new ScheduledWorkflowService($this->pdo, fn() => $this->clock);
    }

    private const TRIGGER = ['server' => 'Outlook', 'tool' => 'wait_for_new', 'args' => ['args' => ['folder' => 'Inbox']]];

    private function eventSchedule(mixed $trigger = self::TRIGGER): array
    {
        return $this->svc()->create(['user_id' => 3, 'workflow_id' => 64, 'scheduled_time' => '2026-10-12 10:00:00',
            'repeat_type' => 'event', 'event_trigger' => $trigger]);
    }

    public function testCreateStoresTheTriggerAndNoNextRun(): void
    {
        $s = $this->eventSchedule();
        self::assertSame('event', $s['repeat_type']);
        self::assertNull($s['next_run']);
        self::assertNull($s['cron']);
        self::assertSame('{"server":"Outlook","tool":"wait_for_new","args":{"args":{"folder":"Inbox"}}}', $s['event_trigger']);
    }

    public function testATickNeverClaimsAnEventSchedule(): void
    {
        $s = $this->eventSchedule();
        $this->clock = $this->clock->modify('+10 years');
        self::assertSame([], $this->svc()->getDueSchedules());
        self::assertFalse($this->svc()->claim((int) $s['id']));
    }

    public function testTheTriggerIsNormalised(): void
    {
        $s = $this->eventSchedule('{"server": " Outlook ", "tool": "wait_for_new"}');   // JSON text, no args
        self::assertSame('{"server":"Outlook","tool":"wait_for_new","args":{}}', $s['event_trigger']);
    }

    /** @dataProvider badTriggers */
    public function testABadTriggerIsRefused(mixed $trigger): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->eventSchedule($trigger);
    }

    public static function badTriggers(): array
    {
        return [
            'missing' => [null], 'not JSON' => ['{oops'], 'no server' => [['tool' => 'w']], 'no tool' => [['server' => 'Outlook']],
            'blank tool' => [['server' => 'Outlook', 'tool' => '  ']], 'args a list' => [['server' => 'O', 'tool' => 'w', 'args' => [1, 2]]],
            'args a string' => [['server' => 'O', 'tool' => 'w', 'args' => 'x']],
        ];
    }

    public function testOtherSchedulesDoNotTouchTheColumn(): void
    {
        // A database the event migration has not reached: cron and timed schedules still work.
        $this->pdo->exec('ALTER TABLE scheduled_workflows DROP COLUMN event_trigger');
        $s = $this->svc()->create(['user_id' => 3, 'workflow_id' => 64, 'scheduled_time' => '2026-10-12 11:00:00', 'repeat_type' => 'daily']);
        self::assertSame('2026-10-12 11:00:00', $s['next_run']);
        $s = $this->svc()->create(['user_id' => 3, 'workflow_id' => 64, 'scheduled_time' => '2026-10-12 11:00:00',
            'repeat_type' => 'cron', 'cron' => '*/5 * * * *']);
        self::assertSame('2026-10-12 10:45:00', $s['next_run']);
        $this->svc()->update((int) $s['id'], 3, ['input_prompt' => 'poll']);
        self::assertSame('poll', $this->svc()->findById((int) $s['id'])['input_prompt']);
    }

    public function testUpdateChangesTheTrigger(): void
    {
        $s = $this->eventSchedule();
        $u = $this->svc()->update((int) $s['id'], 3, ['repeat_type' => 'event',
            'event_trigger' => ['server' => 'Outlook', 'tool' => 'wait_for_new', 'args' => ['timeout_s' => 60]]]);
        self::assertSame('{"server":"Outlook","tool":"wait_for_new","args":{"timeout_s":60}}', $u['event_trigger']);
        self::assertNull($u['next_run']);
        $u = $this->svc()->update((int) $s['id'], 3, ['input_prompt' => 'go']);   // the trigger is kept
        self::assertSame('{"server":"Outlook","tool":"wait_for_new","args":{"timeout_s":60}}', $u['event_trigger']);
    }

    public function testCronBecomesEventAndBack(): void
    {
        $s = $this->svc()->create(['user_id' => 3, 'workflow_id' => 64, 'scheduled_time' => '2026-10-12 10:00:00',
            'repeat_type' => 'cron', 'cron' => '*/2 * * * *']);
        self::assertSame('2026-10-12 10:44:00', $s['next_run']);
        $u = $this->svc()->update((int) $s['id'], 3, ['repeat_type' => 'event', 'event_trigger' => self::TRIGGER, 'cron' => null]);
        self::assertSame('event', $u['repeat_type']);
        self::assertNull($u['next_run']);
        self::assertNull($u['cron']);
        $u = $this->svc()->update((int) $s['id'], 3, ['repeat_type' => 'cron', 'cron' => '*/2 * * * *']);
        self::assertNull($u['event_trigger']);
        self::assertSame('2026-10-12 10:44:00', $u['next_run']);
        $this->svc()->update((int) $s['id'], 3, ['repeat_type' => 'event', 'event_trigger' => self::TRIGGER]);
        $u = $this->svc()->update((int) $s['id'], 3, ['repeat_type' => 'daily']);   // timed again: from its time
        self::assertNull($u['event_trigger']);
        self::assertSame('2026-10-12 10:00:00', $u['next_run']);
    }

    public function testUpdateToEventWithoutATriggerIsRefused(): void
    {
        $s = $this->svc()->create(['user_id' => 3, 'workflow_id' => 64, 'scheduled_time' => '2026-10-12 10:00:00', 'repeat_type' => 'daily']);
        $this->expectException(\InvalidArgumentException::class);
        $this->svc()->update((int) $s['id'], 3, ['repeat_type' => 'event']);
    }
}
