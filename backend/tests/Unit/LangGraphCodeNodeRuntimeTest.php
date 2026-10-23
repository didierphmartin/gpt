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

    public function testACodeBranchOfADispatcherReceivesWhatTheDispatcherReceived(): void
    {
        // Start(1) -> Poll(2, code) -> triage(3, dispatcher) -> claims(4, code): claims gets the email.
        $py = "from __future__ import annotations\nimport json, os, time, uuid\nfrom datetime import datetime\nfrom typing import Awaitable, Callable\n"
            . LangGraphRuntime::runRecordBlock() . "\n" . LangGraphRuntime::workflowGraphBlock() . "\n"
            . "g = WorkflowGraph(edges=[['1','2'],['2','3'],['3','4']], order=['1','2','3','4'],\n"
            . "    node_types={'1':'start','2':'code','3':'agent','4':'code'},\n"
            . "    agents={'2': {'kind':'code','display':'Poll'}, '3': {'kind':'dispatcher','display':'triage','dispatch':[{'id':'4','name':'claims'}]},\n"
            . "            '4': {'kind':'code','display':'claims'}}, run_node=None, start_documents=[])\n"
            . "outs = {'1': {'source':'start','text':'poll'}, '2': {'source':'Poll','text':'{\\\"id\\\": \\\"m1\\\"}'},\n"
            . "        '3': {'source':'triage','text':'### Input from: Poll'}}\n"
            . "print(json.dumps(json.loads(g._request_for('4', {'user_prompt':'poll','node_outputs':outs}))['parents']))\n";
        $file = tempnam(sys_get_temp_dir(), 'cn') . '.py';
        file_put_contents($file, $py);
        exec('python3 ' . escapeshellarg($file) . ' 2>&1', $out, $rc);
        self::assertSame(0, $rc, implode("\n", $out));
        self::assertSame('[{"name": "Poll", "text": "{\\"id\\": \\"m1\\"}", "start": false}]', end($out));
    }

    public function testCodeNodesAreCheckedAtStartup(): void
    {
        // spec §5.2: every code node's source passes check_code when its Node is built (single file:
        // NODES at import; modular: each agent module's make_node at import) -- before any node runs.
        $with = LangGraphRuntime::nodeClassesBlock(true, true);
        self::assertMatchesRegularExpression('~class CodeNode\(Node\):.*?def __init__\(self, cfg: dict\):\n        super\(\).__init__\(cfg\)\n.*?CODE_HARNESS\.check_code\(self\.source\(\)\)~s', $with);
        // The code itself: the package's file (read at each run) or the embedded source (Task 7).
        self::assertStringContainsString('with open(os.path.join(PACKAGE_DIR, self.cfg["source_file"]), encoding="utf-8") as fh:', $with);
        self::assertStringContainsString('res = await asyncio.to_thread(CODE_HARNESS.execute, self.source(), value,', $with);
    }

    public function testToolErrorResultTakesErrorExitInCompiledScript(): void
    {
        $block = LangGraphRuntime::codeHarnessBlock();
        $py = "import json, sys, types\nMCP_SLUGS = {'s': 'http://x/mcp'}\nclass _M:\n"
            . "    def call_tool_raw(self, u, t, a):\n"
            . "        return {'isError': True, 'content': [{'type': 'text', 'text': 'quota_exceeded'}]}\nMCP = _M()\n"
            . $block
            . "\nr = CODE_HARNESS.execute('def run(i, call_tool):\\n    return {\"route\": \"ok\", \"output\": call_tool(\"s\", \"t\")}',"
            . " None, ['ok', 'error'], ['s'], _code_transport, 5)\n"
            . "print(r['route'])\nprint('quota_exceeded' in r['output_text'])\n";
        $file = tempnam(sys_get_temp_dir(), 'cn') . '.py';
        file_put_contents($file, $py);
        exec('python3 ' . escapeshellarg($file) . ' 2>&1', $out, $rc);
        self::assertSame(0, $rc, implode("\n", $out));
        self::assertSame(['error', 'True'], $out);
    }
}
