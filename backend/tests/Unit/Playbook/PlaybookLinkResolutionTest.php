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
}
