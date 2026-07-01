<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\WorkflowGraphAnalyzer;

class LangGraphParityTest extends TestCase
{
    public function testTopoOrderMatchesAnalyzer(): void
    {
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start']],
                ['id' => '2', 'type' => 'agent', 'config' => ['type' => 'agent']],
                ['id' => '3', 'type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3']],
        ];
        $a = WorkflowGraphAnalyzer::analyzeGraph($graph);
        $this->assertSame(['1', '2', '3'], $a['order']);
    }
}
