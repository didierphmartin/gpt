<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Playbook;

use AgentTeam\Services\PlaybookEmit;
use AgentTeam\Services\WorkflowGraphRepository;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Playbook\PlaybookStore;

final class PlaybookLinkResolutionTest extends TestCase
{
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        PlaybookStoreTest::schema($this->db);
        // RobotOwnership asks these (who may use the robot; the robot's id): empty here, so nothing is shared
        $this->db->exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT, role TEXT, kind TEXT NOT NULL DEFAULT 'person')");
        $this->db->exec('CREATE TABLE IF NOT EXISTS packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)');
    }

    public function testGetNodesFillsTheLinkedTextForTheWorkflowOwner(): void
    {
        $id = (new PlaybookStore($this->db))->save(3, null, PlaybookStoreTest::OKTA, 'okta-reset')['id'];
        $this->db->exec("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'Bridge')");
        $this->db->exec("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'playbook', '{\"name\":\"Reset\",\"playbook_id\":$id}')");
        $this->db->exec("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'playbook', '{\"name\":\"Gone\",\"playbook_id\":99}')");
        $nodes = (new WorkflowGraphRepository($this->db))->getNodes(1);
        $this->assertSame(PlaybookStoreTest::OKTA, $nodes[0]['config']['playbook']);
        $this->assertArrayNotHasKey('playbook', $nodes[1]['config']);
        $this->assertTrue($nodes[1]['config']['playbook_missing']);
    }

    public function testAnotherUsersPlaybookIsNotResolved(): void
    {
        $id = (new PlaybookStore($this->db))->save(4, null, PlaybookStoreTest::OKTA, 'okta-reset')['id'];
        $this->db->exec("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'Bridge')");
        $this->db->exec("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'playbook', '{\"playbook_id\":$id}')");
        $this->assertTrue((new WorkflowGraphRepository($this->db))->getNodes(1)[0]['config']['playbook_missing']);
    }

    public function testCompileRefusesAMissingPlaybookNamingTheNode(): void
    {
        $this->expectExceptionMessage('Playbook #99 not found (node Gone).');
        PlaybookEmit::nodeData(['id' => '5', 'config' => ['name' => 'Gone', 'playbook_id' => 99, 'playbook_missing' => true]], [], [], '3');
    }

    public function testGetNodesClearsAStoredMissingFlagWhenThePlaybookExists(): void
    {
        $id = (new PlaybookStore($this->db))->save(3, null, PlaybookStoreTest::OKTA, 'okta-reset')['id'];
        $this->db->exec("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'Bridge')");
        $this->db->exec("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'playbook', '{\"playbook_id\":$id,\"playbook_missing\":true}')");
        $cfg = (new WorkflowGraphRepository($this->db))->getNodes(1)[0]['config'];
        $this->assertArrayNotHasKey('playbook_missing', $cfg);
        $this->assertSame(PlaybookStoreTest::OKTA, $cfg['playbook']);
    }

    public function testCreateNodeNeverStoresTheDerivedKeys(): void
    {
        $this->db->exec('DROP TABLE workflow_nodes');
        $this->db->exec('CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, node_type TEXT, agent_id INTEGER, config TEXT, pos_x INTEGER, pos_y INTEGER, drawflow_node_id TEXT)');
        $repo = new WorkflowGraphRepository($this->db);
        $nodeId = $repo->createNode(1, ['node_type' => 'playbook', 'config' => ['playbook_id' => 7, 'playbook' => 'stale', 'playbook_missing' => true]]);
        $stored = json_decode((string) $this->db->query("SELECT config FROM workflow_nodes WHERE id = $nodeId")->fetchColumn(), true);
        $this->assertSame(7, $stored['playbook_id']);
        $this->assertArrayNotHasKey('playbook', $stored);
        $this->assertArrayNotHasKey('playbook_missing', $stored);

        $repo->updateNode($nodeId, ['node_type' => 'playbook', 'config' => ['playbook_id' => 7, 'playbook' => 'stale2', 'playbook_missing' => true]]);
        $stored = json_decode((string) $this->db->query("SELECT config FROM workflow_nodes WHERE id = $nodeId")->fetchColumn(), true);
        $this->assertArrayNotHasKey('playbook', $stored);
        $this->assertArrayNotHasKey('playbook_missing', $stored);
    }

    public function testNonPlaybookNodeWithAPlaybookIdIsUntouched(): void
    {
        $this->db->exec("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'Bridge')");
        $this->db->exec("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'agent', '{\"playbook_id\":99}')");
        $this->assertSame(['playbook_id' => 99], (new WorkflowGraphRepository($this->db))->getNodes(1)[0]['config']);
    }
}
