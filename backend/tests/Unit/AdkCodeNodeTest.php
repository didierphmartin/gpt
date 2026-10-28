<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\ADKGenerator;
use AgentTeam\Services\WorkflowGraphAnalyzer;

class AdkCodeNodeTest extends TestCase
{
    /** Start -> agent A (one MCP tool on server "Outlook") -> Output. */
    public static function mcpAnalyzed(): array
    {
        $graph = ['nodes' => [
            ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'GO']],
            ['id' => '2', 'type' => 'agent', 'config' => ['type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'A',
                'provider' => 'claude', 'model' => 'm', 'selectedTools' => ['list_mail']]],
            ['id' => '3', 'type' => 'output', 'config' => ['type' => 'output']],
        ], 'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3']]];
        return array_merge(WorkflowGraphAnalyzer::analyzeGraph($graph), [
            'workflow' => ['id' => 7, 'name' => 'mcp'], 'generated_at' => '2026-01-01 00:00:00 UTC',
            'usedCatalog' => ['list_mail' => ['server_url' => 'http://localhost:8770', 'description' => 'List',
                'input_schema' => ['type' => 'object', 'properties' => []]]],
            'usedServers' => ['http://localhost:8770' => ['name' => 'Outlook']],
            'serverSlugs' => ['http://localhost:8770' => 'outlook'],
            'startPrompt' => 'GO', 'startDocuments' => [],
            'agents' => ['2' => ['name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm',
                'temperature' => null, 'max_tokens' => null, 'tools' => ['list_mail'], 'skill_content' => '',
                'output_schema_id' => null, 'documents' => []]],
        ]);
    }

    public function testMcpClientBakesSlugsAndReadsHeadersFromEnv(): void
    {
        $code = ADKGenerator::emitAdk(self::mcpAnalyzed());
        self::assertStringContainsString("MCP_SERVER_SLUGS = {\n    \"http://localhost:8770\": \"outlook\"", $code);
        self::assertStringContainsString('MCP_SLUGS = {v: k for k, v in MCP_SERVER_SLUGS.items()}', $code);
        self::assertStringContainsString('var = f"MCP_HEADERS_{slug.upper()}"', $code);
        self::assertStringContainsString('def _call_mcp_tool_raw(server_url: str, tool_name: str, arguments: dict) -> dict:', $code);
        // ADK no longer emits the shared client
        self::assertStringNotContainsString('def _init_mcp_session(url: str, headers: dict)', $code);
    }

    public function testDotenvLookupCoversSingleFileAndPackage(): void
    {
        $code = ADKGenerator::emitAdk(self::mcpAnalyzed());
        self::assertStringContainsString('for _d in (_HERE, os.path.dirname(_HERE), os.path.dirname(os.path.dirname(_HERE))):', $code);
    }

    /** Runs a snippet against the emitted module's MCP helpers (no network). */
    private static function runPy(string $code, string $snippet, array $env = []): array
    {
        $dir = sys_get_temp_dir() . '/adkcn_' . bin2hex(random_bytes(4));
        mkdir($dir);
        // Only the MCP CLIENT section: from its banner to the next banner.
        $start = strpos($code, 'MCP_SERVER_SLUGS = ');
        $end = strpos($code, '# =====', $start);
        file_put_contents("$dir/m.py", "import json, os, time\nimport httpx\n" . substr($code, $start, $end - $start) . "\n" . $snippet);
        $envStr = '';
        foreach ($env as $k => $v) { $envStr .= $k . '=' . escapeshellarg($v) . ' '; }
        exec("cd " . escapeshellarg($dir) . " && env {$envStr}python3 m.py 2>&1", $out, $rc);
        return [$rc, implode("\n", $out)];
    }

    public function testHeadersMergeAndBadJsonNamesTheVariable(): void
    {
        $code = ADKGenerator::emitAdk(self::mcpAnalyzed());
        [$rc, $out] = self::runPy($code, 'print(_mcp_headers("http://localhost:8770")["X-Outlook-Account"])',
            ['MCP_HEADERS_OUTLOOK' => '{"X-Outlook-Account":"acc-1"}']);
        self::assertSame(0, $rc, $out);
        self::assertSame('acc-1', trim($out));
        [$rc, $out] = self::runPy($code, '_mcp_headers("http://localhost:8770")', ['MCP_HEADERS_OUTLOOK' => '{oops']);
        self::assertNotSame(0, $rc);
        self::assertStringContainsString('Environment variable MCP_HEADERS_OUTLOOK is not valid JSON', $out);
    }

    public function testUrlOverrideFromEnv(): void
    {
        $code = ADKGenerator::emitAdk(self::mcpAnalyzed());
        [$rc, $out] = self::runPy($code, 'print(_mcp_live_url("http://localhost:8770"))', ['MCP_URL_OUTLOOK' => 'http://h:1']);
        self::assertSame(0, $rc, $out);
        self::assertSame('http://h:1', trim($out));
    }

    /** Start -> code C (exits next, server Outlook) -> Output. */
    public static function codeAnalyzed(string $src = "def run(input, call_tool):\n    return {'output': {'got': input}}\n"): array
    {
        $graph = ['nodes' => [
            ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'GO']],
            ['id' => '2', 'type' => 'code', 'config' => ['type' => 'code', 'name' => 'C', 'code' => $src,
                'exits' => ['next'], 'mcp_servers' => ['Outlook'], 'timeout_s' => 30]],
            ['id' => '3', 'type' => 'output', 'config' => ['type' => 'output']],
        ], 'edges' => [['from' => '1', 'to' => '2', 'from_port' => 'output_1'], ['from' => '2', 'to' => '3', 'from_port' => 'output_1']]];
        $a = array_merge(WorkflowGraphAnalyzer::analyzeGraph($graph), [
            'workflow' => ['id' => 8, 'name' => 'code'], 'generated_at' => '2026-01-01 00:00:00 UTC',
            'usedCatalog' => [], 'usedServers' => [], 'serverSlugs' => ['http://localhost:8770' => 'outlook'],
            'startPrompt' => 'GO', 'startDocuments' => [], 'agents' => [], 'playbooks' => [],
        ]);
        $a['code'] = ['2' => \AgentTeam\Services\CodeNodeEmit::nodeData($graph['nodes'][1], $graph['edges'],
            ['outlook' => 'http://localhost:8770'], ['1', '2', '3'])];
        return $a;
    }

    public function testCodeNodeEmitsCodeAgentWithHarness(): void
    {
        $code = ADKGenerator::emitAdk(self::codeAnalyzed());
        // the single file embeds the editor's harness, as LangGraph's single file does
        self::assertStringContainsString('CODE_HARNESS = types_module.ModuleType("code_node_harness")', $code);
        self::assertStringContainsString('class _CodeAgent(BaseAgent):', $code);
        self::assertStringContainsString('node_2 = _CodeAgent(', $code);
        self::assertStringContainsString('parents=[["user_prompt", "Start", True]]', $code);
        self::assertStringContainsString('node_name=self.display', $code);
        self::assertMatchesRegularExpression('/sub_agents=\[\s*node_2,\s*node_3\s*\]/', $code);
        [$rc, $out] = self::pyCompile($code);
        self::assertSame(0, $rc, $out);
    }

    private static function pyCompile(string $code): array
    {
        $f = sys_get_temp_dir() . '/adkcn_' . bin2hex(random_bytes(4)) . '.py';
        file_put_contents($f, $code);
        exec('python3 -m py_compile ' . escapeshellarg($f) . ' 2>&1', $out, $rc);
        return [$rc, implode("\n", $out)];
    }

    public function testCodeParentsSubstituteDispatcher(): void
    {
        // Start -> code T -> dispatcher D (agent with menu) -> code B
        $graph = ['nodes' => [
            ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start']],
            ['id' => '2', 'type' => 'code', 'config' => ['type' => 'code', 'name' => 'T', 'code' => "def run(input, call_tool):\n    return 1\n", 'exits' => ['next'], 'mcp_servers' => []]],
            ['id' => '3', 'type' => 'agent', 'config' => ['type' => 'agent', 'agent_name' => 'D', 'agent_type' => 'dispatcher']],
            ['id' => '4', 'type' => 'code', 'config' => ['type' => 'code', 'name' => 'B', 'code' => "def run(input, call_tool):\n    return 1\n", 'exits' => ['next'], 'mcp_servers' => []]],
        ], 'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3'], ['from' => '3', 'to' => '4']]];
        $a = WorkflowGraphAnalyzer::analyzeGraph($graph);
        self::assertSame([['user_prompt', 'Start', true]], ADKGenerator::codeParents($a, '2'));
        self::assertSame([['node_2', 'T', false]], ADKGenerator::codeParents($a, '4'));
    }

    /** wf 64's shape: Start -> trigger T (exits new_mail, no_mail) -> dispatcher D -> code A | code B -> Output O. */
    public static function wf64Analyzed(): array
    {
        $code = "def run(input, call_tool):\n    return {'output': input}\n";
        $graph = ['nodes' => [
            ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'GO']],
            ['id' => '10', 'type' => 'code', 'config' => ['type' => 'code', 'name' => 'T', 'code' => "def run(input, call_tool):\n    return {'route': 'new_mail', 'output': {'subject': 'hi'}}\n", 'exits' => ['new_mail', 'no_mail'], 'mcp_servers' => []]],
            ['id' => '2', 'type' => 'agent', 'config' => ['type' => 'agent', 'agent_name' => 'D', 'agent_type' => 'dispatcher', 'provider' => 'claude', 'model' => 'm']],
            ['id' => '3', 'type' => 'code', 'config' => ['type' => 'code', 'name' => 'A', 'code' => $code, 'exits' => ['next'], 'mcp_servers' => []]],
            ['id' => '4', 'type' => 'code', 'config' => ['type' => 'code', 'name' => 'B', 'code' => $code, 'exits' => ['next'], 'mcp_servers' => []]],
            ['id' => '5', 'type' => 'output', 'config' => ['type' => 'output']],
        ], 'edges' => [
            ['from' => '1', 'to' => '10', 'from_port' => 'output_1'],
            ['from' => '10', 'to' => '2', 'from_port' => 'output_1'],
            ['from' => '2', 'to' => '3'], ['from' => '2', 'to' => '4'],
            ['from' => '3', 'to' => '5'], ['from' => '4', 'to' => '5'],
        ]];
        $a = array_merge(WorkflowGraphAnalyzer::analyzeGraph($graph), [
            'workflow' => ['id' => 64, 'name' => 'wf64'], 'generated_at' => '2026-01-01 00:00:00 UTC',
            'usedCatalog' => [], 'usedServers' => [], 'serverSlugs' => [],
            'startPrompt' => 'GO', 'startDocuments' => [], 'playbooks' => [],
            'agents' => ['2' => ['name' => 'D', 'systemPrompt' => 'Route the email.', 'provider' => 'claude', 'model' => 'm',
                'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '',
                'output_schema_id' => null, 'documents' => []]],
        ]);
        $ids = ['1', '10', '2', '3', '4', '5'];
        $byId = array_column($graph['nodes'], null, 'id');
        $a['code'] = [];
        foreach (['10', '3', '4'] as $cid) {
            $a['code'][$cid] = \AgentTeam\Services\CodeNodeEmit::nodeData($byId[$cid], $graph['edges'], [], $ids);
        }
        return $a;
    }

    public function testWf64ShapeRoutesThroughGatesAndNestsCodeInDispatcher(): void
    {
        $code = ADKGenerator::emitAdk(self::wf64Analyzed());
        // dispatcher menu nests the code branches
        self::assertMatchesRegularExpression('/node_2__dispatch = _DispatcherAgent\(.*?sub_agents=\[node_2, node_3, node_4\]/s', $code);
        // dispatcher reads the trigger's output as its task and in its instruction
        self::assertStringContainsString('task_keys=["node_10"]', $code);
        self::assertMatchesRegularExpression('/_agent_instruction\(.*?\["node_10"\]\)/s', $code);
        // the dispatcher runs only on the work exit
        self::assertStringContainsString('_Gate(name="gate_2", when=[["node_10", "route_10", "new_mail"]], sub_agents=[node_2__dispatch])', $code);
        // Output runs when one branch ran
        self::assertStringContainsString('_Gate(name="gate_5", when=[["node_3", "", ""], ["node_4", "", ""]], sub_agents=[node_5])', $code);
        // branch code nodes read the trigger's output, not the dispatcher's text
        self::assertStringContainsString('parents=[["node_10", "T", False]]', $code);
        self::assertSame(0, self::pyCompile($code)[0]);
    }

    public function testUngatedWorkflowUnchanged(): void
    {
        self::assertStringNotContainsString('_Gate(', ADKGenerator::emitAdk(self::mcpAnalyzed()));
    }

    /** The node's argument declarations are compiled in, and its run fills ARGS from the parents' meta. */
    public function testCodeAgentCarriesArgDeclsAndPassesMeta(): void
    {
        $a = self::codeAnalyzed();
        $a['code']['2']['arg_decls'] = [['name' => 'folder', 'required' => true]];
        $code = ADKGenerator::emitAdk($a);
        self::assertStringContainsString('meta=CODE_HARNESS.received_meta(parents)', $code);
        self::assertStringContainsString('arg_decls=self.arg_decls', $code);
        self::assertMatchesRegularExpression('/arg_decls=\[\s*\{\s*"name": "folder",\s*"required": True\s*\}\s*\]/', $code);
        [$rc, $out] = self::pyCompile($code);
        self::assertSame(0, $rc, $out);
    }
}
