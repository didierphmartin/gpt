<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;

/** LangGraph compiler: code nodes (single file + modular), refused by other packagings. */
class LangGraphGeneratorCodeNodeTest extends TestCase
{
    private function pdo(): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (85, '3', 'ServiceNow', 'http://localhost/servicenow/?profile=mock&toolset=jobs', 1)");
        $pdo->exec("INSERT INTO mcp_servers VALUES (9, NULL, 'Global News', 'http://localhost/news/', 1)");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 85, 'poll_jobs', 'Poll', '{}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (3, 9, 'get_news', 'News', '{}')");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('deepseek', 'deepseek-v4-flash', 1)");
        return $pdo;
    }

    private function generate(array $graph, ?string $userId = '3'): string
    {
        return $this->generateWith($graph, [], $userId)['code'];
    }

    private function generateWith(array $graph, array $options, ?string $userId = '3'): array
    {
        $pdo = $this->pdo();
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Dispatcher demo', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph);
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        $gen = new LangGraphGenerator($pdo, $wfRepo, $graphRepo, $agentRepo);
        return $gen->generate(44, $userId, $options);
    }

    private function codeGraph(): array
    {
        return [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'poll']],
                ['id' => '2', 'node_type' => 'code', 'config' => ['type' => 'code', 'name' => 'Poll ServiceNow',
                    'code' => "def run(input, call_tool):\n    r = call_tool('servicenow', 'poll_jobs', {})\n    if r.get('job') is None:\n        return {'route': 'no_job', 'output': None}\n    return {'route': 'job', 'output': r['job']}\n",
                    'exits' => ['job', 'no_job'], 'mcp_tools' => ['servicenow.poll_jobs'], 'timeout_s' => 30]],
                ['id' => '3', 'node_type' => 'output', 'config' => ['type' => 'output']],
                ['id' => '4', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [
                ['from' => '1', 'to' => '2', 'from_port' => 'output_1'],
                ['from' => '2', 'to' => '3', 'from_port' => 'output_1'],
                ['from' => '2', 'to' => '4', 'from_port' => 'output_2'],
            ],
        ];
    }

    public function testSingleFileBakesTheCodeNode(): void
    {
        $code = $this->generate($this->codeGraph());
        self::assertStringContainsString('CODE_NODES = {', $code);
        self::assertStringContainsString('"exit_targets": {"job":["3"],"no_job":["4"]}', $code);
        self::assertMatchesRegularExpression('~MCP_SLUGS = \{\s*"servicenow": "http://localhost/servicenow/\?profile=mock&toolset=jobs"\s*\}~', $code);
        self::assertStringContainsString('class CodeNode(Node):', $code);
        self::assertStringContainsString('CODE_HARNESS = types.ModuleType("code_node_harness")', $code);
        self::assertStringContainsString('"2": "code"', $code);
        self::assertStringContainsString('{**AGENTS, **PLAYBOOKS, **CODE_NODES}', $code);
        // the code node is documented like an agent: a comment block before its entry, with its declared tool
        self::assertMatchesRegularExpression('~CODE_NODES = \{\n    # ---- node 2: Poll ServiceNow \(code\) -+\n    #   tools          : servicenow\.poll_jobs\n(    #[^\n]*\n)*    "2": \{~', $code);
        $file = tempnam(sys_get_temp_dir(), 'lgcn') . '.py';
        file_put_contents($file, $code);
        exec('python3 -m py_compile ' . escapeshellarg($file) . ' 2>&1', $out, $rc);
        self::assertSame(0, $rc, implode("\n", $out));
    }

    public function testWorkflowsWithoutCodeNodesAreUnchanged(): void
    {
        $graph = ['nodes' => [$this->codeGraph()['nodes'][0], $this->codeGraph()['nodes'][2]],
                  'edges' => [['from' => '1', 'to' => '3', 'from_port' => 'output_1']]];
        $code = $this->generate($graph);
        self::assertStringNotContainsString('CODE_HARNESS', $code);
        self::assertStringNotContainsString('class CodeNode', $code);
    }

    public function testUnsupportedPackagingsRefuse(): void
    {
        foreach ([['a2a' => true]] as $opts) {
            try {
                $this->generateWith($this->codeGraph(), $opts);
                self::fail('A2A accepted a code node');
            } catch (\RuntimeException $e) {
                self::assertStringContainsString('Code nodes are not supported by the A2A', $e->getMessage());
            }
        }
    }

    public function testModularBakesACodeModule(): void
    {
        $files = $this->generateWith($this->codeGraph(), ['modular' => true])['files'];
        $byPath = array_column($files, 'code', 'path');
        $module = $byPath['agents/poll_servicenow.py'] ?? '';
        self::assertStringContainsString('"kind": "code"', $module);
        self::assertStringContainsString('run_node = make_node(NODE).run', $module);
        self::assertStringContainsString('class CodeNode(Node):', $byPath['common.py']);
        self::assertStringContainsString('MCP_SLUGS = ', $byPath['common.py']);
        self::assertStringContainsString('"exit_targets": {"job":["3"],"no_job":["4"]}', $byPath['workflow.py']);
    }

    public function testADispatchersCodeChildIsOnItsMenu(): void
    {
        // A code child of a dispatcher runs only when the dispatcher picks it (as in the editor).
        $g = $this->codeGraph();
        $g['nodes'][] = ['id' => '9', 'node_type' => '', 'config' => ['type' => 'agent-template', 'agent_name' => 'Front desk',
            'agent_type' => 'dispatcher', 'instructions' => 'Route.', 'agent_provider' => 'claude', 'model' => 'claude-sonnet-4-6',
            'tools' => [], 'settings' => ['temperature' => 0.7, 'max_tokens' => 4096]]];
        $g['edges'] = [['from' => '1', 'to' => '9', 'from_port' => 'output_1'], ['from' => '9', 'to' => '2', 'from_port' => 'output_1'],
                       ['from' => '2', 'to' => '3', 'from_port' => 'output_1'], ['from' => '2', 'to' => '4', 'from_port' => 'output_2']];
        $code = $this->generate($g);
        self::assertStringContainsString('"dispatch": [{"id": "2", "name": "Poll ServiceNow", "description": ""}]', $code);
        $byPath = array_column($this->generateWith($g, ['modular' => true])['files'], 'code', 'path');
        self::assertStringContainsString('"dispatch": [{"id":"2","name":"Poll ServiceNow"}]', $byPath['workflow.py']);
    }
}
