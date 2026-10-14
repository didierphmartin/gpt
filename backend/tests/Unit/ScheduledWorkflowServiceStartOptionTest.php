<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\ScheduledWorkflowService;
use PHPUnit\Framework\TestCase;

/** spec 2026-10-13 start-trigger-options §2: an event schedule remembers the option it came from. */
final class ScheduledWorkflowServiceStartOptionTest extends TestCase
{
    private \PDO $pdo;
    private \DateTimeImmutable $clock;

    protected function setUp(): void
    {
        $this->clock = new \DateTimeImmutable('2026-10-14 09:00:00');
        $this->pdo = new \PDO('sqlite::memory:');
        $this->pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $this->pdo->sqliteCreateFunction('NOW', fn() => $this->clock->format('Y-m-d H:i:s'), 0);
        $this->pdo->exec("CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
            workflow_id INTEGER, input_prompt TEXT, scheduled_time TEXT, status TEXT DEFAULT 'pending',
            repeat_type TEXT DEFAULT 'none', repeat_interval INTEGER DEFAULT 1, cron TEXT, event_trigger TEXT,
            trigger_component_id INTEGER, last_run TEXT, next_run TEXT, running_since TEXT, created_at TEXT, error_message TEXT)");
        $this->pdo->exec('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, name TEXT)');
    }

    private function svc(): ScheduledWorkflowService
    {
        return new ScheduledWorkflowService($this->pdo, fn() => $this->clock);
    }

    private const WATCH = ['server' => 'Outlook', 'tool' => 'wait_for_new', 'args' => ['args' => ['folder' => 'Inbox']]];

    public function testCreateStoresTheComponent(): void
    {
        $s = $this->svc()->create(['user_id' => 3, 'workflow_id' => 64, 'scheduled_time' => '2026-10-14 09:00:00',
            'repeat_type' => 'event', 'event_trigger' => self::WATCH, 'trigger_component_id' => 7]);
        $this->assertSame(7, (int) $s['trigger_component_id']);
        $this->assertNull($s['next_run']);
    }

    public function testCreateWithoutAnOptionLeavesItNull(): void
    {
        $s = $this->svc()->create(['user_id' => 3, 'workflow_id' => 64, 'scheduled_time' => '2026-10-14 09:00:00',
            'repeat_type' => 'event', 'event_trigger' => self::WATCH]);
        $this->assertNull($s['trigger_component_id']);
    }

    public function testUpdateSetsTheComponent(): void
    {
        $s = $this->svc()->create(['user_id' => 3, 'workflow_id' => 64, 'scheduled_time' => '2026-10-14 10:00:00', 'repeat_type' => 'none']);
        $u = $this->svc()->update((int) $s['id'], 3, ['repeat_type' => 'event', 'event_trigger' => self::WATCH, 'trigger_component_id' => 7]);
        $this->assertSame(7, (int) $u['trigger_component_id']);
        $this->assertSame('event', $u['repeat_type']);
    }

    /** Review focus 5: leaving the event (Delay ticked) clears the option with the trigger. */
    public function testLeavingTheEventClearsTheComponent(): void
    {
        $s = $this->svc()->create(['user_id' => 3, 'workflow_id' => 64, 'scheduled_time' => '2026-10-14 10:00:00',
            'repeat_type' => 'event', 'event_trigger' => self::WATCH, 'trigger_component_id' => 7]);
        $u = $this->svc()->update((int) $s['id'], 3, ['repeat_type' => 'daily']);
        $this->assertNull($u['trigger_component_id']);
        $this->assertNull($u['event_trigger']);
    }
}
