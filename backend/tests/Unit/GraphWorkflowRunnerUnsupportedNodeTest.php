<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\GraphWorkflowRunner;
use PHPUnit\Framework\TestCase;

final class GraphWorkflowRunnerUnsupportedNodeTest extends TestCase
{
    public function testCodeAndPlaybookNodesAreRefusedWithAReason(): void
    {
        self::assertStringContainsString('compiled', GraphWorkflowRunner::unsupportedNodeMessage('code'));
        self::assertStringContainsString('Playbook', GraphWorkflowRunner::unsupportedNodeMessage('playbook'));
        self::assertNull(GraphWorkflowRunner::unsupportedNodeMessage('agent'));
    }
}
