<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\GraphWorkflowRunner;
use PHPUnit\Framework\TestCase;

/**
 * An agent-template node set up on the canvas (a dispatcher with its provider and routing in the node) runs as an
 * inline agent on the server, as it does in the editor's browser run; a template never set up still stops the run.
 */
final class GraphWorkflowRunnerTemplateNodeTest extends TestCase
{
    private static function node(string $type, array $config, $agentId = null): array
    {
        return ['id' => '7', 'node_type' => $type, 'agent_id' => $agentId, 'config' => $config];
    }

    public function testACanvasDispatcherRunsAsAnAgent(): void
    {
        $dispatcher = self::node('agent-template', ['type' => 'agent-template', 'agent_name' => 'email dispatcher',
            'agent_type' => 'dispatcher', 'agent_provider' => 'claude', 'isTemplate' => false,
            'settings' => ['routing_mode' => 'jev', 'unclear_branch' => 'Miscellaneous']]);
        $out = GraphWorkflowRunner::configuredTemplatesAsAgents(['nodes' => [$dispatcher], 'edges' => []]);
        self::assertSame('agent', $out['nodes'][0]['node_type']);
        self::assertSame($dispatcher['config'], $out['nodes'][0]['config']);
    }

    public function testATemplateLinkedToASavedAgentRunsThatAgent(): void
    {
        $out = GraphWorkflowRunner::configuredTemplatesAsAgents(['nodes' => [
            self::node('agent-template', ['type' => 'agent-template', 'agent_id' => 42]),
        ], 'edges' => []]);
        self::assertSame('agent', $out['nodes'][0]['node_type']);
        self::assertSame(42, $out['nodes'][0]['agent_id']);
    }

    public function testAnEmptyColumnFallsBackToTheConfigType(): void
    {
        $out = GraphWorkflowRunner::configuredTemplatesAsAgents(['nodes' => [
            self::node('', ['type' => 'agent-template', 'agent_name' => 'triage', 'instructions' => 'Sort it.']),
        ], 'edges' => []]);
        self::assertSame('agent', $out['nodes'][0]['node_type']);
    }

    public function testATemplateNeverSetUpIsLeftToFail(): void
    {
        $nodes = [
            self::node('agent-template', ['type' => 'agent-template', 'isTemplate' => true, 'agent_name' => 'Agent']),
            self::node('agent-template', ['type' => 'agent-template', 'agent_name' => '', 'instructions' => '']),
        ];
        $out = GraphWorkflowRunner::configuredTemplatesAsAgents(['nodes' => $nodes, 'edges' => []]);
        self::assertSame('agent-template', $out['nodes'][0]['node_type']);
        self::assertSame('agent-template', $out['nodes'][1]['node_type']);
    }

    public function testOtherNodesAndEdgesAreUntouched(): void
    {
        $graph = ['nodes' => [self::node('code', ['type' => 'code', 'agent_name' => 'x']), self::node('output', [])],
            'edges' => [['from_node_id' => '1', 'to_node_id' => '7']]];
        self::assertSame($graph, GraphWorkflowRunner::configuredTemplatesAsAgents($graph));
    }
}
