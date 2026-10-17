<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\CompiledA2AEmit;
use AgentTeam\Services\ADKGenerator;
use AgentTeam\Services\MAFGenerator;
use AgentTeam\Services\NOOAGenerator;

/** The A2A code structure of ADK, MAF and NOOA: layout, ports, files, LangGraph's refusals. */
class CompiledA2ATest extends TestCase
{
    public function testLayoutGivesOneServerPerNodeOnConsecutivePorts(): void
    {
        $l = CompiledA2AEmit::layout(AdkCodeNodeTest::wf64Analyzed());
        // wf64Analyzed has one dispatcher agent (2); its code nodes are not A2A nodes
        self::assertSame(['2'], array_map('strval', array_keys($l)));
        self::assertSame('servers/2_d.py', $l['2']['file']);
        self::assertSame(8701, $l['2']['port']);
        self::assertSame('dispatcher', $l['2']['kind']);
        self::assertSame([['3', 'A'], ['4', 'B']], $l['2']['menu']);
    }

    public function testCodeNodesAreRefusedWithLangGraphsMessage(): void
    {
        $this->expectExceptionMessage('Code nodes are not supported by the A2A packaging yet.');
        ADKGenerator::a2aPackage(AdkCodeNodeTest::wf64Analyzed());
    }

    public function testAStartOptionIsRefused(): void
    {
        $a = AdkCodeNodeTest::wf64Analyzed();
        $a['code'] = [];
        $a['triggerNodeId'] = '10';
        $this->expectExceptionMessage('A Start option (an event or schedule trigger) needs the single-file or modular format');
        CompiledA2AEmit::refuse($a);
    }

    public static function generators(): array
    {
        return [[ADKGenerator::class, 'adk'], [MAFGenerator::class, 'maf'], [NOOAGenerator::class, 'nooa']];
    }

    /** @dataProvider generators */
    public function testPackageFiles(string $gen, string $target): void
    {
        $a = AdkCodeNodeTest::wf64Analyzed();
        $a['code'] = [];
        $pkg = $gen::a2aPackage($a);
        self::assertSame("wf64_{$target}_a2a", $pkg['root']);
        $paths = array_column($pkg['files'], 'path');
        foreach (['orchestrator.py', 'api.py', 'workflow.py', 'common.py', 'servers/2_d.py', 'requirements.txt'] as $p) {
            self::assertContains($p, $paths, $target);
        }
        $files = array_column($pkg['files'], 'code', 'path');
        self::assertStringContainsString('a2a-sdk[http-server]>=1.1,<2', $files['requirements.txt']);
        self::assertStringContainsString('class AgentSupervisor', $files['orchestrator.py']);
        self::assertStringContainsString('async def run_node(request_text: str, trace) -> dict:', $files['servers/2_d.py']);
        foreach (['orchestrator.py', 'api.py', 'servers/2_d.py'] as $p) {
            self::assertSame(0, MafParityTest::pyCompile($files[$p])[0], "{$target} {$p}");
        }
    }
}
