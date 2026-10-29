<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use AgentTeam\Services\WorkflowRepository;
use PDO;
use PHPUnit\Framework\TestCase;

/** Copy: a personal instance of a workflow (row, nodes, edges, paused schedules), whoever owns the source. */
final class WorkflowDuplicateTest extends TestCase
{
    private PDO $db;
    private WorkflowRepository $repo;
    private array $ids;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->ids = RobotSchema::create($this->db);
        RobotSchema::agentsAndPlaybooks($this->db);
        foreach (['description TEXT', 'steps TEXT', 'triggers TEXT', 'variables TEXT', 'output_storage_enabled INTEGER DEFAULT 0',
            'output_folder TEXT', 'orchestration TEXT', 'workspace_id INTEGER'] as $col) {
            $this->db->exec("ALTER TABLE agent_workflows ADD COLUMN $col");
        }
        foreach (['pos_x INTEGER', 'pos_y INTEGER', 'drawflow_node_id INTEGER'] as $col) {
            $this->db->exec("ALTER TABLE workflow_nodes ADD COLUMN $col");
        }
        $this->db->exec('ALTER TABLE workflow_edges ADD COLUMN condition_expr TEXT');
        $this->db->exec("UPDATE workflow_nodes SET pos_x = id * 10, pos_y = 5, drawflow_node_id = id");
        $this->db->exec("UPDATE agent_workflows SET steps = '[]', triggers = '[]', variables = '{}', orchestration = 'workflow'");
        // wf 75 is "owned" by user 2 here; the copier is user 3
        $this->db->exec("UPDATE scheduled_workflows SET last_run = '2026-10-01 00:00:00', error_message = 'boom', running_since = '2026-10-01 00:00:01'");
        $this->repo = new WorkflowRepository($this->db);
    }

    public function testCopyIsPersonalWithNodesEdgesAndPausedSchedule(): void
    {
        $copy = $this->repo->duplicate(75, 3);
        $this->assertNotNull($copy);
        $this->assertNotSame(75, $copy->getId());
        $this->assertSame(3, $copy->getUserId());
        $this->assertSame('Mail to PDF (Copy)', $copy->getName());

        $nodes = fn(int $wf) => $this->db->query("SELECT * FROM workflow_nodes WHERE workflow_id = $wf ORDER BY id")->fetchAll(PDO::FETCH_ASSOC);
        $src = $nodes(75);
        $new = $nodes($copy->getId());
        $this->assertCount(4, $new);
        foreach ($src as $i => $s) {
            foreach (['node_type', 'agent_id', 'config', 'pos_x', 'pos_y', 'drawflow_node_id'] as $k) {
                $this->assertSame($s[$k], $new[$i][$k], $k);
            }
            $this->assertNotSame($s['id'], $new[$i]['id']);
        }
        $this->assertSame($this->ids['To PDF'], json_decode($new[1]['config'], true)['code_component_id']);

        $newIds = array_column($new, 'id');
        $edges = $this->db->query('SELECT from_node_id, to_node_id, from_port FROM workflow_edges WHERE workflow_id = ' . $copy->getId() . ' ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
        $this->assertSame([[$newIds[0], $newIds[1]], [$newIds[1], $newIds[2]], [$newIds[2], $newIds[3]]],
            array_map(fn($e) => [(int) $e['from_node_id'], (int) $e['to_node_id']], $edges));

        $sched = $this->db->query('SELECT * FROM scheduled_workflows WHERE workflow_id = ' . $copy->getId())->fetchAll(PDO::FETCH_ASSOC);
        $this->assertCount(1, $sched);
        $this->assertSame(3, (int) $sched[0]['user_id']);
        $this->assertSame('paused', $sched[0]['status']);
        $this->assertSame('event', $sched[0]['repeat_type']);
        $this->assertNull($sched[0]['last_run']);
        $this->assertNull($sched[0]['running_since']);
        $this->assertNull($sched[0]['error_message']);
        $this->assertSame(0, (int) $this->db->query('SELECT COUNT(*) FROM active_workflows')->fetchColumn());

        // the source is untouched
        $this->assertSame(4, count($nodes(75)));
        $this->assertSame(2, (int) $this->db->query('SELECT user_id FROM agent_workflows WHERE id = 75')->fetchColumn());
        $this->assertSame(1, (int) $this->db->query('SELECT COUNT(*) FROM scheduled_workflows WHERE workflow_id = 75 AND user_id = 2')->fetchColumn());
    }

    public function testNameClashCountsUp(): void
    {
        $this->assertSame('Mail to PDF (Copy)', $this->repo->duplicate(75, 3)->getName());
        $this->assertSame('Mail to PDF (Copy 2)', $this->repo->duplicate(75, 3)->getName());
        $this->assertSame('Mail to PDF (Copy 3)', $this->repo->duplicate(75, 3)->getName());
        // another owner's copies don't clash
        $this->assertSame('Mail to PDF (Copy)', $this->repo->duplicate(75, 1)->getName());
    }

    public function testExplicitNameAndMissingWorkflow(): void
    {
        $this->assertSame('Mine', $this->repo->duplicate(75, 3, 'Mine')->getName());
        $this->assertNull($this->repo->duplicate(999, 3));
    }
}
