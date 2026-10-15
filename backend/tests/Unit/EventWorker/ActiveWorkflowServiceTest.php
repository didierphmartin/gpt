<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\EventWorker;

use AgentTeam\Services\ActiveWorkflowError;
use AgentTeam\Services\ActiveWorkflowService;
use PDO;
use PHPUnit\Framework\TestCase;

/** spec 2026-10-14 event-worker §2: activation, mode, sweep. */
final class ActiveWorkflowServiceTest extends TestCase
{
    private PDO $db;
    private string $now = '2026-10-14 09:00:00';

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        EventWorkerSchema::create($this->db, fn() => $this->now);
        EventWorkerSchema::option($this->db, 1, 3);
    }

    private function svc(): ActiveWorkflowService { return new ActiveWorkflowService($this->db); }

    private function refused(callable $fn): ActiveWorkflowError
    {
        try { $fn(); } catch (ActiveWorkflowError $e) { return $e; }
        $this->fail('expected ActiveWorkflowError');
    }

    public function testModeReadsTheNewestLiveRow(): void
    {
        EventWorkerSchema::workflow($this->db, 64, 3, 1);
        $this->assertSame('prompt', $this->svc()->mode(64)['mode']);
        EventWorkerSchema::row($this->db, 64, 3, 'daily');
        $this->assertSame('schedule', $this->svc()->mode(64)['mode']);
        $id = EventWorkerSchema::row($this->db, 64, 3, 'event', 1);
        $m = $this->svc()->mode(64);
        $this->assertSame(['option', $id, 1], [$m['mode'], (int) $m['schedule']['id'], $m['component_id']]);
    }

    public function testAPausedRowIsNotAMode(): void
    {
        EventWorkerSchema::workflow($this->db, 64, 3, 1);
        EventWorkerSchema::row($this->db, 64, 3, 'event', 1, 'paused');
        $this->assertSame('prompt', $this->svc()->mode(64)['mode']);
    }

    public function testAnEventRowWhoseStartIsNotOnItsOptionIsModeGone(): void
    {
        EventWorkerSchema::workflow($this->db, 62, 3, null);          // Start on Enter Prompt, row left behind
        EventWorkerSchema::row($this->db, 62, 3, 'event', 1);
        $this->assertSame('mode_gone', $this->svc()->mode(62)['mode']);
        $this->db->exec("UPDATE workflow_nodes SET config = '{\"type\":\"start\",\"start_option\":1}' WHERE node_type = 'start'");
        $this->db->exec('UPDATE code_components SET start_trigger = NULL');   // no longer an option
        $this->assertSame('mode_gone', $this->svc()->mode(62)['mode']);
    }

    public function testActivateAnOptionWorkflow(): void
    {
        EventWorkerSchema::workflow($this->db, 64, 3, 1);
        EventWorkerSchema::row($this->db, 64, 3, 'event', 1);
        $r = $this->svc()->activate(3, 64);
        $this->assertNull($r['replaced']);
        $this->assertSame([64, 'option', 1, 'starting'], [(int) $r['active']['workflow_id'], $r['active']['mode'],
            (int) $r['active']['trigger_component_id'], $r['active']['watch_state']]);
        $this->assertSame('wf 64', $r['active']['workflow_name']);
    }

    public function testActivatingAnotherReplacesIt(): void
    {
        EventWorkerSchema::workflow($this->db, 64, 3, 1);
        EventWorkerSchema::row($this->db, 64, 3, 'event', 1);
        EventWorkerSchema::workflow($this->db, 70, 3, null);
        EventWorkerSchema::row($this->db, 70, 3, 'daily');
        $this->svc()->activate(3, 64);
        $r = $this->svc()->activate(3, 70);
        $this->assertSame(['workflow_id' => 64, 'workflow_name' => 'wf 64'], $r['replaced']);
        $this->assertSame('schedule', $this->svc()->get(3)['mode']);
        $this->assertSame(1, (int) $this->db->query('SELECT COUNT(*) FROM active_workflows')->fetchColumn());
    }

    public function testRefusals(): void
    {
        EventWorkerSchema::workflow($this->db, 64, 3, 1);
        $this->assertSame(['no_trigger', 422], [($e = $this->refused(fn() => $this->svc()->activate(3, 64)))->kind, $e->status]);
        EventWorkerSchema::workflow($this->db, 65, 3, 1, false);       // no links
        EventWorkerSchema::row($this->db, 65, 3, 'event', 1);
        $this->assertSame('no_links', $this->refused(fn() => $this->svc()->activate(3, 65))->kind);
        $this->assertSame('not_found', $this->refused(fn() => $this->svc()->activate(4, 64))->kind);   // not the owner
        $this->assertSame('not_found', $this->refused(fn() => $this->svc()->activate(3, 999))->kind);
    }

    public function testDeactivateOnlyThatWorkflow(): void
    {
        EventWorkerSchema::workflow($this->db, 64, 3, 1);
        EventWorkerSchema::row($this->db, 64, 3, 'event', 1);
        $this->svc()->activate(3, 64);
        $this->svc()->deactivate(3, 70);
        $this->assertNotNull($this->svc()->get(3));
        $this->svc()->deactivate(3, 64);
        $this->assertNull($this->svc()->get(3));
    }

    public function testSweepDeactivatesWhenTheModeChanged(): void
    {
        EventWorkerSchema::workflow($this->db, 64, 3, 1);
        $row = EventWorkerSchema::row($this->db, 64, 3, 'event', 1);
        $this->svc()->activate(3, 64);
        $this->assertSame([], $this->svc()->sweep());
        $this->db->exec("DELETE FROM scheduled_workflows WHERE id = $row");   // switched to Enter Prompt
        $this->assertSame([64], $this->svc()->sweep());
        $this->assertNull($this->svc()->get(3));
    }

    public function testSweepDeactivatesAnotherOption(): void
    {
        EventWorkerSchema::option($this->db, 2, 3);
        EventWorkerSchema::workflow($this->db, 64, 3, 1);
        EventWorkerSchema::row($this->db, 64, 3, 'event', 1);
        $this->svc()->activate(3, 64);
        $this->db->exec("UPDATE workflow_nodes SET config = '{\"type\":\"start\",\"start_option\":2}' WHERE workflow_id = 64 AND node_type = 'start'");
        EventWorkerSchema::row($this->db, 64, 3, 'event', 2);
        $this->assertSame([64], $this->svc()->sweep());
    }

    public function testCheckReasons(): void
    {
        EventWorkerSchema::workflow($this->db, 64, 3, 1);
        EventWorkerSchema::row($this->db, 64, 3, 'event', 1);
        $this->svc()->activate(3, 64);
        $row = fn() => $this->svc()->all()[0];
        $this->assertSame([true, null], [$this->svc()->check($row())['ok'], $this->svc()->check($row())['reason']]);
        $this->db->exec('DELETE FROM workflow_edges');
        $this->assertSame('no_links', $this->svc()->check($row())['reason']);
        $this->db->exec('UPDATE agent_workflows SET enabled = 0');
        $this->assertSame('disabled', $this->svc()->check($row())['reason']);
    }

    public function testStateAndAges(): void
    {
        EventWorkerSchema::workflow($this->db, 64, 3, 1);
        EventWorkerSchema::row($this->db, 64, 3, 'event', 1);
        $this->svc()->activate(3, 64);
        $this->assertNull($this->svc()->get(3)['checked_age_s']);
        $this->now = '2026-10-14 09:00:40';
        $this->svc()->setState(3, 'waiting', 'fallback');
        $this->now = '2026-10-14 09:01:00';
        $a = $this->svc()->get(3);
        $this->assertSame(['waiting', 'fallback', 20, 60], [$a['watch_state'], $a['watch_message'], $a['checked_age_s'], $a['activated_age_s']]);
    }

    public function testScheduleWorkflowIdsAndCascade(): void
    {
        EventWorkerSchema::workflow($this->db, 70, 3, null);
        EventWorkerSchema::row($this->db, 70, 3, 'daily');
        $this->svc()->activate(3, 70);
        $this->assertSame([70], $this->svc()->scheduleWorkflowIds());
        $this->db->exec('DELETE FROM agent_workflows WHERE id = 70');
        $this->assertNull($this->svc()->get(3));
    }
}
