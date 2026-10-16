<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\ADKGenerator;
use AgentTeam\Services\CodeNodeEmit;
use AgentTeam\Services\WorkflowGraphAnalyzer;

/** Opt-in (ADK_E2E=1): a compiled ADK script with code nodes RUNS (runner venv) against a fake MCP server. */
class AdkCodeNodeE2ETest extends TestCase
{
    private const PY = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';

    private $server = null;
    private string $log = '';
    private string $url = '';

    protected function setUp(): void
    {
        if (getenv('ADK_E2E') !== '1') {
            self::markTestSkipped('Set ADK_E2E=1 to run.');
        }
        if (!is_file(self::PY)) {
            self::markTestSkipped('venv python missing');
        }
    }

    protected function tearDown(): void
    {
        if (is_resource($this->server)) {
            proc_terminate($this->server, 9);
            proc_close($this->server);
        }
    }

    private function startServer(bool $empty = false): void
    {
        $sock = stream_socket_server('tcp://127.0.0.1:0');
        $port = (int) substr(strrchr(stream_socket_get_name($sock, false), ':'), 1);
        fclose($sock);
        $this->log = sys_get_temp_dir() . '/adk_e2e_' . bin2hex(random_bytes(4)) . '.jsonl';
        $args = ['python3', dirname(__DIR__) . '/fixtures/fake_mcp_server.py', (string) $port, $this->log];
        if ($empty) {
            $args[] = 'empty';
        }
        $this->server = proc_open($args, [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
        $this->url = "http://127.0.0.1:{$port}";
        for ($i = 0; $i < 50; $i++) {
            $c = @fsockopen('127.0.0.1', $port, $en, $es, 0.1);
            if ($c) {
                fclose($c);
                return;
            }
            usleep(100000);
        }
        self::fail('fake MCP server did not start');
    }

    /** Start -> trigger T (new_mail | no_mail) -> branch B (on new_mail) -> Output; no LLM node. */
    private function analyzed(string $branchCode): array
    {
        $trigger = "def run(input, call_tool):\n    m = call_tool('outlook', 'next_mail', {})\n"
            . "    return {'route': 'new_mail' if m else 'no_mail', 'output': m}\n";
        $graph = ['nodes' => [
            ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'go']],
            ['id' => '10', 'type' => 'code', 'config' => ['type' => 'code', 'name' => 'T', 'code' => $trigger,
                'exits' => ['new_mail', 'no_mail'], 'mcp_servers' => ['Outlook'], 'timeout_s' => 30]],
            ['id' => '3', 'type' => 'code', 'config' => ['type' => 'code', 'name' => 'B', 'code' => $branchCode,
                'exits' => ['next'], 'mcp_servers' => ['Outlook'], 'timeout_s' => 30]],
            ['id' => '5', 'type' => 'output', 'config' => ['type' => 'output']],
        ], 'edges' => [
            ['from' => '1', 'to' => '10', 'from_port' => 'output_1'],
            ['from' => '10', 'to' => '3', 'from_port' => 'output_1'],
            ['from' => '3', 'to' => '5', 'from_port' => 'output_1'],
        ]];
        $a = array_merge(WorkflowGraphAnalyzer::analyzeGraph($graph), [
            'workflow' => ['id' => 99, 'name' => 'adk e2e'], 'usedCatalog' => [], 'usedServers' => [],
            'serverSlugs' => [$this->url => 'outlook'], 'startPrompt' => 'go', 'startDocuments' => [],
            'agents' => [], 'playbooks' => [],
        ]);
        $byId = array_column($graph['nodes'], null, 'id');
        $a['code'] = [];
        foreach (['10', '3'] as $cid) {
            $a['code'][$cid] = CodeNodeEmit::nodeData($byId[$cid], $graph['edges'], ['outlook' => $this->url], ['1', '10', '3', '5']);
        }
        return $a;
    }

    private function run_(array $analyzed): array
    {
        $dir = sys_get_temp_dir() . '/adk_e2e_' . bin2hex(random_bytes(4));
        mkdir($dir);
        file_put_contents("$dir/workflow.py", ADKGenerator::emitAdk($analyzed));
        file_put_contents("$dir/.env", "MCP_HEADERS_OUTLOOK={\"X-Outlook-Account\":\"acc-1\"}\n");
        $proc = proc_open([self::PY, 'workflow.py', 'go'], [1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes, $dir,
            ['PATH' => getenv('PATH'), 'HOME' => getenv('HOME')]);
        $text = (string) stream_get_contents($pipes[1]);
        $rc = proc_close($proc);
        fwrite(STDERR, "\n--- ADK E2E output ($dir) ---\n$text\n");
        return [$rc, $text];
    }

    private function calls(): array
    {
        $out = [];
        foreach (file($this->log, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $l) {
            $out[] = json_decode($l, true);
        }
        return $out;
    }

    private const FILE = "def run(input, call_tool):\n    call_tool('outlook', 'move_mail', {'id': input['id'], 'folder': 'Inbox/' + NODE_NAME})\n"
        . "    return {'output': 'filed ' + input['subject']}\n";

    public function testRoutesFilesAndSendsHeaders(): void
    {
        $this->startServer();
        [$rc, $text] = $this->run_($this->analyzed(self::FILE));
        self::assertSame(0, $rc, $text);
        self::assertStringContainsString('filed test 50', $text);
        $moves = array_values(array_filter($this->calls(), fn($c) => ($c['tool'] ?? '') === 'move_mail'));
        self::assertCount(1, $moves);
        self::assertSame('Inbox/B', $moves[0]['args']['folder']);
        foreach ($this->calls() as $c) {
            self::assertSame('acc-1', $c['headers']['x-outlook-account'] ?? null, json_encode($c));
        }
    }

    public function testNoMailSkipsEverythingDownstream(): void
    {
        $this->startServer(true);
        [$rc, $text] = $this->run_($this->analyzed(self::FILE));
        self::assertSame(0, $rc, $text);
        self::assertStringContainsString('skipped (its branch was not taken)', $text);
        // nothing to do: the answer is the Output's, empty -- not the trigger's text (review I1)
        self::assertStringContainsString('[workflow] done in', $text);
        self::assertMatchesRegularExpression('/\[workflow\] done in [0-9.]+s, 0 chars/', $text);
        self::assertSame([], array_filter($this->calls(), fn($c) => ($c['tool'] ?? '') === 'move_mail'));
    }

    public function testFailingCodeStopsTheRun(): void
    {
        $this->startServer();
        [$rc, $text] = $this->run_($this->analyzed("def run(input, call_tool):\n    return call_tool('other', 'x', {})\n"));
        self::assertNotSame(0, $rc, $text);
        self::assertStringContainsString("code node 'B' failed", $text);
    }
}
