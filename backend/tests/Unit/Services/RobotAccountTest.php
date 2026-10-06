<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\Services;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Services\RobotAccount;

class RobotAccountTest extends TestCase
{
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER DEFAULT 0, capabilities TEXT, updated_at TEXT)');
        $this->db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, first_name TEXT, last_name TEXT,
            password TEXT, provider TEXT, role TEXT, kind TEXT DEFAULT 'person', email_verified INTEGER DEFAULT 0)");
    }

    public function testEnsureCreatesTheRobotOnceWithItsRole(): void
    {
        $this->db->exec("INSERT INTO packages (role, capabilities) VALUES ('user', '{\"sidebar\":{},\"providers\":{}}')");
        $id = RobotAccount::ensure($this->db);
        $this->assertSame($id, RobotAccount::ensure($this->db));
        $this->assertSame($id, RobotAccount::id($this->db));
        $row = $this->db->query("SELECT email, first_name, last_name, password, role, kind FROM users WHERE id = $id")->fetch();
        $this->assertSame(['email' => 'robot@synergyai.invalid', 'first_name' => 'SynergyAI', 'last_name' => 'Operations',
            'password' => null, 'role' => 'robot', 'kind' => 'service'], $row);
        $pkg = $this->db->query("SELECT name, builtin, capabilities FROM packages WHERE role = 'robot'")->fetch();
        $this->assertSame('Robot', $pkg['name']);
        $this->assertSame(1, (int) $pkg['builtin']);
        $this->assertSame('{"sidebar":{},"providers":{}}', $pkg['capabilities']);
        $this->assertSame(1, (int) $this->db->query("SELECT COUNT(*) FROM users WHERE kind = 'service'")->fetchColumn());
        $this->assertSame(1, (int) $this->db->query("SELECT COUNT(*) FROM packages WHERE role = 'robot'")->fetchColumn());
    }

    public function testEnsureWithoutAUserRowGetsEmptyCapabilities(): void
    {
        RobotAccount::ensure($this->db);
        $this->assertSame('{}', $this->db->query("SELECT capabilities FROM packages WHERE role = 'robot'")->fetchColumn());
    }

    public function testIdDoesNotCreate(): void
    {
        $this->assertNull(RobotAccount::id($this->db));
        $this->assertSame(0, (int) $this->db->query('SELECT COUNT(*) FROM users')->fetchColumn());
    }
}
