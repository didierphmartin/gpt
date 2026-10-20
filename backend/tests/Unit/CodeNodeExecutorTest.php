<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\CodeNodeExecutor;
use PHPUnit\Framework\TestCase;

/** Runs the real python3 runner (no MCP server needed for these cases). */
final class CodeNodeExecutorTest extends TestCase
{
    /** A Python 3.10+ interpreter: CODE_NODE_PYTHON, else /usr/local/bin/python3, else python3 from PATH. */
    private static function python(): string
    {
        $env = getenv('CODE_NODE_PYTHON');
        return $env ?: (is_executable('/usr/local/bin/python3') ? '/usr/local/bin/python3' : 'python3');
    }

    private function exec(array $config = []): CodeNodeExecutor
    {
        return new CodeNodeExecutor($this->pdo(), $config + ['code_nodes' => ['python' => self::python()]]);
    }

    /** Skips when the interpreter is too old; otherwise requires the run to have succeeded. */
    private function assertRan(array $out): void
    {
        $err = (string) ($out['result']['error'] ?? '');
        if (!$out['result']['ok'] && str_contains($err, 'needs Python 3.10+')) {
            self::markTestSkipped($err);
        }
        self::assertTrue($out['result']['ok'], $err);
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
        $this->assertRan($out);
        self::assertSame('b', $out['result']['route']);
        self::assertSame('HI', $out['result']['output_text']);
    }

    public function testConfigArgsReachTheCodeAsTheArgsGlobal(): void
    {
        $code = "def run(input, call_tool):\n    return {'route': 'a', 'output': [ARGS.get('tag'), ARGS.get('version') + 1]}\n";
        $node = self::node($code);
        $node['config']['args'] = ['tag' => 'okta-reset', 'version' => 2];
        $out = $this->exec()->run($node, [], [2], '3', [], '');
        $this->assertRan($out);
        self::assertSame('["okta-reset", 3]', $out['result']['output_text']);
        $out = $this->exec()->run(self::node("def run(i, c):\n    return {'route': 'a', 'output': ARGS}\n"), [], [2], '3', [], '');
        $this->assertRan($out);
        self::assertSame('{}', $out['result']['output_text']);
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

    public function testRunawayCodeIsStoppedWithATimeoutError(): void
    {
        $node = self::node("def run(i, c):\n    while True:\n        pass\n");
        $node['config']['timeout_s'] = 1;
        $t = microtime(true);
        $out = $this->exec()->run($node, [], [2], '3', [], '');
        if (!$out['result']['ok'] && str_contains((string) $out['result']['error'], 'needs Python 3.10+')) {
            self::markTestSkipped($out['result']['error']);
        }
        self::assertFalse($out['result']['ok']);
        self::assertMatchesRegularExpression('/time/i', $out['result']['error']);
        self::assertLessThan(10, microtime(true) - $t);
    }

    public function testChildThatNeverStopsIsKilledByTheExecutor(): void
    {
        $dir = sys_get_temp_dir() . '/codenode_stub_' . bin2hex(random_bytes(4));
        mkdir($dir);
        $stub = $dir . '/python';
        file_put_contents($stub, "#!/bin/sh\nexec sleep 30\n");
        chmod($stub, 0755);
        try {
            $node = self::node("def run(i, c):\n    return {'route': 'a', 'output': 1}\n");
            $node['config']['timeout_s'] = 1;
            $t = microtime(true);
            $out = (new CodeNodeExecutor($this->pdo(), ['code_nodes' => ['python' => $stub]]))
                ->run($node, [], [2], '3', [], '');
            self::assertFalse($out['result']['ok']);
            self::assertStringContainsString('(process killed)', $out['result']['error']);
            self::assertLessThan(1 + 5 + 2, microtime(true) - $t);
        } finally {
            @unlink($stub);
            @rmdir($dir);
        }
    }
}
