/**
 * Port of backend/tests/Unit/MafGeneratorEmitTest.php: what MAFGenerator.emitMaf() writes for a minimal analysis
 * (start -> A(claude) -> output) and its skill / MCP variants. Each case is also differential: the TypeScript
 * output is byte-identical to PHP's MAFGenerator::emitMaf() on the same array (tests/fixtures/compiler/php_cmp.php).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAFGenerator } from '../src/AgentTeam/MAFGenerator';
import { phpSkipReason } from './support/phpCompiler';
import { asPhpArg, cmpBatch } from './support/phpCmp';
import { emitAnalyzed, withMcp } from './support/mafAnalyses';
import { codeAnalyzed } from './support/adkAnalyses';

const NO_PHP = phpSkipReason() || false;

function variants(): Record<string, any> {
  const storage = emitAnalyzed();
  storage.outputStorageEnabled = true;
  storage.outputFolder = null;
  const skill = emitAnalyzed();
  skill.agents['2'].skills = [{ dir: 'html' }];
  return { plain: emitAnalyzed(), storage, skill, mcp: withMcp(emitAnalyzed()) };
}

const emit = (a: any): string => MAFGenerator.emitMaf(asPhpArg(a));

test('testHeaderAndImports', () => {
  const code = emit(emitAnalyzed());
  assert.ok(code.includes('from agent_framework import (\n    Agent,'));
  assert.ok(code.includes('    WorkflowBuilder,\n'));
  assert.ok(code.includes('from agent_framework.anthropic import AnthropicClient'));
  assert.ok(code.includes('from agent_framework.openai import OpenAIChatCompletionClient'));
  assert.ok(code.includes('load_dotenv('));
});

/**
 * DeepSeek V4 in thinking mode rejects a replayed assistant tool-call turn that lacks `reasoning_content`; the emitted
 * script subclasses the chat-completion client to capture and replay it (an empty string when the turn produced none).
 */
test('testDeepSeekReasoningContentIsRoundTripped', () => {
  const code = emit(emitAnalyzed());
  assert.ok(code.includes('class ReasoningRoundTripClient(OpenAIChatCompletionClient):'));
  assert.ok(code.includes('def _parse_response_from_openai(self, response, options):'));
  assert.ok(code.includes('def _prepare_message_for_openai(self, message):'));
  assert.ok(code.includes('"reasoning_content"'));
  assert.match(code, /if m\.get\("role"\) == "assistant":\s*m\["reasoning_content"\]/);
  assert.ok(code.includes('return ReasoningRoundTripClient(**kwargs)'));
  assert.ok(!code.includes('return OpenAIChatCompletionClient(**kwargs)'));
});

test('testDeepSeekFlashGetsV4ThinkingRules', () => {
  assert.ok(emit(emitAnalyzed()).includes('elif p == "deepseek" and str(model).startswith(("deepseek-v4", "deepseek-flash")):'));
});

test('testClientFactoryUsesChatCompletionAndBaseUrls', () => {
  const code = emit(emitAnalyzed());
  assert.ok(code.includes('def make(cls, provider: str, model: str)'));   // ProviderClients
  assert.ok(code.includes('AnthropicClient(model=model'));
  // OpenAI-compatible providers MUST use ChatCompletion (the reasoning round-trip subclass), never OpenAIChatClient
  assert.ok(code.includes('class ReasoningRoundTripClient(OpenAIChatCompletionClient)'));
  assert.ok(code.includes('kwargs = {"model": model'));
  assert.ok(!code.includes('OpenAIChatClient('));
  assert.ok(code.includes('https://api.x.ai/v1'));
  assert.ok(code.includes('https://generativelanguage.googleapis.com/v1beta/openai/'));
});

test('testAgentsAndOrchestrationEmitted', () => {
  const code = emit(emitAnalyzed());
  assert.ok(code.includes('AGENTS = {'));
  assert.ok(code.includes('"2": {'));            // agent node baked
  // one executor per canvas node, assembled by create_workflow() on WorkflowBuilder
  assert.ok(code.includes('class AgentNodeExecutor(Executor):'));
  assert.ok(code.includes('Agent(client, instructions='));
  assert.ok(code.includes('.run('));
  assert.ok(code.includes('def create_workflow():'));
  assert.ok(code.includes('builder = WorkflowBuilder(start_executor=start_node, output_from=[output_node])'));
  assert.ok(code.includes('async def run_workflow(prompt: str'));
  assert.ok(code.includes('asyncio.run(run_workflow('));
  // Parity with LangGraph build_context: every agent node sees the original prompt
  // (framed input), while the output node gets the raw merged deliverable.
  assert.ok(code.includes('def _framed_input(self)'));
  assert.ok(code.includes('Original user request:'));
  assert.ok(code.includes('class OutputNodeExecutor(Executor):'));
  // Result API: agent-framework's WorkflowRunResult has NO .text — use get_outputs().
  assert.ok(code.includes('_result.get_outputs()'));
  assert.ok(!code.includes('_result.text'));
});

test('testStartPromptAndStorageBaked', () => {
  const code = emit(variants().storage);
  assert.ok(code.includes('Analyze example.com'));      // start prompt baked
  assert.ok(code.includes('OUTPUT_STORAGE_ENABLED = True'));
  assert.ok(code.includes('WORKFLOW_ID = 7'));
});

test('testSkillRuntimeEmittedWhenSkillPresent', () => {
  const code = emit(variants().skill);
  assert.ok(code.includes('_LAST_SKILL_OUTPUTS'));
  assert.ok(code.includes('def _run_skill_script('));
  assert.ok(code.includes('SYNERGYAI_OUTPUT_DIR'));
  assert.ok(code.includes('async def run_step(cls, skill'));   // SkillRuntime
  assert.ok(code.includes('def make_tool(cls, dir_name: str)'));   // SkillRuntime's dir-scoped skill tool
  // baked into AGENTS — jsonToPython pretty-prints, so match the dir key
  assert.ok(code.includes('"dir": "html"'));
  // Regression guard: MAF must NEVER pull in LangChain (the skill runtime uses
  // MAF Agents + plain-callable tools, not StructuredTool / RUN_SKILL_SCRIPT_TOOL).
  const block = MAFGenerator.skillRunnerBlockForTest();
  assert.ok(!block.includes('langchain'));
  assert.ok(!block.includes('StructuredTool'));
  assert.ok(!block.includes('RUN_SKILL_SCRIPT_TOOL'));
  assert.ok(!block.includes('create_model'));
});

test('testNoSkillRuntimeWhenNoSkills', () => {
  const code = emit(emitAnalyzed());  // no skills, no tools
  assert.ok(!code.includes('def _run_skill_script('));
  // Tool-free workflow: the catalog placeholder fallback is emitted (no MCP block).
  assert.ok(code.includes('catalog = {}'));
  assert.ok(!code.includes('catalog = build_tools_from_catalog()'));
});

test('testMcpToolsEmitted', () => {
  const code = emit(variants().mcp);
  assert.ok(code.includes('MCP_SERVERS = {'));
  assert.ok(code.includes('def _call_mcp_tool('));
  assert.ok(code.includes('def _tool_web_search('));
  assert.ok(code.includes('catalog = build_tools_from_catalog()'));
  assert.ok(!code.includes('catalog = {}'));   // placeholder replaced
  // Load-bearing spec property: MCP tools are bound as PLAIN callables (MAF
  // auto-wraps), never ADK's FunctionTool wrapper.
  assert.ok(!code.includes('FunctionTool('));
  assert.ok(code.includes('"web_search": _tool_web_search'));
});

test('emitMaf and skillRunnerBlockForTest are byte-identical to PHP on every variant', { skip: NO_PHP }, () => {
  const vs = variants();
  const names = Object.keys(vs);
  const php = cmpBatch([
    ...names.map((n) => ({ class: 'MAFGenerator', method: 'emitMaf', args: [vs[n]] })),
    { class: 'MAFGenerator', method: 'skillRunnerBlockForTest', args: [] },
  ]);
  // The two generations can straddle a second: compare everything but the Generated stamp.
  const unstamp = (s: string) => s.replace(/^( {2}Generated: {2})\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/m, '$1<stamp>');
  names.forEach((n, i) => {
    assert.ok(php[i].ok, `${n}: PHP threw ${php[i].error}`);
    assert.equal(unstamp(emit(vs[n])), unstamp(php[i].result), `${n}: emitMaf differs from PHP`);
  });
  assert.equal(MAFGenerator.skillRunnerBlockForTest(), php[names.length].result);
});

/** A code node's CODE_NODES entry carries its argument declarations; its run fills ARGS from the parents' meta. */
test('testCodeNodeCarriesArgDeclsAndPassesMeta', () => {
  const a = codeAnalyzed();
  a.code['2'].arg_decls = [{ name: 'folder', required: true }];
  const code = MAFGenerator.emitMaf(a);
  assert.ok(code.includes('meta=CODE_HARNESS.received_meta(parents)'));
  assert.ok(code.includes('arg_decls=cfg.get("arg_decls")'));
  assert.match(code, /"arg_decls": \[\s*\{\s*"name": "folder",\s*"required": True\s*\}\s*\]/);
});
