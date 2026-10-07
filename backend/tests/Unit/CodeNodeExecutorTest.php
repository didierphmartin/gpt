<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\CodeNodeExecutor;
use PHPUnit\Framework\TestCase;

/** Runs the real python3 runner (no MCP server needed for these cases). */
final class CodeNodeExecutorTest extends TestCase
{
    private function exec(array $config = []): CodeNodeExecutor
    {
        return new CodeNodeExecutor($this->pdo(), $config);
    }

    private function pdo(): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, headers TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO mcp_servers (user_id, name, url, headers, enabled) VALUES ('3', 'Outlook', 'http://127.0.0.1:9/mcp', '{\"X-Outlook-Account\":\"k\"}', 1)");
        return $pdo;
    }

    private static function node(string $code, array $servers = [], array $exits = ['a', 'b']): array
    {
        return ['id' => 2, 'node_type' => 'code', 'config' => ['name' => 'C', 'code' => $code, 'exits' => $exits,
            'mcp_servers' => $servers, 'timeout_s' => 5]];
    }

    public function testRunsTheHarness(): void
    {
        $code = "def run(input, call_tool):\n    return {'route': 'b', 'output': input.upper()}\n";
        $out = $this->exec()->run(self::node($code), [], [2], '3', [['name' => 'start', 'text' => 'hi', 'start' => true]], 'hi');
        self::assertSame('b', $out['result']['route']);
        self::assertSame('HI', $out['result']['output_text']);
    }

    public function testUnknownServerIsRefusedBeforeRunning(): void
    {
        $this->expectExceptionMessage('is not one of your MCP servers');
        $this->exec()->run(self::node("def run(i, c):\n    return {'route': 'a', 'output': 1}\n", ['Nope']), [], [2], '3', [], '');
    }

    public function testSwitchedOff(): void
    {
        self::assertTrue(CodeNodeExecutor::enabled([]));
        self::assertFalse(CodeNodeExecutor::enabled(['code_nodes' => ['server_side' => false]]));
    }

    public function testOwnServerBeatsGlobalOnNameClash(): void
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, headers TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO mcp_servers (user_id, name, url, headers, enabled) VALUES (NULL, 'Outlook', 'http://global/mcp', NULL, 1)");
        $pdo->exec("INSERT INTO mcp_servers (user_id, name, url, headers, enabled) VALUES ('3', 'Outlook', 'http://own/mcp', NULL, 1)");
        $pdo->exec("INSERT INTO mcp_servers (user_id, name, url, headers, enabled) VALUES (NULL, 'Shared', 'http://shared/mcp', NULL, 1)");
        $pdo->exec("INSERT INTO mcp_servers (user_id, name, url, headers, enabled) VALUES ('9', 'Other', 'http://other/mcp', NULL, 1)");
        $m = new \ReflectionMethod(CodeNodeExecutor::class, 'servers');
        $m->setAccessible(true);
        $servers = $m->invoke(new CodeNodeExecutor($pdo, []), '3');
        self::assertSame('http://own/mcp', $servers['outlook']['url']);
        self::assertSame('http://shared/mcp', $servers['shared']['url']);
        self::assertArrayNotHasKey('other', $servers);
    }

    public function testRunnerFailureBecomesAnErrorResult(): void
    {
        $out = (new CodeNodeExecutor($this->pdo(), ['code_nodes' => ['python' => '/usr/bin/false']]))
            ->run(self::node("def run(i, c):\n    return {'route': 'a', 'output': 1}\n"), [], [2], '3', [], '');
        self::assertFalse($out['result']['ok']);
        self::assertStringContainsString('code node runner failed', $out['result']['error']);
    }
}
