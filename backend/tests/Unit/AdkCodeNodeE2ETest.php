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
    /** The target under test: MafE2ETest overrides these three, the scenarios are the same. */
    protected const ENV_FLAG = 'ADK_E2E';

    protected function emit(array $analyzed): string
    {
        return ADKGenerator::emitAdk($analyzed);
    }

    protected function packageFiles(array $analyzed): array
    {
        return \AgentTeam\Services\ADKPackage::files($analyzed, sys_get_temp_dir());
    }

    private const PY = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';

    private $server = null;
    private string $log = '';
    private string $url = '';

    protected function setUp(): void
    {
        if (getenv(static::ENV_FLAG) !== '1') {
            self::markTestSkipped('Set ' . static::ENV_FLAG . '=1 to run.');
        }
        if (!is_file(self::PY)) {
            self::markTestSkipped('venv python missing');
        }
    }

    protected function tearDown(): void
    {
        if (is_resource($this->api ?? null)) {
            proc_terminate($this->api, 9);
            proc_close($this->api);
        }
        if (is_resource($this->server)) {
            proc_terminate($this->server, 9);
            proc_close($this->server);
        }
    }

    private function startServer(bool $empty = false, string $mode = ''): void
    {
        $sock = stream_socket_server('tcp://127.0.0.1:0');
        $port = (int) substr(strrchr(stream_socket_get_name($sock, false), ':'), 1);
        fclose($sock);
        $this->log = sys_get_temp_dir() . '/adk_e2e_' . bin2hex(random_bytes(4)) . '.jsonl';
        $args = ['python3', dirname(__DIR__) . '/fixtures/fake_mcp_server.py', (string) $port, $this->log];
        if ($empty || $mode !== '') {
            $args[] = $empty ? 'empty' : $mode;
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
        file_put_contents("$dir/workflow.py", $this->emit($analyzed));
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
        foreach ((is_file($this->log) ? file($this->log, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) : []) ?: [] as $l) {   // no request yet: no log file
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
        self::assertMatchesRegularExpression('/\[workflow\] done in [0-9.]+s, 0 chars|Final output: 0 chars/', $text);
        self::assertSame([], array_filter($this->calls(), fn($c) => ($c['tool'] ?? '') === 'move_mail'));
    }

    public function testFailingCodeStopsTheRun(): void
    {
        $this->startServer();
        [$rc, $text] = $this->run_($this->analyzed("def run(input, call_tool):\n    return call_tool('other', 'x', {})\n"));
        self::assertNotSame(0, $rc, $text);
        self::assertStringContainsString("code node 'B' failed", $text);
    }

    private $api = null;

    /** The E2E graph as a listening package (watch on outlook.wait_for_new), written to a folder; returns the folder. */
    private function writeListeningPackage(?array $a = null, string $startMode = 'watch'): string
    {
        if ($a === null) {
            // the branch takes 3 s, as a real one (an LLM, a mail move) does: /live sends a run it sees in
            // progress; one already over at its first look is history (LiveFeed's rule)
            $a = $this->analyzed("import time\n" . self::FILE . "\n# slow\n");
            $a['code']['3']['source'] = str_replace("def run(input, call_tool):\n", "def run(input, call_tool):\n    time.sleep(3)\n", $a['code']['3']['source']);
        }
        $a['startMode'] = $startMode;
        $a['defaultWatch'] = ['server' => 'outlook', 'tool' => 'wait_for_new', 'args' => []];
        $a['package'] = true;
        $pkg = \AgentTeam\Services\RunServerEmitter::package(['code' => $this->emit($a)], 'adk e2e', 'e2e', 'run server',
            \AgentTeam\Services\CompiledRuntimeEmit::packageCommonBlock(), true);
        $dir = sys_get_temp_dir() . '/adk_listen_' . bin2hex(random_bytes(4));
        foreach (array_merge($pkg['files'], $this->packageFiles($a)) as $f) {
            @mkdir(dirname("$dir/{$f['path']}"), 0777, true);
            file_put_contents("$dir/{$f['path']}", $f['code']);
        }
        file_put_contents("$dir/.env", "MCP_HEADERS_OUTLOOK={\"X-Outlook-Account\":\"acc-1\"}\nJEV_API_KEY=jev-test-key\n");
        return $dir;
    }

    private function startApi(string $dir): string
    {
        $sock = stream_socket_server('tcp://127.0.0.1:0');
        $port = (int) substr(strrchr(stream_socket_get_name($sock, false), ':'), 1);
        fclose($sock);
        $this->api = proc_open([self::PY, 'api.py', '--port', (string) $port], [1 => ['file', "$dir/api.log", 'w'], 2 => ['file', "$dir/api.log", 'a']],
            $pipes, $dir, ['PATH' => getenv('PATH'), 'HOME' => getenv('HOME')]);
        $base = "http://127.0.0.1:{$port}";
        for ($i = 0; $i < 100; $i++) {
            if (@file_get_contents("$base/.well-known/workflow.json") !== false) {
                return $base;
            }
            usleep(200000);
        }
        self::fail("api.py did not start:\n" . @file_get_contents("$dir/api.log"));
    }

    private static function post(string $url, array $body): array
    {
        $ctx = stream_context_create(['http' => ['method' => 'POST', 'header' => "Content-Type: application/json\r\n",
            'content' => json_encode((object) $body), 'ignore_errors' => true, 'timeout' => 10]]);
        $text = (string) @file_get_contents($url, false, $ctx);
        preg_match('{HTTP/\S+ (\d+)}', $http_response_header[0] ?? '', $m);
        return [(int) ($m[1] ?? 0), json_decode($text, true)];
    }

    /** GET /live for $seconds: the SSE text (curl: the stream is chunked and never ends on its own). */
    private static function live(string $base, int $seconds): string
    {
        exec('curl -s -N -m ' . $seconds . ' ' . escapeshellarg("$base/live"), $out);
        return implode("\n", $out);
    }

    private function runEvents(string $dir): array
    {
        $out = [];
        foreach (glob("$dir/runs/*.jsonl") ?: [] as $f) {
            foreach (file($f, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $l) {
                $out[] = json_decode($l, true);
            }
        }
        return $out;
    }

    public function testPackageListensRecordsAndStops(): void
    {
        $this->startServer();
        $dir = $this->writeListeningPackage();
        $base = $this->startApi($dir);
        // the canvas connects to /live first, then the runs come (a new connection streams runs from then on)
        $live = proc_open(['curl', '-s', '-N', '-m', '20', "$base/live"], [1 => ['file', "$dir/live.txt", 'w']], $p);
        usleep(500000);
        [$code, $r] = self::post("$base/listen", []);
        self::assertSame(200, $code, json_encode($r));
        self::assertTrue($r['listening']);
        $events = [];
        for ($i = 0; $i < 150; $i++) {
            $events = $this->runEvents($dir);
            if (in_array('workflow_complete', array_column($events, 'type'), true)) {
                break;
            }
            usleep(200000);
        }
        $done = array_values(array_filter($events, fn($e) => $e['type'] === 'workflow_complete'));
        self::assertNotEmpty($done, "no completed run:\n" . file_get_contents("$dir/api.log"));
        self::assertTrue($done[0]['success'], json_encode($done[0]));
        // the drain runs again at once; that quiet run's file exists while it runs, then goes
        for ($i = 0; $i < 50 && count(glob("$dir/runs/*.jsonl")) !== 1; $i++) {
            usleep(200000);
        }
        $events = $this->runEvents($dir);   // the real run's events only
        $completed = [];
        foreach ($events as $e) {
            if ($e['type'] === 'node_complete') {
                $completed[$e['node_id']] = $e;
            }
        }
        self::assertSame(['1', '10', '3', '5'], array_map('strval', array_keys($completed)));
        self::assertSame('new_mail', $completed['10']['exit']);
        self::assertSame('start', $completed['1']['node_type']);
        // the drain runs again at once; that quiet run's file exists while it runs, then goes
        for ($i = 0; $i < 50 && count(glob("$dir/runs/*.jsonl")) !== 1; $i++) {
            usleep(200000);
        }
        self::assertCount(1, glob("$dir/runs/*.jsonl"), 'the drain\'s second, quiet run leaves no file');
        self::assertCount(1, array_filter($this->calls(), fn($c) => ($c['tool'] ?? '') === 'move_mail'));
        // GET /live streams the run to the canvas
        proc_close($live);   // curl ends at -m 20
        $stream = (string) file_get_contents("$dir/live.txt");
        self::assertMatchesRegularExpression('/event: run\\ndata: .*"node_id":\\s*"10"/', $stream);
        self::assertMatchesRegularExpression('/"type":\\s*"workflow_complete"/', $stream);
        // a served run is refused while listening
        [$code] = self::post("$base/runs", ['prompt' => 'x']);
        self::assertSame(409, $code);
        // stop: the state line says so once the wait in flight returns
        self::post("$base/listen", ['stop' => true]);
        $state = '';
        for ($i = 0; $i < 10 && !str_contains($state, 'Not listening: stopped'); $i++) {
            sleep(1);
            $state = self::live($base, 2);
        }
        self::assertStringContainsString('Not listening: stopped', $state);
    }

    public function testQuietWakeLeavesNoRun(): void
    {
        $this->startServer(true);
        $dir = $this->writeListeningPackage();
        $base = $this->startApi($dir);
        self::post("$base/listen", []);
        for ($i = 0; $i < 50 && count(array_filter($this->calls(), fn($c) => ($c['tool'] ?? '') === 'next_mail')) < 1; $i++) {
            usleep(200000);
        }
        sleep(2);   // the run after the wake has ended
        self::assertSame([], glob("$dir/runs/*.jsonl") ?: [], 'a quiet run leaves no run file');
        self::assertMatchesRegularExpression('/"listening":\\s*true/', self::live($base, 2));
    }

    /** Start -> trigger T -> dispatcher D (Jev) -> code A | code B -> Output; no LLM turn at all. */
    private function jevAnalyzed(string $unclearBranch = ''): array
    {
        $file = "def run(input, call_tool):\n    call_tool('outlook', 'move_mail', {'id': input['id'], 'folder': 'Inbox/' + NODE_NAME})\n"
            . "    return 'filed ' + input['subject']\n";
        $trigger = "def run(input, call_tool):\n    m = call_tool('outlook', 'next_mail', {})\n"
            . "    return {'route': 'new_mail' if m else 'no_mail', 'output': m}\n";
        $code = fn(string $id, string $name, string $src, array $exits) => ['id' => $id, 'type' => 'code',
            'config' => ['type' => 'code', 'name' => $name, 'code' => $src, 'exits' => $exits, 'mcp_servers' => ['Outlook'], 'timeout_s' => 30]];
        $graph = ['nodes' => [
            ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'go']],
            $code('10', 'T', $trigger, ['new_mail', 'no_mail']),
            ['id' => '2', 'type' => 'agent', 'config' => ['type' => 'agent', 'agent_name' => 'D', 'agent_type' => 'dispatcher', 'provider' => 'claude', 'model' => 'm']],
            $code('3', 'A', $file, ['next']),
            $code('4', 'B', $file, ['next']),
            ['id' => '5', 'type' => 'output', 'config' => ['type' => 'output']],
        ], 'edges' => [
            ['from' => '1', 'to' => '10', 'from_port' => 'output_1'], ['from' => '10', 'to' => '2', 'from_port' => 'output_1'],
            ['from' => '2', 'to' => '3'], ['from' => '2', 'to' => '4'], ['from' => '3', 'to' => '5'], ['from' => '4', 'to' => '5'],
        ]];
        $a = array_merge(WorkflowGraphAnalyzer::analyzeGraph($graph), [
            'workflow' => ['id' => 98, 'name' => 'adk jev'], 'usedCatalog' => [], 'usedServers' => [],
            'serverSlugs' => [$this->url => 'outlook'], 'startPrompt' => 'go', 'startDocuments' => [], 'playbooks' => [],
            'agents' => ['2' => ['name' => 'D', 'systemPrompt' => 'Route the email.', 'provider' => 'claude', 'model' => 'm',
                'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []]],
            'decisions' => ['2' => ['decision_question' => 'Which team handles this email?', 'routing_mode' => 'jev',
                'unclear_branch' => $unclearBranch, 'min_confidence' => 0.6,
                'decision' => [['provider' => 'jev', 'protocol' => 'typesafe', 'url' => $this->url . '/systemone',
                    'model' => 'jev-latest', 'key_env' => 'JEV_API_KEY', 'url_env' => 'JEV_BASE_URL']]]],
        ]);
        $byId = array_column($graph['nodes'], null, 'id');
        $a['code'] = [];
        foreach (['10', '3', '4'] as $cid) {
            $a['code'][$cid] = CodeNodeEmit::nodeData($byId[$cid], $graph['edges'], ['outlook' => $this->url], array_keys($byId));
        }
        return $a;
    }

    private function runJev(array $analyzed): array
    {
        $dir = sys_get_temp_dir() . '/adk_jev_' . bin2hex(random_bytes(4));
        mkdir($dir);
        file_put_contents("$dir/workflow.py", $this->emit($analyzed));
        file_put_contents("$dir/.env", "MCP_HEADERS_OUTLOOK={\"X-Outlook-Account\":\"acc-1\"}\nJEV_API_KEY=jev-test-key\n");
        $proc = proc_open([self::PY, 'workflow.py', 'go'], [1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes, $dir,
            ['PATH' => getenv('PATH'), 'HOME' => getenv('HOME')]);
        $text = (string) stream_get_contents($pipes[1]);
        $rc = proc_close($proc);
        fwrite(STDERR, "\n--- ADK Jev output ($dir) ---\n$text\n");
        return [$rc, $text];
    }

    public function testJevRoutesWithoutAnLlmTurn(): void
    {
        $this->startServer(false, 'claim');
        [$rc, $text] = $this->runJev($this->jevAnalyzed());
        self::assertSame(0, $rc, $text);
        self::assertStringContainsString("jev routed to 'B' (confidence 0.97", $text);
        $jev = array_values(array_filter($this->calls(), fn($c) => ($c['method'] ?? '') === 'jev'));
        self::assertCount(1, $jev);
        self::assertSame('Bearer jev-test-key', $jev[0]['headers']['authorization']);
        self::assertSame(['A', 'B', 'unclear'], $jev[0]['criteria']);
        self::assertStringContainsString('my car claim', $jev[0]['request']);   // the trigger's email, not a prompt
        $moves = array_values(array_filter($this->calls(), fn($c) => ($c['tool'] ?? '') === 'move_mail'));
        self::assertSame('Inbox/B', $moves[0]['args']['folder'] ?? null);
        self::assertCount(1, $moves);
    }

    public function testUnclearStopsAsNotClassified(): void
    {
        $this->startServer();   // "test 50": no "claim" -> the fake Jev answers unclear
        [$rc, $text] = $this->runJev($this->jevAnalyzed());
        self::assertSame(0, $rc, $text);
        self::assertStringContainsString('Not classified: dispatcher "D" did not route the request (jev: unclear', $text);
        self::assertSame([], array_filter($this->calls(), fn($c) => ($c['tool'] ?? '') === 'move_mail'));
    }

    public function testUnclearGoesToTheUnclearBranch(): void
    {
        $this->startServer();
        [$rc, $text] = $this->runJev($this->jevAnalyzed('A'));
        self::assertSame(0, $rc, $text);
        self::assertStringContainsString("sent to the unclear branch 'A'", $text);
        $moves = array_values(array_filter($this->calls(), fn($c) => ($c['tool'] ?? '') === 'move_mail'));
        self::assertSame('Inbox/A', $moves[0]['args']['folder'] ?? null);
    }

    /** Waits for a completed, recorded run in the package's runs/; returns its events. */
    private function completedRun(string $dir): array
    {
        for ($i = 0; $i < 150; $i++) {
            foreach (glob("$dir/runs/*.jsonl") ?: [] as $f) {
                $ev = array_map(fn($l) => json_decode($l, true), file($f, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES));
                if (in_array('workflow_complete', array_column($ev, 'type'), true)) {
                    return $ev;
                }
            }
            usleep(200000);
        }
        self::fail("no recorded run:\n" . @file_get_contents("$dir/api.log"));
    }

    /** Review I1: a dispatcher that does not route is work, not a quiet poll -- the run is recorded and answers why. */
    public function testListeningNotClassifiedIsRecorded(): void
    {
        $this->startServer();   // "test 50": the fake Jev answers unclear
        $dir = $this->writeListeningPackage($this->jevAnalyzed());
        $base = $this->startApi($dir);
        self::post("$base/listen", []);
        $ev = $this->completedRun($dir);
        $done = array_values(array_filter($ev, fn($e) => $e['type'] === 'workflow_complete'))[0];
        self::assertTrue($done['success']);
        self::assertStringContainsString('Not classified: dispatcher "D"', (string) $done['output']);
        $d = array_values(array_filter($ev, fn($e) => $e['type'] === 'node_complete' && (string) $e['node_id'] === '2'));
        self::assertTrue($d[0]['success']);
    }

    /** Review I1: a decision model that cannot answer (no usable provider) is an error the canvas shows. */
    public function testListeningJevErrorIsRecorded(): void
    {
        $this->startServer(false, 'claim');
        $a = $this->jevAnalyzed();
        $a['decisions']['2']['decision'] = [];   // routing names jev, but no jev provider was compiled in: unavailable
        $dir = $this->writeListeningPackage($a);
        $base = $this->startApi($dir);
        self::post("$base/listen", []);
        $ev = $this->completedRun($dir);
        $d = array_values(array_filter($ev, fn($e) => $e['type'] === 'node_complete' && (string) $e['node_id'] === '2'));
        self::assertFalse($d[0]['success']);
        self::assertStringContainsString('Error: dispatcher "D" did not route the request (jev: unavailable', (string) $d[0]['error']);
        $done = array_values(array_filter($ev, fn($e) => $e['type'] === 'workflow_complete'))[0];
        self::assertStringContainsString('Error: dispatcher "D"', (string) $done['output']);
    }

    /** Review I2: a node runs when one parent reached it, even if another parent's exit went elsewhere. */
    public function testOtherParentStillReachesTheNode(): void
    {
        $this->startServer();
        $code = fn(string $id, string $name, string $src, array $exits) => ['id' => $id, 'type' => 'code',
            'config' => ['type' => 'code', 'name' => $name, 'code' => $src, 'exits' => $exits, 'mcp_servers' => [], 'timeout_s' => 30]];
        $graph = ['nodes' => [
            ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'go']],
            $code('10', 'T', "def run(input, call_tool):\n    return {'route': 'a', 'output': 'from T'}\n", ['a', 'b']),
            $code('11', 'U', "def run(input, call_tool):\n    return 'from U'\n", ['next']),
            $code('12', 'X', "def run(input, call_tool):\n    return 'X ran'\n", ['next']),
            ['id' => '5', 'type' => 'output', 'config' => ['type' => 'output']],
        ], 'edges' => [
            ['from' => '1', 'to' => '10', 'from_port' => 'output_1'], ['from' => '1', 'to' => '11', 'from_port' => 'output_1'],
            ['from' => '10', 'to' => '12', 'from_port' => 'output_2'], ['from' => '11', 'to' => '12', 'from_port' => 'output_1'],
            ['from' => '12', 'to' => '5', 'from_port' => 'output_1'],
        ]];
        $a = array_merge(WorkflowGraphAnalyzer::analyzeGraph($graph), [
            'workflow' => ['id' => 97, 'name' => 'two parents'], 'usedCatalog' => [], 'usedServers' => [], 'serverSlugs' => [],
            'startPrompt' => 'go', 'startDocuments' => [], 'agents' => [], 'playbooks' => [],
        ]);
        $byId = array_column($graph['nodes'], null, 'id');
        foreach (['10', '11', '12'] as $cid) {
            $a['code'][$cid] = CodeNodeEmit::nodeData($byId[$cid], $graph['edges'], [], array_keys($byId));
        }
        [$rc, $text] = $this->run_($a);
        self::assertSame(0, $rc, $text);
        self::assertStringContainsString('X ran', $text);
    }

    /** Review I3: the package's CLI prints the answer of a one-off run. */
    public function testPackageCliPrintsTheAnswer(): void
    {
        $this->startServer();
        $dir = $this->writeListeningPackage($this->analyzed(self::FILE), 'prompt');
        $proc = proc_open([self::PY, 'workflow.py', 'go'], [1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes, $dir,
            ['PATH' => getenv('PATH'), 'HOME' => getenv('HOME')]);
        $text = (string) stream_get_contents($pipes[1]);
        $rc = proc_close($proc);
        self::assertSame(0, $rc, $text);
        self::assertStringContainsString('filed test 50', $text);
    }
}
