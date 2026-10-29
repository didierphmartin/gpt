<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use AgentTeam\Services\WorkflowRepository;
use PDO;
use PHPUnit\Framework\TestCase;

/** Robot-owned workflows are listed and accessible when the caller may use the robot. */
final class WorkflowRepositoryRobotTest extends TestCase
{
    private WorkflowRepository $repo;

    protected function setUp(): void
    {
        $db = new PDO('sqlite::memory:');
        $db->exec('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, description TEXT, enabled INTEGER DEFAULT 1)');
        $db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (75, 120, 'Robot wf'), (9, 3, 'Mine')");
        $this->repo = new WorkflowRepository($db);
    }

    public function testFindByUserIncludesRobotWorkflowsOnlyWhenGivenRobot(): void
    {
        $ids = fn(array $ws) => array_map(fn($w) => $w->getId(), $ws);
        $with = $ids($this->repo->findByUser(3, false, 120));
        sort($with);
        $this->assertSame([9, 75], $with);
        $this->assertSame([9], $ids($this->repo->findByUser(3)));
    }

    public function testAccessAndOwnership(): void
    {
        $this->assertTrue($this->repo->canUserAccess(3, 75, 120));
        $this->assertTrue($this->repo->isOwner(3, 75, 120));
        $this->assertFalse($this->repo->canUserAccess(3, 75));
        $this->assertFalse($this->repo->canUserAccess(4, 75, null));
        $this->assertFalse($this->repo->canUserAccess(4, 9, 120));
    }
}
