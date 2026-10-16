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

/** Standalone plan task 6: the program runs in the Start's mode; --once; the recorder and console wired; Listener. */
final class LangGraphCliTest extends TestCase
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

    /** runRecordBlock + consoleBlock + cronBlock + watchBlock + listenerBlock, then $tail; asserts exit 0 and a last line "ok". */
    private function py(string $tail): array
    {
        $file = tempnam(sys_get_temp_dir(), 'cli') . '.py';
        file_put_contents($file, "from __future__ import annotations\n"
            . "import argparse, asyncio, json, os, re, signal, sys, threading, time, uuid\n"
            . "from datetime import datetime, timedelta\nfrom typing import Callable\n"
            . LangGraphRuntime::runRecordBlock() . "\n" . LangGraphRuntime::consoleBlock() . "\n"
            . LangGraphRuntime::cronBlock() . "\n" . LangGraphRuntime::watchBlock() . "\n"
            . LangGraphRuntime::listenerBlock() . "\n" . $tail);
        exec($this->python() . ' ' . escapeshellarg($file) . ' 2>&1', $out, $rc);
        unlink($file);
        self::assertSame(0, $rc, implode("\n", $out));
        self::assertSame('ok', end($out), implode("\n", $out));
        return $out;
    }

    public function testChooseMode(): void
    {
        $this->py(<<<'PY'
from types import SimpleNamespace as A
def a(**k): return A(**{"prompt": [], "once": False, "cron": None, "watch": None, **k})
assert choose_mode(a(), "watch") == "watch"
assert choose_mode(a(), "cron") == "cron"
assert choose_mode(a(), "prompt") == "once"
assert choose_mode(a(prompt=["hi"]), "watch") == "once"
assert choose_mode(a(once=True), "watch") == "once"
assert choose_mode(a(cron=""), "watch") == "cron"
assert choose_mode(a(watch=""), "prompt") == "watch"
print("ok")
PY);
    }

    public function testListenerStartsOnceAndStops(): void
    {
        $this->py(<<<'PY'
import tempfile, threading
MCP_SERVER_SLUGS = {"http://mail.local/mcp": "outlook"}
class SlowMcp:
    def call_tool_raw(self, url, tool, args):
        time.sleep(0.05)
        return {"structuredContent": {"status": "timeout"}, "content": []}
MCP = SlowMcp()
st = LoopState()
L = Listener("watch", lambda: "", drains=True, loop=None, cron_expr=None,
             trigger=WatchTrigger("outlook", "wait_for_new", {}), state=st,
             lock_path=os.path.join(tempfile.mkdtemp(), ".run.lock"))
L.start(); L.start()
time.sleep(0.2)
assert L.running and threading.active_count() >= 2
L.stop()
time.sleep(0.3)
assert not L.running
print("ok")
PY);
    }

    public function testListenerStartsAgainAfterAStopAndInstallsNoSignalHandler(): void
    {
        $this->py(<<<'PY'
import tempfile
MCP_SERVER_SLUGS = {"http://mail.local/mcp": "outlook"}
class SlowMcp:
    def call_tool_raw(self, url, tool, args):
        time.sleep(0.02)
        return {"structuredContent": {"status": "timeout"}, "content": []}
MCP = SlowMcp()
before = signal.getsignal(signal.SIGTERM)
L = Listener("watch", lambda: "", drains=False, loop=RunLoop(), cron_expr=None,
             trigger=WatchTrigger("outlook", "wait_for_new", {}), state=LoopState(),
             lock_path=os.path.join(tempfile.mkdtemp(), ".run.lock"))
L.start(); time.sleep(0.1)
assert signal.getsignal(signal.SIGTERM) is before
L.stop(); time.sleep(0.2)
assert not L.running
L.start(); time.sleep(0.1)
assert L.running
L.stop(); time.sleep(0.2)
assert not L.running
print("ok")
PY);
    }

    /** Task 6 review: start() right after stop() -- the thread still finishing its trigger call -- leaves a listener that
     *  listens, in the same thread (a second thread would find the lock held); a later stop() still stops it. */
    public function testStopThenStartAtOnceLeavesARunningListener(): void
    {
        $this->py(<<<'PY'
import tempfile, threading
MCP_SERVER_SLUGS = {"http://mail.local/mcp": "outlook"}
calls = []
class SlowMcp:
    def call_tool_raw(self, url, tool, args):
        calls.append(time.monotonic())
        time.sleep(0.3)
        return {"structuredContent": {"status": "timeout"}, "content": []}
MCP = SlowMcp()
L = Listener("watch", lambda: "", drains=False, loop=RunLoop(), cron_expr=None,
             trigger=WatchTrigger("outlook", "wait_for_new", {}), state=LoopState(echo=False),
             lock_path=os.path.join(tempfile.mkdtemp(), ".run.lock"))
L.start(); time.sleep(0.1)                     # inside the first trigger call
L.stop(); assert not L.listening               # stopping: no longer reported as listening
L.start()                                      # the old thread is still in its call
assert L.listening
time.sleep(1.0)
assert L.running and L.listening and len(calls) >= 3, calls        # it went on calling the trigger
assert threading.active_count() == 2, threading.enumerate()       # one listener thread, not two
L.stop(); time.sleep(0.5)
assert not L.running and not L.listening
# the loop already left (a nap the stop woke): the same thread runs it again
class FailingMcp:
    def call_tool_raw(self, url, tool, args):
        calls.append(time.monotonic())
        raise OSError("refused")
MCP = FailingMcp()
L.start(); time.sleep(0.1)                     # now napping 30 s after a failed call
n = len(calls)
L.stop(); L.start()
time.sleep(0.3)
assert L.running and L.listening and len(calls) == n + 1, (n, calls)
L.stop(); time.sleep(0.3)
assert not L.running
print("ok")
PY);
    }

    public function testBannerNamesTheMode(): void
    {
        $out = $this->py(<<<'PY'
MCP_SERVER_SLUGS = {"http://mail.local/mcp": "outlook"}
w = Listener("watch", lambda: "", drains=True, loop=None, cron_expr=None,
             trigger=WatchTrigger("outlook", "wait_for_new", {"folder": "Inbox"}), state=LoopState(), lock_path=None)
print(w.banner())
c = Listener("cron", lambda: "", drains=True, loop=None, cron_expr="0 9 * * *", trigger=None, state=LoopState(), lock_path=None)
print(c.banner(now=datetime(2026, 10, 15, 8, 0)))
print("ok")
PY);
        self::assertSame('Listening for events: outlook.wait_for_new {"folder":"Inbox"} (Ctrl-C to stop)', $out[0]);
        self::assertSame('Scheduled: 0 9 * * * — next run 2026-10-15 09:00 (Ctrl-C to stop)', $out[1]);
    }

    /** Deferred finding: a Listener whose lock is held shows "Not listening: already running" (tone off), in a thread too. */
    public function testALockHeldElsewhereSetsTheStateAndEndsTheThread(): void
    {
        $out = $this->py(<<<'PY'
import tempfile, fcntl
MCP_SERVER_SLUGS = {"http://mail.local/mcp": "outlook"}
path = os.path.join(tempfile.mkdtemp(), ".run.lock")
held = open(path, "a")
fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
seen = []
st = LoopState()
st.on_change.append(lambda s: seen.append((s.line, s.tone)))
L = Listener("watch", lambda: "", drains=True, loop=None, cron_expr=None,
             trigger=WatchTrigger("outlook", "wait_for_new", {}), state=st, lock_path=path)
L.start()
time.sleep(0.2)
assert not L.running
assert seen == [(f"Not listening: already running ({path})", "off")], seen
print("ok")
PY);
        self::assertStringNotContainsString('Traceback', implode("\n", $out));
    }

    /** Deferred finding: a LoopState listener that raises is reported and the others still run. */
    public function testABrokenStateListenerDoesNotStopTheOthers(): void
    {
        $out = $this->py(<<<'PY'
st = LoopState(echo=False)
seen = []
def broken(s): raise RuntimeError("feed gone")
st.on_change += [broken, lambda s: seen.append(s.line)]
st.set("Listening for events", "ok")
assert seen == ["Listening for events"], seen
print("ok")
PY);
        self::assertContains('[warn] state listener failed: feed gone', $out);
    }

    // ---------- the generator: the entry files ----------

    private const POLL = "def run(input, call_tool):\n    r = call_tool('outlook', 'poll_new_mail', {})\n"
        . "    if r.get('mail') is None:\n        return {'route': 'no_mail', 'output': None}\n    return {'route': 'new_mail', 'output': r['mail']}\n";

    private function pdo(): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (7, '3', 'Outlook', 'http://127.0.0.1:8770/mcp', 1)");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 7, 'poll_new_mail', 'Poll', '{}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (2, 7, 'wait_for_new', 'Wait', '{}')");
        return $pdo;
    }

    private function generate(array $graph, array $options = []): array
    {
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Email prototype', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph);
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        return (new LangGraphGenerator($this->pdo(), $wfRepo, $graphRepo, $agentRepo))->generate(44, '3', $options);
    }

    /** Start (17) on a Start option, expanded as WorkflowGraphRepository::getGraph does (LangGraphStartModeTest's fixture). */
    private function optionGraph(?array $watch = ['server' => 'Outlook', 'tool' => 'wait_for_new', 'args' => ['folder' => 'Inbox']]): array
    {
        $raw = ['nodes' => [
                ['id' => '17', 'node_type' => 'start', 'config' => ['type' => 'start', 'start_option' => 5]],
                ['id' => '18', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ], 'edges' => [['from_node_id' => '17', 'to_node_id' => '18', 'from_port' => 'output_1']]];
        return StartOptionGraph::expand($raw, fn(int $id) => ['name' => 'Outlook: get new email', 'code' => self::POLL,
            'exits' => ['new_mail', 'no_mail'], 'mcp_servers' => ['Outlook'], 'timeout_s' => 30,
            'start_trigger' => ['label' => 'Outlook: get new email', 'work_exit' => 'new_mail'] + ($watch !== null ? ['watch' => $watch] : [])]);
    }

    /** Start -> code node "Check" (exits work / no_mail / error) -> Output on `work` only: no_mail ends the run
     *  quietly; FAILNOW takes the error exit. */
    private function codeGraph(): array
    {
        return ['nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'NOTHING']],
                ['id' => '2', 'node_type' => 'code', 'config' => ['type' => 'code', 'name' => 'Check',
                    'code' => "def run(input, call_tool):\n    if 'WORKNOW' in str(input):\n        return {'route': 'work', 'output': 'mail for you'}\n"
                        . "    if 'FAILNOW' in str(input):\n        return {'route': 'error', 'output': 'mailbox gone'}\n"
                        . "    return {'route': 'no_mail', 'output': None}\n",
                    'exits' => ['work', 'no_mail', 'error'], 'mcp_servers' => [], 'timeout_s' => 30]],
                ['id' => '3', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ], 'edges' => [['from' => '1', 'to' => '2', 'from_port' => 'output_1'], ['from' => '2', 'to' => '3', 'from_port' => 'output_1']]];
    }

    /** @return array<string, string> path => code of every emitted file (single file as workflow.py) */
    private function files(array $gen): array
    {
        return isset($gen['files']) ? array_column($gen['files'], 'code', 'path') : ['workflow.py' => $gen['code']];
    }

    public function testEntryFilesRunInTheStartsModeAndCompile(): void
    {
        $py = $this->python();
        foreach (['single' => [], 'modular' => ['modular' => true]] as $label => $opts) {
            $files = $this->files($this->generate($this->optionGraph(), $opts));
            $wf = $files['workflow.py'];
            foreach (['mode = choose_mode(a, START_MODE)', 'when.add_argument("--once"', 'talk.add_argument("--quiet"',
                      'talk.add_argument("--verbose"', 'RUNS_DIR = os.environ.get("RUNS_DIR") or os.path.join(PACKAGE_DIR, "runs")',
                      'PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))', 'def make_run_once(',
                      'lock_path=os.path.join(PACKAGE_DIR, ".run.lock")', 'class Listener', 'def choose_mode(',
                      'recorder = RunRecorder(RUNS_DIR, WORKFLOW_ID, WORKFLOW_NAME, listeners=[view])',
                      'global GRAPH_RECORDER'] as $needle) {
                self::assertStringContainsString($needle, $wf, "$label: $needle");
            }
            self::assertLessThan(strpos($wf, 'class Listener'), strpos($wf, 'def run_watch('), "$label: Listener after the watch block");
            self::assertStringContainsString("the Start's mode (prompt: one run; schedule: --cron; Start option: --watch)", $wf, $label);
            self::assertStringContainsString(' --once ', $wf, $label);
            foreach ($files as $path => $code) {
                if (!str_ends_with($path, '.py')) {
                    continue;
                }
                $tmp = tempnam(sys_get_temp_dir(), 'cli') . '.py';
                file_put_contents($tmp, $code);
                exec($py . ' -m py_compile ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
                unlink($tmp);
                self::assertSame(0, $rc, "$label/$path: " . implode("\n", $out));
            }
        }
    }

    // ---------- the generated program, run (needs langgraph: the SynergyAI venv) ----------

    private function venv(): string
    {
        if (!is_file(self::VENV)) {
            self::markTestSkipped('venv python missing');
        }
        return self::VENV;
    }

    /** Writes $files to a new temp dir; runs workflow.py (or $script, written next to it) with $args; returns [rc, output, dir]. */
    private function runProgram(array $files, array $args, ?string $script = null): array
    {
        if ($script !== null) {
            $files['drive.py'] = $script;
        }
        $dir = sys_get_temp_dir() . '/lgcli_' . bin2hex(random_bytes(4));
        mkdir($dir . '/pkg', 0777, true);
        foreach ($files as $path => $code) {
            @mkdir(dirname("$dir/pkg/$path"), 0777, true);
            file_put_contents("$dir/pkg/$path", $code);
        }
        $proc = proc_open([$this->venv(), $script !== null ? 'drive.py' : 'workflow.py', ...$args], [1 => ['pipe', 'w'], 2 => ['redirect', 1]], $pipes, "$dir/pkg",
            ['PATH' => getenv('PATH'), 'HOME' => getenv('HOME'), 'SYNERGYAI_OUTPUT_ROOT' => "$dir/outputs"]);
        $text = stream_get_contents($pipes[1]);
        $rc = proc_close($proc);
        return [$rc, (string) $text, $dir];
    }

    /** Deferred finding (Task 3): the WorkflowGraph hooks, executed -- a quiet run leaves nothing; a work run one log. */
    public function testAGeneratedProgramRecordsAWorkRunAndDropsAQuietOne(): void
    {
        $this->venv();
        foreach (['single' => [], 'modular' => ['modular' => true]] as $label => $opts) {
            $files = $this->files($this->generate($this->codeGraph(), $opts));

            [$rc, $text, $dir] = $this->runProgram($files, ['--once', 'NOTHING']);
            self::assertSame(0, $rc, "$label quiet: $text");
            self::assertSame([], glob("$dir/pkg/runs/*.jsonl"), "$label: a quiet run leaves no run log\n$text");
            self::assertStringNotContainsString('Done in', $text, $label);
            self::assertStringNotContainsString('FINAL OUTPUT', $text, $label);
            self::assertStringNotContainsString('✓', $text, $label);

            [$rc, $text, $dir] = $this->runProgram($files, ['--once', 'WORKNOW']);
            self::assertSame(0, $rc, "$label work: $text");
            $logs = glob("$dir/pkg/runs/*.jsonl");
            self::assertCount(1, $logs, "$label\n$text");
            self::assertSame(basename($logs[0], '.jsonl'), trim((string) file_get_contents("$dir/pkg/runs/current")));
            $events = array_map(fn($l) => json_decode($l, true), file($logs[0], FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES));
            $code = array_values(array_filter($events, fn($e) => $e['type'] === 'node_complete' && $e['node_id'] === '2'));
            self::assertCount(1, $code, $label);
            self::assertSame('work', $code[0]['exit'], $label);
            self::assertSame('Check', $code[0]['node_name'], $label);
            self::assertSame(['workflow_start', 'node_start', 'node_complete'], array_column(array_slice($events, 0, 3), 'type'), $label);
            $last = end($events);
            self::assertSame('workflow_complete', $last['type'], $label);
            self::assertTrue($last['success'], $label);
            self::assertSame('mail for you', $last['output'], $label);
            self::assertStringContainsString('  ✓ Check', $text, $label);
            self::assertMatchesRegularExpression('~\[\d\d:\d\d\] Done in \d+\.\d s~', $text, $label);
        }
    }

    /** Loads workflow.py as a module and calls make_run_once as --cron / --watch do (loop_mode) at verbosity argv[1] on argv[2]. */
    private const LOOP_DRIVER = <<<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("prog", "workflow.py")
m = importlib.util.module_from_spec(spec)
sys.modules["prog"] = m
spec.loader.exec_module(m)
view = m.ConsoleView(sys.argv[1])
rec = m.RunRecorder(m.RUNS_DIR, m.WORKFLOW_ID, m.WORKFLOW_NAME, listeners=[view])
m.RUN_OUT.chatty = sys.argv[1] == "verbose"
print("RESULT", repr(m.make_run_once(sys.argv[2], m.RunLoop(), view, rec, loop_mode=True)()))
PY;

    /** Fix round 1 (spec §4.1/§4.2): in a loop mode a quiet run prints nothing, a real run only the view's block
     *  (the progress lines under --verbose); --once --quiet prints only the Done / Failed line. */
    public function testLoopRunsPrintOnlyTheBlockAndQuietRunsNothing(): void
    {
        $this->venv();
        foreach (['single' => [], 'modular' => ['modular' => true]] as $label => $opts) {
            $files = $this->files($this->generate($this->codeGraph(), $opts));

            [$rc, $text] = $this->runProgram($files, ['normal', 'NOTHING'], self::LOOP_DRIVER);
            self::assertSame(0, $rc, "$label: $text");
            self::assertSame("RESULT ''", trim($text), "$label: a quiet loop run prints nothing");

            [$rc, $text] = $this->runProgram($files, ['normal', 'WORKNOW'], self::LOOP_DRIVER);
            self::assertSame(0, $rc, "$label: $text");
            $lines = explode("\n", rtrim($text));
            self::assertSame(["    · 'Check' code -- exits=['work', 'no_mail', 'error'], mcp_servers=[]", "    · exit 'work'",
                              '  ✓ Check', '  ✓ Output'], array_slice($lines, 0, 4), "$label: $text");
            self::assertMatchesRegularExpression('~^\[\d\d:\d\d\] Done in \d+\.\d s$~', $lines[4], "$label: $text");
            self::assertSame("RESULT 'mail for you'", $lines[5], "$label: $text");
            self::assertCount(6, $lines, "$label: no [node], [info], FINAL OUTPUT or RUN SUMMARY\n$text");

            [$rc, $text] = $this->runProgram($files, ['verbose', 'WORKNOW'], self::LOOP_DRIVER);
            self::assertSame(0, $rc, "$label: $text");
            self::assertStringContainsString('[info] Running...', $text, $label);
            self::assertStringContainsString("[node] [2] exit 'work'", $text, $label);
            self::assertStringNotContainsString('FINAL OUTPUT', $text, $label);
            self::assertLessThan(strpos($text, '  ✓ Check'), strpos($text, '[info] Running...'), "$label: progress lines before the block");

            [$rc, $text] = $this->runProgram($files, ['--once', '--quiet', 'WORKNOW']);
            self::assertSame(0, $rc, "$label: $text");
            self::assertMatchesRegularExpression('~^\[\d\d:\d\d\] Done in \d+\.\d s$~', trim($text), "$label --once --quiet: $text");

            [$rc, $text] = $this->runProgram($files, ['--once', '--quiet', 'FAILNOW']);
            self::assertSame(1, $rc, "$label: $text");
            self::assertMatchesRegularExpression("~^\\[\\d\\d:\\d\\d\\] Failed: ErrorExitTaken: code node 'Check' took its error exit: mailbox gone$~", trim($text), "$label --once --quiet: $text");
        }
    }

    /** Task 1 left DEFAULT_WATCH None for a Start option without a watch: the default mode then fails as a usage error. */
    public function testAStartOptionWithoutAWatchIsAUsageError(): void
    {
        $this->venv();
        foreach (['single' => [], 'modular' => ['modular' => true]] as $label => $opts) {
            $files = $this->files($this->generate($this->optionGraph(null), $opts));
            self::assertStringContainsString('START_MODE = "watch"', $files['workflow.py'], $label);
            self::assertStringContainsString('DEFAULT_WATCH = None', $files['workflow.py'], $label);
            [$rc, $text] = $this->runProgram($files, []);
            self::assertSame(2, $rc, "$label: $text");
            self::assertStringContainsString('--watch needs a trigger: this workflow has no event trigger', $text, $label);
            self::assertStringNotContainsString('Traceback', $text, $label);
        }
    }
}
