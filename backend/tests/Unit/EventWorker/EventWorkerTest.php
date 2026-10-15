<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\EventWorker;

use AgentTeam\Services\ActiveWorkflowService;
use AgentTeam\Services\EventWorker;
use AgentTeam\Services\RunSpawner;
use AgentTeam\Services\WatchTransport;
use PDO;
use PHPUnit\Framework\TestCase;

final class FakeTransport implements WatchTransport
{
    public array $open = [];      // key => body
    public array $answers = [];   // key => [body, http, err], handed out by done()
    public int $started = 0;
    public function start(int $key, string $url, array $headers, string $body): void { $this->open[$key] = $body; $this->started++; }
    public function cancel(int $key): void { unset($this->open[$key]); }
    public function done(): array
    {
        $out = [];
        foreach ($this->answers as $k => $a) { if (isset($this->open[$k])) { $out[$k] = $a; unset($this->open[$k]); } }
        $this->answers = [];
        return $out;
    }
    public function answer(int $key, array $payload): void
    {
        $this->answers[$key] = [json_encode(['jsonrpc' => '2.0', 'id' => 1, 'result' => ['structuredContent' => $payload]]), 200, ''];
    }
}

final class FakeRuns implements RunSpawner
{
    public array $started = [];   // [key, scheduleId]
    public array $ended = [];     // key => exit code, handed out by done()
    public int $ticks = 0;
    public function start(int $key, int $scheduleId): void { $this->started[] = [$key, $scheduleId]; }
    public function done(): array { $d = $this->ended; $this->ended = []; return $d; }
    public function scheduleTick(): void { $this->ticks++; }
}

/** spec 2026-10-14 event-worker §3. */
final class EventWorkerTest extends TestCase
{
    private PDO $db;
    private float $t = 1000.0;
    private FakeTransport $tr;
    private FakeRuns $runs;
    private EventWorker $w;
    private int $row;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        EventWorkerSchema::create($this->db, fn() => date('Y-m-d H:i:s', (int) $this->t));
        EventWorkerSchema::option($this->db, 1, 3);
        EventWorkerSchema::workflow($this->db, 64, 3, 1);
        $this->row = EventWorkerSchema::row($this->db, 64, 3, 'event', 1);
        $this->db->exec("INSERT INTO mcp_servers (user_id, name, url, headers) VALUES (3, 'Outlook', 'http://fake/mcp', '{}')");
        $this->tr = new FakeTransport();
        $this->runs = new FakeRuns();
        $active = new ActiveWorkflowService($this->db);
        $this->w = new EventWorker($active, fn(int $u, string $n) => \AgentTeam\Services\WatchCall::server($this->db, $u, $n),
            $this->tr, $this->runs, fn() => $this->t);
    }

    private function active(int $user = 3, int $wf = 64): void { (new ActiveWorkflowService($this->db))->activate($user, $wf); }
    private function state(int $user = 3): array
    {
        return $this->db->query("SELECT watch_state, watch_message FROM active_workflows WHERE user_id = $user")->fetch() ?: [];
    }
    private function step(float $after = 0.0): void { $this->t += $after; $this->w->step(); }

    public function testNothingActiveNothingOpen(): void
    {
        $this->step();
        $this->assertSame([], $this->tr->open);
    }

    public function testAnActiveOptionWorkflowWaitsAndRunsOnReady(): void
    {
        $this->active();
        $this->step();
        $this->assertArrayHasKey(3, $this->tr->open);
        $this->assertSame('waiting', $this->state()['watch_state']);
        $this->tr->answer(3, ['status' => 'ready', 'via' => 'event', 'events' => 'on']);
        $this->step(1);
        $this->assertSame([[3, $this->row]], $this->runs->started);
        $this->assertSame('running', $this->state()['watch_state']);
        $this->assertArrayNotHasKey(3, $this->tr->open);          // no wait during a run
        $this->runs->ended[3] = 0;
        $this->step(1);
        $this->assertArrayHasKey(3, $this->tr->open);             // waiting again
        $this->assertSame(['waiting', null], array_values($this->state()));
    }

    public function testATimeoutWaitsAgain(): void
    {
        $this->active();
        $this->step();
        $this->tr->answer(3, ['status' => 'timeout', 'events' => 'off']);
        $this->step(1);
        $this->assertSame(2, $this->tr->started);
        $this->assertSame(['waiting', 'fallback'], array_values($this->state()));   // events off: the 15-min fallback
    }

    public function testAnErrorBacksOffDoublingToTheCap(): void
    {
        $this->active();
        $this->step();
        $delays = [];
        for ($i = 0; $i < 5; $i++) {
            $this->tr->answer(3, ['error' => 'reconnect_needed']);
            $this->step(1);
            $delays[] = $this->w->slots()[3]['backoff'];
            $this->assertSame(['error', 'reconnect_needed'], array_values($this->state()));
            $this->step($this->w->slots()[3]['until'] - $this->t - 0.5);   // not yet
            $this->assertArrayNotHasKey(3, $this->tr->open);
            $this->step(1);                                                  // due: wait again
            $this->assertArrayHasKey(3, $this->tr->open);
        }
        $this->assertSame([30, 60, 120, 240, 300], $delays);
        $this->tr->answer(3, ['status' => 'timeout']);
        $this->step(1);
        $this->assertSame(0, $this->w->slots()[3]['backoff']);              // a good answer resets it
    }

    public function testAFailedRunKeepsTheWatch(): void
    {
        $this->active();
        $this->step();
        $this->tr->answer(3, ['status' => 'ready']);
        $this->step(1);
        $this->runs->ended[3] = 1;
        $this->step(1);
        $this->assertSame(['waiting', 'run_failed'], array_values($this->state()));
        $this->assertArrayHasKey(3, $this->tr->open);
    }

    public function testAReadyAfterDeactivationStartsNoRun(): void
    {
        $this->active();
        $this->step();
        (new ActiveWorkflowService($this->db))->deactivate(3, 64);
        $this->tr->answers[3] = [json_encode(['result' => ['structuredContent' => ['status' => 'ready']]]), 200, ''];
        $this->step(EventWorker::RECONCILE_S);
        $this->assertSame([], $this->runs->started);
        $this->assertSame([], $this->tr->open);
        $this->assertSame([], $this->w->slots());
    }

    public function testDeactivatingDuringARunOpensNoNewWait(): void
    {
        $this->active();
        $this->step();
        $this->tr->answer(3, ['status' => 'ready']);
        $this->step(1);
        (new ActiveWorkflowService($this->db))->deactivate(3, 64);
        $this->step(EventWorker::RECONCILE_S);
        $this->runs->ended[3] = 0;
        $this->step(1);
        $this->assertSame([], $this->tr->open);
        $this->assertSame([], $this->w->slots());
    }

    public function testNoLinksIsIdleAndResumesWhenFixed(): void
    {
        $this->active();
        $edges = $this->db->query('SELECT * FROM workflow_edges')->fetchAll();
        $this->db->exec('DELETE FROM workflow_edges');
        $this->step();
        $this->assertSame([], $this->tr->open);
        $this->assertSame(['idle', 'no_links'], array_values($this->state()));
        $e = $edges[0];
        $this->db->prepare('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id) VALUES (?, ?, ?)')
            ->execute([$e['workflow_id'], $e['from_node_id'], $e['to_node_id']]);
        $this->step(EventWorker::RECONCILE_S);
        $this->assertArrayHasKey(3, $this->tr->open);
    }

    public function testAMissingServerIsAnErrorWithBackoff(): void
    {
        $this->db->exec('DELETE FROM mcp_servers');
        $this->active();
        $this->step();
        $this->assertSame(['error', 'server_missing'], array_values($this->state()));
        $this->assertSame(30, $this->w->slots()[3]['backoff']);
    }

    public function testScheduleModeIsScheduledAndTicksEveryMinute(): void
    {
        EventWorkerSchema::workflow($this->db, 70, 3, null);
        EventWorkerSchema::row($this->db, 70, 3, 'daily');
        $this->active(3, 70);
        $this->step();
        $this->assertSame([], $this->tr->open);
        $this->assertSame(['scheduled', '2026-10-15 09:00:00'], array_values($this->state()));
        $this->assertSame(1, $this->runs->ticks);
        $this->step(30);
        $this->assertSame(1, $this->runs->ticks);
        $this->step(31);
        $this->assertSame(2, $this->runs->ticks);
    }

    public function testTheHeartbeatRefreshesTheCheckedTime(): void
    {
        $this->active();
        $this->step();
        $first = $this->db->query('SELECT watch_checked_at FROM active_workflows')->fetchColumn();
        $this->step(EventWorker::HEARTBEAT_S + 1);
        $this->assertNotSame($first, $this->db->query('SELECT watch_checked_at FROM active_workflows')->fetchColumn());
    }

    public function testTwoUsersAreIndependent(): void
    {
        EventWorkerSchema::option($this->db, 2, 4);
        EventWorkerSchema::workflow($this->db, 80, 4, 2);
        EventWorkerSchema::row($this->db, 80, 4, 'event', 2);
        $this->db->exec("INSERT INTO mcp_servers (user_id, name, url, headers) VALUES (4, 'Outlook', 'http://fake4/mcp', '{}')");
        $this->active();
        $this->active(4, 80);
        $this->step();
        $this->tr->answer(3, ['error' => 'reconnect_needed']);
        $this->tr->answer(4, ['status' => 'ready']);
        $this->step(1);
        $this->assertSame('error', $this->state(3)['watch_state']);
        $this->assertSame('running', $this->state(4)['watch_state']);
        $this->assertSame(30, $this->w->slots()[3]['backoff']);
        $this->assertSame(0, $this->w->slots()[4]['backoff']);
    }

    public function testSwitchingTheActiveWorkflowCancelsTheOldWait(): void
    {
        EventWorkerSchema::workflow($this->db, 66, 3, 1);
        $other = EventWorkerSchema::row($this->db, 66, 3, 'event', 1);
        $this->active();
        $this->step();
        $this->active(3, 66);
        $this->step(EventWorker::RECONCILE_S);
        $this->assertSame(66, $this->w->slots()[3]['workflow_id']);
        $this->assertSame($other, $this->w->slots()[3]['schedule_id']);
        $this->assertSame(2, $this->tr->started);
    }
}
