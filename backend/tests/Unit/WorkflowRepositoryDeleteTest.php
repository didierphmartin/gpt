<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\WorkflowRepository;
use PHPUnit\Framework\TestCase;

/**
 * scheduled_workflows is MyISAM (no foreign key): deleting a workflow must delete its schedules itself, or an
 * orphan event row keeps the option "active" in the data and a timed row stays pending for a workflow that is gone.
 */
final class WorkflowRepositoryDeleteTest extends TestCase
{
    private \PDO $pdo;

    protected function setUp(): void
    {
        $this->pdo = new \PDO('sqlite::memory:');
        $this->pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, name TEXT)');
        $this->pdo->exec('CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER,
            repeat_type TEXT, trigger_component_id INTEGER)');
        $this->pdo->exec("INSERT INTO agent_workflows (id, name) VALUES (66, 'gone'), (67, 'kept')");
        $this->pdo->exec("INSERT INTO scheduled_workflows (workflow_id, repeat_type, trigger_component_id)
            VALUES (66, 'event', 1), (66, 'cron', NULL), (67, 'daily', NULL)");
    }

    public function testDeletingAWorkflowDeletesItsSchedules(): void
    {
        $this->assertTrue((new WorkflowRepository($this->pdo))->delete(66));

        $this->assertSame(0, (int) $this->pdo->query('SELECT COUNT(*) FROM agent_workflows WHERE id = 66')->fetchColumn());
        $this->assertSame(0, (int) $this->pdo->query('SELECT COUNT(*) FROM scheduled_workflows WHERE workflow_id = 66')->fetchColumn());
        $this->assertSame(1, (int) $this->pdo->query('SELECT COUNT(*) FROM scheduled_workflows WHERE workflow_id = 67')->fetchColumn());
    }
}
