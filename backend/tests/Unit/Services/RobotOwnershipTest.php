<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Services;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\RobotOwnership;

/** Robot-owned workflows: who runs them, and whether they are locked (active). */
final class RobotOwnershipTest extends TestCase
{
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, role TEXT, kind TEXT NOT NULL DEFAULT 'person')");
        $this->db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)');
        $this->db->exec("INSERT INTO packages (role, name, builtin, capabilities) VALUES ('user', 'User', 1, '{}')");
        $this->db->exec("INSERT INTO users (id, email, role, kind) VALUES (3, 'p@x.test', 'user', 'person'), (120, 'r@x.test', 'robot', 'service')");
        $this->db->exec('CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT)');
        $this->db->exec("INSERT INTO agent_workflows (id, user_id, name) VALUES (75, 120, 'Robot wf'), (9, 3, 'Mine')");
        $this->db->exec('CREATE TABLE active_workflows (user_id INTEGER PRIMARY KEY, workflow_id INTEGER NOT NULL)');
        $this->db->exec('INSERT INTO active_workflows (user_id, workflow_id) VALUES (120, 75)');
    }

    private function own(string $edition = 'individual'): RobotOwnership
    {
        return new RobotOwnership($this->db, ['edition' => $edition]);
    }

    public function testRobotOwnedAndRunAs(): void
    {
        $o = $this->own();
        $this->assertSame(120, $o->robotId());
        $this->assertTrue($o->isRobotOwned(75));
        $this->assertFalse($o->isRobotOwned(9));
        $this->assertSame(120, $o->runAs(3, 75));
        $this->assertSame(3, $o->runAs(3, 9));
    }

    public function testLocked(): void
    {
        $o = $this->own();
        $this->assertTrue($o->isLocked(75));
        $this->assertFalse($o->isLocked(9));
    }

    public function testNoRobotPermissionMeansNoRobot(): void
    {
        $o = $this->own('corporate');
        $this->assertNull($o->robotFor(3));
        $this->assertSame(3, $o->runAs(3, 75));
    }
}
