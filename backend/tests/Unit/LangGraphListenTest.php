<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\LangGraphRuntime;
use AgentTeam\Services\StartOptionGraph;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;
use PHPUnit\Framework\TestCase;

/** Standalone plan task 8: api.py listens (POST /listen, --listen) and streams its runs (GET /live) like SynergyAI's /live. */
final class LangGraphListenTest extends TestCase
{
    private const VENV = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';

    private function python(): string
    {
        $py = is_executable('/usr/local/bin/python3') ? '/usr/local/bin/python3' : 'python3';
        exec($py . ' -c ' . escapeshellarg('import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)') . ' 2>&1', $o, $rc);
        if ($rc !== 0) {
            self::markTestSkipped('Python 3.10+ not available');
        }
        return $py;
    }

    /** runRecordBlock + liveFeedBlock, then $tail; asserts exit 0 and a last line "ok". */
    private function py(string $tail): array
    {
        $file = tempnam(sys_get_temp_dir(), 'live') . '.py';
        file_put_contents($file, "from __future__ import annotations\n"
            . "import json, os, re, time, uuid\nfrom datetime import datetime\nfrom typing import Callable\n"
            . LangGraphRuntime::runRecordBlock() . "\n" . LangGraphRuntime::liveFeedBlock() . "\n" . $tail);
        exec($this->python() . ' ' . escapeshellarg($file) . ' 2>&1', $out, $rc);
        unlink($file);
        self::assertSame(0, $rc, implode("\n", $out));
        self::assertSame('ok', end($out), implode("\n", $out));
        return $out;
    }

    public function testFeedRules(): void
    {
        $this->py(<<<'PY'
import tempfile
d = tempfile.mkdtemp()
assert live_next(d, None) == ([], None)                                   # no pointer (Review Focus 3)
r = RunRecorder(d, 44, "W")
rid = r.begin(); r.node_start("1000000017", "T", "code")
ev, cur = live_next(d, None)
assert ev == [] and cur is None                                            # in progress but not real yet: held back
r.node_complete("1000000017", "T", "code", exit="new_mail"); r.node_start("21", "jev", "agent")
ev, cur = live_next(d, None)
assert [e["type"] for e in ev] == ["workflow_start", "node_start", "node_complete", "node_start"] and cur == f"{rid}:4"
r.node_complete("21", "jev", "agent", output="x")
ev, cur = live_next(d, cur)
assert [e["type"] for e in ev] == ["node_complete"] and cur == f"{rid}:5"
r.complete(success=True, output="done"); r.end(quiet=False)
rid2 = r.begin(); r.node_start("1000000017", "T", "code"); r.node_complete("1000000017", "T", "code", exit="no_mail"); r.complete(success=True); r.end(quiet=True)
ev, cur2 = live_next(d, cur)                                               # previous tail first; the quiet run is gone
assert [e["type"] for e in ev] == ["workflow_complete"] and cur2 == f"{rid}:6", (ev, cur2)
assert live_next(d, f"{'0'*32}:3") == ([], f"{'0'*32}:3")                 # unknown run in the cursor
ev, _ = live_next(d, None)
assert ev == []                                                            # first connect after a finished run: nothing
print("ok")
PY);
    }

    /** The rest of LiveFeedTest's cases, over files written by hand (the server's own event shapes). */
    public function testTheServersOtherFeedRules(): void
    {
        $this->py(<<<'PY'
import tempfile
A, B = "a" * 32, "b" * 32
WORK = {"node_start": {"type": "node_start", "node_id": 2598, "node_type": "agent"},
        "node_complete": {"type": "node_complete", "node_id": 2598, "node_type": "agent"}}
QUIET = [{"type": "workflow_start"}, {"type": "node_start", "node_id": 2597, "node_type": "start"},
         {"type": "node_complete", "node_id": 2597, "node_type": "start"},
         {"type": "node_start", "node_id": "1000002597", "node_type": "code"},
         {"type": "node_log", "node_id": "1000002597", "message": "poll ok"},
         {"type": "node_complete", "node_id": "1000002597", "node_type": "code"}]
def path(d, rid): return os.path.join(d, f"2026-10-16_09-00-00_{rid}.jsonl")
def append(d, rid, types):
    with open(path(d, rid), "a") as fh:
        for t in types:
            fh.write(json.dumps(t if isinstance(t, dict) else WORK.get(t, {"type": t})) + "\n")
def start(d, rid, types):
    with open(os.path.join(d, "current"), "w") as fh:
        fh.write(f"2026-10-16_09-00-00_{rid}")
    append(d, rid, types)
def types(r): return [e["type"] for e in r[0]]

d = tempfile.mkdtemp()                                   # first connect skips a finished run
start(d, A, ["workflow_start", "node_start", "workflow_complete"])
assert live_next(d, None) == ([], f"{A}:3")

d = tempfile.mkdtemp()                                   # a failed run is finished
start(d, A, ["workflow_start", "workflow_error"])
assert live_next(d, None)[0] == []

d = tempfile.mkdtemp()                                   # a new run is read from the start
start(d, A, ["workflow_start", "workflow_complete"]); start(d, B, ["workflow_start", "node_start", "workflow_complete"])
r = live_next(d, f"{A}:2")
assert types(r) == ["workflow_start", "node_start", "workflow_complete"] and r[1] == f"{B}:3"

d = tempfile.mkdtemp()                                   # a partial last line waits
start(d, A, ["workflow_start", "node_start"])
with open(path(d, A), "a") as fh:
    fh.write('{"type":"node_co')
r = live_next(d, None)
assert types(r) == ["workflow_start", "node_start"] and r[1] == f"{A}:2"
assert types(live_next(d, "nonsense")) == ["workflow_start", "node_start"]     # a bad cursor is a first connect

d = tempfile.mkdtemp()                                   # an unreadable line is still a line
start(d, A, ["workflow_start", "node_start"])
with open(path(d, A), "a") as fh:
    fh.write("not json\n")
r = live_next(d, f"{A}:2")
assert r == ([{"type": "unreadable"}], f"{A}:3"), r

d = tempfile.mkdtemp()                                   # a quiet run is held back ...
start(d, A, ["workflow_start", "node_start", "workflow_complete"]); start(d, B, QUIET)
assert live_next(d, f"{A}:3") == ([], f"{A}:3")
assert live_next(d, None) == ([], None)
append(d, B, ["node_start"])                             # ... and returned from its first line once a work node runs
r = live_next(d, f"{A}:3")
assert len(r[0]) == 7 and r[0][0]["type"] == "workflow_start" and r[0][6]["node_id"] == 2598 and r[1] == f"{B}:7"

d = tempfile.mkdtemp()                                   # a run that fails after the trigger is returned
start(d, A, ["workflow_start", "node_start", "workflow_complete"]); start(d, B, QUIET)
append(d, B, [{"type": "workflow_error", "error": "boom"}])
r = live_next(d, f"{A}:3")
assert len(r[0]) == 7 and r[0][6]["type"] == "workflow_error" and r[1] == f"{B}:7"

d = tempfile.mkdtemp()                                   # the cursor's tail comes before the next run
start(d, A, ["workflow_start", "node_start"]); append(d, A, [{"type": "workflow_complete", "output": "the answer"}])
start(d, B, ["workflow_start", "node_start"])
r = live_next(d, f"{A}:2")
assert types(r) == ["workflow_complete", "workflow_start", "node_start"] and r[0][0]["output"] == "the answer" and r[1] == f"{B}:2"

d = tempfile.mkdtemp()                                   # ... also while the next run is held back
start(d, A, ["workflow_start", "node_start", "workflow_complete"]); start(d, B, QUIET)
r = live_next(d, f"{A}:2")
assert types(r) == ["workflow_complete"] and r[1] == f"{A}:3"

d = tempfile.mkdtemp()                                   # a deleted quiet run is skipped
start(d, A, ["workflow_start", "workflow_complete"])
with open(os.path.join(d, "current"), "w") as fh:
    fh.write(f"2026-10-16_09-00-01_{B}")
assert live_next(d, f"{A}:2") == ([], f"{A}:2")
assert live_next(os.path.join(d, "missing"), None) == ([], None)     # no runs folder yet
print("ok")
PY);
    }

    // ---------- the generated package ----------

    private const POLL = "def run(input, call_tool):\n    r = call_tool('outlook', 'poll_new_mail', {})\n"
        . "    if r.get('mail') is None:\n        return {'route': 'no_mail', 'output': None}\n    return {'route': 'new_mail', 'output': r['mail']}\n";

    /** The Outlook server sits on a closed port (9): nothing here may reach a real MCP server. */
    private function pdo(): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (7, '3', 'Outlook', 'http://127.0.0.1:9/mcp', 1)");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 7, 'poll_new_mail', 'Poll', '{}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (2, 7, 'wait_for_new', 'Wait', '{}')");
        return $pdo;
    }

    /** @return array<string, string> path => code */
    private function generate(array $graph, array $options = ['modular' => true]): array
    {
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Email prototype', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph);
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        $gen = (new LangGraphGenerator($this->pdo(), $wfRepo, $graphRepo, $agentRepo))->generate(44, '3', $options);
        return array_column($gen['files'], 'code', 'path');
    }

    /** Task 1's fixture: Start (17) on a Start option whose trigger waits on outlook.wait_for_new. */
    private function optionGraph(bool $withWatch = true): array
    {
        $raw = ['nodes' => [
                ['id' => '17', 'node_type' => 'start', 'config' => ['type' => 'start', 'start_option' => 5]],
                ['id' => '18', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ], 'edges' => [['from_node_id' => '17', 'to_node_id' => '18', 'from_port' => 'output_1']]];
        return StartOptionGraph::expand($raw, fn(int $id) => ['name' => 'Outlook: get new email', 'code' => self::POLL,
            'exits' => ['new_mail', 'no_mail'], 'mcp_servers' => ['Outlook'], 'timeout_s' => 30,
            'start_trigger' => ['label' => 'Outlook: get new email', 'work_exit' => 'new_mail']
                + ($withWatch ? ['watch' => ['server' => 'Outlook', 'tool' => 'wait_for_new', 'args' => ['folder' => 'Inbox']]] : [])]);
    }

    /** Start (prompt) -> Output: the Start takes a prompt, so there is nothing to listen to. */
    private function promptGraph(): array
    {
        return ['nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'hello']],
                ['id' => '2', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ], 'edges' => [['from' => '1', 'to' => '2', 'from_port' => 'output_1']]];
    }

    public function testTheModularPackageListensAndEveryFileCompiles(): void
    {
        $py = $this->python();
        $files = $this->generate($this->optionGraph());
        foreach (['@app.post("/listen")', '@app.get("/live")', '"--listen"', 'from common import live_next',
                  'from workflow import make_listener, RUNS_DIR, START_MODE, LoopState'] as $needle) {
            self::assertStringContainsString($needle, $files['api.py'], $needle);
        }
        self::assertStringContainsString('def make_listener(state: LoopState) -> Listener | None:', $files['workflow.py']);
        self::assertStringContainsString('def live_next(runs_dir: str, cursor: str | None)', $files['common.py']);
        self::assertStringContainsString('python api.py --listen', $files['api.py'], 'the docstring says how');
        foreach ($files as $path => $code) {
            if (!str_ends_with($path, '.py')) {
                continue;
            }
            $tmp = tempnam(sys_get_temp_dir(), 'listen') . '.py';
            file_put_contents($tmp, $code);
            exec($py . ' -m py_compile ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
            unlink($tmp);
            self::assertSame(0, $rc, "$path: " . implode("\n", $out));
        }
    }

    public function testTheA2AServerDoesNotListen(): void
    {
        $files = $this->generate($this->promptGraph(), ['a2a' => true]);
        self::assertStringNotContainsString('/listen', $files['api.py']);
        self::assertStringNotContainsString('--listen', $files['api.py']);
    }

    // ---------- run with the SynergyAI venv (fastapi, langgraph) ----------

    private function venv(): string
    {
        if (!is_file(self::VENV)) {
            self::markTestSkipped('venv python missing');
        }
        return self::VENV;
    }

    /** Writes $files under a fresh temp dir; returns the package folder. */
    private function writePackage(array $files): string
    {
        $dir = sys_get_temp_dir() . '/lglisten_' . bin2hex(random_bytes(4)) . '/pkg';
        foreach ($files as $path => $code) {
            @mkdir(dirname("$dir/$path"), 0777, true);
            file_put_contents("$dir/$path", $code);
        }
        return $dir;
    }

    private static function env(): array
    {
        return ['PATH' => getenv('PATH'), 'HOME' => getenv('HOME'), 'MCP_URL_OUTLOOK' => 'http://127.0.0.1:9/mcp'];
    }

    public function testMakeListenerFollowsTheStartsMode(): void
    {
        $venv = $this->venv();
        $script = <<<'PY'
import os, sys
sys.path.insert(0, os.getcwd())
import workflow
try:
    L = workflow.make_listener(workflow.LoopState())
except ValueError as e:                        # a Start option without a trigger: api.py answers 409 with this
    assert workflow.DEFAULT_WATCH is None and "--watch needs a trigger" in str(e), e
    print("refused"); print("ok"); sys.exit(0)
if workflow.START_MODE == "prompt":
    assert L is None
else:
    assert isinstance(L, workflow.Listener) and L.mode == "watch" and str(L.trigger) == "outlook.wait_for_new", L
    assert L.lock_path == os.path.join(workflow.PACKAGE_DIR, ".run.lock") and not L.running
print("ok")
PY;
        foreach (['option' => $this->optionGraph(), 'prompt' => $this->promptGraph(), 'no trigger' => $this->optionGraph(false)] as $label => $graph) {
            $dir = $this->writePackage($this->generate($graph) + ['probe.py' => $script]);
            $proc = proc_open([$venv, 'probe.py'], [1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes, $dir, self::env());
            $text = (string) stream_get_contents($pipes[1]);
            self::assertSame(0, proc_close($proc), "$label: $text");
            self::assertStringEndsWith(($label === 'no trigger' ? "refused\n" : '') . "ok\n", $text, $label);
        }
    }

    /**
     * Fix round 1 (ruling): listening and POST /runs exclude each other (409 both ways; a stop is always
     * accepted), and a /runs run after the listener stopped gets its own trace lines and nothing foreign --
     * a listener run used to leave RUN_OUT holding and GRAPH_RECORDER set, so a later served run lost its
     * [info] / [node] lines. Driven in-process (TestClient) with the MCP client faked: no server is reached.
     */
    public function testListeningAndServedRunsExcludeEachOther(): void
    {
        $venv = $this->venv();
        $script = <<<'PY'
import asyncio, json, os, sys, time
sys.path.insert(0, os.getcwd())
import common
fake = {"ready": 1}
def call_tool_raw(url, tool, args):
    if tool == "wait_for_new":
        if fake["ready"]:
            fake["ready"] -= 1
            return {"structuredContent": {"status": "ready", "via": "test"}, "content": []}
        time.sleep(0.05)
        return {"structuredContent": {"status": "timeout"}, "content": []}
    body = {"mail": None}                                   # the poll finds nothing: a quiet run
    return {"structuredContent": body, "content": [{"type": "text", "text": json.dumps(body)}]}
common.MCP.call_tool_raw = call_tool_raw
import api, workflow
from starlette.testclient import TestClient

def until(cond, what, limit=20.0):
    end = time.monotonic() + limit
    while not cond():
        assert time.monotonic() < end, what
        time.sleep(0.05)

with TestClient(api.app) as c:
    # a served run in progress: no listening (a stop is still accepted)
    real_run = api.run_workflow
    async def slow(prompt, session=None):
        await asyncio.sleep(1.0)
        return "slow"
    api.run_workflow = slow
    rid = c.post("/runs", json={"prompt": "x"}).json()["run_id"]
    r = c.post("/listen", json={})
    assert r.status_code == 409 and r.json() == {"detail": "A POST /runs run is in progress; listen when it ends."}, r.text
    r = c.post("/listen", json={"stop": True})
    assert r.status_code == 200 and r.json()["listening"] is False, r.text
    until(lambda: api.RUNS[rid].status != "running", "the slow run did not end")
    api.run_workflow = real_run

    # listening: one (quiet) listener run, and no served run meanwhile
    assert c.post("/listen", json={}).json()["listening"] is True
    until(lambda: fake["ready"] == 0 and api.LOOP_STATE.line == "Listening for events", "no listener run")
    assert common.RUN_OUT.mode == "print", common.RUN_OUT.mode              # left as found
    assert workflow.GRAPH_RECORDER is common.NULL_RECORDER
    r = c.post("/runs", json={"prompt": "x"})
    assert r.status_code == 409 and r.json() == {"detail": 'This workflow is listening; stop it (POST /listen {"stop": true}) before POST /runs.'}, r.text
    assert c.post("/listen", json={"stop": True}).json()["listening"] is False
    until(lambda: not api.LISTENER.running, "the listener did not stop")

    # a served run after it: its own trace lines, nothing from the listener
    rid = c.post("/runs", json={"prompt": "x"}).json()["run_id"]
    traces, name = [], "message"
    with c.stream("GET", f"/runs/{rid}/events") as resp:
        for line in resp.iter_lines():
            if line.startswith("event:"):
                name = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                if name in ("done", "error"):
                    assert name == "done", line
                    break
                ev = json.loads(line.split(":", 1)[1])
                if ev.get("type") == "trace":
                    traces.append(ev["text"])
    assert any(t.startswith("[info] Running") for t in traces), traces
    assert any(t.startswith("[node] [") for t in traces), traces
    assert not any("watch" in t or "Listening" in t or "Done in" in t for t in traces), traces
print("ok")
PY;
        $dir = $this->writePackage($this->generate($this->optionGraph()) + ['probe.py' => $script]);
        $proc = proc_open([$venv, 'probe.py'], [1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes, $dir, self::env());
        $text = (string) stream_get_contents($pipes[1]);
        self::assertSame(0, proc_close($proc), $text);
        self::assertStringEndsWith("ok\n", $text, $text);
    }

    private static function freePort(): int
    {
        $s = stream_socket_server('tcp://127.0.0.1:0');
        $port = (int) substr(strrchr(stream_socket_get_name($s, false), ':'), 1);
        fclose($s);
        return $port;
    }

    /** @return array{0: int, 1: array, 2: array} status, decoded body, lower-cased headers */
    private static function http(string $method, string $url, array|object|null $body = null, array $headers = []): array
    {
        $ctx = stream_context_create(['http' => ['method' => $method, 'ignore_errors' => true, 'timeout' => 10,
            'header' => implode("\r\n", array_merge($body !== null ? ['Content-Type: application/json'] : [], $headers)),
            'content' => $body !== null ? json_encode($body) : '']]);
        $raw = @file_get_contents($url, false, $ctx);
        $status = 0;
        $h = [];
        foreach ($http_response_header ?? [] as $line) {
            if (preg_match('#^HTTP/\S+ (\d+)#', $line, $m)) {
                $status = (int) $m[1];
            } elseif (str_contains($line, ':')) {
                [$k, $v] = explode(':', $line, 2);
                $h[strtolower(trim($k))] = trim($v);
            }
        }
        return [$status, json_decode((string) $raw, true) ?? [], $h];
    }

    /** Opt-in (CODE_NODE_E2E=1): the real api.py, served by uvicorn, toggled over HTTP. */
    public function testListenRoutes(): void
    {
        if (getenv('CODE_NODE_E2E') !== '1') {
            self::markTestSkipped('set CODE_NODE_E2E=1 to serve api.py');
        }
        $venv = $this->venv();
        $dir = $this->writePackage($this->generate($this->optionGraph()));
        $port = self::freePort();
        $base = "http://127.0.0.1:$port";
        $log = "$dir/server.log";
        $proc = proc_open([$venv, 'api.py', '--port', (string) $port], [1 => ['file', $log, 'w'], 2 => ['file', $log, 'a']],
            $pipes, $dir, self::env());
        try {
            $up = false;
            for ($i = 0; $i < 100 && !$up; $i++) {
                usleep(200000);
                $up = self::http('GET', "$base/.well-known/workflow.json")[0] === 200;
            }
            self::assertTrue($up, 'server did not start: ' . @file_get_contents($log));

            // The editor's page (http://localhost/...) sends JSON, so the browser asks first.
            [$st, , $h] = self::http('OPTIONS', "$base/listen", null, ['Origin: http://localhost',
                'Access-Control-Request-Method: POST', 'Access-Control-Request-Headers: content-type']);
            self::assertSame(200, $st);
            self::assertSame('http://localhost', $h['access-control-allow-origin'] ?? null);

            [$st, $r1] = self::http('POST', "$base/listen", new \stdClass());
            self::assertSame(200, $st, json_encode($r1));
            [$st, $r2] = self::http('POST', "$base/listen", new \stdClass());
            self::assertSame(200, $st, json_encode($r2));
            self::assertTrue($r1['listening']);
            self::assertTrue($r2['listening']);
            self::assertSame('watch', $r2['mode']);
            self::assertSame(['line', 'tone'], array_keys($r2['state']));
            [$st, $r] = self::http('POST', "$base/runs", ['prompt' => 'x']);
            self::assertSame(409, $st, json_encode($r));
            self::assertSame(['detail' => 'This workflow is listening; stop it (POST /listen {"stop": true}) before POST /runs.'], $r);

            usleep(1500000);   // the trigger's first call fails at once (closed port)
            // A run in progress in the package's runs/ (what RunRecorder writes): /live replays it.
            $rid = str_repeat('c', 32);
            @mkdir("$dir/runs");
            file_put_contents("$dir/runs/current", "2026-10-16_09-00-00_$rid");
            file_put_contents("$dir/runs/2026-10-16_09-00-00_$rid.jsonl",
                json_encode(['type' => 'workflow_start', 'run_id' => $rid]) . "\n"
                . json_encode(['type' => 'node_start', 'node_id' => '18', 'node_type' => 'output', 'node_name' => 'Output']) . "\n");
            $sock = fsockopen('127.0.0.1', $port, $errno, $errstr, 5);
            fwrite($sock, "GET /live HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://localhost\r\nAccept: text/event-stream\r\n\r\n");
            stream_set_timeout($sock, 8);
            $seen = '';
            $state = null;
            $deadline = microtime(true) + 8;
            while ($state === null && microtime(true) < $deadline && ($chunk = fgets($sock)) !== false) {
                $seen .= $chunk;
                if (preg_match('/event: state\r?\ndata: (.*)\r?\n/', $seen, $m)) {
                    $state = json_decode($m[1], true);
                }
            }
            fclose($sock);
            self::assertNotNull($state, $seen);
            preg_match_all('/event: run\r?\ndata: (.*)\r?\n/', $seen, $runs);
            $runs = array_map(fn($d) => json_decode($d, true), $runs[1]);
            self::assertSame(['workflow_start', 'node_start'], array_map(fn($f) => $f['event']['type'], $runs), $seen);
            self::assertSame("$rid:2", $runs[1]['cursor']);
            self::assertStringContainsString('access-control-allow-origin: http://localhost', strtolower($seen));
            self::assertSame('Not listening: server unreachable — retrying in 30 s', $state['compiled']['line'] ?? null, $seen);
            self::assertSame('err', $state['compiled']['tone']);
            self::assertTrue($state['compiled']['listening']);

            [$st, $r3] = self::http('POST', "$base/listen", ['stop' => true]);
            self::assertSame(200, $st, json_encode($r3));
            self::assertFalse($r3['listening'], json_encode($r3));
            // Once the stop has taken effect (the backoff nap ends at once), POST /runs is served again.
            for ($i = 0, $st = 409; $i < 50 && $st === 409; $i++) {
                usleep(100000);
                [$st, $r] = self::http('POST', "$base/runs", ['prompt' => 'x']);
            }
            self::assertSame(200, $st, json_encode($r) . "\n" . @file_get_contents($log));
        } finally {
            proc_terminate($proc);
            proc_close($proc);
        }
    }

    /** Opt-in: `python api.py --listen` starts the listener before serving. */
    public function testTheListenFlagStartsTheListener(): void
    {
        if (getenv('CODE_NODE_E2E') !== '1') {
            self::markTestSkipped('set CODE_NODE_E2E=1 to serve api.py');
        }
        $venv = $this->venv();
        $dir = $this->writePackage($this->generate($this->optionGraph()));
        $port = self::freePort();
        $log = "$dir/server.log";
        $proc = proc_open([$venv, 'api.py', '--port', (string) $port, '--listen'], [1 => ['file', $log, 'w'], 2 => ['file', $log, 'a']],
            $pipes, $dir, self::env());
        try {
            $st = 0;
            for ($i = 0; $i < 100 && $st !== 200; $i++) {
                usleep(200000);
                $st = self::http('GET', "http://127.0.0.1:$port/.well-known/workflow.json")[0];
            }
            $sock = fsockopen('127.0.0.1', $port, $errno, $errstr, 5);
            fwrite($sock, "GET /live HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
            stream_set_timeout($sock, 5);
            $seen = '';
            while (!preg_match('/event: state\r?\ndata: (.*)\r?\n/', $seen, $m) && ($chunk = fgets($sock)) !== false) {
                $seen .= $chunk;
            }
            fclose($sock);
            self::assertTrue(json_decode($m[1] ?? 'null', true)['compiled']['listening'] ?? false, $seen);
            self::assertStringContainsString('Listening for events: outlook.wait_for_new {"folder":"Inbox"}', (string) file_get_contents($log));
        } finally {
            proc_terminate($proc);
            proc_close($proc);
        }
    }

    /** Opt-in: a Start that takes a prompt has nothing to listen to. */
    public function testAPromptStartRefusesToListen(): void
    {
        if (getenv('CODE_NODE_E2E') !== '1') {
            self::markTestSkipped('set CODE_NODE_E2E=1 to serve api.py');
        }
        $venv = $this->venv();
        $dir = $this->writePackage($this->generate($this->promptGraph()));
        $port = self::freePort();
        $proc = proc_open([$venv, 'api.py', '--port', (string) $port], [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
            $pipes, $dir, self::env());
        try {
            $st = 0;
            for ($i = 0; $i < 100 && $st !== 200; $i++) {
                usleep(200000);
                $st = self::http('GET', "http://127.0.0.1:$port/.well-known/workflow.json")[0];
            }
            [$st, $r] = self::http('POST', "http://127.0.0.1:$port/listen", new \stdClass());
            self::assertSame(409, $st);
            self::assertSame(['detail' => "This workflow's Start takes a prompt; use POST /runs."], $r);
        } finally {
            proc_terminate($proc);
            proc_close($proc);
        }
        $proc = proc_open([$venv, 'api.py', '--port', (string) self::freePort(), '--listen'], [1 => ['pipe', 'w'], 2 => ['redirect', 1]],
            $pipes, $dir, self::env());
        $text = (string) stream_get_contents($pipes[1]);
        self::assertSame(2, proc_close($proc), $text);
        self::assertStringContainsString("--listen: This workflow's Start takes a prompt; use POST /runs.", $text);
    }
}
