<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\StartOptionGraph;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;
use PHPUnit\Framework\TestCase;

/**
 * Opt-in (CODE_NODE_E2E=1): spec 2026-10-15 langgraph standalone, the whole path. The modular package of a Start-option
 * workflow runs with real Python against a fake Outlook MCP server: it catches the event, routes it with a code node
 * (no LLM), records one run, and stays quiet on the empty poll that follows.
 */
final class LangGraphStandaloneE2ETest extends TestCase
{
    private const VENV = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';

    private const POLL = "def run(input, call_tool):\n    r = call_tool('outlook', 'poll_new_mail', {})\n"
        . "    if r.get('mail') is None:\n        return {'route': 'no_mail', 'output': None}\n    return {'route': 'new_mail', 'output': r['mail']}\n";

    private const CLASSIFY = "def run(input, call_tool):\n    return {'route': 'claim' if 'Claim' in input else 'other', 'output': input}\n";

    protected function setUp(): void
    {
        if (getenv('CODE_NODE_E2E') !== '1') {
            self::markTestSkipped('Set CODE_NODE_E2E=1 to run.');
        }
        if (!is_file(self::VENV)) {
            self::markTestSkipped('venv python missing');
        }
    }

    private function pdo(): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER, headers TEXT)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (7, '3', 'Outlook', 'http://127.0.0.1:8770/mcp', 1, NULL)");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 7, 'poll_new_mail', 'Poll', '{}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (2, 7, 'wait_for_new', 'Wait', '{}')");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)");
        return $pdo;
    }

    /** Start option (17) -> Classify (19) -> claim: Output A (18) / other: Output B (20). */
    private function graph(): array
    {
        $raw = ['nodes' => [
                ['id' => '17', 'node_type' => 'start', 'config' => ['type' => 'start', 'start_option' => 5]],
                ['id' => '19', 'node_type' => 'code', 'config' => ['type' => 'code', 'name' => 'Classify',
                    'code' => self::CLASSIFY, 'exits' => ['claim', 'other'], 'mcp_servers' => [], 'timeout_s' => 30]],
                ['id' => '18', 'node_type' => 'output', 'config' => ['type' => 'output']],
                ['id' => '20', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ], 'edges' => [
                ['from_node_id' => '17', 'to_node_id' => '19', 'from_port' => 'output_1'],
                ['from_node_id' => '19', 'to_node_id' => '18', 'from_port' => 'output_1'],
                ['from_node_id' => '19', 'to_node_id' => '20', 'from_port' => 'output_2'],
            ]];
        return StartOptionGraph::expand($raw, fn(int $id) => ['name' => 'Outlook: get new email', 'code' => self::POLL,
            'exits' => ['new_mail', 'no_mail'], 'mcp_servers' => ['Outlook'], 'timeout_s' => 30,
            'start_trigger' => ['label' => 'Outlook: get new email', 'work_exit' => 'new_mail',
                'watch' => ['server' => 'Outlook', 'tool' => 'wait_for_new', 'args' => ['folder' => 'Inbox']]]]);
    }

    private function generate(): array
    {
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Email triage', 'user_id' => '3',
            'output_storage_enabled' => true]));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($this->graph());
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        return (new LangGraphGenerator($this->pdo(), $wfRepo, $graphRepo, $agentRepo))->generate(44, '3', ['modular' => true]);
    }

    private static function freePort(): int
    {
        $s = stream_socket_server('tcp://127.0.0.1:0');
        $port = (int) substr(strrchr((string) stream_socket_get_name($s, false), ':'), 1);
        fclose($s);
        return $port;
    }

    private static function rmrf(string $dir): void
    {
        foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST) as $f) {
            $f->isDir() && !$f->isLink() ? rmdir($f->getPathname()) : unlink($f->getPathname());
        }
        rmdir($dir);
    }

    public function testACompiledWatchWorkflowCatchesAnEventRoutesItAndStaysQuietAfterwards(): void
    {
        $dir = sys_get_temp_dir() . '/lgstandalone_' . bin2hex(random_bytes(4));
        mkdir("$dir/pkg", 0777, true);
        $port = self::freePort();
        $fake = $wf = null;
        try {
            foreach ($this->generate()['files'] as $f) {
                @mkdir(dirname("$dir/pkg/{$f['path']}"), 0777, true);
                file_put_contents("$dir/pkg/{$f['path']}", ($f['encoding'] ?? '') === 'base64' ? base64_decode($f['code']) : $f['code']);
            }
            file_put_contents("$dir/pkg/.env", "MCP_URL_OUTLOOK=http://127.0.0.1:$port/mcp\n");

            $fake = proc_open([self::VENV, __DIR__ . '/../fixtures/compiled/fake_outlook_mcp.py', (string) $port],
                [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $fp);
            for ($i = 0; $i < 50 && !@fsockopen('127.0.0.1', $port); $i++) {
                usleep(100000);
            }

            $wf = proc_open([self::VENV, 'workflow.py'], [1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes, "$dir/pkg",
                ['PATH' => getenv('PATH'), 'HOME' => getenv('HOME'), 'SYNERGYAI_OUTPUT_ROOT' => "$dir/outputs", 'PYTHONUNBUFFERED' => '1']);
            stream_set_blocking($pipes[1], false);
            $text = '';
            $until = microtime(true) + 4;
            while (microtime(true) < $until) {
                $text .= (string) stream_get_contents($pipes[1]);
                usleep(100000);
            }
            proc_terminate($wf, SIGTERM);
            stream_set_blocking($pipes[1], true);
            $text .= (string) stream_get_contents($pipes[1]);
            proc_close($wf);
            $wf = null;
            echo "\n--- E2E stdout ---\n$text------------------\n";

            self::assertStringContainsString('Listening for events: outlook.wait_for_new', $text);
            self::assertMatchesRegularExpression('~\[\d\d:\d\d\] New event — From: jane@acme\.com · Subject: Claim for water damage~', $text);
            self::assertStringContainsString('  ✓ Classify', $text);
            self::assertStringContainsString('[watch] stopped.', $text);

            $logs = glob("$dir/pkg/runs/*.jsonl");
            self::assertCount(1, $logs, "one run only; the empty poll is quiet\n$text");
            $events = array_map(fn($l) => json_decode($l, true), file($logs[0], FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES));
            $done = array_values(array_filter($events, fn($e) => $e['type'] === 'node_complete' && ($e['node_name'] ?? '') === 'Classify'));
            self::assertCount(1, $done);
            self::assertSame('claim', $done[0]['exit']);
            $last = end($events);
            self::assertSame('workflow_complete', $last['type']);
            self::assertTrue($last['success']);

            self::assertCount(1, glob("$dir/outputs/*/*"), 'one saved output');

            $lock = <<<'PY'
import fcntl
fh = open(".run.lock", "a+")
fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
print("LOCKED")
PY;
            exec(escapeshellarg(self::VENV) . ' -c ' . escapeshellarg($lock) . ' 2>&1', $out, $rc);
            self::assertSame(['LOCKED'], $out, 'the run lock is free after exit');
        } finally {
            foreach ([$wf, $fake] as $p) {
                if (is_resource($p)) {
                    proc_terminate($p, SIGKILL);
                    proc_close($p);
                }
            }
            self::rmrf($dir);
        }
    }
}
