<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\MAFGenerator;

final class MafGeneratorEmitTest extends TestCase
{
    /** Minimal analyzed shape: start -> A(claude) -> output. */
    private function analyzed(): array
    {
        return [
            'workflow' => ['id' => 7, 'name' => 'Demo Flow'],
            'byId' => [
                '1' => ['id' => '1', 'type' => 'start', 'config' => []],
                '2' => ['id' => '2', 'type' => 'agent', 'config' => []],
                '3' => ['id' => '3', 'type' => 'output', 'config' => []],
            ],
            'layers' => [['1'], ['2'], ['3']],
            'parents' => ['2' => ['1'], '3' => ['2']],
            'startNodeId' => '1',
            'agents' => [
                '2' => ['name' => 'A', 'systemPrompt' => 'You are A.', 'provider' => 'claude',
                        'model' => 'claude-sonnet-4-6', 'temperature' => null, 'max_tokens' => null,
                        'tools' => [], 'skill_content' => '', 'skills' => [], 'documents' => []],
            ],
            'usedCatalog' => [], 'usedServers' => [],
            'startPrompt' => 'Analyze example.com', 'startDocuments' => [],
            'outputStorageEnabled' => false, 'outputFolder' => null,
        ];
    }

    public function testHeaderAndImports(): void
    {
        $code = MAFGenerator::emitMaf($this->analyzed());
        $this->assertStringContainsString('from agent_framework import Agent, workflow', $code);
        $this->assertStringContainsString('from agent_framework.anthropic import AnthropicClient', $code);
        $this->assertStringContainsString('from agent_framework.openai import OpenAIChatCompletionClient', $code);
        $this->assertStringContainsString('load_dotenv(', $code);
    }

    public function testClientFactoryUsesChatCompletionAndBaseUrls(): void
    {
        $code = MAFGenerator::emitMaf($this->analyzed());
        $this->assertStringContainsString('def _make_client(provider', $code);
        $this->assertStringContainsString('AnthropicClient(model=model', $code);
        // OpenAI-compatible providers MUST use ChatCompletion, never OpenAIChatClient
        $this->assertStringContainsString('OpenAIChatCompletionClient(model=model', $code);
        $this->assertStringNotContainsString('OpenAIChatClient(', $code);
        $this->assertStringContainsString('https://api.x.ai/v1', $code);
        $this->assertStringContainsString('https://generativelanguage.googleapis.com/v1beta/openai/', $code);
    }

    public function testAgentsAndOrchestrationEmitted(): void
    {
        $code = MAFGenerator::emitMaf($this->analyzed());
        $this->assertStringContainsString('AGENTS = {', $code);
        $this->assertStringContainsString('"2": {', $code);            // agent node baked
        $this->assertStringContainsString('async def _run_node(', $code);
        $this->assertStringContainsString('Agent(client, instructions=', $code);
        $this->assertStringContainsString('.run(', $code);
        $this->assertStringContainsString('@workflow', $code);
        $this->assertStringContainsString('async def main(user_prompt', $code);
        $this->assertStringContainsString('asyncio.gather(', $code);
        $this->assertStringContainsString('OUTPUT_NODE_ID = "3"', $code);
        $this->assertStringContainsString('asyncio.run(main.run(', $code);
    }

    public function testStartPromptAndStorageBaked(): void
    {
        $a = $this->analyzed();
        $a['outputStorageEnabled'] = true; $a['outputFolder'] = null;
        $code = MAFGenerator::emitMaf($a);
        $this->assertStringContainsString('Analyze example.com', $code);      // start prompt baked
        $this->assertStringContainsString('OUTPUT_STORAGE_ENABLED = True', $code);
        $this->assertStringContainsString('WORKFLOW_ID = 7', $code);
    }

    public function testSkillRuntimeEmittedWhenSkillPresent(): void
    {
        $a = $this->analyzed();
        $a['agents']['2']['skills'] = [['dir' => 'html']];
        $code = MAFGenerator::emitMaf($a);
        $this->assertStringContainsString('_LAST_SKILL_OUTPUTS', $code);
        $this->assertStringContainsString('def _run_skill_script(', $code);
        $this->assertStringContainsString('SYNERGYAI_OUTPUT_DIR', $code);
        $this->assertStringContainsString('async def _run_skill_step(', $code);
        $this->assertStringContainsString('_make_skill_tool', $code);
        // baked into AGENTS — jsonToPython pretty-prints, so match the dir key
        $this->assertStringContainsString('"dir": "html"', $code);
    }

    public function testNoSkillRuntimeWhenNoSkills(): void
    {
        $code = MAFGenerator::emitMaf($this->analyzed());  // no skills
        $this->assertStringNotContainsString('def _run_skill_script(', $code);
    }
}
