<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Services\ADKGenerator;
use AgentTeam\Services\WorkflowGraphAnalyzer;

class AdkGeneratorEmitTest extends TestCase
{
    protected function analyzed(): array
    {
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start',  'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'You are A', 'provider' => 'claude', 'model' => 'claude-sonnet-4-6', 'selectedTools' => []]],
                ['id' => '3', 'type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3']],
        ];
        $base = WorkflowGraphAnalyzer::analyzeGraph($graph);
        return array_merge($base, [
            'workflow' => ['id' => 7, 'name' => 'demo'],
            'agents' => ['2' => ['name' => 'A', 'systemPrompt' => 'You are A', 'provider' => 'claude', 'model' => 'claude-sonnet-4-6', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []]],
            'usedCatalog' => [], 'usedServers' => [],
            'startPrompt' => 'GO', 'startDocuments' => [],
        ]);
    }

    public function testHeaderAndImports(): void
    {
        $code = ADKGenerator::emitAdk($this->analyzed());
        $this->assertStringContainsString('google-adk', $code);
        $this->assertStringContainsString('from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent', $code);
        $this->assertStringContainsString('from google.adk.models.lite_llm import LiteLlm', $code);
    }

    public function testModelFactoryMapsProviders(): void
    {
        $code = ADKGenerator::emitAdk($this->analyzed());
        $this->assertStringContainsString('def _make_model(provider: str, model: str)', $code);
        // Gemini => bare model string; others => LiteLlm(...)
        $this->assertStringContainsString('return model', $code);          // gemini path
        $this->assertStringContainsString('return LiteLlm(model=', $code); // non-gemini path
    }

    public function testMcpToolBuilderEmitted(): void
    {
        $a = $this->analyzed();
        // usedServers: keyed by URL, value = {name: ...}  — matches WorkflowGraphAnalyzer::buildToolCatalog
        $a['usedServers'] = ['http://localhost:9000/mcp' => ['name' => 'test-server']];
        // usedCatalog: entry carries server_url directly — matches buildToolCatalog $toolCatalog[$tname]
        // Empty properties → no-arg concrete function.
        $a['usedCatalog'] = ['search' => ['server_url' => 'http://localhost:9000/mcp', 'description' => 'Search', 'input_schema' => ['type' => 'object', 'properties' => []]]];
        $code = ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('MCP_SERVERS = {', $code);
        $this->assertStringContainsString('TOOL_CATALOG = {', $code);
        $this->assertStringContainsString('def _call_mcp_tool(', $code);
        $this->assertStringContainsString('def build_tools_from_catalog()', $code);
        $this->assertStringContainsString('FunctionTool(', $code);
        // The URL must appear in TOOL_CATALOG (as server_url value) so the tool builder can read it
        $this->assertStringContainsString('http://localhost:9000/mcp', $code);
        // New concrete-function shape: URL baked directly into the _call_mcp_tool call
        $this->assertStringContainsString('def _tool_search()', $code,
            'No-arg concrete function must be emitted for empty-schema tool');
        $this->assertStringContainsString('_call_mcp_tool("http://localhost:9000/mcp", "search"', $code,
            'Server URL must be baked into the _call_mcp_tool call (not read from TOOL_CATALOG at runtime)');
        $this->assertStringContainsString('"search": FunctionTool(_tool_search)', $code,
            'build_tools_from_catalog must map real tool name to FunctionTool of the concrete function');
        // Confirm the URL is embedded in TOOL_CATALOG in the emitted code (it will be the server_url value)
        $this->assertMatchesRegularExpression('/"server_url":\s*"http:\/\/localhost:9000\/mcp"/', $code,
            'TOOL_CATALOG in emitted code must contain server_url with the actual URL');
    }

    /**
     * I2: typed FunctionTool signatures from input_schema.
     * A tool with required + optional properties must emit a concrete function
     * whose Python signature matches the schema (required first, optional with
     * default=None), a Google-style docstring, and the real server URL baked
     * into the _call_mcp_tool call.
     */
    public function testTypedFunctionToolFromInputSchema(): void
    {
        $a = $this->analyzed();
        $a['usedCatalog'] = [
            'search' => [
                'server_url'   => 'http://localhost:9001/mcp',
                'description'  => 'Web search',
                'input_schema' => [
                    'type'       => 'object',
                    'properties' => [
                        'query' => ['type' => 'string', 'description' => 'q'],
                        'limit' => ['type' => 'integer'],
                    ],
                    'required'   => ['query'],
                ],
            ],
        ];
        $code = ADKGenerator::emitAdk($a);

        // Test 1: concrete function with correct signature (required first, optional second)
        $this->assertStringContainsString(
            'def _tool_search(query: str, limit: int = None) -> str:',
            $code,
            'Required param must come first with no default; optional param must have default=None'
        );
        // Google-style docstring with Args section
        $this->assertStringContainsString('Args:', $code, 'Docstring must include Args: section');
        $this->assertStringContainsString('query: q', $code, 'Docstring must include param description');
        // Real server URL baked into the _call_mcp_tool call (not resolved at runtime)
        $this->assertStringContainsString(
            '_call_mcp_tool("http://localhost:9001/mcp", "search"',
            $code,
            'Server URL must be baked as a literal into the _call_mcp_tool call'
        );

        // Test 2: build_tools_from_catalog maps the REAL tool name to FunctionTool of concrete fn
        $this->assertStringContainsString(
            '"search": FunctionTool(_tool_search)',
            $code,
            'build_tools_from_catalog must map "search" → FunctionTool(_tool_search)'
        );
    }

    /**
     * I2: empty catalog produces a no-op build_tools_from_catalog that returns {}.
     */
    public function testEmptyCatalogBuilderReturnsEmptyDict(): void
    {
        $code = ADKGenerator::emitAdk($this->analyzed()); // usedCatalog = []
        $this->assertStringContainsString('def build_tools_from_catalog() -> dict:', $code);
        $this->assertStringContainsString('return {}', $code);
        // No concrete _tool_* functions should appear
        $this->assertStringNotContainsString('def _tool_', $code,
            'No concrete tool functions should be emitted when catalog is empty');
    }

    public function testSkillRunnerEmittedAndAsyncSafe(): void
    {
        $a = $this->analyzed();
        // Fixture updated: skills list (not skill_content) now triggers needsSkills.
        $skillMd = "Use the skill: call run_skill_script with dir_name='html/create'";
        $a['agents']['2']['skill_content'] = $skillMd;
        $a['agents']['2']['skills'] = [['inline' => $skillMd]];
        $code = ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('SKILLS_DIR', $code);
        $this->assertStringContainsString('def _run_skill_script(', $code);
        $this->assertStringContainsString('asyncio.create_subprocess_exec', $code); // async-safe entry
        $this->assertStringContainsString('RUN_SKILL_SCRIPT_TOOL = FunctionTool(', $code);
    }

    public function testSkillRunnerOmittedWhenNoSkills(): void
    {
        $code = ADKGenerator::emitAdk($this->analyzed());
        $this->assertStringNotContainsString('_run_skill_script', $code);
        $this->assertStringNotContainsString('RUN_SKILL_SCRIPT_TOOL', $code);
    }

    public function testAgentEmittedWithOutputKeyAndParentInjection(): void
    {
        $a = $this->analyzed();
        $code = ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('node_2 = LlmAgent(', $code);
        $this->assertStringContainsString('output_key="node_2"', $code);
        $this->assertStringContainsString('model=_make_model("claude", "claude-sonnet-4-6")', $code);
        $this->assertStringContainsString('You are A', $code);
    }

    public function testGenerateContentConfigTyped(): void
    {
        // With temperature + max_tokens set → typed GenerateContentConfig emitted
        $a = $this->analyzed();
        $a['agents']['2']['temperature'] = 0.7;
        $a['agents']['2']['max_tokens']  = 1024;
        $code = ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('types.GenerateContentConfig(', $code);
        $this->assertStringContainsString('temperature=0.7', $code);
        $this->assertStringContainsString('max_output_tokens=1024', $code);

        // With both null → no generate_content_config key at all
        $code2 = ADKGenerator::emitAdk($this->analyzed());
        $this->assertStringNotContainsString('generate_content_config', $code2);
    }

    public function testRunSkillScriptToolInAgentToolsList(): void
    {
        // Fixture updated for Task 4: needsSkills is now gated on the 'skills' list, not
        // skill_content. When a skills list is present the node compiles to a SequentialAgent
        // (main LlmAgent named node_2_agent + inline skill step), and the skill-runner helpers
        // ARE emitted. The main agent (node_2_agent) must NEVER receive RUN_SKILL_SCRIPT_TOOL
        // in its tools list — skills are separate SequentialAgent steps.
        $a = $this->analyzed();
        $skillMd = "Use the skill: call run_skill_script with dir_name='html/create'";
        $a['agents']['2']['skill_content'] = $skillMd;
        $a['agents']['2']['skills'] = [['inline' => $skillMd]];
        $code = ADKGenerator::emitAdk($a);
        // With skills list: node_2 becomes a SequentialAgent; main LlmAgent is node_2_agent
        $this->assertStringContainsString('node_2_agent = LlmAgent(', $code);
        // Skill runner IS emitted at module level (skills list triggers needsSkills)
        $this->assertStringContainsString('RUN_SKILL_SCRIPT_TOOL = FunctionTool(', $code);
        // The main agent must NOT carry RUN_SKILL_SCRIPT_TOOL in its tools list
        $agentBlock = substr($code, strpos($code, 'node_2_agent = LlmAgent('));
        $this->assertStringNotContainsString('RUN_SKILL_SCRIPT_TOOL', $agentBlock);
    }

    public function testRootLayeringAndMain(): void
    {
        // diamond -> layer 1 has two agents -> ParallelAgent
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start',  'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
                ['id' => '3', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'B', 'systemPrompt' => 'B', 'provider' => 'gemini', 'model' => 'g', 'selectedTools' => []]],
                ['id' => '4', 'type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '1', 'to' => '3'], ['from' => '2', 'to' => '4'], ['from' => '3', 'to' => '4']],
        ];
        $base = \AgentTeam\Services\WorkflowGraphAnalyzer::analyzeGraph($graph);
        $a = array_merge($base, [
            'workflow' => ['id' => 1, 'name' => 'w'], 'usedCatalog' => [], 'usedServers' => [],
            'startPrompt' => 'GO', 'startDocuments' => [],
            'agents' => [
                '2' => ['name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
                '3' => ['name' => 'B', 'systemPrompt' => 'B', 'provider' => 'gemini', 'model' => 'g', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
            ],
        ]);
        $code = ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('ParallelAgent(', $code);
        $this->assertStringContainsString('root_agent = SequentialAgent(', $code);
        $this->assertStringContainsString('node_4', $code);            // output consolidator
        $this->assertStringContainsString('async def main(', $code);
        $this->assertStringContainsString('Runner(', $code);
    }

    public function testMainHonorsOutputStorageSetting(): void
    {
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start',  'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 's', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
                ['id' => '3', 'type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3']],
        ];
        $base = \AgentTeam\Services\WorkflowGraphAnalyzer::analyzeGraph($graph);
        $mk = function (bool $enabled, ?string $folder) use ($base) {
            return array_merge($base, [
                'workflow' => ['id' => 42, 'name' => 'W'], 'usedCatalog' => [], 'usedServers' => [],
                'startPrompt' => 'GO', 'startDocuments' => [],
                'outputStorageEnabled' => $enabled, 'outputFolder' => $folder,
                'agents' => ['2' => ['name' => 'A', 'systemPrompt' => 's', 'provider' => 'claude', 'model' => 'm',
                    'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'skills' => [],
                    'output_schema_id' => null, 'documents' => []]],
            ]);
        };

        // Storage ON, default folder -> saves to <synergyAI>/outputs/workflow/<id>-<slug>_<ts>.<ext>
        $on = ADKGenerator::emitAdk($mk(true, null));
        $this->assertStringContainsString('WORKFLOW_ID = 42', $on);
        $this->assertStringContainsString('OUTPUT_STORAGE_ENABLED = True', $on);
        $this->assertStringContainsString('OUTPUT_FOLDER = None', $on);
        $this->assertStringContainsString('if OUTPUT_STORAGE_ENABLED:', $on);
        $this->assertStringContainsString('~/Documents/synergyAI/outputs', $on);
        $this->assertStringContainsString('os.path.join(_root, "workflow")', $on);
        $this->assertStringContainsString('{WORKFLOW_ID}-{_slug}_{_ts}.{_ext}', $on);
        // The old unconditional cwd-relative save must be gone.
        $this->assertStringNotContainsString('os.path.join("outputs", f"{_slug}', $on);

        // Storage OFF -> the else branch skips saving.
        $off = ADKGenerator::emitAdk($mk(false, null));
        $this->assertStringContainsString('OUTPUT_STORAGE_ENABLED = False', $off);
        $this->assertStringContainsString('output storage is OFF', $off);

        // Custom folder -> baked as OUTPUT_FOLDER and used to override the default.
        $custom = ADKGenerator::emitAdk($mk(true, 'client-reports'));
        $this->assertStringContainsString('OUTPUT_FOLDER = "client-reports"', $custom);
        $this->assertStringContainsString('os.path.join(_root, OUTPUT_FOLDER)', $custom);
    }

    public function testOutputNodeIsNonLlmPassThrough(): void
    {
        // Diamond: node 4 is an output (fan-in) node with parents 2 and 3. It must be
        // emitted as a non-LLM _PassThroughAgent that forwards the parents' state
        // verbatim -- NOT an LlmAgent (which would re-summarise and lose formatting
        // such as a finished HTML report, turning it back into plain markdown).
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start',  'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
                ['id' => '3', 'type' => 'agent',  'config' => ['type' => 'agent', 'agent_name' => 'B', 'systemPrompt' => 'B', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
                ['id' => '4', 'type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '1', 'to' => '3'], ['from' => '2', 'to' => '4'], ['from' => '3', 'to' => '4']],
        ];
        $base = \AgentTeam\Services\WorkflowGraphAnalyzer::analyzeGraph($graph);
        $a = array_merge($base, [
            'workflow' => ['id' => 2, 'name' => 'diamond'], 'usedCatalog' => [], 'usedServers' => [],
            'startPrompt' => 'GO', 'startDocuments' => [],
            'agents' => [
                '2' => ['name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
                '3' => ['name' => 'B', 'systemPrompt' => 'B', 'provider' => 'claude', 'model' => 'm', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
            ],
        ]);
        $code = ADKGenerator::emitAdk($a);
        // The pass-through class is emitted and node_4 instantiates it with its parents' state keys.
        $this->assertStringContainsString('class _PassThroughAgent(BaseAgent):', $code);
        $this->assertMatchesRegularExpression('/node_4 = _PassThroughAgent\(name="node_4", source_keys=\[[^\]]*"node_2"[^\]]*"node_3"[^\]]*\]\)/', $code);
        // Output node must NOT be an LlmAgent and must NOT re-summarise.
        $this->assertStringNotContainsString('node_4 = LlmAgent(', $code);
        $this->assertStringNotContainsString('Consolidate the following results', $code);
        // Required imports for the custom agent.
        $this->assertStringContainsString('from google.adk.events import Event, EventActions', $code);
    }

    /**
     * Regression guard: mcpClientBlock() uses httpx.Client and time.time() at runtime.
     * Both must be imported at module scope in the emitted header — even when the
     * workflow has no MCP tools (mcpClientBlock is always emitted unconditionally).
     */
    public function testHeaderImportsHttpxAndTime(): void
    {
        $code = ADKGenerator::emitAdk($this->analyzed());
        // httpx must appear as its own top-level import
        $this->assertMatchesRegularExpression('/^import httpx$/m', $code,
            '"import httpx" must be a top-level module-scope import in the emitted header');
        // time must be on the stdlib import line (or any module-scope import)
        $this->assertMatchesRegularExpression('/^import .*\btime\b/m', $code,
            '"time" must be imported at module scope (mcpClientBlock uses time.time())');
        // requirements docstring must mention httpx so installers know it is needed
        $this->assertStringContainsString('pip install google-adk litellm httpx', $code,
            'requirements pip-install line must include httpx');
    }

    /**
     * I2 Fix 2: adversarial property ordering.
     * input_schema lists optional property BEFORE required one.
     * The emitted signature must place required (no default) BEFORE optional (= None)
     * regardless of dict-key order.
     */
    public function testRequiredParamOrderedBeforeOptionalRegardlessOfSchemaOrder(): void
    {
        $a = $this->analyzed();
        $a['usedCatalog'] = [
            'search' => [
                'server_url'   => 'http://localhost:9002/mcp',
                'description'  => 'Search',
                'input_schema' => [
                    'type'       => 'object',
                    // Optional (limit) is listed FIRST in properties dict
                    'properties' => [
                        'limit' => ['type' => 'integer'],
                        'query' => ['type' => 'string'],
                    ],
                    // But query is the required one
                    'required'   => ['query'],
                ],
            ],
        ];
        $code = ADKGenerator::emitAdk($a);

        // Required param must come first despite being listed second in properties
        $this->assertStringContainsString(
            'def _tool_search(query: str, limit: int = None)',
            $code,
            'Required param (query) must appear before optional param (limit) regardless of properties dict order'
        );
        // Sanity: the reverse ordering must NOT appear
        $this->assertStringNotContainsString(
            'def _tool_search(limit:',
            $code,
            'Optional param must not appear first in function signature'
        );
    }

    /**
     * I2 Fix 3: invalid identifier and Python keyword property names.
     * A property named with a hyphen (user-id) and a property named after a
     * Python keyword (in) must NOT appear as named parameters in the emitted
     * function signature — they must route to the **extra fallback.
     */
    public function testInvalidIdentifierAndKeywordPropertiesRoutedToExtra(): void
    {
        $a = $this->analyzed();
        $a['usedCatalog'] = [
            'lookup' => [
                'server_url'   => 'http://localhost:9003/mcp',
                'description'  => 'Lookup',
                'input_schema' => [
                    'type'       => 'object',
                    'properties' => [
                        'user-id' => ['type' => 'string'],  // invalid identifier (hyphen)
                        'in'      => ['type' => 'string'],  // Python keyword
                        'query'   => ['type' => 'string'],  // valid, non-keyword
                    ],
                    'required' => ['query'],
                ],
            ],
        ];
        $code = ADKGenerator::emitAdk($a);

        // Valid non-keyword param must appear normally
        $this->assertStringContainsString('query: str', $code,
            'Valid non-keyword param must appear as named parameter');
        // **extra must be present because two props are invalid/keyword
        $this->assertStringContainsString('**extra', $code,
            '**extra must be emitted when invalid-identifier or keyword-named props exist');
        // Python keyword must NOT appear as a named parameter
        $this->assertDoesNotMatchRegularExpression(
            '/def _tool_lookup\([^)]*\bin:/',
            $code,
            'Python keyword "in" must not appear as a named param in the function signature'
        );
        // Hyphenated name must NOT appear as a named parameter
        $this->assertDoesNotMatchRegularExpression(
            '/def _tool_lookup\([^)]*user-id:/',
            $code,
            'Hyphenated property "user-id" must not appear as a named param in the function signature'
        );
    }

    /**
     * I3: documentConverterBlock always emitted + START_DOCUMENTS always baked.
     */
    public function testDocumentConverterBlockAlwaysEmitted(): void
    {
        $code = ADKGenerator::emitAdk($this->analyzed());
        $this->assertStringContainsString('def _convert_doc_to_markdown(', $code,
            '_convert_doc_to_markdown must always be emitted regardless of startDocuments');
        $this->assertStringContainsString('START_DOCUMENTS = []', $code,
            'START_DOCUMENTS must be emitted as empty list when startDocuments is empty');
    }

    /**
     * I3: when startDocuments is non-empty, emitted code contains the baked list
     * and the prepend block in main().
     */
    public function testStartDocumentsNonEmptyBakedAndPrepended(): void
    {
        $a = $this->analyzed();
        $a['startDocuments'] = [
            ['name' => 'spec.md', 'path' => '/uploads/spec.md'],
        ];
        $code = ADKGenerator::emitAdk($a);

        // The baked list must contain the doc entry
        $this->assertStringContainsString('START_DOCUMENTS = [', $code,
            'START_DOCUMENTS must be a non-empty list when startDocuments is set');
        $this->assertStringContainsString('"path": "/uploads/spec.md"', $code,
            'Baked START_DOCUMENTS must include the doc path');

        // The converter function must be present
        $this->assertStringContainsString('def _convert_doc_to_markdown(', $code,
            '_convert_doc_to_markdown must be emitted when docs exist');

        // The prepend block must appear in main()
        $this->assertStringContainsString('if START_DOCUMENTS:', $code,
            'main() must check START_DOCUMENTS at runtime');
        $this->assertStringContainsString('_convert_doc_to_markdown(path)', $code,
            'main() must call _convert_doc_to_markdown for each doc');
        $this->assertStringContainsString('"## Attached Documents\\n\\n"', $code,
            'main() must prepend "## Attached Documents" header (mirrors LangGraph)');
    }

    /**
     * I3: empty startDocuments still emits START_DOCUMENTS = [] and an always-present
     * prepend guard (if START_DOCUMENTS:) so the golden is byte-stable.
     */
    public function testEmptyStartDocumentsEmitsEmptyListAndGuard(): void
    {
        $code = ADKGenerator::emitAdk($this->analyzed()); // startDocuments = []
        $this->assertStringContainsString('START_DOCUMENTS = []', $code);
        $this->assertStringContainsString('if START_DOCUMENTS:', $code,
            'The guard must be emitted even when START_DOCUMENTS is empty (guard is always in main)');
    }

    public function testSkillRunnerEmitsLiveSkillHelpers(): void
    {
        $code = \AgentTeam\Services\ADKGenerator::skillRunnerBlockForTest();
        $this->assertStringContainsString('def _read_skill_md(', $code);
        $this->assertStringContainsString('SKILLS_DIR', $code);          // reads from disk
        $this->assertStringContainsString('def _skill_instruction(', $code);
        $this->assertStringContainsString('def _make_skill_tool(', $code);
        // dir-scoped tool passes through input_files + read_outputs (needed by file-based
        // skills like html/create: stage HTML at /scratch, render to /outputs, read back)
        $this->assertStringContainsString('return await _run_skill_script(dir_name, script, argv, input_files, read_outputs)', $code);
        // skill subprocess must get SYNERGYAI_OUTPUT_DIR (a real dir), else skills fall
        // back to "/outputs" (fs root) and their extract files silently fail to write.
        // Mirror the interpreter: bucket grouped skills into <root>/<group> + export the
        // dir_name/group env vars, so a dimension skill's extract is where gather_audits reads.
        $this->assertStringContainsString('SKILL_OUTPUTS_ROOT', $code);
        $this->assertStringContainsString('def _skill_output_dir(', $code);
        $this->assertStringContainsString('os.makedirs(out_dir', $code);
        $this->assertStringContainsString('SYNERGYAI_OUTPUT_DIR=out_dir', $code);
        $this->assertStringContainsString('SYNERGYAI_SKILL_DIR_NAME=dir_name', $code);
        $this->assertStringContainsString('SYNERGYAI_SKILL_GROUP=group', $code);
        $this->assertStringContainsString('cwd=skill_path, env=env', $code);
        // /scratch + /outputs virtual-path remap, input_files staging, read_outputs — the
        // full interpreter skill-filesystem parity (so html/create's -i /scratch -o /outputs works)
        $this->assertStringContainsString('SKILL_SCRATCH_DIR', $code);
        $this->assertStringContainsString('def _remap_virtual_path(', $code);
        $this->assertStringContainsString('SYNERGYAI_SCRATCH_DIR=SKILL_SCRATCH_DIR', $code);
        $this->assertStringContainsString('_remap_virtual_path(raw_path, out_dir)', $code);   // input_files staged
        $this->assertStringContainsString('[output file ', $code);                            // read_outputs surfaced
    }

    public function testSkillNodeCompilesToSequentialWithMandatorySkillStep(): void
    {
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent', 'config' => ['type' => 'agent', 'agent_name' => 'R',
                    'systemPrompt' => 'write the report', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
            ],
            'edges' => [['from' => '1', 'to' => '2']],
        ];
        $base = \AgentTeam\Services\WorkflowGraphAnalyzer::analyzeGraph($graph);
        $a = array_merge($base, [
            'workflow' => ['id' => 1, 'name' => 'w'], 'usedCatalog' => [], 'usedServers' => [],
            'startPrompt' => 'GO', 'startDocuments' => [],
            'agents' => [
                '2' => ['name' => 'R', 'systemPrompt' => 'write the report', 'provider' => 'claude', 'model' => 'm',
                    'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '',
                    'skills' => [['dir' => 'GEO/geo-report']], 'output_schema_id' => null, 'documents' => []],
            ],
        ]);
        $code = \AgentTeam\Services\ADKGenerator::emitAdk($a);

        // main agent is separate and has NO skill tool. Check the main agent's own
        // block (not the whole file: the module-level RUN_SKILL_SCRIPT_TOOL = FunctionTool(...)
        // definition is emitted once needsSkills is on, and is unrelated to what the agent gets).
        $this->assertStringContainsString('node_2_agent = LlmAgent(', $code);
        $mainStart = strpos($code, 'node_2_agent = LlmAgent(');
        $mainBlock = substr($code, $mainStart, strpos($code, "\n)", $mainStart) - $mainStart);
        $this->assertStringNotContainsString('RUN_SKILL_SCRIPT_TOOL', $mainBlock); // never given to the main agent
        // skill step: node model, dir-scoped tool, callable instruction seeded by the agent's result
        $this->assertStringContainsString('node_2_skill_1 = LlmAgent(', $code);
        $this->assertStringContainsString('_make_model("claude", "m")', $code);
        $this->assertStringContainsString('_make_skill_tool("GEO/geo-report")', $code);
        $this->assertStringContainsString('_skill_instruction("GEO/geo-report", "node_2_agent"', $code);
        $this->assertStringContainsString('output_key="node_2"', $code);       // last step writes the node key
        // wrapper the layering references
        $this->assertMatchesRegularExpression('/node_2 = SequentialAgent\(\s*name="node_2",\s*sub_agents=\[node_2_agent, node_2_skill_1\]/s', $code);
    }

    public function testParentOutputsInjectedIntoInstruction(): void
    {
        // node 3 (output) is child of 2; a downstream agent reading node 2 must see {node_2}
        $graph = [
            'nodes' => [
                ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'GO']],
                ['id' => '2', 'type' => 'agent', 'config' => ['type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
                ['id' => '3', 'type' => 'agent', 'config' => ['type' => 'agent', 'agent_name' => 'B', 'systemPrompt' => 'B reads A', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
            ],
            'edges' => [['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3']],
        ];
        $base = \AgentTeam\Services\WorkflowGraphAnalyzer::analyzeGraph($graph);
        $a = array_merge($base, [
            'workflow' => ['id' => 1, 'name' => 'w'], 'usedCatalog' => [], 'usedServers' => [],
            'startPrompt' => 'GO', 'startDocuments' => [],
            'agents' => [
                '2' => ['name' => 'A', 'systemPrompt' => 'A', 'provider' => 'claude', 'model' => 'm', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
                '3' => ['name' => 'B', 'systemPrompt' => 'B reads A', 'provider' => 'claude', 'model' => 'm', 'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '', 'output_schema_id' => null, 'documents' => []],
            ],
        ]);
        $code = ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('{node_2}', $code); // node 3 instruction injects parent 2
    }

    public function testSkillHelpersEmittedWhenAgentHasSkillsList(): void
    {
        $graph = ['nodes' => [
            ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'GO']],
            ['id' => '2', 'type' => 'agent', 'config' => ['type' => 'agent', 'agent_name' => 'R',
                'systemPrompt' => 's', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
        ], 'edges' => [['from' => '1', 'to' => '2']]];
        $base = \AgentTeam\Services\WorkflowGraphAnalyzer::analyzeGraph($graph);
        $a = array_merge($base, ['workflow' => ['id' => 1, 'name' => 'w'], 'usedCatalog' => [], 'usedServers' => [],
            'startPrompt' => 'GO', 'startDocuments' => [], 'agents' => [
            '2' => ['name' => 'R', 'systemPrompt' => 's', 'provider' => 'claude', 'model' => 'm',
                'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '',
                'skills' => [['dir' => 'GEO/geo-report']], 'output_schema_id' => null, 'documents' => []]]]);
        $code = \AgentTeam\Services\ADKGenerator::emitAdk($a);
        $this->assertStringContainsString('def _make_skill_tool(', $code);
    }
}
