<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Models\Workflow;
use AgentTeam\Services\ADKGenerator;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\MAFGenerator;
use AgentTeam\Services\NOOAGenerator;
use AgentTeam\Services\WorkflowGraphAnalyzer;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;

/**
 * Every compile target documents the generated script the same way, for any
 * workflow shape: PROVENANCE, GRAPH NODES, GRAPH EDGES, EXECUTION ORDER,
 * DATA FLOW, TO RUN in the module docstring, and a uniform comment block
 * before each node definition. Also pins the analyzer fix that made
 * editor-saved agent nodes (DB node_type '') vanish from ADK/MAF/NOOA.
 */
class GeneratedDocParityTest extends TestCase
{
    private const PLAYBOOK = "Title: Time Off\n\nTrigger: PTO.\n\nInstructions:\n1. #Get PTO Balance for the requester.\n2. #Request Approval from the manager then #Resolve Request.\n\nTools used: Workday\n\nActions used: #Get PTO Balance; #Request Approval; #Resolve Request\n";

    /** The Dispatcher-demo shape, with the '' node_type the editor really saves. */
    private function graph(): array
    {
        $agent = fn(string $name, string $type = 'standard') => [
            'type' => 'agent-template', 'agent_name' => $name, 'agent_type' => $type,
            'instructions' => "You are {$name}.", 'agent_provider' => 'claude', 'model' => 'claude-sonnet-4-5',
            'tools' => [], 'settings' => ['temperature' => 0.7, 'max_tokens' => 4096],
        ];
        return [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'I want to take some vacations']],
                ['id' => '2', 'node_type' => '', 'config' => $agent('techBuddy', 'dispatcher')],
                ['id' => '3', 'node_type' => '', 'config' => $agent('IT claims')],
                ['id' => '4', 'node_type' => '', 'config' => $agent('Human resources')],
                ['id' => '5', 'node_type' => 'playbook', 'config' => ['type' => 'playbook', 'name' => 'Playbook HR',
                    'playbook' => self::PLAYBOOK, 'agent_provider' => 'deepseek', 'model' => 'deepseek-v4-flash', 'writes_enabled' => true]],
                ['id' => '6', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [
                ['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3'], ['from' => '2', 'to' => '4'],
                ['from' => '3', 'to' => '6'], ['from' => '4', 'to' => '5'], ['from' => '5', 'to' => '6'],
            ],
        ];
    }

    private function pdo(): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (85, '3', 'Workday', 'http://localhost/mockstack/index.php/workday', 1)");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 85, 'get_pto_balance', 'Get balances', '{\"type\":\"object\",\"properties\":{\"email\":{\"type\":\"string\"}}}')");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)");
        return $pdo;
    }

    /** @return array<string,string> target => generated code */
    private function generateAll(): array
    {
        $pdo = $this->pdo();
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Dispatcher demo', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($this->graph());
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        $out = [];
        foreach (['LangGraph' => LangGraphGenerator::class, 'ADK' => ADKGenerator::class,
                  'MAF' => MAFGenerator::class, 'NOOA' => NOOAGenerator::class] as $label => $cls) {
            $out[$label] = (new $cls($pdo, $wfRepo, $graphRepo, $agentRepo))->generate(44, '3')['code'];
        }
        return $out;
    }

    public function testAnalyzerReadsEmptyNodeTypeFromConfig(): void
    {
        $this->assertSame('agent-template', WorkflowGraphAnalyzer::typeOf(['node_type' => '', 'config' => ['type' => 'agent-template']]));
        $this->assertSame('playbook', WorkflowGraphAnalyzer::typeOf(['node_type' => 'playbook', 'config' => ['type' => 'agent']]));
        $this->assertSame('agent', WorkflowGraphAnalyzer::typeOf(['config' => []]));
    }

    public function testEveryTargetCarriesTheSameDocumentationSections(): void
    {
        foreach ($this->generateAll() as $target => $code) {
            $doc = substr($code, 0, strpos($code, '"""', 3));
            foreach (['PROVENANCE', 'GRAPH NODES', 'GRAPH EDGES', 'EXECUTION ORDER', 'DATA FLOW', 'TO RUN',
                      'Workflow:   Dispatcher demo (id 44)', 'This file is a frozen snapshot',
                      'techBuddy -- claude/claude-sonnet-4-5, temp 0.7, max_tokens 4096, 0 tool(s), DISPATCHER -> one of: IT claims | Human resources',
                      'Start (1) -> techBuddy (2)', 'techBuddy (2) -> IT claims (3)   (dispatcher menu:',
                      'layer 2:  IT claims  ||  Human resources',
                      'ANTHROPIC_API_KEY (claude)', 'Output storage (Output node setting): OFF'] as $needle) {
                $this->assertStringContainsString($needle, $doc, "{$target}: docstring lacks {$needle}");
            }
            $this->assertMatchesRegularExpression('/Generated:  \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ by the SynergyAI workflow editor/', $doc, $target);
            // Uniform per-node comment block before every agent definition.
            $this->assertStringContainsString('# ---- node 2: techBuddy (agent-template) ', $code, $target);
            $this->assertStringContainsString('#   provider/model : claude / claude-sonnet-4-5   temp 0.7   max_tokens 4096   thinking default', $code, $target);
            $this->assertStringContainsString('#   dispatcher     : routes to one of: IT claims | Human resources', $code, $target);
            $this->assertStringContainsString('#   children       : IT claims (3) | Human resources (4)', $code, $target);
            $this->assertStringContainsString('#   parents        : techBuddy (2)', $code, $target);
        }
    }

    public function testAgentsWithEmptyDbNodeTypeCompileOnEveryTarget(): void
    {
        foreach ($this->generateAll() as $target => $code) {
            $this->assertStringContainsString('You are Human resources.', $code, "{$target} lost the agent node");
        }
    }

    public function testPlaybookAndDispatcherSupportIsStatedHonestly(): void
    {
        $all = $this->generateAll();
        $lg = $all['LangGraph'];
        $this->assertStringContainsString('playbook "Time Off", 1 bound / 0 unbound action(s), writes ON', $lg);
        $this->assertStringContainsString('(dispatcher: only the chosen one runs)', $lg);
        $this->assertStringContainsString('PLAYBOOK_GATE_MODE', $lg);
        $this->assertStringContainsString('DEEPSEEK_API_KEY (deepseek)', $lg);
        foreach (['ADK', 'MAF', 'NOOA'] as $t) {
            $code = $all[$t];
            $this->assertStringContainsString('NOT RUN BY THIS TARGET (playbook nodes are not supported here', $code, $t);
            $this->assertStringContainsString('menu NOT honoured by this target: all children run', $code, $t);
            $this->assertStringContainsString('(run in PARALLEL -- dispatcher menu not honoured by this target)', $code, $t);
            $this->assertStringNotContainsString('PLAYBOOK_GATE_MODE', $code, $t);
            $doc = substr($code, 0, strpos($code, '"""', 3));
            $this->assertStringNotContainsString('DEEPSEEK_API_KEY', $doc, "{$t}: an unsupported node's provider key must not be listed");
        }
    }

    public function testEveryTargetStillEmitsValidPython(): void
    {
        foreach ($this->generateAll() as $target => $code) {
            $tmp = tempnam(sys_get_temp_dir(), 'gen') . '.py';
            file_put_contents($tmp, $code);
            exec('python3 -m py_compile ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
            @unlink($tmp);
            $this->assertSame(0, $rc, "{$target}: " . implode("\n", $out));
        }
    }
}
