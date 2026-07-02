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

    public function testModelFactoryMapsProviders(): void
    {
        $code = ADKGenerator::emitAdk($this->analyzed());
        $this->assertStringContainsString('def _make_model(provider: str, model: str)', $code);
        // Gemini => bare model string; others => LiteLlm(...)
        $this->assertStringContainsString('return model', $code);          // gemini path
        $this->assertStringContainsString('return LiteLlm(model=', $code); // non-gemini path
    }

    public function testMcpToolBuilderEmitted(): void
    {
        $a = $this->analyzed();
        $a['usedServers'] = ['srv1' => ['url' => 'http://localhost:9000/mcp']];
        $a['usedCatalog'] = ['search' => ['server' => 'srv1', 'description' => 'Search', 'input_schema' => ['type' => 'object', 'properties' => []]]];
        $code = ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('MCP_SERVERS = {', $code);
        $this->assertStringContainsString('TOOL_CATALOG = {', $code);
        $this->assertStringContainsString('def _call_mcp_tool(', $code);
        $this->assertStringContainsString('def build_tools_from_catalog()', $code);
        $this->assertStringContainsString('FunctionTool(', $code);
        $this->assertStringContainsString('http://localhost:9000/mcp', $code);
    }

    public function testSkillRunnerEmittedAndAsyncSafe(): void
    {
        $a = $this->analyzed();
        $a['agents']['2']['skill_content'] = "Use the skill: call run_skill_script with dir_name='html/create'";
        $code = ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('SKILLS_DIR', $code);
        $this->assertStringContainsString('def _run_skill_script(', $code);
        $this->assertStringContainsString('asyncio.create_subprocess_exec', $code); // async-safe entry
        $this->assertStringContainsString('RUN_SKILL_SCRIPT_TOOL = FunctionTool(', $code);
    }

    public function testSkillRunnerOmittedWhenNoSkills(): void
    {
        $code = ADKGenerator::emitAdk($this->analyzed());
        $this->assertStringNotContainsString('_run_skill_script', $code);
        $this->assertStringNotContainsString('RUN_SKILL_SCRIPT_TOOL', $code);
    }

    public function testAgentEmittedWithOutputKeyAndParentInjection(): void
    {
        $a = $this->analyzed();
        $code = ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('node_2 = LlmAgent(', $code);
        $this->assertStringContainsString('output_key="node_2"', $code);
        $this->assertStringContainsString('model=_make_model("claude", "claude-sonnet-4-6")', $code);
        $this->assertStringContainsString('You are A', $code);
    }

    public function testGenerateContentConfigTyped(): void
    {
        // With temperature + max_tokens set → typed GenerateContentConfig emitted
        $a = $this->analyzed();
        $a['agents']['2']['temperature'] = 0.7;
        $a['agents']['2']['max_tokens']  = 1024;
        $code = ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('types.GenerateContentConfig(', $code);
        $this->assertStringContainsString('temperature=0.7', $code);
        $this->assertStringContainsString('max_output_tokens=1024', $code);

        // With both null → no generate_content_config key at all
        $code2 = ADKGenerator::emitAdk($this->analyzed());
        $this->assertStringNotContainsString('generate_content_config', $code2);
    }

    public function testRunSkillScriptToolInAgentToolsList(): void
    {
        $a = $this->analyzed();
        $a['agents']['2']['skill_content'] = "Use the skill: call run_skill_script with dir_name='html/create'";
        $code = ADKGenerator::emitAdk($a);
        // The LlmAgent block for node_2 must include RUN_SKILL_SCRIPT_TOOL in its tools list
        $this->assertStringContainsString('node_2 = LlmAgent(', $code);
        $this->assertStringContainsString('RUN_SKILL_SCRIPT_TOOL', $code);
        // Confirm it's inside the tools=[...] assignment for node_2
        $agentBlock = substr($code, strpos($code, 'node_2 = LlmAgent('));
        $this->assertStringContainsString('RUN_SKILL_SCRIPT_TOOL', $agentBlock);
    }

    public function testRootLayeringAndMain(): void
    {
        // diamond -> layer 1 has two agents -> ParallelAgent
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start',  'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
                ['id' => '3', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'B', 'systemPrompt' => 'B', 'provider' => 'gemini', 'model' => 'g', 'selectedTools' => []]],
                ['id' => '4', 'type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '1', 'to' => '3'], ['from' => '2', 'to' => '4'], ['from' => '3', 'to' => '4']],
        ];
        $base = \AgentTeam\Services\WorkflowGraphAnalyzer::analyzeGraph($graph);
        $a = array_merge($base, [
            'workflow' => ['id' => 1, 'name' => 'w'], 'usedCatalog' => [], 'usedServers' => [],
            'startPrompt' => 'GO', 'startDocuments' => [],
            'agents' => [
                '2' => ['name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
                '3' => ['name' => 'B', 'systemPrompt' => 'B', 'provider' => 'gemini', 'model' => 'g', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
            ],
        ]);
        $code = ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('ParallelAgent(', $code);
        $this->assertStringContainsString('root_agent = SequentialAgent(', $code);
        $this->assertStringContainsString('node_4', $code);            // output consolidator
        $this->assertStringContainsString('async def main(', $code);
        $this->assertStringContainsString('Runner(', $code);
    }

    public function testParentOutputsInjectedIntoInstruction(): void
    {
        // node 3 (output) is child of 2; a downstream agent reading node 2 must see {node_2}
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent', 'config' => ['type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
                ['id' => '3', 'type' => 'agent', 'config' => ['type' => 'agent', 'agent_name' => 'B', 'systemPrompt' => 'B reads A', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3']],
        ];
        $base = \AgentTeam\Services\WorkflowGraphAnalyzer::analyzeGraph($graph);
        $a = array_merge($base, [
            'workflow' => ['id' => 1, 'name' => 'w'], 'usedCatalog' => [], 'usedServers' => [],
            'startPrompt' => 'GO', 'startDocuments' => [],
            'agents' => [
                '2' => ['name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
                '3' => ['name' => 'B', 'systemPrompt' => 'B reads A', 'provider' => 'claude', 'model' => 'm', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
            ],
        ]);
        $code = ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('{node_2}', $code); // node 3 instruction injects parent 2
    }
}
