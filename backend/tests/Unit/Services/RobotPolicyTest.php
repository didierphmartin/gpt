<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Services;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\RobotPolicy;

final class RobotPolicyTest extends TestCase
{
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT)');
        $this->db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)');
        $this->db->exec("INSERT INTO packages (role, name, builtin, capabilities) VALUES
            ('guest', 'Guest', 1, '{}'), ('user', 'User', 1, '{}'), ('admin', 'Admin', 1, '{}'),
            ('ops', 'Ops', 0, '{\"use_robot\": true}'), ('nope', 'Nope', 0, '{\"use_robot\": false}')");
        $this->db->exec("INSERT INTO users (id, role) VALUES (1, 'user'), (2, 'ops'), (3, 'nope'), (4, 'admin')");
    }

    public function testIndividualUsesAndManages(): void
    {
        $p = new RobotPolicy($this->db, ['edition' => 'individual']);
        $this->assertTrue($p->canUse(1));
        $this->assertTrue($p->canManage(1));
    }

    /** @dataProvider nonIndividual */
    public function testUseFollowsTheRoleCapabilityAndManageIsAdmin(string $edition): void
    {
        $p = new RobotPolicy($this->db, ['edition' => $edition]);
        $this->assertFalse($p->canUse(1));
        $this->assertTrue($p->canUse(2));
        $this->assertFalse($p->canUse(3));
        $this->assertFalse($p->canManage(1));
        $this->assertFalse($p->canManage(2));
        $this->assertTrue($p->canManage(4));
    }

    public static function nonIndividual(): array
    {
        return [['corporate'], ['']];
    }
}
