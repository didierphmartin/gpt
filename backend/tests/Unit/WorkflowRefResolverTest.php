<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\UnresolvedRefsException;
use AgentTeam\Services\WorkflowRefResolver;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Tests\Unit\CodeComponent\CodeComponentStoreTest;

final class WorkflowRefResolverTest extends TestCase
{
    private PDO $db;
    private WorkflowRefResolver $r;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        CodeComponentStoreTest::schema($this->db);
        $this->db->exec('CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, pkey TEXT, title TEXT, text TEXT)');
        // id 1 is another user's copy of the same pkey, id 2 the owner's.
        $this->db->exec("INSERT INTO playbooks (user_id, pkey, title, text) VALUES (4, 'reset-pw', 'x', 'x'), (3, 'reset-pw', 'y', 'y')");
        $this->comp(4, 'Poll', ['x']);
        $this->comp(3, 'Poll', ['new_mail', 'no_mail', 'error']);
        $this->r = new WorkflowRefResolver($this->db);
    }

    private function comp(int $user, string $name, array $exits): void
    {
        $this->db->prepare("INSERT INTO code_components (user_id, name, code, exits, mcp_servers) VALUES (?, ?, 'c', ?, '[]')")
            ->execute([$user, $name, json_encode($exits)]);
    }

    private function missing(array $nodes, array $edges = []): array
    {
        try {
            $this->r->resolve(3, $nodes, $edges);
        } catch (UnresolvedRefsException $e) {
            return $e->missing;
        }
        $this->fail('expected UnresolvedRefsException');
    }

    public function testPlaybookRefBecomesTheOwnersId(): void
    {
        $out = $this->r->resolve(3, [['id' => '1', 'node_type' => 'playbook',
            'config' => ['type' => 'playbook', 'playbook_ref' => 'reset-pw', 'exits' => ['done', 'failed']]]], []);
        $cfg = $out['nodes'][0]['config'];
        $this->assertSame(2, $cfg['playbook_id']);
        $this->assertArrayNotHasKey('playbook_ref', $cfg);
        $this->assertSame(['done', 'failed'], $cfg['exits']);
    }

    public function testComponentRefAndArgsAndEdgePorts(): void
    {
        $nodes = [
            ['id' => '1', 'node_type' => 'playbook', 'config' => ['playbook_ref' => 'reset-pw']],
            ['id' => '2', 'node_type' => 'code', 'config' => ['code_component_ref' => 'Poll', 'args' => ['a' => 1]]],
            ['id' => '3', 'node_type' => 'agent', 'config' => []],
        ];
        $edges = [
            ['from' => '1', 'to' => '3', 'from_port_name' => 'failed'],
            ['from' => '1', 'to' => '3', 'from_port_name' => 'done'],
            ['from' => '2', 'to' => '3', 'from_port_name' => 'no_mail'],
            ['from' => '2', 'to' => '3', 'from_port_name' => 'error', 'to_port' => 'input_1'],
            ['from' => '3', 'to' => '1', 'from_port' => 'output_1'],
        ];
        $out = $this->r->resolve(3, $nodes, $edges);
        $cfg = $out['nodes'][1]['config'];
        $this->assertSame(2, $cfg['code_component_id']);
        $this->assertArrayNotHasKey('code_component_ref', $cfg);
        $this->assertSame(['a' => 1], $cfg['args']);
        $this->assertSame(['output_2', 'output_1', 'output_2', 'output_3', 'output_1'], array_column($out['edges'], 'from_port'));
        $this->assertArrayNotHasKey('from_port_name', $out['edges'][0]);
        $this->assertSame('input_1', $out['edges'][3]['to_port']);
    }

    public function testStartOptionRefAndItsEdges(): void
    {
        $nodes = [['id' => 's', 'node_type' => 'start', 'config' => ['start_option_ref' => 'Poll', 'start_args' => ['q' => 'x']]],
            ['id' => 'a', 'node_type' => 'agent', 'config' => []]];
        $out = $this->r->resolve(3, $nodes, [['from' => 's', 'to' => 'a', 'from_port_name' => 'no_mail']]);
        $this->assertSame(2, $out['nodes'][0]['config']['start_option']);
        $this->assertSame(['q' => 'x'], $out['nodes'][0]['config']['start_args']);
        $this->assertArrayNotHasKey('start_option_ref', $out['nodes'][0]['config']);
        $this->assertSame('output_2', $out['edges'][0]['from_port']);
    }

    public function testUnknownPlaybookAndComponentAreListedTogether(): void
    {
        $missing = $this->missing([
            ['id' => '1', 'node_type' => 'playbook', 'config' => ['playbook_ref' => 'nope']],
            ['id' => '2', 'node_type' => 'code', 'config' => ['code_component_ref' => 'Ghost']],
        ]);
        $this->assertCount(2, $missing);
        $this->assertStringContainsString('nope', $missing[0]);
        $this->assertStringContainsString('Ghost', $missing[1]);
    }

    public function testUnknownExitNameIsMissing(): void
    {
        $missing = $this->missing(
            [['id' => '1', 'node_type' => 'code', 'config' => ['code_component_ref' => 'Poll']], ['id' => '2', 'node_type' => 'agent', 'config' => []]],
            [['from' => '1', 'to' => '2', 'from_port_name' => 'bogus']]
        );
        $this->assertCount(1, $missing);
        $this->assertStringContainsString('bogus', $missing[0]);
    }

    public function testAnotherUsersPlaybookIsNotUsed(): void
    {
        $this->db->exec("INSERT INTO playbooks (user_id, pkey, title, text) VALUES (4, 'only-theirs', 'x', 'x')");
        $this->assertCount(1, $this->missing([['id' => '1', 'node_type' => 'playbook', 'config' => ['playbook_ref' => 'only-theirs']]]));
    }

    public function testAGraphWithoutRefsIsUnchanged(): void
    {
        $nodes = [['id' => '1', 'node_type' => 'agent', 'config' => ['x' => 1]], ['id' => '2', 'node_type' => 'code', 'config' => ['code' => 'y', 'exits' => ['next']]]];
        $edges = [['from' => '1', 'to' => '2', 'from_port' => 'output_2']];
        $this->assertSame(['nodes' => $nodes, 'edges' => $edges], $this->r->resolve(3, $nodes, $edges));
    }
}
