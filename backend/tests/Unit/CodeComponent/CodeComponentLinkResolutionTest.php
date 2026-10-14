<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\CodeComponent;

use AgentTeam\Services\CodeNodeEmit;
use AgentTeam\Services\WorkflowGraphRepository;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\CodeComponent\CodeComponentStore;

final class CodeComponentLinkResolutionTest extends TestCase
{
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        CodeComponentStoreTest::schema($this->db);
        // getNodes also runs the playbook fill-in loop, which needs the table to exist.
        $this->db->exec('CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, pkey TEXT, title TEXT, text TEXT, updated_at TEXT)');
        $this->db->exec("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'Mail triage')");
    }

    private function node(string $type, array $cfg): void
    {
        $this->db->prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, ?, ?)')->execute([$type, json_encode($cfg)]);
    }

    public function testGetNodesFillsTheComponentForTheOwner(): void
    {
        $id = (new CodeComponentStore($this->db))->save(3, null, CodeComponentStoreTest::POLL)['id'];
        // Saved exits are stale (another workflow changed the component since): the component wins.
        $this->node('code', ['name' => 'Poll', 'code_component_id' => $id, 'exits' => ['old'], 'code_component_missing' => true]);
        $cfg = (new WorkflowGraphRepository($this->db))->getNodes(1)[0]['config'];
        $this->assertSame(CodeComponentStoreTest::POLL['code'], $cfg['code']);
        $this->assertSame(['new_mail', 'no_mail', 'error'], $cfg['exits']);
        $this->assertSame(['Outlook'], $cfg['mcp_servers']);
        $this->assertSame(20, $cfg['timeout_s']);
        $this->assertArrayNotHasKey('code_component_missing', $cfg);
        $this->assertSame('Poll', $cfg['name']);
    }

    public function testMissingOrForeignComponentIsFlagged(): void
    {
        $foreign = (new CodeComponentStore($this->db))->save(4, null, CodeComponentStoreTest::POLL)['id'];
        $this->node('code', ['name' => 'Gone', 'code_component_id' => 99]);
        $this->node('code', ['name' => 'Theirs', 'code_component_id' => $foreign]);
        $nodes = (new WorkflowGraphRepository($this->db))->getNodes(1);
        $this->assertTrue($nodes[0]['config']['code_component_missing']);
        $this->assertTrue($nodes[1]['config']['code_component_missing']);
        $this->assertArrayNotHasKey('code', $nodes[1]['config']);
    }

    public function testUnlinkedAndNonCodeNodesAreUntouched(): void
    {
        $this->node('code', ['name' => 'Inline', 'code' => 'x', 'exits' => ['next']]);
        $this->node('agent', ['code_component_id' => 5]);
        $nodes = (new WorkflowGraphRepository($this->db))->getNodes(1);
        $this->assertSame(['name' => 'Inline', 'code' => 'x', 'exits' => ['next']], $nodes[0]['config']);
        $this->assertSame(['code_component_id' => 5], $nodes[1]['config']);
    }

    public function testCreateAndUpdateStoreOnlyTheLink(): void
    {
        $repo = new WorkflowGraphRepository($this->db);
        $full = ['name' => 'Poll', 'code_component_id' => 7, 'code' => 'x', 'exits' => ['a'], 'mcp_servers' => ['O'],
            'timeout_s' => 5, 'code_component_missing' => true, 'disabled' => false];
        $nodeId = $repo->createNode(1, ['node_type' => 'code', 'config' => $full]);
        $stored = fn() => json_decode((string) $this->db->query("SELECT config FROM workflow_nodes WHERE id = $nodeId")->fetchColumn(), true);
        $this->assertSame(['name' => 'Poll', 'code_component_id' => 7, 'disabled' => false, 'type' => 'code'], $stored());
        $repo->updateNode($nodeId, ['node_type' => 'code', 'config' => $full]);
        $this->assertSame(['name' => 'Poll', 'code_component_id' => 7, 'disabled' => false, 'type' => 'code'], $stored());
        // An unlinked code node keeps its own code.
        $inline = $repo->createNode(1, ['node_type' => 'code', 'config' => ['code' => 'y', 'exits' => ['next']]]);
        $this->assertSame('y', json_decode((string) $this->db->query("SELECT config FROM workflow_nodes WHERE id = $inline")->fetchColumn(), true)['code']);
    }

    public function testCompileRefusesAMissingComponentNamingTheNode(): void
    {
        $this->expectExceptionMessage('Code component #99 not found (node Gone).');
        CodeNodeEmit::nodeData(['id' => '5', 'config' => ['name' => 'Gone', 'code_component_id' => 99, 'code_component_missing' => true]], [], []);
    }

    /** A DB whose node_type is still the old ENUM (no 'code') stores '' for a code node: config.type still says code. */
    public function testACodeNodeWhoseColumnLostItsTypeIsStillResolvedAndCounted(): void
    {
        $store = new CodeComponentStore($this->db);
        $id = $store->save(3, null, CodeComponentStoreTest::POLL)['id'];
        $this->node('', ['type' => 'code', 'name' => 'Poll', 'code_component_id' => $id]);
        $cfg = (new WorkflowGraphRepository($this->db))->getNodes(1)[0]['config'];
        $this->assertSame(CodeComponentStoreTest::POLL['code'], $cfg['code']);
        $this->assertSame([['workflow_id' => 1, 'workflow_name' => 'Mail triage', 'node_name' => 'Poll']], $store->usedBy(3, $id));
        $this->assertSame(1, $store->list(3)[0]['used_by']);
    }

    public function testANonCodeConfigTypeWithAnEmptyColumnIsNotResolved(): void
    {
        $id = (new CodeComponentStore($this->db))->save(3, null, CodeComponentStoreTest::POLL)['id'];
        $this->node('', ['type' => 'agent', 'code_component_id' => $id]);
        $this->assertSame(['type' => 'agent', 'code_component_id' => $id], (new WorkflowGraphRepository($this->db))->getNodes(1)[0]['config']);
        $this->assertSame([], (new CodeComponentStore($this->db))->usedBy(3, $id));
    }
}
