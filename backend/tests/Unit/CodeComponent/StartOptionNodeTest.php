<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\CodeComponent;

use AgentTeam\Services\StartOptionGraph;
use AgentTeam\Services\WorkflowGraphRepository;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentError;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentStore;

/** spec 2026-10-13 §10: a Start node on a Start option is the component — one port per exit. */
final class StartOptionNodeTest extends TestCase
{
    private PDO $db;
    private CodeComponentStore $store;
    private int $cid;
    private int $start;
    /** @var int[] edges from Start's output_1..3 (new_mail, no_mail, error) to agents A, B, C */
    private array $edges;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        CodeComponentStoreTest::schema($this->db);
        $this->db->exec('CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, pkey TEXT, title TEXT, text TEXT, updated_at TEXT)');
        $this->store = new CodeComponentStore($this->db);
        $this->cid = $this->store->save(3, null, CodeComponentStoreTest::POLL)['id'];
        $this->store->setStartTrigger(3, $this->cid, ['label' => 'Outlook: Get New Email'] + CodeComponentStartOptionTest::TRIGGER);
        $this->db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (1, '3', 'Mail triage')");
        $this->start = $this->node('start', ['type' => 'start', 'start_option' => $this->cid]);
        $this->edges = [];
        foreach (['output_1', 'output_2', 'output_3'] as $port) {
            $to = $this->node('agent', ['type' => 'agent']);
            $this->db->prepare('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port, to_port) VALUES (1, ?, ?, ?, ?)')
                ->execute([$this->start, $to, $port, 'input_1']);
            $this->edges[] = (int) $this->db->lastInsertId();
        }
    }

    private function node(string $type, array $cfg): int
    {
        $this->db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config, pos_x, pos_y) VALUES (1, ?, ?, 100, 50)')
            ->execute([$type, json_encode($cfg)]);
        return (int) $this->db->lastInsertId();
    }

    private function ports(): array
    {
        $out = [];
        foreach ($this->db->query('SELECT id, from_port FROM workflow_edges ORDER BY id')->fetchAll() as $r) {
            $out[(int) $r['id']] = $r['from_port'];
        }
        return $out;
    }

    private function startConfig(): array
    {
        $st = $this->db->prepare('SELECT config FROM workflow_nodes WHERE id = ?');
        $st->execute([$this->start]);
        return json_decode((string) $st->fetchColumn(), true);
    }

    public function testStartReadsTheOptionsExitsAndLabel(): void
    {
        $start = (new WorkflowGraphRepository($this->db))->getNodes(1)[0];
        $this->assertSame(['new_mail', 'no_mail', 'error'], $start['config']['exits']);
        $this->assertSame('Outlook: Get New Email', $start['config']['start_option_label']);
        $this->assertArrayNotHasKey('start_option_missing', $start['config']);
    }

    public function testSavingStartStoresOnlyTheOption(): void
    {
        (new WorkflowGraphRepository($this->db))->updateNode($this->start, ['node_type' => 'start', 'config' => ['type' => 'start',
            'start_option' => $this->cid, 'exits' => ['x'], 'start_option_label' => 'x', 'start_option_missing' => true]]);
        $this->assertSame(['type' => 'start', 'start_option' => $this->cid], $this->startConfig());
    }

    public function testTheGraphRunsTheComponentAfterStart(): void
    {
        $g = (new WorkflowGraphRepository($this->db))->getGraph(1);
        $code = (string) (StartOptionGraph::ID_OFFSET + $this->start);
        $node = array_values(array_filter($g['nodes'], fn($n) => (string) $n['id'] === $code))[0];
        $this->assertSame('code', $node['node_type']);
        $this->assertSame('Outlook: Get New Email', $node['config']['name']);
        $this->assertSame($this->cid, $node['config']['code_component_id']);
        $this->assertSame(['new_mail', 'no_mail', 'error'], $node['config']['exits']);
        $this->assertSame(['Outlook'], $node['config']['mcp_servers']);
        $from = array_map(fn($e) => [(string) $e['from_node_id'], $e['from_port']], $g['edges']);
        $this->assertSame([[$code, 'output_1'], [$code, 'output_2'], [$code, 'output_3'], [(string) $this->start, 'output_1']], $from);
        $this->assertSame($code, (string) end($g['edges'])['to_node_id']);
    }

    public function testExpandedStartCarriesArgDecls(): void
    {
        $args = [['name' => 'folder', 'required' => true]];
        $this->store->save(3, $this->cid, CodeComponentStoreTest::POLL + ['args' => $args]);
        $g = (new WorkflowGraphRepository($this->db))->getGraph(1);
        $code = (string) (StartOptionGraph::ID_OFFSET + $this->start);
        $node = array_values(array_filter($g['nodes'], fn($n) => (string) $n['id'] === $code))[0];
        $this->assertSame($args, $node['config']['arg_decls']);
    }

    public function testAPlainStartIsNotExpanded(): void
    {
        $graph = ['nodes' => [['id' => 5, 'node_type' => 'start', 'config' => ['type' => 'start']]],
            'edges' => [['id' => 1, 'from_node_id' => 5, 'to_node_id' => 6, 'from_port' => 'output_1']]];
        $this->assertSame($graph, StartOptionGraph::expand($graph, fn() => $this->fail('no lookup')));
    }

    public function testAStartWhoseOptionIsGoneIsNotExpanded(): void
    {
        $graph = ['nodes' => [['id' => 5, 'node_type' => 'start', 'config' => ['type' => 'start', 'start_option' => 9]]], 'edges' => []];
        $this->assertSame($graph, StartOptionGraph::expand($graph, fn() => null));
        $this->assertSame($graph, StartOptionGraph::expand($graph, fn() => ['start_trigger' => null] + CodeComponentStoreTest::POLL));
    }

    public function testUsedByListsTheStart(): void
    {
        $this->assertSame([['workflow_id' => 1, 'workflow_name' => 'Mail triage', 'node_name' => 'Start']], $this->store->usedBy(3, $this->cid));
    }

    public function testReorderingExitsMovesStartsLinks(): void
    {
        $this->store->save(3, $this->cid, ['exits' => ['no_mail', 'new_mail', 'error']] + CodeComponentStoreTest::POLL);
        [$e1, $e2, $e3] = $this->edges;
        $this->assertSame([$e1 => 'output_2', $e2 => 'output_1', $e3 => 'output_3'], $this->ports());
    }

    public function testRemovingAnExitWithLinksOnStartAsksFirst(): void
    {
        try {
            $this->store->save(3, $this->cid, ['exits' => ['new_mail', 'no_mail']] + CodeComponentStoreTest::POLL);
            $this->fail('expected links_dropped');
        } catch (CodeComponentError $e) {
            $this->assertSame([['workflow_id' => 1, 'workflow_name' => 'Mail triage', 'node_name' => 'Start', 'exit' => 'error', 'count' => 1]],
                $e->data);
        }
        $this->store->save(3, $this->cid, ['exits' => ['new_mail', 'no_mail'], 'confirm_drop_links' => true] + CodeComponentStoreTest::POLL);
        [$e1, $e2] = $this->edges;
        $this->assertSame([$e1 => 'output_1', $e2 => 'output_2'], $this->ports());
    }

    public function testRemovingTheOptionTurnsStartBackIntoAPlainStart(): void
    {
        $impact = $this->store->clearStartTrigger(3, $this->cid);
        $this->assertSame([['workflow_id' => 1, 'workflow_name' => 'Mail triage']], $impact);
        $this->assertSame([$this->edges[0] => 'output_1'], $this->ports());   // the work exit's link stays
        $this->assertSame(['type' => 'start'], $this->startConfig());
    }
}
