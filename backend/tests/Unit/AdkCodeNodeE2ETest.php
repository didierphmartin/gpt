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

    /** [workflow.py, common.py, agents/ files] of the package ("agents in separate files"). */
    protected function packageSources(array $analyzed): array
    {
        return ADKGenerator::packageFiles($analyzed);
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

    /** A node's arguments (a component's settings, a Start option's Start args) reach its code as ARGS. */
    public function testTheCodeReadsItsArguments(): void
    {
        $this->startServer();
        $a = $this->analyzed("def run(input, call_tool):\n    return 'folder=' + str(ARGS.get('folder'))\n");
        $a['code']['3']['args'] = ['folder' => 'Didier'];
        [$rc, $text] = $this->run_($a);
        self::assertSame(0, $rc, $text);
        self::assertStringContainsString('folder=Didier', $text);
    }

    /**
     * The Output takes a node once, and only through the exit it took: Convert(2) took done -> Store(5); its
     * error link to the Output carries nothing, and Store's two exits to the same Output give one answer.
     */
    public function testTheOutputTakesANodeOnceAndOnlyThroughTheExitItTook(): void
    {
        $code = fn(string $name, string $text) => ['type' => 'code', 'name' => $name, 'exits' => ['done', 'error'],
            'mcp_servers' => [], 'timeout_s' => 30, 'code' => "def run(input, call_tool):\n    return {'route': 'done', 'output': '$text'}\n"];
        $graph = ['nodes' => [
            ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'go']],
            ['id' => '2', 'type' => 'code', 'config' => $code('Convert', 'PACKAGE')],
            ['id' => '5', 'type' => 'code', 'config' => $code('Store', 'STORED')],
            ['id' => '3', 'type' => 'output', 'config' => ['type' => 'output']],
        ], 'edges' => [
            ['from' => '1', 'to' => '2', 'from_port' => 'output_1'],
            ['from' => '2', 'to' => '5', 'from_port' => 'output_1'],
            ['from' => '2', 'to' => '3', 'from_port' => 'output_2'],
            ['from' => '5', 'to' => '3', 'from_port' => 'output_1'],
            ['from' => '5', 'to' => '3', 'from_port' => 'output_2'],
        ]];
        $a = array_merge(WorkflowGraphAnalyzer::analyzeGraph($graph), [
            'workflow' => ['id' => 99, 'name' => 'adk e2e'], 'usedCatalog' => [], 'usedServers' => [],
            'serverSlugs' => [], 'startPrompt' => 'go', 'startDocuments' => [], 'agents' => [], 'playbooks' => [],
        ]);
        $byId = array_column($graph['nodes'], null, 'id');
        $a['code'] = [];
        foreach (['2', '5'] as $cid) {
            $a['code'][$cid] = CodeNodeEmit::nodeData($byId[$cid], $graph['edges'], [], ['1', '2', '5', '3']);
        }
        [$rc, $text] = $this->run_($a);
        self::assertSame(0, $rc, $text);
        self::assertStringContainsString('STORED', $text);
        self::assertStringNotContainsString('PACKAGE', $this->finalAnswer($text), $text);
        self::assertSame(1, substr_count($this->finalAnswer($text), 'STORED'), $text);
    }

    /** The run's answer as the program prints it: after "FINAL OUTPUT" (MAF, NOOA) or "[workflow] done" (ADK), up to RUN SUMMARY. */
    private function finalAnswer(string $text): string
    {
        $i = strrpos($text, 'FINAL OUTPUT');
        $i = $i !== false ? $i : strrpos($text, '[workflow] done');
        self::assertNotFalse($i, "no final answer in:\n$text");
        return substr($text, $i, (int) (strpos($text, 'RUN SUMMARY', $i) ?: strlen($text)) - $i);
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
        [$workflowPy, $commonPy, $nodeFiles] = $this->packageSources($a);
        $pkg = \AgentTeam\Services\RunServerEmitter::package(['code' => $workflowPy], 'adk e2e', 'e2e', 'run server', $commonPy, true);
        $dir = sys_get_temp_dir() . '/adk_listen_' . bin2hex(random_bytes(4));
        foreach (array_merge($pkg['files'], $nodeFiles, $this->packageFiles($a)) as $f) {
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

    /** The target's A2A package for an analysis (servers/, orchestrator.py, api.py, the runtime). */
    protected function a2aPackage(array $analyzed): array
    {
        return ADKGenerator::a2aPackage($analyzed);
    }

    /** Start -> dispatcher D (Jev) -> agent A | agent B -> Output, every model the fake one ("answer from <model>"). */
    private function a2aAnalyzed(): array
    {
        $agent = fn(string $id, string $name, array $extra = []) => ['id' => $id, 'type' => 'agent',
            'config' => ['type' => 'agent', 'agent_name' => $name, 'provider' => 'deepseek', 'model' => 'fake-' . strtolower($name)] + $extra];
        $graph = ['nodes' => [
            ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'my car claim']],
            $agent('2', 'D', ['agent_type' => 'dispatcher']), $agent('3', 'A'), $agent('4', 'B'),
            ['id' => '5', 'type' => 'output', 'config' => ['type' => 'output']],
        ], 'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3'], ['from' => '2', 'to' => '4'],
            ['from' => '3', 'to' => '5'], ['from' => '4', 'to' => '5']]];
        $ag = fn(string $name, string $prompt) => ['name' => $name, 'systemPrompt' => $prompt, 'provider' => 'deepseek',
            'model' => 'fake-' . strtolower($name), 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skills' => [],
            'skill_content' => '', 'output_schema_id' => null, 'documents' => []];
        return array_merge(WorkflowGraphAnalyzer::analyzeGraph($graph), [
            'workflow' => ['id' => 96, 'name' => 'a2a e2e'], 'usedCatalog' => [], 'usedServers' => [], 'serverSlugs' => [],
            'startPrompt' => 'my car claim', 'playbooks' => [], 'code' => [],
            // a Start document (copied into the package) and output storage ON: the A2A orchestrator honours both
            'startDocuments' => [['name' => 'note.txt', 'path' => 'start_documents/note.txt']],
            'outputStorageEnabled' => true, 'outputFolder' => null,
            'agents' => ['2' => $ag('D', 'Route the request.'), '3' => $ag('A', 'Handle it as A.'), '4' => $ag('B', 'Handle it as B.')],
            'decisions' => ['2' => ['decision_question' => 'Which agent handles this?', 'routing_mode' => 'jev', 'unclear_branch' => '',
                'min_confidence' => 0.6, 'decision' => [['provider' => 'jev', 'protocol' => 'typesafe', 'url' => $this->url . '/systemone',
                    'model' => 'jev-latest', 'key_env' => 'JEV_API_KEY', 'url_env' => 'JEV_BASE_URL']]]],
        ]);
    }

    /** A2A: the orchestrator spawns one A2A agent server per node; Jev routes; only the chosen agent runs. */
    public function testA2ARoutesOverAgentServers(): void
    {
        $this->startServer();
        $pkg = $this->a2aPackage($this->a2aAnalyzed());
        $dir = sys_get_temp_dir() . '/adk_e2e_a2a_' . bin2hex(random_bytes(4));
        foreach ($pkg['files'] as $f) {
            @mkdir(dirname("$dir/{$f['path']}"), 0777, true);
            file_put_contents("$dir/{$f['path']}", $f['code']);
        }
        file_put_contents("$dir/.env", "JEV_API_KEY=jev-test-key\nDEEPSEEK_API_KEY=fake\nDEEPSEEK_BASE_URL={$this->url}/v1\n");
        @mkdir("$dir/start_documents");
        file_put_contents("$dir/start_documents/note.txt", "The policy number is PN-4242.");
        $base = random_int(21000, 29000);
        $proc = proc_open([self::PY, 'orchestrator.py', 'my car claim'], [1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes, $dir,
            ['PATH' => getenv('PATH'), 'HOME' => getenv('HOME'), 'A2A_BASE_PORT' => (string) $base, 'SYNERGYAI_OUTPUT_ROOT' => "$dir/out"]);
        $text = (string) stream_get_contents($pipes[1]);
        $rc = proc_close($proc);
        fwrite(STDERR, "\n--- A2A output ($dir) ---\n$text\n");
        self::assertSame(0, $rc, $text);
        self::assertStringContainsString('answer from fake-b', $text);
        $llm = array_values(array_filter($this->calls(), fn($c) => ($c['method'] ?? '') === 'llm'));
        self::assertSame(['fake-b'], array_values(array_unique(array_column($llm, 'model'))), json_encode($llm));
        self::assertStringContainsString('my car claim', implode(' ', $llm[0]['messages']));
        // Review I3: the Start's document reaches the nodes, and the answer is saved (output storage ON)
        self::assertStringContainsString('PN-4242', implode(' ', $llm[0]['messages']));
        $saved = glob("$dir/out/workflow/*") ?: [];
        self::assertCount(1, $saved, 'the answer is saved under SYNERGYAI_OUTPUT_ROOT');
        self::assertStringStartsWith('answer from fake-b', trim((string) file_get_contents($saved[0])));
        $jev = array_values(array_filter($this->calls(), fn($c) => ($c['method'] ?? '') === 'jev'));
        self::assertCount(1, $jev);
        self::assertStringContainsString('my car claim', $jev[0]['request']);
    }

    /** The target's generator class (the playbook E2E compiles through it, from an in-memory database). */
    protected function generatorClass(): string
    {
        return ADKGenerator::class;
    }

    /** Start -> playbook PB (deepseek "fake-pb", one #Request Approval) -> Output, in an in-memory workflow database. */
    private function playbookGenerator(): object
    {
        $pb = "Title: Time Off\n\nTrigger: PTO.\n\nInstructions:\n1. Say hello.\n2. #Request Approval from the manager then finish.\n\nActions used: #Request Approval\n";
        $db = new \PDO('sqlite::memory:');
        $db->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $db->setAttribute(\PDO::ATTR_DEFAULT_FETCH_MODE, \PDO::FETCH_ASSOC);
        $db->exec("CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, user_id INTEGER, workspace_id INTEGER, name TEXT, description TEXT, steps TEXT, triggers TEXT, variables TEXT, enabled INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT, output_storage_enabled INTEGER DEFAULT 0, output_folder TEXT, orchestration TEXT DEFAULT 'workflow')");
        $db->exec('CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY, workflow_id INTEGER, node_type TEXT, agent_id INTEGER, config TEXT, pos_x INTEGER DEFAULT 0, pos_y INTEGER DEFAULT 0, drawflow_node_id TEXT, created_at TEXT)');
        $db->exec("CREATE TABLE workflow_edges (id INTEGER PRIMARY KEY, workflow_id INTEGER, from_node_id INTEGER, to_node_id INTEGER, from_port TEXT DEFAULT 'output_1', to_port TEXT DEFAULT 'input_1', condition_expr TEXT, created_at TEXT)");
        $db->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $db->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $db->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $db->exec("INSERT INTO agent_workflows (id, user_id, name, description, steps, orchestration) VALUES (74, 3, 'Playbook e2e', 'x', '[]', 'workflow')");
        $ins = $db->prepare('INSERT INTO workflow_nodes (id, workflow_id, node_type, agent_id, config, drawflow_node_id) VALUES (?, 74, ?, NULL, ?, ?)');
        $ins->execute([1, 'start', json_encode(['type' => 'start', 'prompt' => 'go']), '1']);
        $ins->execute([2, 'playbook', json_encode(['type' => 'playbook', 'name' => 'PB', 'playbook' => $pb, 'agent_provider' => 'deepseek',
            'model' => 'fake-pb', 'writes_enabled' => true]), '2']);
        $ins->execute([3, 'output', json_encode(['type' => 'output']), '3']);
        $db->exec('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id) VALUES (74, 1, 2), (74, 2, 3)');
        $cls = $this->generatorClass();
        return new $cls($db, new \AgentTeam\Services\WorkflowRepository($db), new \AgentTeam\Services\WorkflowGraphRepository($db),
            new \AgentTeam\Services\AgentRepository($db));
    }

    private function writeTo(array $files, string $prefix): string
    {
        $dir = sys_get_temp_dir() . "/adk_e2e_{$prefix}_" . bin2hex(random_bytes(4));
        foreach ($files as $f) {
            @mkdir(dirname("$dir/{$f['path']}"), 0777, true);
            file_put_contents("$dir/{$f['path']}", $f['code']);
        }
        file_put_contents("$dir/.env", "DEEPSEEK_API_KEY=fake\nDEEPSEEK_BASE_URL={$this->url}/v1\nPLAYBOOK_GATE_MODE=auto\n");
        return $dir;
    }

    private function runIn(string $dir, array $argv, array $env = []): array
    {
        $proc = proc_open(array_merge([self::PY], $argv), [1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes, $dir,
            ['PATH' => getenv('PATH'), 'HOME' => getenv('HOME')] + $env);
        $text = (string) stream_get_contents($pipes[1]);
        $rc = proc_close($proc);
        fwrite(STDERR, "\n--- output ($dir) ---\n$text\n");
        return [$rc, $text];
    }

    /** Review C1: a playbook's tool calls (its approval gate) run in a package -- the runtime lives in common.py there. */
    public function testPlaybookToolCallRunsInThePackage(): void
    {
        $this->startServer();
        $dir = $this->writeTo($this->playbookGenerator()->generatePackage(74)['files'], 'pbmod');
        [$rc, $text] = $this->runIn($dir, ['workflow.py', 'go']);
        self::assertSame(0, $rc, $text);
        self::assertStringNotContainsString('RecursionError', $text);
        self::assertStringContainsString('answer from fake-pb after tool', $text);
    }

    /** Review C1: the same over A2A (the gate goes to the orchestrator, answered by PLAYBOOK_GATE_MODE=auto). */
    public function testPlaybookToolCallRunsOverA2A(): void
    {
        $this->startServer();
        $dir = $this->writeTo($this->playbookGenerator()->generateA2A(74)['files'], 'pba2a');
        [$rc, $text] = $this->runIn($dir, ['orchestrator.py', 'go'], ['A2A_BASE_PORT' => (string) random_int(21000, 29000), 'PLAYBOOK_GATE_MODE' => 'auto']);
        self::assertSame(0, $rc, $text);
        self::assertStringNotContainsString('RecursionError', $text);
        self::assertStringContainsString('answer from fake-pb after tool', $text);
    }
}
