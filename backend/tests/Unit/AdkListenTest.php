<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\ADKGenerator;
use AgentTeam\Services\StartTriggerFacts;

class AdkListenTest extends TestCase
{
    private static function triggerNodes(string $server = 'Outlook'): array
    {
        return [
            ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start']],
            ['id' => '1000000001', 'type' => 'code', 'config' => ['type' => 'code', 'name' => 'T',
                'start_trigger' => ['label' => 'T', 'work_exit' => 'new_mail',
                    'watch' => ['server' => $server, 'tool' => 'wait_for_new', 'args' => ['folder' => 'Inbox']]]]],
        ];
    }

    public function testTriggerNodeMakesTheStartWatch(): void
    {
        $f = StartTriggerFacts::of(null, 64, self::triggerNodes(), ['http://x' => 'outlook']);
        self::assertSame('watch', $f['startMode']);
        self::assertSame(['server' => 'outlook', 'tool' => 'wait_for_new', 'args' => ['folder' => 'Inbox']], $f['defaultWatch']);
        self::assertSame('1000000001', $f['triggerNodeId']);
    }

    public function testWatchOnAnUnusedServerIsRefused(): void
    {
        $this->expectExceptionMessage('which no node of this workflow uses');
        StartTriggerFacts::of(null, 64, self::triggerNodes('Gmail'), ['http://x' => 'outlook']);
    }

    public function testNoTriggerNoScheduleIsAPromptStart(): void
    {
        $pdo = new \PDO('sqlite::memory:');   // no scheduled_workflows table
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $f = StartTriggerFacts::of($pdo, 64, [['id' => '1', 'type' => 'start', 'config' => ['type' => 'start']]], []);
        self::assertSame(['startMode' => 'prompt', 'defaultCron' => null, 'defaultWatch' => null, 'triggerNodeId' => null], $f);
    }

    public function testScriptBakesTheStartMode(): void
    {
        $a = AdkCodeNodeTest::codeAnalyzed();
        $a['startMode'] = 'watch';
        $a['defaultWatch'] = ['server' => 'outlook', 'tool' => 'wait_for_new', 'args' => ['folder' => 'Inbox']];
        $code = ADKGenerator::emitAdk($a);
        self::assertStringContainsString('START_MODE = "watch"', $code);
        self::assertStringContainsString('DEFAULT_CRON = None', $code);
        self::assertMatchesRegularExpression('/DEFAULT_WATCH = \{\s*"server": "outlook",\s*"tool": "wait_for_new",\s*"args": \{\s*"folder": "Inbox"\s*\}\s*\}/', $code);
        self::assertStringContainsString('START_MODE = "prompt"', ADKGenerator::emitAdk(AdkCodeNodeTest::codeAnalyzed()));
    }

    public function testRecordingCoversNodesButNotTheDispatcherChooser(): void
    {
        $code = ADKGenerator::emitAdk(AdkCodeNodeTest::wf64Analyzed());
        self::assertMatchesRegularExpression('/NODE_META = \{.*"node_10": \[\s*"10",\s*"code",\s*"T"\s*\]/s', $code);
        self::assertMatchesRegularExpression('/"node_5": \[\s*"5",\s*"output",\s*"Output"\s*\]/s', $code);
        self::assertStringNotContainsString('"node_2": [', $code);   // the chooser: _DispatcherAgent records node 2
        self::assertStringContainsString('START_NODE = ["1", "Start"]', $code);
        self::assertStringContainsString('OUTPUT_NODE_KEYS = ["node_5"]', $code);
        self::assertStringContainsString('_attach_recording(root_agent)', $code);
        self::assertStringContainsString("node_id=\"2\",\n    display=\"D\",", $code);
    }

    /** The RUN EVENTS helpers, run with a fake recorder and fake callback contexts. */
    public function testRecordingHelpersEmitTheRunEvents(): void
    {
        $code = ADKGenerator::emitAdk(AdkCodeNodeTest::wf64Analyzed());
        $start = strpos($code, 'NODE_META = ');
        $end = strpos($code, '# =====', $start);
        $py = substr($code, $start, $end - $start) . <<<'PY'

class Rec:
    def __init__(self): self.ev = []
    def node_start(self, *a): self.ev.append(["start", *a])
    def node_complete(self, *a, **k): self.ev.append(["complete", *a, k])
class Ctx:
    def __init__(self, name, state): self.agent_name, self.state = name, state
class Agent:
    def __init__(self, name, subs=()): self.name, self.sub_agents = name, list(subs)
GRAPH_RECORDER = Rec()
_run_reset()
root = Agent("workflow", [Agent("node_10"), Agent("gate_2", [Agent("node_2__dispatch", [Agent("node_2"), Agent("node_3")])])])
_attach_recording(root)
t = root.sub_agents[0]
assert t.before_agent_callback is _rec_before and not hasattr(root.sub_agents[1].sub_agents[0].sub_agents[0], "before_agent_callback")
st = {"node_10": '{"subject": "hi"}', "route_10": "new_mail"}
_rec_before(Ctx("node_10", st)); _rec_after(Ctx("node_10", st))
_rec_node_start("3", "A", "code")   # then the run fails: run_workflow closes it
for nid, (name, typ) in list(_RUN["open"].items()):
    _rec_node_complete(nid, name, typ, success=False, error="RuntimeError: boom")
import json
print(json.dumps([GRAPH_RECORDER.ev, _RUN["ran"], _RUN["routes"]]))
PY;
        $f = sys_get_temp_dir() . '/adkrec_' . bin2hex(random_bytes(4)) . '.py';
        file_put_contents($f, $py);
        exec('python3 ' . escapeshellarg($f) . ' 2>&1', $out, $rc);
        self::assertSame(0, $rc, implode("\n", $out));
        [$ev, $ran, $routes] = json_decode(end($out), true);
        self::assertSame(['start', '10', 'T', 'code'], $ev[0]);
        self::assertSame(['complete', '10', 'T', 'code', ['output' => '{"subject": "hi"}', 'exit' => 'new_mail']], $ev[1]);
        self::assertSame(['complete', '3', 'A', 'code', ['output' => '', 'success' => false, 'error' => 'RuntimeError: boom']], $ev[3]);
        self::assertSame(['10', '3'], $ran);
        self::assertSame(['10' => 'new_mail'], $routes);
    }
}
