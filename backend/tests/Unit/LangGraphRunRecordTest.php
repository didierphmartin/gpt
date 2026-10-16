<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\LangGraphRuntime;
use PHPUnit\Framework\TestCase;

/** Standalone plan task 3: run records in the server's format, and the server's quiet rule. */
final class LangGraphRunRecordTest extends TestCase
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

    private function py(string $tail, string $head = ''): array
    {
        $file = tempnam(sys_get_temp_dir(), 'rr') . '.py';
        file_put_contents($file, "from __future__ import annotations\nimport json, os, tempfile, time, uuid\nfrom datetime import datetime\nfrom typing import Callable\n"
            . $head . LangGraphRuntime::runRecordBlock() . "\n" . LangGraphRuntime::consoleBlock() . "\n" . $tail);
        exec($this->python() . ' ' . escapeshellarg($file) . ' 2>&1', $out, $rc);
        unlink($file);
        self::assertSame(0, $rc, implode("\n", $out));
        self::assertSame('ok', end($out), implode("\n", $out));
        return $out;
    }

    public function testARunWritesServerFormatEventsAndThePointer(): void
    {
        $this->py(<<<'PY'
d = tempfile.mkdtemp()
seen = []
r = RunRecorder(d, 44, "Email prototype", listeners=[seen.append])
rid = r.begin()
assert len(rid) == 32 and all(c in "0123456789abcdef" for c in rid)
r.node_start("1000000017", "Outlook: get new email", "code")
r.node_complete("1000000017", "Outlook: get new email", "code", output="From: a@b.c\nSubject: Claim", exit="new_mail")
r.node_start("21", "jev", "agent")
r.node_log("21", "jev routed to claims (confidence 0.97)")
r.node_complete("21", "jev", "agent", output="ok", route={"id": "23", "name": "claims"})
r.complete(success=True, output="done")
r.end(quiet=False)
name = open(os.path.join(d, "current")).read().strip()
lines = [json.loads(l) for l in open(os.path.join(d, name + ".jsonl"))]
assert [e["type"] for e in lines] == ["workflow_start", "node_start", "node_complete", "node_start", "node_log", "node_complete", "workflow_complete"], lines
assert lines[0]["run_id"] == rid and lines[0]["workflow_id"] == 44
assert lines[2]["drawflow_id"] is None and lines[2]["node_id"] == "1000000017" and lines[2]["exit"] == "new_mail"
assert lines[5]["route"] == {"id": "23", "name": "claims"}
assert all(isinstance(e["timestamp"], float) for e in lines)
assert len(seen) == 7
print("ok")
PY);
    }

    public function testAQuietRunLeavesNoFile(): void
    {
        $this->py(<<<'PY'
d = tempfile.mkdtemp()
r = RunRecorder(d, 44, "W")
r.begin(); r.node_start("1000000017", "T", "code"); r.node_complete("1000000017", "T", "code", exit="no_mail")
r.complete(success=True); r.end(quiet=True)
assert [f for f in os.listdir(d) if f.endswith(".jsonl")] == [], os.listdir(d)
print("ok")
PY);
    }

    public function testQuietRuleMatchesTheServer(): void
    {
        $this->py(<<<'PY'
types = {"1": "start", "9": "code", "2": "agent", "3": "output"}
agents = {"9": {"kind": "code"}, "2": {"kind": "agent"}}
assert is_quiet(types, {"9": "no_mail"}, agents, ["1", "9"]) is True
assert is_quiet(types, {"9": "new_mail"}, agents, ["1", "9", "2", "3"]) is False
assert is_quiet(types, {"9": "error"}, agents, ["1", "9"]) is False          # an error is never quiet
assert is_quiet(types, {}, agents, ["1", "2", "3"]) is False                 # no code node ran: a plain run
print("ok")
PY);
    }

    public function testAFailedRunIsKept(): void
    {
        $this->py(<<<'PY'
d = tempfile.mkdtemp()
r = RunRecorder(d, 44, "W")
r.begin(); r.node_start("2", "jev", "agent"); r.node_complete("2", "jev", "agent", success=False, error="boom")
r.complete(success=False, error="boom"); r.end(quiet=False)
name = open(os.path.join(d, "current")).read().strip()
last = [json.loads(l) for l in open(os.path.join(d, name + ".jsonl"))][-1]
assert last == {**last, "type": "workflow_complete", "success": False, "error": "boom"}
print("ok")
PY);
    }

    /*
     * Ported from frontend/assets/js/start-options.js:
     *
     *     function eventSubject(output) {
     *         const s = String(output ?? '');
     *         const lines = ['From', 'Subject'].map((k) => new RegExp(`^${k}:[ \\t]*(.+)$`, 'm').exec(s)).filter(Boolean)
     *             .map((m) => m[0].trim());
     *         return lines.length ? lines.join('\n') : s.slice(0, 200);
     *     }
     *
     * The JS joins the From and Subject lines with a NEWLINE (not " · "), so ConsoleView joins those lines with " · " to keep one console line (spec §4.2).
     */
    public function testConsoleShowsTheLiveOverlayTexts(): void
    {
        $this->py(<<<'PY'
lines = []
v = ConsoleView(out=lines.append, now=lambda: datetime(2026, 10, 15, 10, 42))
r = RunRecorder(None, 44, "W", listeners=[v])
r.begin()
r.node_start("1", "Start", "start"); r.node_complete("1", "Start", "start", output="poll")
r.node_complete("1000000017", "Outlook: get new email", "code", output="From: jane@acme.com\nSubject: Claim for water damage\n\nBody", exit="new_mail")
r.node_log("21", "jev routed to claims (confidence 0.97)")
r.node_complete("21", "jev", "agent", output="x", route={"id": "23", "name": "claims"})
r.node_complete("23", "claims", "agent", output="y")
r.node_complete("24", "bad", "agent", success=False, error="oops")
assert lines == [], lines   # buffered until the run completes
r.complete(success=True, output="done")
assert lines[0] == "[10:42] New event — From: jane@acme.com · Subject: Claim for water damage", lines
assert not any("\n" in l for l in lines), lines
assert "    · jev routed to claims (confidence 0.97)" in lines
assert "  ✓ jev → claims" in lines and "  ✓ claims" in lines and "  ✗ bad: oops" in lines
assert not any("Start" in l for l in lines), lines
assert lines[-1].startswith("[10:42] Done in ") and "done" not in lines[-1], lines
print("ok")
PY);
    }

    public function testEventSubjectMatchesTheJs(): void
    {
        $this->py(<<<'PY'
assert event_subject("From:\t  a@b.c  \nSubject:x y\nFrom: later") == "From:\t  a@b.c\nSubject:x y"
assert event_subject("Subject: only") == "Subject: only"
assert event_subject("x" * 300) == "x" * 200
assert event_subject("") == ""
print("ok")
PY);
    }

    public function testVerboseAddsOutputsAndTheAnswer(): void
    {
        $this->py(<<<'PY'
lines = []
v = ConsoleView(verbosity="verbose", out=lines.append, now=lambda: datetime(2026, 10, 15, 10, 42))
r = RunRecorder(None, 44, "W", listeners=[v])
r.begin(); r.node_complete("23", "claims", "agent", output="y" * 600); r.complete(success=True, output="a" * 300)
assert "      " + "y" * 500 in lines and "      " + "y" * 501 not in lines, lines
assert lines[-1].endswith(" — " + "a" * 200) and "a" * 201 not in lines[-1], lines
print("ok")
PY);
    }

    public function testQuietVerbosityAndDiscard(): void
    {
        $this->py(<<<'PY'
lines = []
v = ConsoleView(verbosity="quiet", out=lines.append, now=lambda: datetime(2026, 10, 15, 10, 42))
r = RunRecorder(None, 44, "W", listeners=[v])
r.begin(); r.node_complete("23", "claims", "agent", output="y"); r.complete(success=False, error="boom")
assert lines == ["[10:42] Failed: boom"], lines
# discard() on a normal view: the buffer is real, and discarding it prints nothing
lines = []
v = ConsoleView(out=lines.append, now=lambda: datetime(2026, 10, 15, 10, 42))
r = RunRecorder(None, 44, "W", listeners=[v])
r.begin()
r.node_complete("1000000017", "T", "code", output="From: a@b.c", exit="new_mail")
r.node_complete("23", "claims", "agent", output="y")
assert len(v.buffered) == 2 and lines == [], (v.buffered, lines)
v.discard()
assert v.buffered == [] and lines == [], (v.buffered, lines)
# a run left uncompleted: the next begin() clears its lines, which never print
r.begin()
r.node_complete("23", "claims", "agent", output="y")
assert len(v.buffered) == 1 and lines == []
r.begin()
assert v.buffered == [] and lines == [], (v.buffered, lines)
print("ok")
PY);
    }

    /**
     * Final review M-a: the node runtime's own lines ([tool], [run_skill_script], a dispatcher's "routed to")
     * go through node_print(): RUN_OUT where the file has it (so a --cron / --watch run holds them like its
     * other progress lines), print where it has not (an A2A agent process).
     */
    public function testNodeLinesGoThroughRunOutWhereThereIsOne(): void
    {
        $head = "import threading\n" . LangGraphRuntime::runEventsBlock() . "\n";
        $out = $this->py(<<<'PY'
RUN_OUT.begin("hold")
node_print("  [tool] -> x()")
assert RUN_OUT.held == ["  [tool] -> x()"], RUN_OUT.held
RUN_OUT.begin("drop")
node_print("dropped")
RUN_OUT.begin("print")
node_print("printed")
print("ok")
PY, $head);
        self::assertSame(['printed', 'ok'], $out);
        $file = tempnam(sys_get_temp_dir(), 'rr') . '.py';
        file_put_contents($file, "from __future__ import annotations\nfrom typing import Callable\n" . $head . "node_print('no RUN_OUT here')\n");
        exec($this->python() . ' ' . escapeshellarg($file) . ' 2>&1', $plain, $rc);
        unlink($file);
        self::assertSame([0, ['no RUN_OUT here']], [$rc, $plain]);

        $gen = LangGraphA2AGeneratorTest::generator();
        $codes = ['single' => $gen->generate(44, '3')['code']];
        foreach (['modular', 'a2a'] as $mode) {
            foreach ($gen->generate(44, '3', [$mode => true])['files'] as $f) {
                $codes["$mode/{$f['path']}"] = $f['code'];
            }
        }
        $checked = 0;
        foreach ($codes as $label => $code) {
            if (($label !== 'single' && !str_ends_with($label, '.py'))
                || (!str_contains($code, 'class ToolCatalog') && !str_contains($code, 'class DispatcherNode'))) {
                continue;
            }
            $checked++;
            self::assertMatchesRegularExpression('/^def node_print\(/m', $code, $label);
            if (str_contains($code, 'RUN_OUT = RunOutput()')) {   // the hook is set after node_print's default, not reset by it
                self::assertLessThan(strpos($code, 'NODE_OUT = RUN_OUT'), strpos($code, 'NODE_OUT: Callable'), $label);
            }
            foreach (['print(f"  [tool]', 'print(f"[node] [{nid}]', 'print(f"  [run_skill_script]'] as $bare) {
                self::assertDoesNotMatchRegularExpression('/(?<!node_)' . preg_quote($bare, '/') . '/', $code, "$label: $bare");
            }
        }
        self::assertGreaterThanOrEqual(3, $checked);
    }

    /** The block must land in every emission that carries WorkflowGraph, and the result must compile. */
    public function testEveryEmissionCarriesTheRecorderAndCompiles(): void
    {
        $this->python();
        $gen = LangGraphA2AGeneratorTest::generator();
        $emissions = ['single' => ['single.py' => $gen->generate(44, '3')['code']]];
        foreach (['modular', 'a2a'] as $mode) {
            $files = [];
            foreach ($gen->generate(44, '3', [$mode => true])['files'] as $f) {
                $files[$f['path']] = $f['code'];
            }
            $emissions[$mode] = $files;
        }
        foreach ($emissions as $label => $files) {
            $withRecorder = 0;
            foreach ($files as $path => $code) {
                if (!str_ends_with($path, '.py')) {
                    continue;
                }
                $tmp = tempnam(sys_get_temp_dir(), 'rr') . '.py';
                file_put_contents($tmp, $code);
                exec($this->python() . ' -m py_compile ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
                unlink($tmp);
                self::assertSame(0, $rc, "$label/$path: " . implode("\n", $out));
                if (str_contains($code, 'class RunRecorder')) {
                    $withRecorder++;
                    self::assertStringContainsString('class WorkflowGraph', $code, "$label/$path");
                    self::assertLessThan(strpos($code, 'class WorkflowGraph'), strpos($code, 'class RunRecorder'));
                    foreach (['uuid', 'datetime'] as $needed) {
                        self::assertMatchesRegularExpression('/^(import .*\b' . $needed . '\b|from datetime import .*\bdatetime\b)/m', $code, "$label/$path imports $needed");
                    }
                }
                if (str_contains($code, 'GRAPH_RECORDER.node_log')) {
                    self::assertMatchesRegularExpression('/^GRAPH_RECORDER = NULL_RECORDER/m', $code, "$label/$path");
                }
            }
            self::assertSame(1, $withRecorder, "$label: exactly one file carries the recorder");
        }
        self::assertStringContainsString('GRAPH_RECORDER.node_log', $emissions['single']['single.py']);
        self::assertStringContainsString('GRAPH_RECORDER.node_log', $emissions['modular']['workflow.py']);
    }
}
