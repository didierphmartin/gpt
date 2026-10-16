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

    private function py(string $tail): array
    {
        $file = tempnam(sys_get_temp_dir(), 'rr') . '.py';
        file_put_contents($file, "from __future__ import annotations\nimport json, os, tempfile, time, uuid\nfrom datetime import datetime\nfrom typing import Callable\n"
            . LangGraphRuntime::runRecordBlock() . "\n" . $tail);
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
