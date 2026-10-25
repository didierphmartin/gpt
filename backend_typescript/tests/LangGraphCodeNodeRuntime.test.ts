/**
 * Port of backend/tests/Unit/LangGraphCodeNodeRuntimeTest.php: the emitted runtime pieces for code nodes, checked as
 * text and executed by python3 where possible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LangGraphRuntime } from '../src/AgentTeam/compiler/LangGraphRuntime';
import { python3, runPySource } from './support/lgFixtures';

const noPy = python3() === null ? 'python3 not available' : false;

test('testCodeNodeClassOnlyWhenAsked', () => {
  assert.ok(!LangGraphRuntime.nodeClassesBlock(true).includes('class CodeNode'));
  const withCode = LangGraphRuntime.nodeClassesBlock(true, true);
  assert.ok(withCode.includes('class CodeNode(Node):'));
  assert.ok(withCode.includes('CODE = "code"'));
  assert.ok(withCode.includes('case NodeKind.CODE:'));
});

test('testHarnessIsEmbeddedVerbatimAndLoads', { skip: noPy }, () => {
  const block = LangGraphRuntime.codeHarnessBlock();
  const py =
    'import json, sys, types\nMCP_SLUGS = {}\nclass _M:\n    def call_tool_raw(self, u, t, a):\n        return {}\nMCP = _M()\n' +
    block +
    "\nprint(CODE_HARNESS.execute('def run(i, c):\\n    return i', 5, ['next'], [], _code_transport, 5)['output_text'])\n" +
    "print(_code_transport('nope', 't', {})['isError'])\n";
  const r = runPySource('python3', py);
  assert.equal(r.rc, 0, r.out.join('\n'));
  assert.deepEqual(r.out, ['5', 'True']);
  assert.ok(block.includes('CODE_HARNESS_SOURCE = "'));
});

test('testMcpClientHasARawCall', () => {
  assert.ok(LangGraphRuntime.mcpClientBlock().includes('def call_tool_raw(self, server_url: str, tool_name: str, arguments: dict) -> dict:'));
});

test('testWorkflowGraphRoutesCodeExits', () => {
  const g = LangGraphRuntime.workflowGraphBlock();
  assert.ok(g.includes('case "agent" | "playbook" | "code":'));
  assert.ok(g.includes('def _code_router(self, nid: str):'));
  assert.ok(g.includes('"start": self.node_types.get(p) == "start"'));
});

test('testACodeBranchOfADispatcherReceivesWhatTheDispatcherReceived', { skip: noPy }, () => {
  // Start(1) -> Poll(2, code) -> triage(3, dispatcher) -> claims(4, code): claims gets the email.
  const py =
    'from __future__ import annotations\nimport json, os, time, uuid\nfrom datetime import datetime\nfrom typing import Awaitable, Callable\n' +
    LangGraphRuntime.runRecordBlock() + '\n' + LangGraphRuntime.workflowGraphBlock() + '\n' +
    "g = WorkflowGraph(edges=[['1','2'],['2','3'],['3','4']], order=['1','2','3','4'],\n" +
    "    node_types={'1':'start','2':'code','3':'agent','4':'code'},\n" +
    "    agents={'2': {'kind':'code','display':'Poll'}, '3': {'kind':'dispatcher','display':'triage','dispatch':[{'id':'4','name':'claims'}]},\n" +
    "            '4': {'kind':'code','display':'claims'}}, run_node=None, start_documents=[])\n" +
    "outs = {'1': {'source':'start','text':'poll'}, '2': {'source':'Poll','text':'{\\\"id\\\": \\\"m1\\\"}'},\n" +
    "        '3': {'source':'triage','text':'### Input from: Poll'}}\n" +
    "print(json.dumps(json.loads(g._request_for('4', {'user_prompt':'poll','node_outputs':outs}))['parents']))\n";
  const r = runPySource('python3', py);
  assert.equal(r.rc, 0, r.out.join('\n'));
  assert.equal(r.out[r.out.length - 1], '[{"name": "Poll", "text": "{\\"id\\": \\"m1\\"}", "start": false}]');
});

test('testCodeNodesAreCheckedAtStartup', () => {
  // spec §5.2: every code node's source passes check_code when its Node is built -- before any node runs.
  const withCode = LangGraphRuntime.nodeClassesBlock(true, true);
  assert.match(withCode, /class CodeNode\(Node\):[\s\S]*?def __init__\(self, cfg: dict\):\n        super\(\).__init__\(cfg\)\n[\s\S]*?CODE_HARNESS\.check_code\(self\.source\(\)\)/);
  // The code itself: the package's file (read at each run) or the embedded source (Task 7).
  assert.ok(withCode.includes('with open(os.path.join(PACKAGE_DIR, self.cfg["source_file"]), encoding="utf-8") as fh:'));
  assert.ok(withCode.includes('res = await asyncio.to_thread(CODE_HARNESS.execute, self.source(), value,'));
});

test('testToolErrorResultTakesErrorExitInCompiledScript', { skip: noPy }, () => {
  const block = LangGraphRuntime.codeHarnessBlock();
  const py =
    "import json, sys, types\nMCP_SLUGS = {'s': 'http://x/mcp'}\nclass _M:\n" +
    '    def call_tool_raw(self, u, t, a):\n' +
    "        return {'isError': True, 'content': [{'type': 'text', 'text': 'quota_exceeded'}]}\nMCP = _M()\n" +
    block +
    "\nr = CODE_HARNESS.execute('def run(i, call_tool):\\n    return {\"route\": \"ok\", \"output\": call_tool(\"s\", \"t\")}'," +
    " None, ['ok', 'error'], ['s'], _code_transport, 5)\n" +
    "print(r['route'])\nprint('quota_exceeded' in r['output_text'])\n";
  const r = runPySource('python3', py);
  assert.equal(r.rc, 0, r.out.join('\n'));
  assert.deepEqual(r.out, ['error', 'True']);
});
