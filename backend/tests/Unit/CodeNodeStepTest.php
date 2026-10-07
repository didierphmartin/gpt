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

    public function testQuietAndDrain(): void
    {
        $codeOnly = [1 => ['type' => 'start'], 2 => ['type' => 'code', 'exit' => 'idle', 'success' => true]];
        self::assertSame(['quiet' => true, 'drain' => false], CodeNodeStep::summarize($codeOnly));
        $work = $codeOnly + [3 => ['type' => 'agent'], 4 => ['type' => 'output']];
        self::assertSame(['quiet' => false, 'drain' => true], CodeNodeStep::summarize($work));
        $plain = [1 => ['type' => 'start'], 3 => ['type' => 'agent'], 4 => ['type' => 'output']];
        self::assertSame(['quiet' => false, 'drain' => false], CodeNodeStep::summarize($plain));
    }

    public function testACodeNodeThatTookNoExitDidNotRun(): void
    {
        // A disabled code node: the generic sentinel, no exit taken. Neither quiet nor drain.
        $disabled = [1 => ['type' => 'start'], 2 => ['type' => 'code', 'output' => 'disabled node', 'success' => true]];
        self::assertSame(['quiet' => false, 'drain' => false], CodeNodeStep::summarize($disabled));
        $disabledThenWork = $disabled + [3 => ['type' => 'agent'], 4 => ['type' => 'output']];
        self::assertSame(['quiet' => false, 'drain' => false], CodeNodeStep::summarize($disabledThenWork));
    }

    public function testErrorExitIsNeverQuietAndDoesNotDrain(): void
    {
        $errored = [1 => ['type' => 'start'], 2 => ['type' => 'code', 'exit' => 'error']];
        self::assertSame(['quiet' => false, 'drain' => false], CodeNodeStep::summarize($errored));
        $failed = [1 => ['type' => 'start'], 2 => ['type' => 'code', 'success' => false]];
        self::assertSame(['quiet' => false, 'drain' => false], CodeNodeStep::summarize($failed));
        $erroredThenWork = $errored + [3 => ['type' => 'agent']];
        self::assertSame(['quiet' => false, 'drain' => false], CodeNodeStep::summarize($erroredThenWork));
    }

    public function testEmptyAgentNameFallsThroughToName(): void
    {
        $nodes = [3 => ['config' => ['agent_name' => '', 'name' => 'Triage']], 2 => self::NODES[2]];
        $edges = [['from_node_id' => 3, 'to_node_id' => 2, 'from_port' => 'output_1']];
        $p = CodeNodeStep::parents(2, $edges, $nodes, [3 => ['output' => 'x']]);
        self::assertSame('Triage', $p[0]['name']);
    }
}
