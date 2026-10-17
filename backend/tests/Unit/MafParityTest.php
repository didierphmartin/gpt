<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\MAFGenerator;

/** MAF gets what ADK has: MCP headers, code nodes, decision routing, run events, a listening package. */
class MafParityTest extends TestCase
{
    public static function pyCompile(string $code): array
    {
        $f = sys_get_temp_dir() . '/mafp_' . bin2hex(random_bytes(4)) . '.py';
        file_put_contents($f, $code);
        exec('python3 -m py_compile ' . escapeshellarg($f) . ' 2>&1', $out, $rc);
        return [$rc, implode("\n", $out)];
    }

    public function testMcpClientWithHeadersForACodeOnlyWorkflow(): void
    {
        $code = MAFGenerator::emitMaf(AdkCodeNodeTest::codeAnalyzed());
        self::assertStringContainsString("MCP_SERVER_SLUGS = {\n    \"http://localhost:8770\": \"outlook\"", $code);
        self::assertStringContainsString('var = f"MCP_HEADERS_{slug.upper()}"', $code);
        self::assertStringContainsString('for _d in (_HERE, os.path.dirname(_HERE), os.path.dirname(os.path.dirname(_HERE))):', $code);
        self::assertSame(0, self::pyCompile($code)[0]);
    }

    /** Review I2: a node named like a stdlib module ("time") must not shadow it in workflow.py (MAF and NOOA packages). */
    public function testANodeNamedLikeAModuleDoesNotShadowIt(): void
    {
        $py = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';
        if (!is_file($py)) {
            self::markTestSkipped('runner venv missing');
        }
        foreach ([\AgentTeam\Services\MAFGenerator::class, \AgentTeam\Services\NOOAGenerator::class] as $gen) {
            $a = AdkCodeNodeTest::wf64Analyzed();
            $a['agents']['2']['name'] = 'time';   // the dispatcher's module would be agents/time.py
            $a['package'] = true;
            [$workflow, $common, $nodes] = $gen::packageFiles($a);
            $dir = sys_get_temp_dir() . '/mafp_' . bin2hex(random_bytes(4));
            @mkdir("$dir/agents", 0777, true);
            file_put_contents("$dir/workflow.py", $workflow);
            file_put_contents("$dir/common.py", $common . "\n" . \AgentTeam\Services\CompiledRuntimeEmit::packageCommonBlock());
            foreach ($nodes as $f) {
                file_put_contents("$dir/{$f['path']}", $f['code']);
            }
            file_put_contents("$dir/code_harness.py", (string) file_get_contents(dirname(__DIR__, 3) . '/frontend/assets/py/code_node_harness.py'));
            exec('cd ' . escapeshellarg($dir) . ' && ANTHROPIC_API_KEY=x ' . escapeshellarg($py)
                . ' -W ignore -c "import workflow; print(workflow.time.sleep.__name__)" 2>&1', $out, $rc);
            self::assertSame(0, $rc, $gen . "\n" . implode("\n", $out));
            self::assertSame('sleep', end($out), $gen);
            $out = [];
        }
    }
}

