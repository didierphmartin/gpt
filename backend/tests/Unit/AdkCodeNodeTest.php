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
        self::assertStringContainsString('MCP_HEADERS_OUTLOOK in .env is not valid JSON', $out);
    }

    public function testUrlOverrideFromEnv(): void
    {
        $code = ADKGenerator::emitAdk(self::mcpAnalyzed());
        [$rc, $out] = self::runPy($code, 'print(_mcp_live_url("http://localhost:8770"))', ['MCP_URL_OUTLOOK' => 'http://h:1']);
        self::assertSame(0, $rc, $out);
        self::assertSame('http://h:1', trim($out));
    }
}
