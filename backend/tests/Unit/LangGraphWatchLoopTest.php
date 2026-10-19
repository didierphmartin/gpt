<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\LangGraphRuntime;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;
use PHPUnit\Framework\TestCase;

/** spec 2026-10-12 mail/drive events §7: --watch in compiled LangGraph scripts. */
final class LangGraphWatchLoopTest extends TestCase
{
    private function python(): string
    {
        $py = is_executable('/usr/local/bin/python3') ? '/usr/local/bin/python3' : 'python3';
        exec($py . ' -c ' . escapeshellarg('import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)') . ' 2>&1', $o, $rc);
        if ($rc !== 0) {
            self::markTestSkipped('Python 3.10+ not available');
        }
        return $py;
    }

    /**
     * A scripted MCP: each call_tool_raw pops the next answer (a dict, or an Exception to raise);
     * a clock whose sleep moves now; and run_once counting runs from a list of outputs.
     */
    private const HARNESS = <<<'PY'
import threading, fcntl
MCP_SERVER_SLUGS = {"http://mail.local/mcp": "outlook"}

class FakeMcp:
    def __init__(self, answers):
        self.answers, self.calls = list(answers), []
    def call_tool_raw(self, url, tool, args):
        self.calls.append((url, tool, args))
        a = self.answers.pop(0)
        if isinstance(a, BaseException):
            raise a
        return a

def ok(**r):
    return {"content": [{"type": "text", "text": json.dumps(r)}], "structuredContent": r}

class Clock:
    def __init__(self):
        self.t, self.slept = datetime(2026, 10, 12, 9, 0), []
    def now(self):
        return self.t
    def sleep(self, s):
        self.slept.append(s)
        self.t += timedelta(seconds=s)

def runner(outputs):
    outputs = list(outputs)
    def run_once():
        return outputs.pop(0) if outputs else ""
    return run_once

TRIGGER = WatchTrigger("outlook", "wait_for_new", {"args": {"folder": "Inbox"}})

PY;

    /** cronBlock() + watchBlock() + HARNESS + $tail; returns [exit code, output lines]. */
    private function runPy(string $tail): array
    {
        $file = tempnam(sys_get_temp_dir(), 'wl') . '.py';
        file_put_contents($file, "from __future__ import annotations\nimport argparse, asyncio, json, re, signal, sys, threading, time\n"
            . "from datetime import datetime, timedelta\nfrom typing import Callable\n"
            . LangGraphRuntime::cronBlock() . "\n" . LangGraphRuntime::watchBlock() . "\n" . self::HARNESS . $tail);
        exec($this->python() . ' ' . escapeshellarg($file) . ' 2>&1', $out, $rc);
        unlink($file);
        return [$rc, $out];
    }

    private function py(string $tail): array
    {
        [$rc, $out] = $this->runPy($tail);
        self::assertSame(0, $rc, implode("\n", $out));
        return $out;
    }

    public function testReadyDrainsTimeoutWaitsAgain(): void
    {
        $out = $this->py(<<<'PY'
MCP = FakeMcp([ok(status="timeout", events="on"), ok(status="ready", via="event", events="on"),
               ok(status="ready", via="fallback", events="on")])
clock = Clock()
run_watch(TRIGGER, runner(["mail 1", "mail 2", "", ""]), drains=True, sleep=clock.sleep, now=clock.now, calls=3)
print("calls", MCP.calls[0], len(MCP.calls), "slept", clock.slept)
PY);
        self::assertSame([
            '[watch] waiting on outlook.wait_for_new. Ctrl-C to stop.',
            '[watch 09:00] Listening for events',
            '[watch 09:00] ready (event): 2 run(s) did work',   // "Running…" goes to the listeners only (final review I1)
            '[watch 09:00] Listening for events',
            '[watch 09:00] Listening (checks every 15 min)',    // the fallback wake found nothing: no ready line
            "calls ('http://mail.local/mcp', 'wait_for_new', {'args': {'folder': 'Inbox'}}) 3 slept []",
        ], $out);
    }

    /**
     * Final review I1: a wake that finds nothing to do prints nothing -- no "Running…", no "ready (…)" line,
     * and the idle line stays as it was (printed once) -- whatever the verbosity but verbose; under
     * --verbose the ready line shows. Listeners still see every state.
     */
    public function testAQuietWakePrintsNothing(): void
    {
        $out = $this->py(<<<'PY'
MCP = FakeMcp([ok(status="ready", via="event")] * 4)
clock = Clock(); st = LoopState(); seen = []
st.on_change.append(lambda s: seen.append(s.line))
run_watch(TRIGGER, runner([]), drains=True, sleep=clock.sleep, now=clock.now, calls=4, state=st)
assert seen.count("Running…") == 4, seen
for verbosity in ("quiet", "normal"):
    MCP = FakeMcp([ok(status="ready", via="event")] * 3)
    run_watch(TRIGGER, runner([]), drains=True, sleep=clock.sleep, now=clock.now, calls=3, verbosity=verbosity)
print("verbose")
MCP = FakeMcp([ok(status="ready", via="event")])
run_watch(TRIGGER, runner([]), drains=True, sleep=clock.sleep, now=clock.now, calls=1, verbosity="verbose")
PY);
        $quiet = ['[watch] waiting on outlook.wait_for_new. Ctrl-C to stop.', '[watch 09:00] Listening for events'];
        self::assertSame(array_merge($quiet, $quiet, $quiet, ['verbose', $quiet[0], '[watch 09:00] ready (event): nothing to do', $quiet[1]]), $out);
    }

    /** Final review I1: --quiet keeps a run that did work to its view's done line; an error still shows. */
    public function testQuietShowsOnlyErrorsOfTheDrain(): void
    {
        $out = $this->py(<<<'PY'
MCP = FakeMcp([ok(status="ready", via="event"), ok(status="ready", via="event")])
clock = Clock()
def run_once(state={"n": 0}):
    state["n"] += 1
    if state["n"] == 2:
        raise RuntimeError("Jev down")
    return "mail" if state["n"] == 1 else ""
run_watch(TRIGGER, run_once, drains=False, sleep=clock.sleep, now=clock.now, calls=2, verbosity="quiet")
PY);
        self::assertSame(['[watch] waiting on outlook.wait_for_new. Ctrl-C to stop.', '[watch 09:00] Listening for events',
            '[watch 09:00] ready (event): error after 0 run(s) that did work: RuntimeError: Jev down',
            '[watch 09:00] Listening — the last run failed'], $out);
    }

    public function testWithoutCodeNodesOneRunPerReady(): void
    {
        $out = $this->py(<<<'PY'
MCP = FakeMcp([ok(status="ready", via="event")])
clock = Clock()
run_watch(TRIGGER, runner(["a", "b"]), drains=False, sleep=clock.sleep, now=clock.now, calls=1)
PY);
        self::assertSame('[watch 09:00] ready (event): 1 run(s) did work', $out[1]);
    }

    public function testEachFailureKindHasItsLineAndTheBackoffGrows(): void
    {
        $out = $this->py(<<<'PY'
MCP = FakeMcp([{"isError": True, "content": [{"type": "text", "text": '{"error": "reconnect_needed"}'}]},
               ConnectionError("refused"),
               {"content": [{"type": "text", "text": "not json"}]},
               ok(answer=42),
               {"isError": True, "content": [{"type": "text", "text": "boom"}]},
               ok(error="not_connected", message="Outlook is not connected"),
               {"content": [{"type": "text", "text": '{"status": "ready", "via": "pending"}'}]}])   # text only: parsed
clock = Clock()
run_watch(TRIGGER, runner(["x", ""]), drains=True, sleep=clock.sleep, now=clock.now, calls=7)
print("slept", clock.slept)
PY);
        self::assertSame('[watch 09:00] Not listening: reconnect_needed — retrying in 30 s', $out[1]);
        self::assertSame('[watch 09:00] Not listening: server unreachable — retrying in 60 s', $out[2]);
        self::assertStringContainsString("Not listening: expected {\"status\": \"ready\" | \"timeout\"}, got 'not json' — retrying in 120 s", $out[3]);
        self::assertStringContainsString('got \'{"answer": 42}\' — retrying in 240 s', $out[4]);
        self::assertSame('[watch 09:07] Not listening: boom — retrying in 300 s', $out[5]);
        self::assertSame('[watch 09:12] Not listening: Outlook is not connected — retrying in 300 s', $out[6]);
        self::assertSame(['[watch 09:17] ready (pending): 1 run(s) did work',
                          '[watch 09:17] Listening for events', 'slept [30.0, 60.0, 120.0, 240.0, 300.0, 300.0]'], array_slice($out, 7));
    }

    public function testWatchErrorKinds(): void
    {
        $out = $this->py(<<<'PY'
MCP = FakeMcp([OSError("down"), {"isError": True, "content": [{"type": "text", "text": "bad"}]},
               ok(error="reconnect_needed", message="sign in"), ok(error="not_connected"), ok(error="quota"), ok(status="later")])
for _ in range(6):
    try:
        TRIGGER.wait()
    except WatchError as e:
        print(e.kind, "|", e)
PY);
        self::assertSame(['unreachable | down', 'tool_error | bad', 'reconnect_needed | sign in', 'not_connected | not_connected',
                          'tool_error | quota', 'bad_answer | expected {"status": "ready" | "timeout"}, got \'{"status": "later"}\''], $out);
    }

    public function testWatchErrorObject(): void
    {
        $out = $this->py(<<<'PY'
MCP = FakeMcp([ok(error={"code": "servicenow_error", "message": "down"})])
try:
    TRIGGER.wait()
except WatchError as e:
    print(e.kind, "|", e)
PY);
        self::assertSame(['tool_error | down'], $out);
    }

    /** Plan task 8 (found by api.py's listen test): McpClient.call_tool_raw turns a refused connection into an
     *  isError result marked transport_error instead of raising -- that is "server unreachable", not a tool error. */
    public function testTheClientsTransportFailureIsUnreachable(): void
    {
        $out = $this->py(<<<'PY'
MCP = FakeMcp([{"isError": True, "transport_error": True, "content": [{"type": "text", "text": "[Errno 61] Connection refused"}]}])
try:
    TRIGGER.wait()
except WatchError as e:
    print(e.kind, "|", e)
PY);
        self::assertSame(['unreachable | [Errno 61] Connection refused'], $out);
        self::assertStringContainsString('return {"isError": True, "transport_error": True, "content": [{"type": "text", "text": str(e)}]}',
            \AgentTeam\Services\LangGraphRuntime::mcpClientBlock());
    }

    public function testBackoffDoublesToFiveMinutesAndResets(): void
    {
        $this->py(<<<'PY'
MCP = FakeMcp([OSError("down")] * 6 + [ok(status="timeout"), OSError("down")])
c = Clock()
WatchLoop(TRIGGER, runner([]), drains=True, max_runs=20, sleep=c.sleep, now=c.now).run(calls=8)
assert c.slept == [30, 60, 120, 240, 300, 300, 30], c.slept
print("ok")
PY);
    }

    public function testReconnectNeededShowsTheServerMessage(): void
    {
        $this->py(<<<'PY'
MCP = FakeMcp([ok(error="reconnect_needed", message="sign in again at http://127.0.0.1:8770/connect")])
c = Clock(); st = LoopState()
WatchLoop(TRIGGER, runner([]), drains=True, max_runs=20, sleep=c.sleep, now=c.now, state=st).run(calls=1)
assert st.line == "Not listening: sign in again at http://127.0.0.1:8770/connect — retrying in 30 s", st.line
assert st.tone == "err"
print("ok")
PY);
    }

    public function testFallbackPrintedOnceAndBadAnswer(): void
    {
        $this->py(<<<'PY'
MCP = FakeMcp([ok(status="timeout", via="fallback"), ok(status="timeout", via="fallback"), ok(nope=1)])
c = Clock(); st = LoopState(); seen = []
st.on_change.append(lambda s: seen.append(s.line))
WatchLoop(TRIGGER, runner([]), drains=True, max_runs=20, sleep=c.sleep, now=c.now, state=st).run(calls=3)
assert seen.count("Listening (checks every 15 min)") == 1, seen
assert seen[-1].startswith("Not listening: ") and st.tone == "err", seen
print("ok")
PY);
    }

    public function testACrashingRunDoesNotStopTheLoop(): void
    {
        $this->py(<<<'PY'
def boom():
    raise RuntimeError("model down")
MCP = FakeMcp([ok(status="ready"), ok(status="timeout")])
c = Clock(); st = LoopState()
WatchLoop(TRIGGER, boom, drains=True, max_runs=20, sleep=c.sleep, now=c.now, state=st).run(calls=2)
assert st.line == "Listening — the last run failed" and st.tone == "warn", st.line
print("ok")
PY);
    }

    public function testRunCapAbandonsALongRun(): void
    {
        $this->py(<<<'PY'
import threading
gate = threading.Event()
def slow():
    gate.wait(5)
    return "late"
line = drain(slow, drains=False, max_runs=1, run_cap_s=0.2)
gate.set()
assert line == "abandoned a run after 30 min", line
print("ok")
PY);
    }

    public function testSecondCopyExits(): void
    {
        $this->py(<<<'PY'
import tempfile, os, subprocess
p = os.path.join(tempfile.mkdtemp(), ".run.lock")
with SingleInstance(p):
    code = subprocess.run([sys.executable, "-c", "import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)", p]).returncode
    assert code != 0, "the lock must be held"
code = subprocess.run([sys.executable, "-c", "import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.flock(f, fcntl.LOCK_EX|fcntl.LOCK_NB)", p]).returncode
assert code == 0, "released on exit"
print("ok")
PY);
    }

    public function testASecondRunWatchOnTheSameLockSaysSoAndExitsZero(): void
    {
        $out = $this->py(<<<'PY'
import tempfile, os, subprocess
p = os.path.join(tempfile.mkdtemp(), ".run.lock")
hold = subprocess.Popen([sys.executable, "-c", "import fcntl,sys,time; f=open(sys.argv[1],'a'); fcntl.flock(f, fcntl.LOCK_EX); print('held', flush=True); time.sleep(5)", p], stdout=subprocess.PIPE, text=True)
hold.stdout.readline()
try:
    run_watch(TRIGGER, runner([]), drains=True, lock_path=p, calls=1)
except SystemExit as e:
    print("exit", e.code)
hold.kill()
PY);
        self::assertSame([], array_values(array_filter($out, fn($l) => str_contains($l, 'waiting on'))));
        self::assertStringContainsString('[watch] already running (', implode("\n", $out));
        self::assertContains('exit 0', $out);
    }

    /**
     * Final review M-c: the Listener's banner prints once the lock is held, in place of the loop's own first
     * line; a second copy prints only "already running".
     */
    public function testTheListenerBannerFollowsTheLock(): void
    {
        [$rc, $out] = $this->runPy(LangGraphRuntime::listenerBlock() . <<<'PY'
import tempfile, os, subprocess
p = os.path.join(tempfile.mkdtemp(), ".run.lock")
clock = Clock()
for mode in ("watch", "cron"):
    MCP = FakeMcp([ok(status="timeout")])
    L = Listener(mode, runner([]), drains=True, loop=None, cron_expr="0 0 1 1 *" if mode == "cron" else None,
                 trigger=TRIGGER if mode == "watch" else None, state=LoopState(), lock_path=p)
    if mode == "watch":
        run_watch(TRIGGER, runner([]), drains=True, sleep=clock.sleep, now=clock.now, calls=1, lock_path=p,
                  state=L.state, banner=L.banner())
    print("second copy")
    hold = subprocess.Popen([sys.executable, "-c", "import fcntl,sys,time; f=open(sys.argv[1],'a'); fcntl.flock(f, fcntl.LOCK_EX); print('held', flush=True); time.sleep(5)", p], stdout=subprocess.PIPE, text=True)
    hold.stdout.readline()
    try:
        L.run_blocking()
    except SystemExit as e:
        print("exit", e.code)
    hold.kill(); hold.wait()
PY);
        self::assertSame(0, $rc, implode("\n", $out));
        self::assertSame(['Listening for events: outlook.wait_for_new {"args":{"folder":"Inbox"}} (Ctrl-C to stop)',
            '[watch 09:00] Listening for events', 'second copy', '[watch 09:00] Not listening: already running (' . '', 'exit 0',
            'second copy', '[cron HH:MM] Not listening: already running (', 'exit 0'],
            array_map(fn($l) => preg_replace(['~\(/.*$~', '~^\[cron \d\d:\d\d\]~'], ['(', '[cron HH:MM]'], $l), $out));
    }

    public function testCtrlCDuringARunLetsItFinish(): void   // Review Focus 5
    {
        $out = $this->py(<<<'PY'
import threading, _thread
done = []
def run_once():
    threading.Timer(0.05, _thread.interrupt_main).start()
    time.sleep(0.3)
    done.append(1)
    return ""
MCP = FakeMcp([ok(status="ready")] + [ok(status="timeout")] * 5)
c = Clock()
WatchLoop(TRIGGER, run_once, drains=False, max_runs=1, sleep=c.sleep, now=c.now).run(calls=3)
assert done == [1], done
print("ok")
PY);
        self::assertSame(['[watch] stopped.', 'ok'], array_slice($out, -2));
    }

    public function testInAThreadAStopEventEndsTheLoopAndNoSignalHandlerIsInstalled(): void
    {
        $out = $this->py(<<<'PY'
before = signal.getsignal(signal.SIGTERM)
stop = threading.Event()
st = LoopState()
calls = []
class Mcp:
    def call_tool_raw(self, url, tool, args):
        calls.append(threading.current_thread() is threading.main_thread())
        if len(calls) == 3:
            stop.set()
        return ok(status="timeout")
MCP = Mcp()
t = threading.Thread(target=run_watch, args=(TRIGGER, runner([])), kwargs=dict(drains=True, state=st, stop=stop), daemon=True)
t.start(); t.join(5)
print("alive", t.is_alive(), "calls", calls, "handler kept", signal.getsignal(signal.SIGTERM) is before, "listening", st.listening)
PY);
        self::assertSame(['[watch] stopped.', 'alive False calls [False, False, False] handler kept True listening False'], array_slice($out, -2));
    }

    public function testABackoffSleepEndsAtOnceOnStop(): void
    {
        $out = $this->py(<<<'PY'
stop = threading.Event()
MCP = FakeMcp([OSError("down")])
threading.Timer(0.2, stop.set).start()
t0 = time.monotonic()
run_watch(TRIGGER, runner([]), drains=True, stop=stop)
print("quick", time.monotonic() - t0 < 5)
PY);
        self::assertSame('quick True', end($out));
    }

    public function testEventsOffListensOnTheFifteenMinuteCheckAndPrintsItOnce(): void
    {
        $out = $this->py(<<<'PY'
off = dict(events="off", reason="EVENTHUB_NOTIFICATION_URL is not set")
MCP = FakeMcp([ok(status="timeout", **off), ok(status="timeout", **off), ok(status="timeout", events="on")])
clock = Clock()
run_watch(TRIGGER, runner([]), drains=True, sleep=clock.sleep, now=clock.now, calls=3)
PY);
        self::assertSame([
            '[watch] waiting on outlook.wait_for_new. Ctrl-C to stop.',
            '[watch 09:00] Listening (checks every 15 min)',
            '[watch 09:00] Listening for events',
        ], $out);
    }

    public function testAnErrorRunIsReportedAndTheLoopGoesOn(): void
    {
        $out = $this->py(<<<'PY'
MCP = FakeMcp([ok(status="ready", via="event"), ok(status="ready", via="event")])
clock = Clock()
def run_once(state={"n": 0}):
    state["n"] += 1
    if state["n"] == 1:
        raise RuntimeError("Jev down")
    return ""
run_watch(TRIGGER, run_once, drains=True, sleep=clock.sleep, now=clock.now, calls=2)
PY);
        self::assertSame('[watch 09:00] ready (event): error after 0 run(s) that did work: RuntimeError: Jev down', $out[1]);
        self::assertSame('[watch 09:00] Listening — the last run failed', $out[2]);
        self::assertSame('[watch 09:00] Listening for events', $out[3]);   // the second wake found nothing: no ready line
        self::assertCount(4, $out);
    }

    public function testCtrlCStops(): void
    {
        $out = $this->py(<<<'PY'
MCP = FakeMcp([KeyboardInterrupt()])
clock = Clock()
run_watch(TRIGGER, runner([]), drains=True, sleep=clock.sleep, now=clock.now)
print("after")
PY);
        self::assertSame(['[watch] waiting on outlook.wait_for_new. Ctrl-C to stop.', '', '[watch] stopped.', 'after'], $out);
    }

    public function testCliTriggerFallsBackToTheBakedOneAndRefusesBadInput(): void
    {
        $out = $this->py(<<<'PY'
ap = argparse.ArgumentParser(prog="wf")
baked = {"server": "outlook", "tool": "wait_for_new", "args": {"args": {"folder": "Inbox"}}}
print(WatchTrigger.from_cli(ap, None, baked))
t = WatchTrigger.from_cli(ap, "", baked)
print(t, t.args)
t = WatchTrigger.from_cli(ap, 'outlook.wait_for_new {"timeout_s": 30}', None)
print(t, t.args, t.url())
PY);
        self::assertSame(['None', "outlook.wait_for_new {'args': {'folder': 'Inbox'}}",
                          "outlook.wait_for_new {'timeout_s': 30} http://mail.local/mcp"], $out);
        foreach (['"", None' => 'this workflow has no event trigger', '"drive.wait", None' => "MCP server 'drive' is not used by this workflow (its servers: outlook); set MCP_URL_DRIVE in .env if the server moved",
                  '"outlook", None' => 'expected server.tool', '"outlook.wait {x", None' => 'the arguments are not JSON',
                  '"outlook.wait [1]", None' => 'must be a JSON object'] as $args => $msg) {
            [$rc, $lines] = $this->runPy("WatchTrigger.from_cli(argparse.ArgumentParser(prog='wf'), {$args})\n");
            self::assertSame(2, $rc, $args);
            self::assertStringContainsString($msg, implode("\n", $lines), $args);
        }
    }

    // ---------- the generator: DEFAULT_WATCH, the loop, the flag and the docs ----------

    /** Workflow 44 polls ServiceNow; $trigger: its event_trigger JSON (null: no row; false: no event_trigger column). */
    private function pdo(string|null|false $trigger, string $status = 'pending'): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (85, '3', 'ServiceNow', 'http://localhost/servicenow/?profile=mock&toolset=jobs', 1)");
        $pdo->exec("INSERT INTO mcp_servers VALUES (86, '3', 'Outlook', 'http://127.0.0.1:8770/mcp', 1)");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 85, 'poll_jobs', 'Poll', '{}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (2, 86, 'wait_for_new', 'Wait', '{}')");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)");
        if ($trigger === false) {
            $pdo->exec('CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT)');
        } else {
            $pdo->exec('CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)');
            $pdo->exec("INSERT INTO scheduled_workflows VALUES (1, 44, 'cron', '*/2 * * * *', 'pending', NULL)");
            if ($trigger !== null) {
                $pdo->exec("INSERT INTO scheduled_workflows VALUES (2, 44, 'event', NULL, " . $pdo->quote($status) . ', ' . $pdo->quote($trigger) . ')');
            }
        }
        return $pdo;
    }

    private function codeGraph(): array
    {
        return [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'poll']],
                ['id' => '2', 'node_type' => 'code', 'config' => ['type' => 'code', 'name' => 'Poll ServiceNow',
                    'code' => "def run(input, call_tool):\n    return {'route': 'job', 'output': 'x'}\n",
                    'exits' => ['job', 'error'], 'mcp_servers' => ['ServiceNow'], 'timeout_s' => 30]],
                ['id' => '3', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2', 'from_port' => 'output_1'], ['from' => '2', 'to' => '3', 'from_port' => 'output_1']],
        ];
    }

    private function generate(\PDO $pdo, array $options = [], ?array $graph = null): array
    {
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Mail poll', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph ?? $this->codeGraph());
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        return (new LangGraphGenerator($pdo, $wfRepo, $graphRepo, $agentRepo))->generate(44, '3', $options);
    }

    private function assertWatchEntry(string $code, string $label, string $default, string $file): void
    {
        self::assertStringContainsString("DEFAULT_WATCH = {$default}\n", $code, $label);
        self::assertSame(1, substr_count($code, 'def run_watch('), $label);
        self::assertStringContainsString('when.add_argument("--watch", nargs="?", const="", default=None, metavar="TRIGGER"', $code, $label);
        // the Start's mode decides, and the loop runs in a Listener (standalone task 6)
        self::assertStringContainsString('watch = WatchTrigger.from_cli(ap, a.watch if a.watch is not None else ("" if mode == "watch" else None), DEFAULT_WATCH)', $code, $label);
        self::assertStringContainsString('Listener(mode, run_once, drains=drains, loop=runs, cron_expr=cron, trigger=watch, state=LoopState(),', $code, $label);
        self::assertStringContainsString('run_watch(self.trigger, self.run_once, drains=self.drains, max_runs=self.max_runs, loop=self.loop,', $code, $label);
        self::assertStringContainsString("python {$file} --watch ", $code, $label);
        $f = tempnam(sys_get_temp_dir(), 'wlc') . '.py';
        file_put_contents($f, $code);
        exec($this->python() . ' -m py_compile ' . escapeshellarg($f) . ' 2>&1', $out, $rc);
        unlink($f);
        self::assertSame(0, $rc, "{$label}: " . implode("\n", $out));
    }

    public function testSingleFileBakesTheEventTrigger(): void
    {
        $code = $this->generate($this->pdo('{"server": "ServiceNow", "tool": "wait_jobs", "args": {"queue": "it"}}'))['code'];
        $this->assertWatchEntry($code, 'single', "{\n    \"server\": \"servicenow\",\n    \"tool\": \"wait_jobs\",\n    \"args\": {\n        \"queue\": \"it\"\n    }\n}", 'mail_poll_langgraph.py');
        self::assertStringContainsString('--watch           # run whenever the event trigger says something new arrived (servicenow.wait_jobs)', $code);
    }

    public function testModularWorkflowPyRunsTheWatchLoop(): void
    {
        $files = array_column($this->generate($this->pdo('{"server": "ServiceNow", "tool": "wait_jobs"}'), ['modular' => true])['files'], 'code', 'path');
        $wf = $files['workflow.py'];
        $this->assertWatchEntry($wf, 'modular', "{\n    \"server\": \"servicenow\",\n    \"tool\": \"wait_jobs\",\n    \"args\": {}\n}", 'workflow.py');
        self::assertStringContainsString('from common import EVENTS, MCP, MCP_SERVER_SLUGS, ', $wf);
        self::assertMatchesRegularExpression('~^import argparse, asyncio, json, ~m', $wf);
        self::assertStringContainsString('MCP_SERVER_SLUGS = ', $files['common.py']);
    }

    public function testNoTriggerBakesNone(): void
    {
        foreach (['no row' => $this->pdo(null), 'paused' => $this->pdo('{"server": "ServiceNow", "tool": "w"}', 'paused'),
                  'no column' => $this->pdo(false), 'no tool' => $this->pdo('{"server": "ServiceNow"}')] as $case => $pdo) {
            $code = $this->generate($pdo)['code'];
            self::assertStringContainsString("DEFAULT_WATCH = None\n", $code, $case);
            self::assertStringContainsString('--watch           # run whenever the event trigger says something new arrived (none saved: pass one)', $code, $case);
        }
    }

    public function testATriggerOnAServerNoNodeUsesIsRefused(): void
    {
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('The event trigger waits on MCP server "Outlook", which no node of this workflow uses');
        $this->generate($this->pdo('{"server": "Outlook", "tool": "wait_for_new"}'));
    }

    public function testA2AAndSwarmHaveNoWatch(): void
    {
        $files = array_column($this->generate($this->pdo(null), ['a2a' => true], LangGraphA2AGeneratorTest::graph())['files'], 'code', 'path');
        self::assertArrayHasKey('orchestrator.py', $files);
        foreach ($files as $path => $code) {   // no code node to drain: no flag, no loop, no DEFAULT_WATCH
            self::assertStringNotContainsString('add_argument("--watch"', $code, $path);
            self::assertStringNotContainsString('def run_watch(', $code, $path);
            self::assertStringNotContainsString('DEFAULT_WATCH', $code, $path);
        }
    }
}
