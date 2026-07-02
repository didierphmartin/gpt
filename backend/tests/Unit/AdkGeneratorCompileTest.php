<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\ADKGenerator;
use AgentTeam\Services\WorkflowGraphAnalyzer;

/**
 * ADK Generator — py_compile gate + golden fixture
 *
 * Task 10: Ensures emitAdk() always produces syntactically-valid Python.
 * Two fixture variants:
 *  1. Diamond (start → [A‖B] → output) — minimal shape, checked against a
 *     committed golden file so accidental emitter changes surface immediately.
 *  2. Full-featured — skill + MCP tool + temperature/max_tokens + multi-provider
 *     (claude + gemini in the same workflow).  This is the real coverage path.
 *
 * Both tests are skipped gracefully when python3 is not on PATH.
 */
class AdkGeneratorCompileTest extends TestCase
{
    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /**
     * Detect whether python3 is available on PATH.
     * Uses `which` (POSIX) with a shell fallback so it works on macOS + Linux.
     */
    private static function python3Available(): bool
    {
        exec('command -v python3 2>/dev/null', $out, $rc);
        return $rc === 0;
    }

    /** Write $code to a temp file, run py_compile, clean up; return [rc, output]. */
    private static function pyCompile(string $code, string $suffix = 'test'): array
    {
        $tmp = sys_get_temp_dir() . "/adk_{$suffix}_" . getmypid() . '.py';
        file_put_contents($tmp, $code);
        exec('python3 -m py_compile ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
        @unlink($tmp);
        return [$rc, implode("\n", $out)];
    }

    /** Diamond analyzed fixture (start → [A‖B] → output). */
    private static function diamondAnalyzed(): array
    {
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start',  'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
                ['id' => '3', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'B', 'systemPrompt' => 'B', 'provider' => 'gemini', 'model' => 'g', 'selectedTools' => []]],
                ['id' => '4', 'type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [
                ['from' => '1', 'to' => '2'], ['from' => '1', 'to' => '3'],
                ['from' => '2', 'to' => '4'], ['from' => '3', 'to' => '4'],
            ],
        ];
        $base = WorkflowGraphAnalyzer::analyzeGraph($graph);
        return array_merge($base, [
            'workflow'       => ['id' => 1, 'name' => 'diamond'],
            'usedCatalog'    => [],
            'usedServers'    => [],
            'startPrompt'    => 'GO',
            'startDocuments' => [],
            'agents'         => [
                '2' => ['name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm',
                        'temperature' => null, 'max_tokens' => null, 'tools' => [],
                        'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
                '3' => ['name' => 'B', 'systemPrompt' => 'B', 'provider' => 'gemini', 'model' => 'g',
                        'temperature' => null, 'max_tokens' => null, 'tools' => [],
                        'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
            ],
        ]);
    }

    /**
     * Full-featured analyzed fixture:
     *  - Agent 2 (claude): skill_content non-empty, MCP tool 'search', temperature + max_tokens set
     *  - Agent 3 (gemini): plain, no tools
     *  - Sequential chain: start → 2 → 3 → output
     *  - usedServers + usedCatalog seeded so MCP blocks are emitted
     */
    private static function fullFeaturedAnalyzed(): array
    {
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start',  'config' => ['type' => 'start', 'prompt' => 'Analyse the market']],
                ['id' => '2', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'Researcher',
                    'systemPrompt' => 'Research and call run_skill_script with dir_name=\'html/create\'',
                    'provider' => 'claude', 'model' => 'claude-sonnet-4-6', 'selectedTools' => ['search']]],
                ['id' => '3', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'Writer',
                    'systemPrompt' => 'Write report', 'provider' => 'gemini', 'model' => 'gemini-2.5-pro',
                    'selectedTools' => []]],
                ['id' => '4', 'type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [
                ['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3'], ['from' => '3', 'to' => '4'],
            ],
        ];
        $base = WorkflowGraphAnalyzer::analyzeGraph($graph);
        return array_merge($base, [
            'workflow'       => ['id' => 99, 'name' => 'full_featured'],
            'usedServers'    => ['srv1' => ['url' => 'http://localhost:9001/mcp']],
            'usedCatalog'    => [
                'search' => [
                    'server'       => 'srv1',
                    'description'  => 'Web search',
                    'input_schema' => ['type' => 'object', 'properties' => ['query' => ['type' => 'string']]],
                ],
            ],
            'startPrompt'    => 'Analyse the market',
            'startDocuments' => [],
            'agents'         => [
                '2' => [
                    'name'             => 'Researcher',
                    'systemPrompt'     => "Research and call run_skill_script with dir_name='html/create'",
                    'provider'         => 'claude',
                    'model'            => 'claude-sonnet-4-6',
                    'temperature'      => 0.5,
                    'max_tokens'       => 2048,
                    'tools'            => ['search'],
                    'skill_content'    => "call run_skill_script dir_name=\"html/create\"",
                    'output_schema_id' => null,
                    'documents'        => [],
                ],
                '3' => [
                    'name'             => 'Writer',
                    'systemPrompt'     => 'Write report',
                    'provider'         => 'gemini',
                    'model'            => 'gemini-2.5-pro',
                    'temperature'      => null,
                    'max_tokens'       => null,
                    'tools'            => [],
                    'skill_content'    => '',
                    'output_schema_id' => null,
                    'documents'        => [],
                ],
            ],
        ]);
    }

    // -------------------------------------------------------------------------
    // Tests
    // -------------------------------------------------------------------------

    /** Diamond fixture must produce syntactically-valid Python. */
    public function testDiamondFixtureCompiles(): void
    {
        if (!self::python3Available()) {
            $this->markTestSkipped('python3 not found on PATH — skipping py_compile gate');
        }

        $code = ADKGenerator::emitAdk(self::diamondAnalyzed());
        [$rc, $output] = self::pyCompile($code, 'diamond');

        $this->assertSame(0, $rc,
            "Diamond fixture failed py_compile:\n{$output}"
        );
    }

    /** Diamond emitted output must match the committed golden fixture byte-for-byte. */
    public function testDiamondMatchesGolden(): void
    {
        $goldenPath = dirname(__DIR__) . '/fixtures/adk_diamond.golden.py';
        if (!file_exists($goldenPath)) {
            $this->markTestSkipped("Golden fixture not found at {$goldenPath}");
        }

        $code   = ADKGenerator::emitAdk(self::diamondAnalyzed());
        $golden = file_get_contents($goldenPath);

        $this->assertSame($golden, $code,
            'emitAdk() output diverged from adk_diamond.golden.py — ' .
            'regenerate the golden if the emitter change was intentional: ' .
            'php -r "require \'vendor/autoload.php\'; ... file_put_contents(\'tests/fixtures/adk_diamond.golden.py\', ...)"'
        );
    }

    /**
     * Full-featured fixture: skill + MCP tool + temperature/max_tokens + multi-provider.
     * This is the real regression gate — covers all emitter branches in one compile.
     */
    public function testFullFeaturedFixtureCompiles(): void
    {
        if (!self::python3Available()) {
            $this->markTestSkipped('python3 not found on PATH — skipping py_compile gate');
        }

        $code = ADKGenerator::emitAdk(self::fullFeaturedAnalyzed());

        // Structural assertions (emit correctness, not just syntax)
        $this->assertStringContainsString('_run_skill_script', $code,
            'Skill runner must be emitted when skill_content is non-empty');
        $this->assertStringContainsString('RUN_SKILL_SCRIPT_TOOL', $code,
            'RUN_SKILL_SCRIPT_TOOL must appear in agent tools list');
        $this->assertStringContainsString('http://localhost:9001/mcp', $code,
            'MCP server URL must be baked into output');
        $this->assertStringContainsString('FunctionTool(', $code,
            'MCP FunctionTool wrappers must be emitted');
        $this->assertStringContainsString('temperature=0.5', $code,
            'temperature must be emitted in GenerateContentConfig');
        $this->assertStringContainsString('max_output_tokens=2048', $code,
            'max_output_tokens must be emitted in GenerateContentConfig');
        $this->assertStringContainsString('_make_model("claude", "claude-sonnet-4-6")', $code,
            'Claude agent must use correct model factory call');
        $this->assertStringContainsString('_make_model("gemini", "gemini-2.5-pro")', $code,
            'Gemini agent must use correct model factory call');

        // The primary gate: syntax-valid Python
        [$rc, $output] = self::pyCompile($code, 'full_featured');
        $this->assertSame(0, $rc,
            "Full-featured fixture failed py_compile:\n{$output}"
        );
    }
}
