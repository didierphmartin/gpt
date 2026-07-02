<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\ADKGenerator;
use AgentTeam\Services\WorkflowGraphAnalyzer;

class AdkGeneratorEmitTest extends TestCase
{
    protected function analyzed(): array
    {
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start',  'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'You are A', 'provider' => 'claude', 'model' => 'claude-sonnet-4-6', 'selectedTools' => []]],
                ['id' => '3', 'type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3']],
        ];
        $base = WorkflowGraphAnalyzer::analyzeGraph($graph);
        return array_merge($base, [
            'workflow' => ['id' => 7, 'name' => 'demo'],
            'agents' => ['2' => ['name' => 'A', 'systemPrompt' => 'You are A', 'provider' => 'claude', 'model' => 'claude-sonnet-4-6', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []]],
            'usedCatalog' => [], 'usedServers' => [],
            'startPrompt' => 'GO', 'startDocuments' => [],
        ]);
    }

    public function testHeaderAndImports(): void
    {
        $code = ADKGenerator::emitAdk($this->analyzed());
        $this->assertStringContainsString('google-adk', $code);
        $this->assertStringContainsString('from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent', $code);
        $this->assertStringContainsString('from google.adk.models.lite_llm import LiteLlm', $code);
    }
}
