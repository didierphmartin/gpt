<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\WorkflowGraphAnalyzer;

class WorkflowGraphAnalyzerTest extends TestCase
{
    /** A diamond: start(1) -> a(2), start(1) -> b(3), a(2) -> out(4), b(3) -> out(4) */
    private function diamond(): array
    {
        return [
            'nodes' => [
                ['id' => '1', 'type' => 'start',  'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'You are A', 'provider' => 'claude', 'model' => 'claude-sonnet-4-6', 'selectedTools' => []]],
                ['id' => '3', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'B', 'systemPrompt' => 'You are B', 'provider' => 'gemini', 'model' => 'gemini-2.5-pro', 'selectedTools' => []]],
                ['id' => '4', 'type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [
                ['from' => '1', 'to' => '2'], ['from' => '1', 'to' => '3'],
                ['from' => '2', 'to' => '4'], ['from' => '3', 'to' => '4'],
            ],
        ];
    }

    public function testLayersGroupIndependentNodes(): void
    {
        $a = WorkflowGraphAnalyzer::analyzeGraph($this->diamond());
        // level 0: [1]; level 1: [2,3] (independent, same depth); level 2: [4]
        $this->assertSame(['1'], $a['layers'][0]);
        sort($a['layers'][1]);
        $this->assertSame(['2', '3'], $a['layers'][1]);
        $this->assertSame(['4'], $a['layers'][2]);
    }

    public function testParentsAndChildren(): void
    {
        $a = WorkflowGraphAnalyzer::analyzeGraph($this->diamond());
        sort($a['parents']['4']);
        $this->assertSame(['2', '3'], $a['parents']['4']);
        sort($a['children']['1']);
        $this->assertSame(['2', '3'], $a['children']['1']);
    }

    public function testStartNodeAndOrderGuarantees(): void
    {
        $a = WorkflowGraphAnalyzer::analyzeGraph($this->diamond());
        $this->assertSame('1', $a['startNodeId']);
        $this->assertContains('1', $a['order']);
        $this->assertContainsOnly('string', $a['order']);
    }

    public function testCycleThrowsRuntimeException(): void
    {
        $this->expectException(\RuntimeException::class);
        WorkflowGraphAnalyzer::analyzeGraph([
            'nodes' => [
                ['id' => '1', 'type' => 'agent'],
                ['id' => '2', 'type' => 'agent'],
            ],
            'edges' => [
                ['from' => '1', 'to' => '2'],
                ['from' => '2', 'to' => '1'],
            ],
        ]);
    }

    public function testAgentSurfacesBoundSkillDir(): void
    {
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent', 'config' => [
                    'type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'do it',
                    'provider' => 'claude', 'model' => 'm', 'selectedTools' => [],
                    'bound_skill' => ['id' => null, 'source' => 'local', 'dir_name' => 'GEO/geo-report', 'name' => 'R'],
                ]],
            ],
            'edges' => [['from' => '1', 'to' => '2']],
        ];
        $a = \AgentTeam\Services\WorkflowGraphAnalyzer::analyzeGraph($graph);
        // analyzeGraph is structural; skills come from the config-aware path. Assert the helper directly:
        $skills = \AgentTeam\Services\WorkflowGraphAnalyzer::skillsFromConfig($graph['nodes'][1]['config']);
        $this->assertSame([['dir' => 'GEO/geo-report']], $skills);
    }

    public function testLegacyInlineSkillContentBecomesInlineEntry(): void
    {
        $cfg = ['type' => 'agent', 'skill_content' => 'legacy instructions'];
        $this->assertSame([['inline' => 'legacy instructions']], \AgentTeam\Services\WorkflowGraphAnalyzer::skillsFromConfig($cfg));
    }

    public function testNoSkillYieldsEmptyList(): void
    {
        $this->assertSame([], \AgentTeam\Services\WorkflowGraphAnalyzer::skillsFromConfig(['type' => 'agent']));
    }

    /** A node left unconnected on the canvas is not part of the workflow. */
    public function testReachableGraphDropsNodesStartDoesNotReach(): void
    {
        $graph = ['nodes' => [
            ['id' => 1, 'node_type' => 'start'], ['id' => 2, 'node_type' => 'agent'],
            ['id' => 3, 'node_type' => 'output'], ['id' => 9, 'node_type' => 'agent'],   // 9: kept on the canvas
        ], 'edges' => [
            ['from_node_id' => 1, 'to_node_id' => 2], ['from_node_id' => 2, 'to_node_id' => 3],
            ['from_node_id' => 9, 'to_node_id' => 3],   // a stray arrow into the flow
        ], 'workflow_id' => 64];

        $out = WorkflowGraphAnalyzer::reachableGraph($graph);

        $this->assertSame([1, 2, 3], array_column($out['nodes'], 'id'));
        $this->assertCount(2, $out['edges'], 'the stray arrow goes with its node');
        $this->assertSame(64, $out['workflow_id']);
        // The trimmed graph analyses without the "disconnected node" error.
        $this->assertSame(['1', '2', '3'], WorkflowGraphAnalyzer::analyzeGraph($out)['order']);
    }

    public function testReachableGraphWithoutAStartIsUnchanged(): void
    {
        $graph = ['nodes' => [['id' => 1, 'node_type' => 'agent']], 'edges' => []];
        $this->assertSame($graph, WorkflowGraphAnalyzer::reachableGraph($graph));
    }
}
