<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\NOOAGenerator;

final class NooaGeneratorEmitTest extends TestCase
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

    /** Diamond: start -> (A || B) -> C -> output. */
    private function diamond(): array
    {
        return [
            'workflow' => ['id' => 9, 'name' => 'Diamond'],
            'byId' => [
                '1' => ['id'=>'1','type'=>'start','config'=>[]],
                '2' => ['id'=>'2','type'=>'agent','config'=>[]],
                '3' => ['id'=>'3','type'=>'agent','config'=>[]],
                '4' => ['id'=>'4','type'=>'agent','config'=>[]],
                '5' => ['id'=>'5','type'=>'output','config'=>[]],
            ],
            'layers' => [['1'], ['2','3'], ['4'], ['5']],
            'parents' => ['2'=>['1'],'3'=>['1'],'4'=>['2','3'],'5'=>['4']],
            'startNodeId' => '1',
            'agents' => [
                '2'=>['name'=>'A','systemPrompt'=>'A','provider'=>'claude','model'=>'m','temperature'=>null,'max_tokens'=>null,'tools'=>[],'skill_content'=>'','skills'=>[],'documents'=>[]],
                '3'=>['name'=>'B','systemPrompt'=>'B','provider'=>'openai','model'=>'gpt-4o','temperature'=>null,'max_tokens'=>null,'tools'=>[],'skill_content'=>'','skills'=>[],'documents'=>[]],
                '4'=>['name'=>'C','systemPrompt'=>'C','provider'=>'gemini','model'=>'gemini-2.5-flash','temperature'=>null,'max_tokens'=>null,'tools'=>[],'skill_content'=>'','skills'=>[],'documents'=>[]],
            ],
            'usedCatalog'=>[], 'usedServers'=>[], 'startPrompt'=>'go', 'startDocuments'=>[],
            'outputStorageEnabled'=>true, 'outputFolder'=>null,
        ];
    }

    public function testHeaderImportsAndFactory(): void
    {
        $code = NOOAGenerator::emitNooa($this->analyzed());
        $this->assertStringContainsString('from nooa import Agent', $code);
        $this->assertStringContainsString('from nooa.unifiedllm.registry import get_llm_client', $code);
        $this->assertStringContainsString('def make_llm(provider', $code);
        $this->assertStringContainsString('load_dotenv(', $code);
        // Provider table parity with the MAF backend.
        $this->assertStringContainsString('https://api.x.ai/v1', $code);
        $this->assertStringContainsString('https://generativelanguage.googleapis.com/v1beta/openai/', $code);
        $this->assertStringContainsString('https://api.moonshot.ai/v1', $code);
    }

    public function testNodeClassEmitted(): void
    {
        $code = NOOAGenerator::emitNooa($this->analyzed());
        $this->assertStringContainsString('class A(Agent, llm=make_llm("claude", "claude-sonnet-4-6"', $code);
        $this->assertStringContainsString('"You are A."', $code);          // docstring = system prompt
        $this->assertStringContainsString('async def respond(self, prompt: str) -> str:', $code);
        $this->assertStringContainsString('AGENTS = {', $code);
        $this->assertStringContainsString('async def run_agent(', $code);
        $this->assertStringContainsString('Original user request:', $code);
    }

    public function testDriverAndGlobals(): void
    {
        $code = NOOAGenerator::emitNooa($this->analyzed());
        $this->assertStringContainsString('async def main(', $code);
        $this->assertStringContainsString('DEFAULT_PROMPT = "Analyze example.com"', $code);
        $this->assertStringContainsString('WORKFLOW_ID = 7', $code);
        $this->assertStringContainsString('OUTPUT_STORAGE_ENABLED = False', $code);
        $this->assertStringContainsString('asyncio.run(main(', $code);
        // Linear graph: no parallel layer, no gather.
        $this->assertStringNotContainsString('asyncio.gather(', $code);
        // No MCP, no skills in this fixture.
        $this->assertStringNotContainsString('MCPManager', $code);
        $this->assertStringNotContainsString('_run_skill_script', $code);
    }

    public function testDiamondParallelLayer(): void
    {
        $code = NOOAGenerator::emitNooa($this->diamond());
        $this->assertStringContainsString('asyncio.gather(', $code);
        $this->assertStringContainsString('run_agent("2"', $code);
        $this->assertStringContainsString('run_agent("3"', $code);
        $this->assertStringContainsString('OUTPUT_STORAGE_ENABLED = True', $code);
        $this->assertStringContainsString('WORKFLOW_ID = 9', $code);
    }
}
