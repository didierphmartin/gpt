<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\CodeComponent;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentStore;

/** A component's exit change remaps workflow_edges.from_port BY NAME in every linked node of the owner's workflows. */
final class CodeComponentExitRemapTest extends TestCase
{
    private PDO $db;
    private CodeComponentStore $store;
    private int $cid;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        CodeComponentStoreTest::schema($this->db);
        $this->store = new CodeComponentStore($this->db);
        $this->cid = $this->store->save(3, null, CodeComponentStoreTest::POLL)['id'];
    }

    private function workflow(string $userId, string $name): int
    {
        $this->db->prepare('INSERT INTO agent_workflows (user_id, name) VALUES (?, ?)')->execute([$userId, $name]);
        return (int) $this->db->lastInsertId();
    }

    private function node(int $wf, string $type, array $config): int
    {
        $this->db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)')
            ->execute([$wf, $type, json_encode($config)]);
        return (int) $this->db->lastInsertId();
    }

    private function edge(int $wf, int $from, int $to, string $fromPort, string $toPort = 'input_1'): int
    {
        $this->db->prepare('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port, to_port) VALUES (?, ?, ?, ?, ?)')
            ->execute([$wf, $from, $to, $fromPort, $toPort]);
        return (int) $this->db->lastInsertId();
    }

    /** edge id => from_port, for the surviving edges */
    private function ports(): array
    {
        $out = [];
        foreach ($this->db->query('SELECT id, from_port FROM workflow_edges ORDER BY id')->fetchAll() as $r) {
            $out[(int) $r['id']] = $r['from_port'];
        }
        return $out;
    }

    /** A linked code node with one child per exit (output_1..output_3 to agents A, B, C). */
    private function linkedNodeWithThreeChildren(int $wf): array
    {
        $code = $this->node($wf, 'code', ['name' => 'Poll', 'code_component_id' => $this->cid]);
        $a = $this->node($wf, 'agent', []);
        $b = $this->node($wf, 'agent', []);
        $c = $this->node($wf, 'agent', []);
        return [$this->edge($wf, $code, $a, 'output_1'), $this->edge($wf, $code, $b, 'output_2'), $this->edge($wf, $code, $c, 'output_3')];
    }

    private function saveExits(array $exits): void
    {
        $this->store->save(3, $this->cid, ['exits' => $exits] + CodeComponentStoreTest::POLL);
    }

    public function testReorderSwapsPortsInEveryLinkedWorkflow(): void
    {
        [$e1, $e2, $e3] = $this->linkedNodeWithThreeChildren($this->workflow('3', 'First'));
        [$f1, $f2, $f3] = $this->linkedNodeWithThreeChildren($this->workflow('3', 'Second'));
        $this->saveExits(['no_mail', 'new_mail', 'error']);
        $this->assertSame([$e1 => 'output_2', $e2 => 'output_1', $e3 => 'output_3',
            $f1 => 'output_2', $f2 => 'output_1', $f3 => 'output_3'], $this->ports());
    }

    public function testInsertKeepsLaterExitsOnTheirNames(): void
    {
        [$e1, $e2, $e3] = $this->linkedNodeWithThreeChildren($this->workflow('3', 'First'));
        $this->saveExits(['new_mail', 'skip', 'no_mail', 'error']);
        $this->assertSame([$e1 => 'output_1', $e2 => 'output_3', $e3 => 'output_4'], $this->ports());
    }

    public function testRemovedExitDropsItsEdges(): void
    {
        [$e1, , $e3] = $this->linkedNodeWithThreeChildren($this->workflow('3', 'First'));
        $this->saveExits(['new_mail', 'error']);
        $this->assertSame([$e1 => 'output_1', $e3 => 'output_2'], $this->ports());
    }

    public function testCollapseToOneExitMovesAllToOutput1AndDropsDuplicates(): void
    {
        $wf = $this->workflow('3', 'First');
        $code = $this->node($wf, 'code', ['name' => 'Poll', 'code_component_id' => $this->cid]);
        $a = $this->node($wf, 'agent', []);
        $b = $this->node($wf, 'agent', []);
        $e1 = $this->edge($wf, $code, $a, 'output_1');
        $this->edge($wf, $code, $a, 'output_2');           // same target as e1: a duplicate once collapsed
        $e3 = $this->edge($wf, $code, $b, 'output_3');
        $e4 = $this->edge($wf, $code, $a, 'output_3', 'input_2'); // same node, other input: kept
        $this->saveExits(['done']);
        $this->assertSame([$e1 => 'output_1', $e3 => 'output_1', $e4 => 'output_1'], $this->ports());
    }

    public function testUnchangedExitsTouchNoEdges(): void
    {
        $wf = $this->workflow('3', 'First');
        $code = $this->node($wf, 'code', ['name' => 'Poll', 'code_component_id' => $this->cid]);
        $a = $this->node($wf, 'agent', []);
        $e1 = $this->edge($wf, $code, $a, 'output_2');
        $e2 = $this->edge($wf, $code, $a, 'output_9'); // beyond the exits: would be untouched anyway
        $this->store->save(3, $this->cid, ['code' => 'def run(i, c):\n    return 2'] + CodeComponentStoreTest::POLL);
        $this->assertSame([$e1 => 'output_2', $e2 => 'output_9'], $this->ports());
    }

    public function testPortBeyondOldExitsIsLeftAlone(): void
    {
        $wf = $this->workflow('3', 'First');
        $code = $this->node($wf, 'code', ['name' => 'Poll', 'code_component_id' => $this->cid]);
        $a = $this->node($wf, 'agent', []);
        $e1 = $this->edge($wf, $code, $a, 'output_7');
        $this->saveExits(['error', 'new_mail']);
        $this->assertSame([$e1 => 'output_7'], $this->ports());
    }

    public function testOtherUsersAndUnlinkedNodesAreUntouched(): void
    {
        $theirs = $this->workflow('4', 'Theirs');
        $code4 = $this->node($theirs, 'code', ['name' => 'Poll', 'code_component_id' => $this->cid]);
        $a4 = $this->node($theirs, 'agent', []);
        $t1 = $this->edge($theirs, $code4, $a4, 'output_1');
        $t2 = $this->edge($theirs, $code4, $a4, 'output_2');
        $mine = $this->workflow('3', 'Mine');
        $plain = $this->node($mine, 'code', ['name' => 'Inline', 'exits' => ['new_mail', 'no_mail', 'error']]);
        $other = $this->node($mine, 'code', ['name' => 'Other', 'code_component_id' => $this->cid + 100]);
        $agentLinked = $this->node($mine, 'agent', ['code_component_id' => $this->cid]);
        $a = $this->node($mine, 'agent', []);
        $p1 = $this->edge($mine, $plain, $a, 'output_1');
        $p2 = $this->edge($mine, $other, $a, 'output_2');
        $p3 = $this->edge($mine, $agentLinked, $a, 'output_1');
        $this->saveExits(['no_mail', 'error']);
        $this->assertSame([$t1 => 'output_1', $t2 => 'output_2', $p1 => 'output_1', $p2 => 'output_2', $p3 => 'output_1'], $this->ports());
    }

    public function testRemapRollsBackWithTheUpdateOnError(): void
    {
        [$e1, $e2, $e3] = $this->linkedNodeWithThreeChildren($this->workflow('3', 'First'));
        $this->db->exec("CREATE TRIGGER boom BEFORE UPDATE ON workflow_edges BEGIN SELECT RAISE(ABORT, 'boom'); END");
        try {
            $this->saveExits(['no_mail', 'new_mail', 'error']);
            $this->fail('expected the save to fail');
        } catch (\PDOException) {
        }
        $this->assertFalse($this->db->inTransaction());
        $this->assertSame(['new_mail', 'no_mail', 'error'], $this->store->get(3, $this->cid)['exits']);
        $this->assertSame([$e1 => 'output_1', $e2 => 'output_2', $e3 => 'output_3'], $this->ports());
    }
}
