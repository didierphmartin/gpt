<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit\Controllers;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\MCPProxyController;
use Quantis\AIPortfolioAssistant\Controllers\RobotServersController;
use Quantis\AIPortfolioAssistant\Services\RobotAccount;
use Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam\WorkflowRobotPublisherTest;

/** MCPProxyController with the wire stubbed: records what would have been sent. */
final class RecordingProxy extends MCPProxyController
{
    public static array $sent = [];
    protected function ensureTablesExist(): void {}
    protected function sendToMCPServer(string $serverUrl, array $request, bool $expectResponse = true, array $extraHeaders = [], string $transport = 'http'): ?array
    {
        self::$sent[] = [$serverUrl, $request['method'] ?? null, $extraHeaders];
        return ['jsonrpc' => '2.0', 'id' => $request['id'] ?? 1, 'result' => ['ok' => true]];
    }
}

/** Task B3: the robot's own MCP server rows. */
final class RobotServersControllerTest extends TestCase
{
    private const CONFIG = ['edition' => 'corporate'];
    private PDO $db;
    private int $robot;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        WorkflowRobotPublisherTest::schema($this->db);
        $this->db->exec('DROP TABLE mcp_servers');   // the shared fixture's table lacks description/transport
        $this->db->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NULL, name TEXT NOT NULL,
            url TEXT NOT NULL, description TEXT, headers TEXT NULL, transport TEXT DEFAULT \'http\', enabled INTEGER DEFAULT 1,
            is_mock INTEGER DEFAULT 0, UNIQUE (user_id, name))');
        $this->robot = RobotAccount::ensure($this->db);
        RecordingProxy::$sent = [];
    }

    private function ctl(): RobotServersController
    {
        return new RobotServersController($this->db, self::CONFIG, fn() => new RecordingProxy($this->db, self::CONFIG));
    }

    private function req(int $u, array $body = [], array $params = []): array
    {
        return ['user_id' => $u, 'body' => $body, 'params' => $params];
    }

    private function add(array $b = []): int
    {
        return $this->ctl()->create($this->req(2, $b + ['name' => 'Outlook', 'url' => 'https://mcp.test/outlook']))['data']['id'];
    }

    public function test_list_shows_header_names_not_values(): void
    {
        $id = $this->add(['description' => 'mail']);
        $this->ctl()->saveKey($this->req(2, ['header' => 'X-Org-Key', 'key' => 'sekret-value'], ['id' => $id]));
        $r = $this->ctl()->index($this->req(2));
        $this->assertSame([['id' => $id, 'name' => 'Outlook', 'url' => 'https://mcp.test/outlook', 'description' => 'mail',
            'enabled' => true, 'header_names' => ['X-Org-Key']]], $r['data']);
        $this->assertStringNotContainsString('sekret-value', json_encode($r));
    }

    public function test_crud_only_on_robot_rows(): void
    {
        $own = 99;
        $this->db->exec("INSERT INTO mcp_servers (id, user_id, name, url) VALUES ($own, '2', 'Mine', 'https://x.test')");
        $c = $this->ctl();
        $this->assertSame([], $c->index($this->req(2))['data']);
        foreach ([$c->update($this->req(2, ['name' => 'Z'], ['id' => $own])), $c->destroy($this->req(2, [], ['id' => $own])),
                  $c->call($this->req(2, ['tool' => 't'], ['id' => $own])),
                  $c->saveKey($this->req(2, ['header' => 'H', 'key' => 'k'], ['id' => $own]))] as $r) {
            $this->assertSame([false, 404], [$r['success'], $r['status_code']]);
        }
        $this->assertSame('Mine', $this->db->query("SELECT name FROM mcp_servers WHERE id = $own")->fetchColumn());

        $id = $this->add();
        $this->assertTrue($c->update($this->req(2, ['name' => 'Outlook2', 'enabled' => false], ['id' => $id]))['success']);
        $row = $this->db->query("SELECT name, enabled, user_id FROM mcp_servers WHERE id = $id")->fetch(PDO::FETCH_NUM);
        $this->assertSame(['Outlook2', 0, (string) $this->robot], [$row[0], (int) $row[1], (string) $row[2]]);
        $this->assertTrue($c->destroy($this->req(2, [], ['id' => $id]))['success']);
        $this->assertSame(1, (int) $this->db->query('SELECT COUNT(*) FROM mcp_servers')->fetchColumn());
    }

    public function test_key_merged_into_headers(): void
    {
        $id = $this->add();
        $this->ctl()->saveKey($this->req(2, ['header' => 'X-A', 'key' => 'one'], ['id' => $id]));
        $this->ctl()->saveKey($this->req(2, ['header' => 'X-B', 'key' => 'two'], ['id' => $id]));
        $this->ctl()->saveKey($this->req(2, ['header' => 'X-A', 'key' => 'three'], ['id' => $id]));
        $h = json_decode((string) $this->db->query("SELECT headers FROM mcp_servers WHERE id = $id")->fetchColumn(), true);
        $this->assertSame(['X-A' => 'three', 'X-B' => 'two'], $h);
        $this->assertSame(400, $this->ctl()->saveKey($this->req(2, ['header' => '', 'key' => 'k'], ['id' => $id]))['status_code']);
    }

    public function test_call_uses_row_headers(): void
    {
        $id = $this->add();
        $this->ctl()->saveKey($this->req(2, ['header' => 'X-Org-Key', 'key' => 'abc'], ['id' => $id]));
        $r = $this->ctl()->call($this->req(2, ['tool' => 'list_mail', 'arguments' => ['n' => 1]], ['id' => $id]));
        $this->assertTrue($r['success']);
        $this->assertSame(['ok' => true], $r['data']['result']);
        $last = end(RecordingProxy::$sent);
        $this->assertSame(['https://mcp.test/outlook', 'tools/call', ['X-Org-Key: abc']], $last);
    }

    public function test_every_route_403_without_use_robot(): void
    {
        $id = $this->add();
        $c = $this->ctl();
        $p = ['id' => $id];
        foreach ([$c->index($this->req(1)), $c->create($this->req(1, ['name' => 'N', 'url' => 'https://a.test'])),
                  $c->update($this->req(1, ['name' => 'N'], $p)), $c->destroy($this->req(1, [], $p)),
                  $c->call($this->req(1, ['tool' => 't'], $p)), $c->saveKey($this->req(1, ['header' => 'H', 'key' => 'k'], $p))] as $r) {
            $this->assertSame([false, 403], [$r['success'], $r['status_code']]);
        }
        $this->assertSame(1, (int) $this->db->query('SELECT COUNT(*) FROM mcp_servers')->fetchColumn());
        $this->assertSame(401, $c->index($this->req(0))['status_code']);
    }
}
