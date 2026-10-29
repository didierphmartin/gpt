<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use AgentTeam\Controllers\WorkflowController;
use AgentTeam\Services\WorkflowRepository;
use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Tests\Unit\CodeComponent\CodeComponentStoreTest;
use ReflectionClass;

final class WorkflowControllerRefsTest extends TestCase
{
    private PDO $db;
    private WorkflowController $ctl;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        CodeComponentStoreTest::schema($this->db);
        $this->db->exec('DROP TABLE agent_workflows');
        $this->db->exec("CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, workspace_id INTEGER, name TEXT,
            description TEXT, steps TEXT, triggers TEXT, variables TEXT, enabled INTEGER DEFAULT 1, output_storage_enabled INTEGER DEFAULT 0,
            output_folder TEXT, orchestration TEXT DEFAULT 'workflow', created_at TEXT, updated_at TEXT)");
        $this->db->exec('CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, pkey TEXT, title TEXT, text TEXT, updated_at TEXT)');
        $this->db->exec("INSERT INTO playbooks (user_id, pkey, title, text) VALUES (3, 'reset-pw', 'x', 'x')");

        $ref = new ReflectionClass(WorkflowController::class);
        $this->ctl = $ref->newInstanceWithoutConstructor();
        $repo = new WorkflowRepository($this->db);
        foreach (['db' => $this->db, 'config' => [], 'workflowRepository' => $repo, 'graphRepository' => $repo->getGraphRepository()] as $k => $v) {
            $p = $ref->getProperty($k);
            $p->setValue($this->ctl, $v);
        }
    }

    private function create(array $nodes, array $edges = []): array
    {
        return $this->ctl->create(['user_id' => 3, 'body' => ['name' => 'Reset', 'definition' => ['nodes' => $nodes, 'edges' => $edges]]]);
    }

    public function testUnknownNamesGive422AndInsertNoWorkflow(): void
    {
        $r = $this->create([['id' => '1', 'node_type' => 'playbook', 'config' => ['playbook_ref' => 'nope']]]);
        $this->assertSame(422, $r['status_code']);
        $this->assertSame('unknown references', $r['error']);
        $this->assertCount(1, $r['missing']);
        $this->assertSame(0, (int) $this->db->query('SELECT COUNT(*) FROM agent_workflows')->fetchColumn());
    }

    public function testValidNamedGraphCreatesTheWorkflowWithResolvedIds(): void
    {
        $r = $this->create(
            [['id' => '1', 'node_type' => 'playbook', 'config' => ['playbook_ref' => 'reset-pw']], ['id' => '2', 'node_type' => 'agent', 'config' => []]],
            [['from' => '1', 'to' => '2', 'from_port_name' => 'failed']]
        );
        $this->assertSame(201, $r['status_code']);
        $cfg = json_decode((string) $this->db->query('SELECT config FROM workflow_nodes WHERE node_type = \'playbook\'')->fetchColumn(), true);
        $this->assertSame(1, $cfg['playbook_id']);
        $this->assertArrayNotHasKey('playbook_ref', $cfg);
        $this->assertSame('output_2', $this->db->query('SELECT from_port FROM workflow_edges')->fetchColumn());
        $this->assertSame(1, (int) $this->db->query('SELECT COUNT(*) FROM agent_workflows')->fetchColumn());
    }
}
