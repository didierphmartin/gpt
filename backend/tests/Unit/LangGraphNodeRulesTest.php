<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;
use PHPUnit\Framework\TestCase;

/** spec 2026-10-15 langgraph standalone §7. */
final class LangGraphNodeRulesTest extends TestCase
{
    private function generate(array $mid): array
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)");
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Rules', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn(['nodes' => [
            ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'hi']], $mid,
            ['id' => '3', 'node_type' => 'output', 'config' => ['type' => 'output']]],
            'edges' => [['from_node_id' => '1', 'to_node_id' => '2', 'from_port' => 'output_1'],
                        ['from_node_id' => '2', 'to_node_id' => '3', 'from_port' => 'output_1']]]);
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        return (new LangGraphGenerator($pdo, $wfRepo, $graphRepo, $agentRepo))->generate(44, '3', []);
    }

    public function testUnconfiguredTemplateIsRefused(): void
    {
        $this->expectExceptionMessage('Unconfigured agent template node found: Claims — pick an agent or fill in its instructions.');
        $this->generate(['id' => '2', 'node_type' => 'agent-template', 'config' => ['type' => 'agent-template', 'name' => 'Claims', 'isTemplate' => true]]);
    }

    public function testConfiguredTemplateCompilesAsAgent(): void
    {
        $code = $this->generate(['id' => '2', 'node_type' => 'agent-template', 'config' => ['type' => 'agent-template', 'name' => 'Claims',
            'agent_name' => 'Claims', 'instructions' => 'Summarize the claim.', 'provider' => 'claude']])['code'];
        self::assertStringContainsString('Summarize the claim.', $code);
    }

    public function testUnknownTypeIsRefused(): void
    {
        $this->expectExceptionMessage('Node "Loop" (loop) cannot be compiled: LangGraph runs start, agent, playbook, code and output nodes.');
        $this->generate(['id' => '2', 'node_type' => 'loop', 'config' => ['type' => 'loop', 'name' => 'Loop']]);
    }
}
