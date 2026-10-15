<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\EventWorker;

use AgentTeam\Services\ScheduledWorkflowService;
use AgentTeam\Services\ScheduleTick;
use PDO;
use PHPUnit\Framework\TestCase;

final class ScheduleTickDrainTest extends TestCase
{
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        EventWorkerSchema::create($this->db, fn() => '2026-10-15 10:00:00');
        $this->db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
    }

    private function svc(): ScheduledWorkflowService
    {
        return new ScheduledWorkflowService($this->db, fn() => new \DateTimeImmutable('2026-10-15 10:00:00'));
    }

    public function testDrainStopsOnAQuietRun(): void
    {
        $answers = [['success' => true, 'drain' => true, 'execution_id' => 'a'], ['success' => true, 'quiet' => true]];
        $r = ScheduleTick::drain(function () use (&$answers) { return array_shift($answers); });
        $this->assertSame(['runs' => 2, 'quiet_count' => 1, 'execution_ids' => ['a']], $r);
    }

    public function testDrainStopsAtTwenty(): void
    {
        $n = 0;
        $r = ScheduleTick::drain(function () use (&$n) { $n++; return ['success' => true, 'drain' => true]; });
        $this->assertSame(20, $r['runs']);
    }

    public function testDrainRaisesOnAFailedRun(): void
    {
        $this->expectException(\RuntimeException::class);
        ScheduleTick::drain(fn() => ['success' => false, 'error' => 'boom']);
    }

    public function testDueSchedulesCanBeRestrictedToWorkflows(): void
    {
        EventWorkerSchema::workflow($this->db, 70, 3, null);
        EventWorkerSchema::workflow($this->db, 71, 3, null);
        EventWorkerSchema::row($this->db, 70, 3, 'daily');
        EventWorkerSchema::row($this->db, 71, 3, 'daily');
        $ids = fn(?array $only) => array_map(fn($r) => (int) $r['workflow_id'], $this->svc()->getDueSchedules($only));
        $this->assertSame([70, 71], $ids(null));
        $this->assertSame([71], $ids([71]));
        $this->assertSame([], $ids([]));
    }

    public function testMarkCompletedLeavesAnEventRowWithoutANextRun(): void
    {
        EventWorkerSchema::workflow($this->db, 64, 3, 1);
        $id = EventWorkerSchema::row($this->db, 64, 3, 'event', 1);
        $this->svc()->markCompleted($id);
        $row = $this->db->query("SELECT status, next_run, last_run FROM scheduled_workflows WHERE id = $id")->fetch();
        $this->assertSame(['pending', null, '2026-10-15 10:00:00'], [$row['status'], $row['next_run'], $row['last_run']]);
    }
}
