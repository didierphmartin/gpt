<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use AgentTeam\Services\LangGraphRuntime;
use PHPUnit\Framework\TestCase;

/** The emitted runtime pieces for code nodes, checked as text and executed by python3 where possible. */
final class LangGraphCodeNodeRuntimeTest extends TestCase
{
    public function testCodeNodeClassOnlyWhenAsked(): void
    {
        self::assertStringNotContainsString('class CodeNode', LangGraphRuntime::nodeClassesBlock(true));
        $with = LangGraphRuntime::nodeClassesBlock(true, true);
        self::assertStringContainsString('class CodeNode(Node):', $with);
        self::assertStringContainsString('CODE = "code"', $with);
        self::assertStringContainsString('case NodeKind.CODE:', $with);
    }

    public function testHarnessIsEmbeddedVerbatimAndLoads(): void
    {
        $block = LangGraphRuntime::codeHarnessBlock();
        $py = "import json, sys, types\nMCP_SLUGS = {}\nclass _M:\n    def call_tool_raw(self, u, t, a):\n        return {}\nMCP = _M()\n"
            . $block . "\nprint(CODE_HARNESS.execute('def run(i, c):\\n    return i', 5, ['next'], [], _code_transport, 5)['output_text'])\n"
            . "print(_code_transport('nope', 't', {})['isError'])\n";
        $file = tempnam(sys_get_temp_dir(), 'cn') . '.py';
        file_put_contents($file, $py);
        exec('python3 ' . escapeshellarg($file) . ' 2>&1', $out, $rc);
        self::assertSame(0, $rc, implode("\n", $out));
        self::assertSame(['5', 'True'], $out);
        self::assertStringContainsString('CODE_HARNESS_SOURCE = "', $block);
    }

    public function testMcpClientHasARawCall(): void
    {
        self::assertStringContainsString('def call_tool_raw(self, server_url: str, tool_name: str, arguments: dict) -> dict:',
            LangGraphRuntime::mcpClientBlock());
    }

    public function testWorkflowGraphRoutesCodeExits(): void
    {
        $g = LangGraphRuntime::workflowGraphBlock();
        self::assertStringContainsString('case "agent" | "playbook" | "code":', $g);
        self::assertStringContainsString('def _code_router(self, nid: str):', $g);
        self::assertStringContainsString('"start": self.node_types.get(p) == "start"', $g);
    }
}
