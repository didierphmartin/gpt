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
}
