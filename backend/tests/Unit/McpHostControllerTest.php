<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PDO;
use PHPUnit\Framework\TestCase;
use Quantis\AIPortfolioAssistant\Controllers\McpHostController;
use Quantis\AIPortfolioAssistant\Services\GitHubFetchError;
use Quantis\AIPortfolioAssistant\Services\McpHostClient;

class McpHostControllerTest extends TestCase
{
    private PDO $db;
    /** @var list<array{method:string,url:string,headers:array,body:?string}> */
    private array $calls = [];
    private array $reply = [];

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT)');
        $this->db->exec("INSERT INTO users VALUES (1, 'admin'), (3, 'user'), (4, 'user')");
        $_ENV['MCPS_URL'] = 'http://mcps:8790';
        $_ENV['MCPS_TOKEN'] = 'tok';
        $_ENV['MCPS_PUBLIC_GATEWAY'] = 'http://localhost:8791';
        $this->calls = [];
        $this->reply = [200, json_encode([
            ['folder' => 'a', 'installed_by' => 3, 'log' => 'x'],
            ['folder' => 'b', 'installed_by' => 4, 'log' => 'y'],
        ])];
    }

    protected function tearDown(): void
    {
        unset($_ENV['MCPS_URL'], $_ENV['MCPS_TOKEN'], $_ENV['MCPS_PUBLIC_GATEWAY']);
    }

    private function ctl(array $config = []): McpHostController
    {
        $transport = function (string $method, string $url, array $headers, ?string $body): array {
            $this->calls[] = compact('method', 'url', 'headers', 'body');
            return $this->reply;
        };
        return new McpHostController($this->db, $config, fn() => new McpHostClient('http://mcps:8790', 'tok', $transport));
    }

    private function req(int $uid, array $body = []): array
    {
        return ['user_id' => $uid, 'body' => $body];
    }

    public function testHostUnavailableWithoutMcpsUrl(): void
    {
        $_ENV['MCPS_URL'] = '';
        $r = $this->ctl()->info($this->req(3));
        $this->assertSame(['available' => false], $r['data']);
        $r = $this->ctl()->install($this->req(3, ['files' => []]), 'a');
        $this->assertSame(404, $r['status_code']);
        $this->assertSame('no server host', $r['data']['error']);
        $this->assertSame([], $this->calls);
    }

    public function testInstallSendsCallerAsOwner(): void
    {
        $this->reply = [200, '{"ok":true}'];
        $r = $this->ctl()->install($this->req(3, ['files' => [], 'installed_by' => 999]), 'new');
        $this->assertSame(200, $r['status_code']);
        $this->assertSame('POST', $this->calls[0]['method']);
        $this->assertStringEndsWith('/servers/new/install', $this->calls[0]['url']);
        $this->assertSame(3, json_decode($this->calls[0]['body'], true)['installed_by']);
    }

    public function testCorporateInstallIsAdminOnly(): void
    {
        $this->reply = [200, '{"ok":true}'];
        $corp = $this->ctl(['edition' => 'corporate']);
        $r = $corp->install($this->req(3, ['files' => []]), 'new');
        $this->assertSame(403, $r['status_code']);
        $this->assertSame('Only an admin can install MCP servers here.', $r['data']['error']);
        $this->assertSame([], $this->calls);
        $this->assertSame(200, $corp->install($this->req(1, ['files' => []]), 'new')['status_code']);
        $this->assertSame(200, $this->ctl(['edition' => 'individual'])->install($this->req(3, ['files' => []]), 'new')['status_code']);
    }

    public function testOthersCannotTouchOrSeeLogs(): void
    {
        $c = $this->ctl();
        $r = $c->restart($this->req(4), 'a');
        $this->assertSame(403, $r['status_code']);
        $this->assertCount(1, $this->calls); // only the list lookup
        $list = $c->list($this->req(4))['data'];
        $this->assertArrayNotHasKey('log', $list[0]);
        $this->assertArrayHasKey('log', $list[1]);
        $this->assertArrayHasKey('log', $c->list($this->req(1))['data'][0]);
        $this->assertSame(200, $c->restart($this->req(1), 'a')['status_code']);
        $this->assertSame(404, $c->restart($this->req(1), 'zzz')['status_code']);
    }

    public function testSupervisorDownIsA503WithText(): void
    {
        $this->reply = [0, ''];
        $r = $this->ctl()->list($this->req(3));
        $this->assertSame(503, $r['status_code']);
        $this->assertSame('The server host is not reachable', $r['data']['error']);
    }

    public function testStatusPassesThrough(): void
    {
        $this->reply = [409, '{"error":"disabled"}'];
        $r = $this->ctl()->restart($this->req(1), 'a');
        $this->assertSame(409, $r['status_code']);
        $this->assertSame('disabled', $r['data']['error']);
        $this->assertSame('disabled', $r['error']);
    }

    public function testRawFolderSurvivesNumericCast(): void
    {
        $this->reply = [200, '{"ok":true}'];
        $this->ctl()->install(['user_id' => 3, 'body' => [], 'params' => ['folder' => '007']], 7);
        $this->assertStringEndsWith('/servers/007/install', $this->calls[0]['url']);
    }

    public function testBadFolderIs400(): void
    {
        $this->assertSame(400, $this->ctl()->install($this->req(3), '.hidden')['status_code']);
    }

    public function testTokenIsSentAndNeverReturned(): void
    {
        $r = $this->ctl()->list($this->req(1));
        $this->assertContains('Authorization: Bearer tok', $this->calls[0]['headers']);
        $this->assertStringNotContainsString('tok', json_encode($r));
    }

    private function fetchCtl(\Closure $fetch, array $config = []): McpHostController
    {
        $fetcher = new class($fetch) {
            public function __construct(private \Closure $fn) {}
            public function fetch(string $url): array { return ($this->fn)($url); }
        };
        return new McpHostController($this->db, $config, fn() => new McpHostClient('http://mcps:8790', 'tok', fn() => $this->reply), fn() => $fetcher);
    }

    public function testFetchUnavailableWithoutHost(): void
    {
        $_ENV['MCPS_URL'] = '';
        $r = $this->fetchCtl(fn() => [])->fetch($this->req(3, ['url' => 'https://github.com/o/r']));
        $this->assertSame(404, $r['status_code']);
        $this->assertFalse($r['success']);
    }

    public function testFetchCorporateNonAdminRefused(): void
    {
        $called = false;
        $c = $this->fetchCtl(function () use (&$called) { $called = true; return []; }, ['edition' => 'corporate']);
        $r = $c->fetch($this->req(3, ['url' => 'https://github.com/o/r']));
        $this->assertSame(403, $r['status_code']);
        $this->assertSame('Only an admin can install MCP servers here.', $r['error']);
        $this->assertFalse($called);
        $this->assertSame(200, $c->fetch($this->req(1, ['url' => 'https://github.com/o/r']))['status_code']);
    }

    public function testFetchReturnsFetcherResult(): void
    {
        $got = null;
        $result = ['folder' => 'srv', 'manifest' => [], 'fields' => [], 'files' => ['a.py' => 'eA=='], 'source' => ['sha' => 'abc']];
        $r = $this->fetchCtl(function ($u) use (&$got, $result) { $got = $u; return $result; })->fetch($this->req(3, ['url' => 'https://github.com/o/r']));
        $this->assertSame('https://github.com/o/r', $got);
        $this->assertSame(['success' => true, 'data' => $result, 'status_code' => 200], $r);
        $this->assertArrayNotHasKey('.env', $r['data']['files']);
    }

    public function testFetchMapsErrors(): void
    {
        $r = $this->fetchCtl(fn() => throw new GitHubFetchError(404, 'Repository, branch or folder not found on GitHub'))->fetch($this->req(3, ['url' => 'x']));
        $this->assertSame(['success' => false, 'error' => 'Repository, branch or folder not found on GitHub', 'status_code' => 404], $r);
        $r = $this->fetchCtl(fn() => throw new \InvalidArgumentException('Not a GitHub link'))->fetch($this->req(3, []));
        $this->assertSame(400, $r['status_code']);
        $this->assertSame('Not a GitHub link', $r['error']);
        $r = $this->fetchCtl(fn() => throw new GitHubFetchError(400, 'bad link'))->fetch($this->req(3, ['url' => 'x']));
        $this->assertSame(400, $r['status_code']);
    }
}
