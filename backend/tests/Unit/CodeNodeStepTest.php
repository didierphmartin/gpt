<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\CodeNodeStep;
use PHPUnit\Framework\TestCase;

final class CodeNodeStepTest extends TestCase
{
    private const EDGES = [
        ['from_node_id' => 1, 'to_node_id' => 2, 'from_port' => 'output_1'],
        ['from_node_id' => 2, 'to_node_id' => 3, 'from_port' => 'output_1'],   // new_mail -> agent
        ['from_node_id' => 3, 'to_node_id' => 4, 'from_port' => 'output_1'],   // agent -> output
    ];
    private const NODES = [
        1 => ['id' => 1, 'node_type' => 'start', 'config' => []],
        2 => ['id' => 2, 'node_type' => 'code', 'config' => ['name' => 'Poll Outlook', 'exits' => ['new_mail', 'no_mail', 'error']]],
        3 => ['id' => 3, 'node_type' => 'agent', 'config' => ['agent_name' => 'Triage']],
        4 => ['id' => 4, 'node_type' => 'output', 'config' => []],
    ];

    public function testParentsMirrorTheEditor(): void
    {
        $p = CodeNodeStep::parents(2, self::EDGES, self::NODES, [1 => ['type' => 'start', 'output' => 'go']]);
        self::assertSame([['name' => 'start', 'text' => 'go', 'start' => true]], $p);
        self::assertSame([], CodeNodeStep::parents(2, self::EDGES, self::NODES, [1 => ['output' => '']]));
    }

    public function testRouteToChosenExit(): void
    {
        $data = ['exits' => ['new_mail', 'no_mail', 'error'], 'exit_targets' => ['new_mail' => ['3'], 'no_mail' => [], 'error' => []]];
        $r = CodeNodeStep::routeAfter($data, ['ok' => true, 'route' => 'new_mail', 'output_text' => '{"id":"m1"}'], [3]);
        self::assertSame(['success' => true, 'output' => '{"id":"m1"}', 'exit' => 'new_mail', 'chosen' => [3], 'skip' => []], $r);
        $r = CodeNodeStep::routeAfter($data, ['ok' => true, 'route' => 'no_mail', 'output_text' => 'null'], [3]);
        self::assertSame([], $r['chosen']);
        self::assertSame([3], $r['skip']);
    }

    public function testFailedRunSkipsAllChildren(): void
    {
        $data = ['exits' => ['next'], 'exit_targets' => ['next' => ['3']]];
        $r = CodeNodeStep::routeAfter($data, ['ok' => false, 'error' => 'CodeNodeError: boom'], [3]);
        self::assertFalse($r['success']);
        self::assertSame('Error: CodeNodeError: boom', $r['output']);
        self::assertSame([3], $r['skip']);
    }

    private static function summarize(array $outputs, array $edges = self::EDGES, array $nodes = self::NODES): array
    {
        return CodeNodeStep::summarize($outputs, $edges, $nodes);
    }

    public function testQuietAndDrain(): void
    {
        $codeOnly = [1 => ['type' => 'start'], 2 => ['type' => 'code', 'exit' => 'no_mail', 'success' => true]];
        self::assertSame(['quiet' => true, 'drain' => false], self::summarize($codeOnly));
        $work = [1 => ['type' => 'start'], 2 => ['type' => 'code', 'exit' => 'new_mail', 'success' => true],
            3 => ['type' => 'agent'], 4 => ['type' => 'output']];
        self::assertSame(['quiet' => false, 'drain' => true], self::summarize($work));
        $plain = [1 => ['type' => 'start'], 3 => ['type' => 'agent'], 4 => ['type' => 'output']];
        self::assertSame(['quiet' => false, 'drain' => false], self::summarize($plain));
    }

    public function testWorkBesideThePollDoesNotDrain(): void
    {
        // Start -> Poll(2) and Start -> Agent(5) in parallel; the poll found no mail.
        $edges = [...self::EDGES, ['from_node_id' => 1, 'to_node_id' => 5, 'from_port' => 'output_1']];
        $nodes = self::NODES + [5 => ['id' => 5, 'node_type' => 'agent', 'config' => ['agent_name' => 'Beside']]];
        $out = [1 => ['type' => 'start'], 2 => ['type' => 'code', 'exit' => 'no_mail', 'success' => true], 5 => ['type' => 'agent']];
        self::assertSame(['quiet' => false, 'drain' => false], self::summarize($out, $edges, $nodes),
            'the agent beside the poll ran (not quiet) but is not behind its exit (no drain)');
        // The same graph when the poll found mail: the agent behind new_mail drains.
        $out = [1 => ['type' => 'start'], 2 => ['type' => 'code', 'exit' => 'new_mail', 'success' => true],
            5 => ['type' => 'agent'], 3 => ['type' => 'agent'], 4 => ['type' => 'output']];
        self::assertSame(['quiet' => false, 'drain' => true], self::summarize($out, $edges, $nodes));
    }

    public function testACodeNodeThatTookNoExitDidNotRun(): void
    {
        // A disabled code node: the generic sentinel, no exit taken. Neither quiet nor drain.
        $disabled = [1 => ['type' => 'start'], 2 => ['type' => 'code', 'output' => 'disabled node', 'success' => true]];
        self::assertSame(['quiet' => false, 'drain' => false], self::summarize($disabled));
        $disabledThenWork = $disabled + [3 => ['type' => 'agent'], 4 => ['type' => 'output']];
        self::assertSame(['quiet' => false, 'drain' => false], self::summarize($disabledThenWork));
    }

    public function testErrorExitIsNeverQuietAndDoesNotDrain(): void
    {
        $errored = [1 => ['type' => 'start'], 2 => ['type' => 'code', 'exit' => 'error']];
        self::assertSame(['quiet' => false, 'drain' => false], self::summarize($errored));
        $failed = [1 => ['type' => 'start'], 2 => ['type' => 'code', 'success' => false]];
        self::assertSame(['quiet' => false, 'drain' => false], self::summarize($failed));
        $erroredThenWork = $errored + [3 => ['type' => 'agent']];
        self::assertSame(['quiet' => false, 'drain' => false], self::summarize($erroredThenWork));
    }

    public function testErrorExitReasonIsOneBoundedLine(): void
    {
        // Parity with the compiled ErrorExitTaken.reason: whitespace collapsed, cut at 200 characters (…).
        self::assertSame('mailbox down: retry later', CodeNodeStep::reason("  mailbox down:\n\t retry   later \n"));
        $long = CodeNodeStep::reason(str_repeat('é', 250));
        self::assertSame(str_repeat('é', 200) . '…', $long);
        self::assertSame(str_repeat('a', 200), CodeNodeStep::reason(str_repeat('a', 200)));
    }

    public function testEmptyAgentNameFallsThroughToName(): void
    {
        $nodes = [3 => ['config' => ['agent_name' => '', 'name' => 'Triage']], 2 => self::NODES[2]];
        $edges = [['from_node_id' => 3, 'to_node_id' => 2, 'from_port' => 'output_1']];
        $p = CodeNodeStep::parents(2, $edges, $nodes, [3 => ['output' => 'x']]);
        self::assertSame('Triage', $p[0]['name']);
    }

    public function testADispatcherParentPassesOnWhatItReceived(): void
    {
        // Start(1) -> Poll(4) -> dispatcher(3) -> claims(2): the branch gets the email, not the framed context.
        $nodes = [1 => ['node_type' => 'start', 'config' => []], 4 => ['node_type' => 'code', 'config' => ['name' => 'Poll']],
            3 => ['node_type' => 'agent', 'config' => ['agent_name' => 'triage']], 2 => self::NODES[2]];
        $edges = [['from_node_id' => 1, 'to_node_id' => 4], ['from_node_id' => 4, 'to_node_id' => 3],
            ['from_node_id' => 3, 'to_node_id' => 2]];
        $outputs = [1 => ['output' => 'poll'], 4 => ['type' => 'code', 'output' => '{"id":"m1"}'],
            3 => ['type' => 'agent', 'output' => "### Input from: Poll\n{\"id\":\"m1\"}", 'route' => ['id' => 2, 'name' => 'claims']]];
        self::assertSame([['name' => 'Poll', 'text' => '{"id":"m1"}', 'start' => false]],
            CodeNodeStep::parents(2, $edges, $nodes, $outputs));
    }
}
