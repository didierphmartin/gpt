<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\CronExpression;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\LangGraphRuntime;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;
use PHPUnit\Framework\TestCase;

/** spec 2026-10-07 §7.2: the compiled loop, with CronExpression.php's semantics. */
final class LangGraphCronLoopTest extends TestCase
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

    /** A fake clock: sleep(s) moves now() forward by s (plus `jump` seconds once, e.g. a laptop asleep). */
    private const CLOCK = <<<'PY'
class Clock:
    def __init__(self, *args, jump=0):
        self.t, self.slept, self.jump = datetime(*args), [], jump
    def now(self):
        return self.t
    def sleep(self, s):
        self.slept.append(s)
        self.t += timedelta(seconds=s + self.jump)
        self.jump = 0

PY;

    /** Run cronBlock() plus $tail with the imports an entry file gives it; returns [exit code, output lines]. */
    private function runPy(string $tail): array
    {
        $file = tempnam(sys_get_temp_dir(), 'cr') . '.py';
        file_put_contents($file, "from __future__ import annotations\nimport argparse, asyncio, re, signal, time\nfrom datetime import datetime, timedelta\n"
            . LangGraphRuntime::cronBlock() . "\n" . self::CLOCK . $tail);
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

    public function testNextFireMatchesThePhpParser(): void
    {
        $cases = [
            ['*/2 * * * *', '2026-10-07 10:42:30'], ['*/5 8-18 * * 1-5', '2026-10-09 18:57:00'],
            ['0 9 * * 7', '2026-10-07 00:00:00'], ['0 9 * * 0', '2026-10-07 00:00:00'],
            ['0 0 1 * 1', '2026-10-07 00:00:00'], ['0 0 */2 * 1', '2026-10-07 00:00:00'],
            ['0 0 * * */2', '2026-10-07 00:00:00'], ['5,35 9-17/4 * * *', '2026-10-07 13:36:00'],
            ['5/20 * * * *', '2026-10-07 10:46:00'], ['0 0 1 * *', '2026-10-31 23:59:59'],
            ['59 23 31 * *', '2026-11-01 00:00:00'], ['0 0 29 2 *', '2026-10-07 00:00:00'],
            ['30 12 29 2 1', '2027-02-27 00:00:00'], ['15 10 * * *', '2026-12-31 10:15:00'],
            ['  0   0  1 1  * ', '2026-10-07 00:00:00'], ['0-59/15 */6 1-7 1,7 1-5', '2026-10-07 00:00:00'],
        ];
        $tail = '';
        foreach ($cases as [$e, $at]) {
            $tail .= 'print(cron_next(' . json_encode($e, JSON_UNESCAPED_SLASHES) . ", datetime.fromisoformat('{$at}')).strftime('%Y-%m-%d %H:%M'))\n";
        }
        $out = $this->py($tail);
        foreach ($cases as $i => [$e, $at]) {
            $php = (new CronExpression($e))->nextAfter(new \DateTimeImmutable($at))->format('Y-m-d H:i');
            self::assertSame($php, $out[$i] ?? null, "{$e} after {$at}");
        }
    }

    public function testInvalidExpressionsAreRefusedLikeThePhpParser(): void
    {
        $exprs = ['* * * *', '* * * * * *', '', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8',
            '5-1 * * * *', '*/0 * * * *', '+5 * * * *', 'a * * * *', '1-2-3 * * * *', '5/ * * * *', ',5 * * * *',
            '0 0 31 2 *', '0 0 30 2 *', '*/2 * * * *', '0 9 * * 7'];
        $tail = '';
        foreach ($exprs as $e) {
            $tail .= "try:\n    cron_next(" . json_encode($e, JSON_UNESCAPED_SLASHES) . ", datetime(2026, 10, 7))\n    print('ok')\nexcept ValueError:\n    print('bad')\n";
        }
        $out = $this->py($tail);
        foreach ($exprs as $i => $e) {
            self::assertSame(CronExpression::isValid($e) ? 'ok' : 'bad', $out[$i] ?? null, "'{$e}'");
        }
    }

    public function testDrainsQuietAndSurvivesErrors(): void
    {
        $out = $this->py(<<<'PY'
outputs = iter(["mail 1", "mail 2", "", "boom", ""])
def run_once():
    o = next(outputs)
    if o == "boom":
        raise RuntimeError("reconnect_needed")
    return o
c = Clock(2026, 10, 7, 10, 42, 30)
run_cron("*/2 * * * *", run_once, drains=True, sleep=c.sleep, now=c.now, ticks=3)
print("sleeps", len(c.slept))
PY);
        $text = implode("\n", $out);
        self::assertStringContainsString('2 run(s) did work', $text);   // tick 1: mail 1, mail 2, then quiet
        self::assertStringContainsString('reconnect_needed', $text);    // tick 2: error logged, loop continues
        self::assertStringContainsString('nothing to do', $text);       // tick 3: quiet
        self::assertStringContainsString('sleeps 6', $text);           // 90 s, then 120 s twice, in naps of <= 60 s
    }

    public function testNoDrainWithoutCodeNodes(): void
    {
        $out = $this->py(<<<'PY'
n = []
c = Clock(2026, 10, 7, 10, 0)
run_cron("* * * * *", lambda: n.append(1) or "report", drains=False, sleep=c.sleep, now=c.now, ticks=1)
print("runs", len(n))
PY);
        self::assertContains('runs 1', $out);
    }

    public function testDrainStopsAtTwentyRunsPerTick(): void
    {
        $out = $this->py(<<<'PY'
n = []
c = Clock(2026, 10, 7, 10, 0)
run_cron("* * * * *", lambda: n.append(1) or "mail", drains=True, sleep=c.sleep, now=c.now, ticks=1)
print("runs", len(n))
PY);
        self::assertContains('runs 20', $out);
        self::assertStringContainsString('20 run(s) did work', implode("\n", $out));
    }

    public function testAnErrorAfterWorkIsLoggedAndEndsTheDrain(): void
    {
        $out = $this->py(<<<'PY'
calls = []
def run_once():
    calls.append(1)
    if len(calls) == 2:
        raise RuntimeError("code node 'Poll Outlook' took its error exit")
    return "mail"
c = Clock(2026, 10, 7, 10, 0)
run_cron("* * * * *", run_once, drains=True, sleep=c.sleep, now=c.now, ticks=1)
print("runs", len(calls))
PY);
        $text = implode("\n", $out);
        self::assertContains('runs 2', $out);
        self::assertStringContainsString("error after 1 run(s) that did work: RuntimeError: code node 'Poll Outlook' took its error exit", $text);
        self::assertStringNotContainsString('nothing to do', $text);
    }

    public function testTicksFireOnTheScheduleInNapsOfAMinuteAtMost(): void
    {
        $out = $this->py(<<<'PY'
c = Clock(2026, 10, 7, 10, 42, 30)
run_cron("*/2 * * * *", lambda: "", drains=True, sleep=c.sleep, now=c.now, ticks=3)
print(c.slept)
PY);
        // first fire 10:44 (90 s away), then 10:46 and 10:48; the clock is re-read after every nap
        self::assertSame('[60.0, 30.0, 60.0, 60.0, 60.0, 60.0]', end($out));
        self::assertStringContainsString('[tick 10:44] nothing to do', implode("\n", $out));
        self::assertStringContainsString('[tick 10:48] nothing to do', implode("\n", $out));
    }

    public function testAClockJumpDuringANapFiresWithoutSleepingTheOldGap(): void
    {
        $out = $this->py(<<<'PY'
c = Clock(2026, 10, 7, 10, 0, 30, jump=3600)   # the first nap lasts an hour (laptop asleep, DST change)
run_cron("*/30 * * * *", lambda: "", drains=False, sleep=c.sleep, now=c.now, ticks=2)
print(c.slept)
PY);
        // due 10:30: one nap, then the clock reads 11:01:30 -> fire at once; the next fire is 11:30
        self::assertSame('[60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 30.0]', end($out));
        self::assertStringContainsString('[tick 10:30] nothing to do', implode("\n", $out));
        self::assertStringContainsString('[tick 11:30] nothing to do', implode("\n", $out));
    }

    public function testSigtermStopsTheLoopLikeCtrlC(): void
    {
        $out = $this->py(<<<'PY'
import os, threading
before = signal.getsignal(signal.SIGTERM)
threading.Timer(0.3, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
try:
    run_cron("0 0 1 1 *", lambda: "", drains=False)
finally:
    print("finally ran")
print("handler restored", signal.getsignal(signal.SIGTERM) is before)
PY);
        self::assertSame(['[cron] stopped.', 'finally ran', 'handler restored True'], array_slice($out, -3));
    }

    public function testACancelledRunIsAnErrorAndItsLeftoverTasksAreCancelled(): void
    {
        $out = $this->py(<<<'PY'
loop = asyncio.new_event_loop()
started = []
async def bad_run():
    started.append(loop.create_task(asyncio.sleep(1000)))   # a task the failed run leaves behind
    await asyncio.sleep(0)
    raise asyncio.CancelledError()
outputs = iter(["cancel", ""])
def run_once():
    if next(outputs) == "cancel":
        return loop.run_until_complete(bad_run())
    print("pending before run 2:", len([t for t in asyncio.all_tasks(loop) if not t.done()]))
    return ""
c = Clock(2026, 10, 7, 10, 0)
run_cron("* * * * *", run_once, drains=True, sleep=c.sleep, now=c.now, ticks=2, loop=loop)
print("leftover cancelled", started[0].cancelled())
PY);
        $text = implode("\n", $out);
        self::assertStringContainsString('[tick 10:01] error after 0 run(s) that did work: CancelledError', $text);
        self::assertContains('pending before run 2: 0', $out);
        self::assertStringContainsString('[tick 10:02] nothing to do', $text);
        self::assertContains('leftover cancelled True', $out);
    }

    public function testCliExpressionFallsBackToTheBakedScheduleAndRefusesBadInput(): void
    {
        $out = $this->py(<<<'PY'
ap = argparse.ArgumentParser()
print(CronExpression.from_cli(ap, None, "*/2 * * * *"))
print(CronExpression.from_cli(ap, "", "*/2 * * * *"))
print(CronExpression.from_cli(ap, "0 9 * * 1", "*/2 * * * *"))
PY);
        self::assertSame(['None', '*/2 * * * *', '0 9 * * 1'], array_slice($out, 0, 3));

        [$rc, $out] = $this->runPy("CronExpression.from_cli(argparse.ArgumentParser(), '', None)");
        self::assertSame(2, $rc);
        self::assertStringContainsString('this workflow has no cron schedule', implode("\n", $out));
        [$rc, $out] = $this->runPy("CronExpression.from_cli(argparse.ArgumentParser(), '0 0 31 2 *', None)");
        self::assertSame(2, $rc);
        self::assertStringContainsString('never fires', implode("\n", $out));
    }

    public function testCodeNodeErrorExitIsReportedByTheGraph(): void
    {
        $out = $this->py("import json\nfrom typing import Awaitable, Callable\nEND, START, StateGraph, WFState = '__end__', '__start__', None, None\n"
            . LangGraphRuntime::workflowGraphBlock() . <<<'PY'
g = WorkflowGraph(edges=[], order=[], node_types={}, start_documents=[], run_node=None,
                  agents={"2": {"display": "Poll Outlook", "kind": "code"}, "5": {"display": "D", "kind": "dispatcher"}})
g.check_error_exits()
print("clean ok")
g.routes = {"2": "mail", "5": "error"}
g.check_error_exits()
print("other exits ok")
g.routes = {"2": "error"}
try:
    g.check_error_exits()
except ErrorExitTaken as e:
    print("raised", e)
PY);
        self::assertSame(['clean ok', 'other exits ok', "raised code node 'Poll Outlook' took its error exit"], $out);
    }

    // ---------- the generator: DEFAULT_CRON, the loop and the docs in every entry file ----------

    /** $cron: the newest schedule row of workflow 44 (null: no scheduled_workflows table); $older: an older active cron row too. */
    private function pdo(?string $cron, string $status = 'pending', bool $older = true): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (85, '3', 'ServiceNow', 'http://localhost/servicenow/?profile=mock&toolset=jobs', 1)");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 85, 'poll_jobs', 'Poll', '{}')");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)");
        if ($cron !== null) {
            $pdo->exec('CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT)');
            if ($older) {
                $pdo->exec("INSERT INTO scheduled_workflows VALUES (1, 44, 'cron', '0 * * * *', 'pending')");
            }
            $pdo->exec("INSERT INTO scheduled_workflows VALUES (2, 44, 'daily', NULL, 'pending')");
            $pdo->exec("INSERT INTO scheduled_workflows VALUES (3, 45, 'cron', '1 1 1 1 1', 'pending')");   // another workflow
            $pdo->exec("INSERT INTO scheduled_workflows VALUES (4, 44, 'cron', " . $pdo->quote($cron) . ", " . $pdo->quote($status) . ")");
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

    private function generate(\PDO $pdo, array $graph, array $options = [], string $orchestration = 'workflow'): array
    {
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn((new Workflow(['id' => 44, 'name' => 'Mail poll', 'user_id' => '3']))->setOrchestration($orchestration));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph);
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        return (new LangGraphGenerator($pdo, $wfRepo, $graphRepo, $agentRepo))->generate(44, '3', $options);
    }

    private function assertCompiles(string $code, string $label): void
    {
        $file = tempnam(sys_get_temp_dir(), 'crc') . '.py';
        file_put_contents($file, $code);
        exec($this->python() . ' -m py_compile ' . escapeshellarg($file) . ' 2>&1', $out, $rc);
        unlink($file);
        self::assertSame(0, $rc, "{$label}: " . implode("\n", $out));
    }

    /** The entry file's cron pieces: baked default, imports, the loop, the CLI flag and its docs. */
    private function assertCronEntry(string $code, string $label, string $default, string $drains, string $file): void
    {
        self::assertStringContainsString("DEFAULT_CRON = {$default}\n", $code, $label);
        self::assertMatchesRegularExpression('~^from datetime import datetime, timedelta$~m', $code, $label);
        self::assertMatchesRegularExpression('~^import argparse, ~m', $code, $label);
        self::assertSame(1, substr_count($code, 'def run_cron('), $label);
        self::assertStringContainsString('ap.add_argument("--cron", nargs="?", const="", default=None, metavar="EXPR"', $code, $label);
        self::assertStringContainsString('CronExpression.from_cli(ap, a.cron, DEFAULT_CRON)', $code, $label);
        self::assertStringContainsString("run_cron(expr, run_once, drains={$drains}, loop=loop)", $code, $label);
        self::assertMatchesRegularExpression('~^import argparse, asyncio, [a-z, ]*\bsignal\b~m', $code, $label);
        self::assertStringContainsString('allow_abbrev=False)', $code, $label);   // --cron is never guessed from a prefix
        self::assertStringContainsString("python {$file} \"your prompt here\" --cron   # a prompt goes BEFORE --cron", $code, $label);
        // every run starts with a clean RUN SUMMARY (the swarm has no per-node times)
        self::assertMatchesRegularExpression('~def run_once\(\) -> str:\n(?:        [^\n]*\n)*?        (?:NODE_DURATIONS\.clear\(\)|session = uuid)~', $code, $label);
        self::assertStringContainsString("python {$file} --cron ", $code, $label);
        self::assertStringContainsString("python {$file} --cron \"*/5 8-18 * * 1-5\"", $code, $label);
        $this->assertCompiles($code, $label);
    }

    public function testSingleFileBakesTheNewestActiveCronSchedule(): void
    {
        $code = $this->generate($this->pdo('*/5 8-18 * * 1-5'), $this->codeGraph())['code'];
        $this->assertCronEntry($code, 'single', '"*/5 8-18 * * 1-5"', 'bool(CODE_NODES)', 'mail_poll_langgraph.py');
        self::assertStringContainsString('python mail_poll_langgraph.py --cron            # loop on the Start node schedule (*/5 8-18 * * 1-5)', $code);
        self::assertStringContainsString('graph.check_error_exits()', $code);
    }

    public function testAPausedNewestScheduleFallsBackToTheOlderActiveOne(): void
    {
        $code = $this->generate($this->pdo('*/2 * * * *', 'paused'), $this->codeGraph())['code'];
        self::assertStringContainsString("DEFAULT_CRON = \"0 * * * *\"\n", $code);
    }

    public function testNoScheduleBakesNone(): void
    {
        foreach ([$this->pdo(null), $this->pdo('*/2 * * * *', 'paused', false)] as $i => $pdo) {
            $code = $this->generate($pdo, $this->codeGraph())['code'];
            self::assertStringContainsString("DEFAULT_CRON = None\n", $code, "case {$i}");
            self::assertStringContainsString('--cron            # loop on the Start node schedule (none saved: pass an expression)', $code, "case {$i}");
        }
    }

    public function testModularWorkflowPyRunsTheLoop(): void
    {
        $res = $this->generate($this->pdo('*/2 * * * *'), $this->codeGraph(), ['modular' => true]);
        $files = array_column($res['files'], 'code', 'path');
        $this->assertCronEntry($files['workflow.py'], 'modular', '"*/2 * * * *"',
            'any(ad["kind"] == "code" for ad in AGENTS.values())', 'workflow.py');
        self::assertStringContainsString('graph.check_error_exits()', $files['workflow.py']);
        self::assertStringNotContainsString('def run_cron(', $files['common.py']);
    }

    public function testA2AOrchestratorRunsTheLoopWithOneSupervisor(): void
    {
        $res = $this->generate($this->pdo('*/2 * * * *'), LangGraphA2AGeneratorTest::graph(), ['a2a' => true]);
        $files = array_column($res['files'], 'code', 'path');
        $orch = $files['orchestrator.py'];
        $this->assertCronEntry($orch, 'a2a', '"*/2 * * * *"', 'False', 'orchestrator.py');
        self::assertSame(1, substr_count($orch, 'sup.start()'));
        self::assertLessThan(strpos($orch, 'sup = AgentSupervisor('), strpos($orch, 'CronExpression.from_cli('),
            'a bad --cron is refused before any agent is started');
    }

    public function testSwarmWorkflowPyRunsTheLoop(): void
    {
        $agent = fn(string $name) => ['type' => 'agent-template', 'agent_name' => $name, 'agent_type' => 'standard',
            'instructions' => "You are {$name}.", 'agent_provider' => 'claude', 'model' => 'claude-sonnet-4-6',
            'tools' => [], 'settings' => ['temperature' => 0.7, 'max_tokens' => 4096]];
        $graph = ['nodes' => [['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'Plan a trip.']],
                ['id' => '2', 'node_type' => '', 'config' => $agent('Alice')], ['id' => '3', 'node_type' => '', 'config' => $agent('Bob')]],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '1', 'to' => '3']]];
        $res = $this->generate($this->pdo('*/2 * * * *'), $graph, ['modular' => true], 'swarm');
        $files = array_column($res['files'], 'code', 'path');
        $this->assertCronEntry($files['workflow.py'], 'swarm', '"*/2 * * * *"', 'False', 'workflow.py');
        self::assertStringContainsString('_GRAPH.checkpointer.delete_thread(session)', $files['workflow.py']);
    }
}
