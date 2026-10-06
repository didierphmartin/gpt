<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\PlaybooksController;
use Quantis\AIPortfolioAssistant\Controllers\RobotController;
use Quantis\AIPortfolioAssistant\Services\RobotAccount;
use Quantis\AIPortfolioAssistant\Tests\Unit\Playbook\PlaybookStoreTest;

final class RobotControllerTest extends TestCase
{
    private PDO $db;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        PlaybookStoreTest::schema($this->db);
        $this->db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT,
            first_name TEXT, last_name TEXT, role TEXT, provider TEXT, kind TEXT NOT NULL DEFAULT 'person', email_verified INTEGER DEFAULT 0)");
        $this->db->exec('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)');
        $this->db->exec("INSERT INTO packages (role, name, builtin, capabilities) VALUES ('user', 'User', 1, '{}'), ('admin', 'Admin', 1, '{}'), ('ops', 'Ops', 0, '{\"use_robot\": true}')");
        $this->db->exec("INSERT INTO users (id, email, role) VALUES (1, 'u@x.test', 'user'), (2, 'o@x.test', 'ops'), (3, 'a@x.test', 'admin')");
    }

    private function req(int $u, array $body = [], array $params = []): array
    {
        return ['user_id' => $u, 'body' => $body, 'params' => $params];
    }

    public function testPublishWithoutUseIsForbidden(): void
    {
        $src = (new \Quantis\AIPortfolioAssistant\Playbook\PlaybookStore($this->db))->save(1, null, PlaybookStoreTest::OKTA, null);
        $c = new PlaybooksController($this->db, ['edition' => 'corporate']);
        $r = $c->publish($this->req(1, [], ['id' => $src['id']]));
        $this->assertFalse($r['success']);
        $this->assertSame(403, $r['status_code']);
        $this->assertSame("Your role can't publish to the robot", $r['error']);
    }

    public function testPublishListUnpublishAndReplacesPayload(): void
    {
        $store = new \Quantis\AIPortfolioAssistant\Playbook\PlaybookStore($this->db);
        $a = $store->save(2, null, PlaybookStoreTest::OKTA, null);
        $c = new PlaybooksController($this->db, ['edition' => 'corporate']);
        $r = $c->publish($this->req(2, [], ['id' => $a['id']]));
        $this->assertTrue($r['success']);
        $this->assertSame(RobotAccount::id($this->db), (int) $this->db->query("SELECT user_id FROM playbooks WHERE id = {$r['data']['id']}")->fetchColumn());
        $rows = $c->index($this->req(2))['data'];
        $this->assertSame('published', $rows[0]['published']);
        $this->assertArrayNotHasKey('published', (new PlaybooksController($this->db, ['edition' => 'corporate']))->index($this->req(1))['data'][0] ?? []);

        $this->db->exec("UPDATE users SET role = 'ops' WHERE id = 1");
        $b = $store->save(1, null, PlaybookStoreTest::OKTA, null);
        $r = $c->publish($this->req(1, [], ['id' => $b['id']]));
        $this->assertSame(409, $r['status_code']);
        $this->assertSame('replaces', $r['kind']);
        $this->assertArrayHasKey('published_at', $r['data']);
        $this->assertTrue($c->publish($this->req(1, ['confirm_replace' => true], ['id' => $b['id']]))['success']);

        $robot = new RobotController($this->db, ['edition' => 'corporate']);
        $this->assertSame(403, $robot->playbooks($this->req(99))['status_code'] ?? 0);
        $list = $robot->playbooks($this->req(2))['data'];
        $this->assertCount(1, $list);
        $this->assertSame($list[0]['id'], $robot->unpublish($this->req(2, [], ['id' => $list[0]['id']]))['success'] ? $list[0]['id'] : null);
        $this->assertSame([], $robot->playbooks($this->req(3))['data']);
    }

    public function testShowReportsFlagsEditionAndCreatesTheRobot(): void
    {
        $this->assertNull(RobotAccount::id($this->db));
        $r = (new RobotController($this->db, ['edition' => 'corporate']))->show($this->req(1));
        $this->assertSame(['exists' => true, 'name' => 'SynergyAI Operations', 'can_use' => false, 'can_manage' => false, 'edition' => 'corporate'], $r['data']);
        $this->assertNotNull(RobotAccount::id($this->db));
        $r = (new RobotController($this->db, ['edition' => 'individual']))->show($this->req(1));
        $this->assertTrue($r['data']['can_use'] && $r['data']['can_manage']);
        $this->assertTrue((new RobotController($this->db, ['edition' => '']))->show($this->req(3))['data']['can_manage']);
    }
}
