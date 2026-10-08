<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\GraphWorkflowRunner;
use PHPUnit\Framework\TestCase;

final class GraphWorkflowRunnerUnsupportedNodeTest extends TestCase
{
    public function testCodeNodesRunUnlessSwitchedOff(): void
    {
        self::assertNull(GraphWorkflowRunner::unsupportedNodeMessage('code'));
        self::assertStringContainsString('CODE_NODES_SERVER_SIDE',
            GraphWorkflowRunner::unsupportedNodeMessage('code', ['code_nodes' => ['server_side' => false]]));
        self::assertStringContainsString('Playbook', GraphWorkflowRunner::unsupportedNodeMessage('playbook'));
        self::assertNull(GraphWorkflowRunner::unsupportedNodeMessage('agent'));
    }
}
