/**
 * Port of backend/tests/Unit/AdkGeneratorEmitTest.php: emitAdk()'s blocks (header, model factory, tool wrappers,
 * skill runtime, agents, layering, CLI entry). Every emitted script is also compared with PHP's
 * ADKGenerator::emitAdk() of the same analysis.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADKGenerator } from '../src/AgentTeam/ADKGenerator';
import { entries, oarr } from '../src/AgentTeam/compiler/php';
import { asPhpArg } from './support/phpCmp';
import { phpCall, phpSkipReason } from './support/phpCompiler';
import { agentRecord, analyzedOf, assertSameAsPhp } from './support/adkAnalyses';

/** emitAdk(), checked against PHP's emitAdk() of the same analysis. */
function emit(a: any): string {
  assertSameAsPhp(a);
  return ADKGenerator.emitAdk(a);
}

function analyzed(): any {
  const graph = {
    nodes: [
      { id: '1', type: 'start', config: { type: 'start', prompt: 'GO' } },
      { id: '2', type: 'agent', config: { type: 'agent', agent_name: 'A', systemPrompt: 'You are A', provider: 'claude', model: 'claude-sonnet-4-6', selectedTools: [] } },
      { id: '3', type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }],
  };
  return analyzedOf(graph, {
    workflow: { id: 7, name: 'demo' },
    agents: { 2: agentRecord('A', 'You are A', 'claude', 'claude-sonnet-4-6') },
    usedCatalog: [], usedServers: [],
    startPrompt: 'GO', startDocuments: [],
  });
}

/** A diamond (start -> [A, B] -> output) with the given providers and models. */
function diamond(name: string, id: number, b: [string, string]): any {
  const graph = {
    nodes: [
      { id: '1', type: 'start', config: { type: 'start', prompt: 'GO' } },
      { id: '2', type: 'agent', config: { type: 'agent', agent_name: 'A', systemPrompt: 'A', provider: 'claude', model: 'm', selectedTools: [] } },
      { id: '3', type: 'agent', config: { type: 'agent', agent_name: 'B', systemPrompt: 'B', provider: b[0], model: b[1], selectedTools: [] } },
      { id: '4', type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from: '1', to: '2' }, { from: '1', to: '3' }, { from: '2', to: '4' }, { from: '3', to: '4' }],
  };
  return analyzedOf(graph, {
    workflow: { id, name }, usedCatalog: [], usedServers: [],
    startPrompt: 'GO', startDocuments: [],
    agents: { 2: agentRecord('A', 'A', 'claude', 'm'), 3: agentRecord('B', 'B', b[0], b[1]) },
  });
}

test('testHeaderAndImports', () => {
  const code = emit(analyzed());
  assert.ok(code.includes('google-adk'));
  assert.ok(code.includes('from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent'));
  assert.ok(code.includes('from google.adk.models.lite_llm import LiteLlm'));
});

test('testModelFactoryMapsProviders', () => {
  const code = ADKGenerator.emitAdk(analyzed());
  assert.ok(code.includes('def _make_model(provider: str, model: str, thinking: str | None = None)'));
  // Gemini => bare model string; others => LiteLlm(...)
  assert.ok(code.includes('return model'));          // gemini path
  assert.ok(code.includes('return LiteLlm(model=')); // non-gemini path
});

test('testMcpToolBuilderEmitted', () => {
  const a = analyzed();
  a['usedServers'] = asPhpArg({ 'http://localhost:9000/mcp': { name: 'test-server' } });
  // Empty properties -> no-arg concrete function.
  a['usedCatalog'] = asPhpArg({ search: { server_url: 'http://localhost:9000/mcp', description: 'Search', input_schema: { type: 'object', properties: [] } } });
  const code = emit(a);
  assert.ok(code.includes('MCP_SERVERS = {'));
  assert.ok(code.includes('TOOL_CATALOG = {'));
  assert.ok(code.includes('def _call_mcp_tool('));
  assert.ok(code.includes('def build_tools_from_catalog()'));
  assert.ok(code.includes('FunctionTool('));
  assert.ok(code.includes('http://localhost:9000/mcp'));
  assert.ok(code.includes('def _tool_search()'), 'No-arg concrete function must be emitted for empty-schema tool');
  assert.ok(code.includes('_call_mcp_tool("http://localhost:9000/mcp", "search"'), 'Server URL must be baked into the _call_mcp_tool call');
  assert.ok(code.includes('"search": FunctionTool(_tool_search)'), 'build_tools_from_catalog must map real tool name to FunctionTool of the concrete function');
  assert.match(code, /"server_url":\s*"http:\/\/localhost:9000\/mcp"/, 'TOOL_CATALOG in emitted code must contain server_url with the actual URL');
});

test('testTypedFunctionToolFromInputSchema', () => {
  const a = analyzed();
  a['usedCatalog'] = asPhpArg({
    search: {
      server_url: 'http://localhost:9001/mcp',
      description: 'Web search',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'q' }, limit: { type: 'integer' } },
        required: ['query'],
      },
    },
  });
  const code = emit(a);
  assert.ok(code.includes('def _tool_search(query: str, limit: int = None) -> str:'),
    'Required param must come first with no default; optional param must have default=None');
  assert.ok(code.includes('Args:'), 'Docstring must include Args: section');
  assert.ok(code.includes('query: q'), 'Docstring must include param description');
  assert.ok(code.includes('_call_mcp_tool("http://localhost:9001/mcp", "search"'), 'Server URL must be baked as a literal into the _call_mcp_tool call');
  assert.ok(code.includes('"search": FunctionTool(_tool_search)'), 'build_tools_from_catalog must map "search" -> FunctionTool(_tool_search)');
});

test('testEmptyCatalogBuilderReturnsEmptyDict', () => {
  const code = ADKGenerator.emitAdk(analyzed());   // usedCatalog = []
  assert.ok(code.includes('def build_tools_from_catalog() -> dict:'));
  assert.ok(code.includes('return {}'));
  assert.ok(!code.includes('def _tool_'), 'No concrete tool functions should be emitted when catalog is empty');
});

test('testSkillRunnerEmittedAndAsyncSafe', () => {
  const a = analyzed();
  const skillMd = "Use the skill: call run_skill_script with dir_name='html/create'";
  a['agents']['2']['skill_content'] = skillMd;
  a['agents']['2']['skills'] = asPhpArg([{ inline: skillMd }]);
  const code = emit(a);
  assert.ok(code.includes('SKILLS_DIR'));
  assert.ok(code.includes('def _run_skill_script('));
  assert.ok(code.includes('asyncio.create_subprocess_exec'));   // async-safe entry
  assert.ok(code.includes('RUN_SKILL_SCRIPT_TOOL = FunctionTool('));
});

test('testSkillRunnerOmittedWhenNoSkills', () => {
  const code = ADKGenerator.emitAdk(analyzed());
  assert.ok(!code.includes('_run_skill_script'));
  assert.ok(!code.includes('RUN_SKILL_SCRIPT_TOOL'));
});

test('testUserPromptBracesAreEscapedButNodePlaceholdersStayLive', () => {
  const a = analyzed();
  a['agents']['2']['systemPrompt'] = 'Today is {date} ({weekday}). The current year is {year}.';
  a['byId']['3'] = asPhpArg({ id: '3', type: 'agent', config: { type: 'agent', agent_name: 'B' } });
  const b = oarr(entries(a['agents']['2']));   // $a['agents']['2'] + ['name' => 'B']: the left side's name stays
  a['agents']['3'] = b;
  a['agents']['3']['systemPrompt'] = 'Summarise {topic} using the input.';
  a['order'] = ['1', '2', '3'];
  a['edges'].push({ from: '2', to: '3' });
  a['parents']['3'] = ['2'];
  a['children']['2'] = ['3'];
  a['layers'] = [['1'], ['2'], ['3']];
  const code = emit(a);
  // The prompt is passed VERBATIM to a callable instruction provider (ADK skips
  // state templating for callables), and parents are read from state by key.
  assert.ok(code.includes('def _agent_instruction(prompt: str, parent_keys: list):'));
  assert.ok(code.includes('instruction=_agent_instruction("Today is {date} ({weekday}). The current year is {year}.", []),'));
  assert.ok(code.includes('instruction=_agent_instruction("Summarise {topic} using the input.", ["node_2"]),'));
  assert.ok(!code.includes('{node_2}'), 'no string-templated placeholders remain');
});

test('testAgentEmittedWithOutputKeyAndParentInjection', () => {
  const code = ADKGenerator.emitAdk(analyzed());
  assert.ok(code.includes('node_2 = LlmAgent('));
  assert.ok(code.includes('output_key="node_2"'));
  assert.ok(code.includes('model=_make_model("claude", "claude-sonnet-4-6", thinking='));
  assert.ok(code.includes('You are A'));
});

test('testGenerateContentConfigTyped', () => {
  // With temperature + max_tokens set -> typed GenerateContentConfig emitted
  const a = analyzed();
  a['agents']['2']['temperature'] = asPhpArg(0.7);
  a['agents']['2']['max_tokens'] = 1024;
  const code = emit(a);
  assert.ok(code.includes('types.GenerateContentConfig('));
  assert.ok(code.includes('temperature=0.7'));
  assert.ok(code.includes('max_output_tokens=1024'));

  // With both null -> no generate_content_config key at all
  const code2 = ADKGenerator.emitAdk(analyzed());
  assert.ok(!code2.includes('generate_content_config'));
});

test('testDeepSeekFlashGetsV4ThinkingRules', () => {
  // deepseek-flash replaced deepseek-v4-flash and still runs in thinking
  // mode: the model factory enables thinking and the generator drops
  // the temperature the API would reject.
  const a = analyzed();
  a['agents']['2']['provider'] = 'deepseek';
  a['agents']['2']['model'] = 'deepseek-flash';
  a['agents']['2']['temperature'] = asPhpArg(0.7);
  const code = emit(a);
  assert.ok(code.includes('if model.startswith(("deepseek-v4", "deepseek-flash")):'));
  assert.ok(code.includes('temperature 0.7 dropped (deepseek-v4 thinking mode'));
  assert.ok(!code.includes('temperature=0.7'));
});

test('testRunSkillScriptToolInAgentToolsList', () => {
  // needsSkills is gated on the 'skills' list, not skill_content. With a skills list the node
  // compiles to a SequentialAgent (main LlmAgent node_2_agent + inline skill step); the main agent
  // must NEVER receive RUN_SKILL_SCRIPT_TOOL -- skills are separate SequentialAgent steps.
  const a = analyzed();
  const skillMd = "Use the skill: call run_skill_script with dir_name='html/create'";
  a['agents']['2']['skill_content'] = skillMd;
  a['agents']['2']['skills'] = asPhpArg([{ inline: skillMd }]);
  const code = ADKGenerator.emitAdk(a);
  assert.ok(code.includes('node_2_agent = LlmAgent('));
  assert.ok(code.includes('RUN_SKILL_SCRIPT_TOOL = FunctionTool('));
  const agentBlock = code.slice(code.indexOf('node_2_agent = LlmAgent('));
  assert.ok(!agentBlock.includes('RUN_SKILL_SCRIPT_TOOL'));
});

test('testRootLayeringAndMain', () => {
  // diamond -> layer 1 has two agents -> ParallelAgent
  const code = emit(diamond('w', 1, ['gemini', 'g']));
  assert.ok(code.includes('ParallelAgent('));
  assert.ok(code.includes('root_agent = SequentialAgent('));
  assert.ok(code.includes('node_4'));            // output consolidator
  assert.ok(code.includes('async def run_workflow('));
  assert.ok(code.includes('Runner('));
  // Entry joins ALL argv (a multi-word prompt is one string), not just sys.argv[1].
  assert.ok(code.includes('" ".join(sys.argv[1:])'));
  assert.ok(!code.includes('run_workflow(sys.argv[1] if'));
});

test('testMainHonorsOutputStorageSetting', () => {
  const graph = {
    nodes: [
      { id: '1', type: 'start', config: { type: 'start', prompt: 'GO' } },
      { id: '2', type: 'agent', config: { type: 'agent', agent_name: 'A', systemPrompt: 's', provider: 'claude', model: 'm', selectedTools: [] } },
      { id: '3', type: 'output', config: { type: 'output' } },
    ],
    edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }],
  };
  const mk = (enabled: boolean, folder: string | null): any => analyzedOf(graph, {
    workflow: { id: 42, name: 'W' }, usedCatalog: [], usedServers: [],
    startPrompt: 'GO', startDocuments: [],
    outputStorageEnabled: enabled, outputFolder: folder,
    agents: { 2: agentRecord('A', 's', 'claude', 'm', { skills: [] }) },
  });

  // Storage ON, default folder -> saves to <synergyAI>/outputs/workflow/<id>-<slug>_<ts>.<ext>
  const on = emit(mk(true, null));
  assert.ok(on.includes('WORKFLOW_ID = 42'));
  assert.ok(on.includes('OUTPUT_STORAGE_ENABLED = True'));
  assert.ok(on.includes('OUTPUT_FOLDER = None'));
  assert.ok(on.includes('if OUTPUT_STORAGE_ENABLED:'));
  assert.ok(on.includes('~/Documents/synergyAI/outputs'));
  assert.ok(on.includes('os.path.join(_root, "workflow")'));
  assert.ok(on.includes('{WORKFLOW_ID}-{_slug}_{_ts}.{_ext}'));
  // The old unconditional cwd-relative save must be gone.
  assert.ok(!on.includes('os.path.join("outputs", f"{_slug}'));

  // Storage OFF -> the else branch skips saving.
  const off = emit(mk(false, null));
  assert.ok(off.includes('OUTPUT_STORAGE_ENABLED = False'));
  assert.ok(off.includes('output storage is OFF'));

  // Custom folder -> baked as OUTPUT_FOLDER and used to override the default.
  const custom = emit(mk(true, 'client-reports'));
  assert.ok(custom.includes('OUTPUT_FOLDER = "client-reports"'));
  assert.ok(custom.includes('os.path.join(_root, OUTPUT_FOLDER)'));
});

test('testOutputNodeIsNonLlmPassThrough', () => {
  // node 4 is an output (fan-in) node with parents 2 and 3: a non-LLM _PassThroughAgent that forwards the
  // parents' state verbatim -- NOT an LlmAgent (which would re-summarise and lose formatting).
  const code = emit(diamond('diamond', 2, ['claude', 'm']));
  assert.ok(code.includes('class _PassThroughAgent(BaseAgent):'));
  assert.match(code, /node_4 = _PassThroughAgent\(name="node_4", source_keys=\[[^\]]*"node_2"[^\]]*"node_3"[^\]]*\]\)/);
  assert.ok(!code.includes('node_4 = LlmAgent('));
  assert.ok(!code.includes('Consolidate the following results'));
  assert.ok(code.includes('from google.adk.events import Event, EventActions'));
});

test('testHeaderImportsHttpxAndTime', () => {
  const code = ADKGenerator.emitAdk(analyzed());
  assert.match(code, /^import httpx$/m, '"import httpx" must be a top-level module-scope import in the emitted header');
  assert.match(code, /^import .*\btime\b/m, '"time" must be imported at module scope (mcpClientBlock uses time.time())');
  assert.ok(code.includes('pip install "google-adk>=2.3,<3" "httpx>=0.27.0" litellm "python-dotenv>=1.0.0"'), 'requirements pip-install line must pin google-adk 2.3.x and include httpx');
});

test('testRequiredParamOrderedBeforeOptionalRegardlessOfSchemaOrder', () => {
  const a = analyzed();
  a['usedCatalog'] = asPhpArg({
    search: {
      server_url: 'http://localhost:9002/mcp',
      description: 'Search',
      // Optional (limit) is listed FIRST in properties, but query is the required one
      input_schema: { type: 'object', properties: { limit: { type: 'integer' }, query: { type: 'string' } }, required: ['query'] },
    },
  });
  const code = emit(a);
  assert.ok(code.includes('def _tool_search(query: str, limit: int = None)'),
    'Required param (query) must appear before optional param (limit) regardless of properties dict order');
  assert.ok(!code.includes('def _tool_search(limit:'), 'Optional param must not appear first in function signature');
});

test('testInvalidIdentifierAndKeywordPropertiesRoutedToExtra', () => {
  const a = analyzed();
  a['usedCatalog'] = asPhpArg({
    lookup: {
      server_url: 'http://localhost:9003/mcp',
      description: 'Lookup',
      input_schema: {
        type: 'object',
        properties: {
          'user-id': { type: 'string' },  // invalid identifier (hyphen)
          in: { type: 'string' },         // Python keyword
          query: { type: 'string' },      // valid, non-keyword
        },
        required: ['query'],
      },
    },
  });
  const code = emit(a);
  assert.ok(code.includes('query: str'), 'Valid non-keyword param must appear as named parameter');
  assert.ok(code.includes('**extra'), '**extra must be emitted when invalid-identifier or keyword-named props exist');
  assert.doesNotMatch(code, /def _tool_lookup\([^)]*\bin:/, 'Python keyword "in" must not appear as a named param in the function signature');
  assert.doesNotMatch(code, /def _tool_lookup\([^)]*user-id:/, 'Hyphenated property "user-id" must not appear as a named param in the function signature');
});

test('testDocumentConverterBlockAlwaysEmitted', () => {
  const code = ADKGenerator.emitAdk(analyzed());
  assert.ok(code.includes('def _convert_doc_to_markdown('), '_convert_doc_to_markdown must always be emitted regardless of startDocuments');
  assert.ok(code.includes('START_DOCUMENTS = []'), 'START_DOCUMENTS must be emitted as empty list when startDocuments is empty');
});

test('testStartDocumentsNonEmptyBakedAndPrepended', () => {
  const a = analyzed();
  a['startDocuments'] = asPhpArg([{ name: 'spec.md', path: '/uploads/spec.md' }]);
  const code = emit(a);
  assert.ok(code.includes('START_DOCUMENTS = ['), 'START_DOCUMENTS must be a non-empty list when startDocuments is set');
  assert.ok(code.includes('"path": "/uploads/spec.md"'), 'Baked START_DOCUMENTS must include the doc path');
  assert.ok(code.includes('def _convert_doc_to_markdown('), '_convert_doc_to_markdown must be emitted when docs exist');
  assert.ok(code.includes('if START_DOCUMENTS:'), 'run_workflow() must check START_DOCUMENTS at runtime');
  assert.ok(code.includes('_convert_doc_to_markdown(path)'), 'run_workflow() must call _convert_doc_to_markdown for each doc');
  assert.ok(code.includes('"## Attached Documents\\n\\n"'), 'run_workflow() must prepend "## Attached Documents" header (mirrors LangGraph)');
});

test('testEmptyStartDocumentsEmitsEmptyListAndGuard', () => {
  const code = ADKGenerator.emitAdk(analyzed());   // startDocuments = []
  assert.ok(code.includes('START_DOCUMENTS = []'));
  assert.ok(code.includes('if START_DOCUMENTS:'), 'The guard must be emitted even when START_DOCUMENTS is empty (guard is always in main)');
});

test('testSkillRunnerEmitsLiveSkillHelpers', () => {
  const code = ADKGenerator.skillRunnerBlockForTest();
  assert.ok(code.includes('def _read_skill_md('));
  assert.ok(code.includes('SKILLS_DIR'));          // reads from disk
  assert.ok(code.includes('def _skill_instruction('));
  assert.ok(code.includes('def _make_skill_tool('));
  // dir-scoped tool passes through input_files + read_outputs
  assert.ok(code.includes('return await _run_skill_script(dir_name, script, argv, input_files, read_outputs)'));
  // skill subprocess must get SYNERGYAI_OUTPUT_DIR (a real dir) and the bucketed group dirs
  assert.ok(code.includes('SKILL_OUTPUTS_ROOT'));
  assert.ok(code.includes('def _skill_output_dir('));
  assert.ok(code.includes('os.makedirs(out_dir'));
  assert.ok(code.includes('SYNERGYAI_OUTPUT_DIR=out_dir'));
  assert.ok(code.includes('SYNERGYAI_SKILL_DIR_NAME=dir_name'));
  assert.ok(code.includes('SYNERGYAI_SKILL_GROUP=group'));
  assert.ok(code.includes('cwd=skill_path, env=env'));
  // /scratch + /outputs virtual-path remap, input_files staging, read_outputs
  assert.ok(code.includes('SKILL_SCRATCH_DIR'));
  assert.ok(code.includes('def _remap_virtual_path('));
  assert.ok(code.includes('SYNERGYAI_SCRATCH_DIR=SKILL_SCRATCH_DIR'));
  assert.ok(code.includes('_remap_virtual_path(raw_path, out_dir)'));   // input_files staged
  assert.ok(code.includes('[output file '));                            // read_outputs surfaced
});

test('skillRunnerBlockForTest() is PHP\'s', { skip: phpSkipReason() || undefined }, () => {
  assert.equal(ADKGenerator.skillRunnerBlockForTest(), phpCall('ADKGenerator', 'skillRunnerBlockForTest', []));
});

/** Start -> R (skills: GEO/geo-report). */
function skillNode(prompt: string): any {
  const graph = {
    nodes: [
      { id: '1', type: 'start', config: { type: 'start', prompt: 'GO' } },
      { id: '2', type: 'agent', config: { type: 'agent', agent_name: 'R', systemPrompt: prompt, provider: 'claude', model: 'm', selectedTools: [] } },
    ],
    edges: [{ from: '1', to: '2' }],
  };
  return analyzedOf(graph, {
    workflow: { id: 1, name: 'w' }, usedCatalog: [], usedServers: [],
    startPrompt: 'GO', startDocuments: [],
    agents: { 2: agentRecord('R', prompt, 'claude', 'm', { skills: [{ dir: 'GEO/geo-report' }] }) },
  });
}

test('testSkillNodeCompilesToSequentialWithMandatorySkillStep', () => {
  const code = emit(skillNode('write the report'));
  // main agent is separate and has NO skill tool (its own block only).
  assert.ok(code.includes('node_2_agent = LlmAgent('));
  const mainStart = code.indexOf('node_2_agent = LlmAgent(');
  const mainBlock = code.slice(mainStart, code.indexOf('\n)', mainStart));
  assert.ok(!mainBlock.includes('RUN_SKILL_SCRIPT_TOOL'));
  // Each skill step = an LLM turn + a capture step.
  assert.ok(code.includes('node_2_skill_1_llm = LlmAgent('));
  assert.ok(code.includes('_make_model("claude", "m", thinking='));
  assert.ok(code.includes('_make_skill_tool("GEO/geo-report")'));
  assert.ok(code.includes('_skill_instruction("GEO/geo-report", "node_2_agent"'));
  assert.ok(code.includes('node_2_skill_1 = _SkillCaptureAgent(name="node_2_skill_1", skill_dir="GEO/geo-report", llm_key="node_2_skill_1_llm", out_key="node_2")'));
  assert.match(code, /node_2 = SequentialAgent\(\s*name="node_2",\s*sub_agents=\[node_2_agent, node_2_skill_1_llm, node_2_skill_1\]/s);
});

test('testParentOutputsInjectedIntoInstruction', () => {
  const graph = {
    nodes: [
      { id: '1', type: 'start', config: { type: 'start', prompt: 'GO' } },
      { id: '2', type: 'agent', config: { type: 'agent', agent_name: 'A', systemPrompt: 'A', provider: 'claude', model: 'm', selectedTools: [] } },
      { id: '3', type: 'agent', config: { type: 'agent', agent_name: 'B', systemPrompt: 'B reads A', provider: 'claude', model: 'm', selectedTools: [] } },
    ],
    edges: [{ from: '1', to: '2' }, { from: '2', to: '3' }],
  };
  const a = analyzedOf(graph, {
    workflow: { id: 1, name: 'w' }, usedCatalog: [], usedServers: [],
    startPrompt: 'GO', startDocuments: [],
    agents: { 2: agentRecord('A', 'A', 'claude', 'm'), 3: agentRecord('B', 'B reads A', 'claude', 'm') },
  });
  const code = emit(a);
  assert.ok(code.includes('_agent_instruction('));   // node 3 reads parent 2 from state
  assert.ok(code.includes('["node_2"]'));
});

test('testSkillHelpersEmittedWhenAgentHasSkillsList', () => {
  const code = ADKGenerator.emitAdk(skillNode('s'));
  assert.ok(code.includes('def _make_skill_tool('));
});

// ---- beyond the PHP test: the provider constraint clamps and the platform default model, differential

test('constraint clamps (kimi-k2, deepseek-v4, anthropic max_tokens) and the default model are PHP\'s', () => {
  for (const [provider, model, temperature, maxTokens, thinking] of [
    ['kimi', 'kimi-k2-turbo', 0.7, null, null], ['kimi', 'kimi-k2', 0.6, null, 'on'], ['kimi', 'kimi-k2', 1, 100, 'off'],
    ['deepseek', 'deepseek-v4-pro', 0.3, null, null], ['deepseek', 'deepseek-v4-pro', 0.3, null, 'off'],
    ['claude', 'claude-sonnet-4-6', null, 32000, null], ['anthropic', '', 0.5, '20000', 'on'], ['google', '', null, null, null],
  ] as Array<[string, string, number | null, any, string | null]>) {
    const a = analyzed();
    a['providerDefaultModels'] = asPhpArg({ claude: 'claude-default', gemini: 'gemini-default' });
    a['agents']['2']['provider'] = provider;
    a['agents']['2']['model'] = model;
    a['agents']['2']['temperature'] = asPhpArg(temperature);
    a['agents']['2']['max_tokens'] = maxTokens;
    a['agents']['2']['thinking'] = thinking;
    a['agents']['2']['skills'] = asPhpArg([{ dir: 'html' }, { inline: 'Make it "short".' }]);
    const code = emit(a);
    assert.ok(code.includes('node_2_skill_2 = _SkillCaptureAgent('), `${provider} ${model}`);
    if (provider === 'kimi' && temperature === 0.7) {
      assert.ok(code.includes('# constraint clamp: temperature 0.7 -> 0.6 (kimi-k2 non-thinking constraint)\n'));
    }
    if (provider === 'anthropic') {
      assert.ok(code.includes('# constraint clamp: max_tokens 20000 -> 16384 (anthropic non-streaming SDK limit)\n'));
      assert.ok(code.includes('_make_model("anthropic", "claude-default", thinking="on")'));
    }
  }
});
