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
}
