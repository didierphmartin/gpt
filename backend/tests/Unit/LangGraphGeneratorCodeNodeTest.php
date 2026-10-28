<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\StartOptionGraph;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;

/** LangGraph compiler: code nodes (single file + modular), refused by other packagings. */
class LangGraphGeneratorCodeNodeTest extends TestCase
{
    private function pdo(): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (85, '3', 'ServiceNow', 'http://localhost/servicenow/?profile=mock&toolset=jobs', 1)");
        $pdo->exec("INSERT INTO mcp_servers VALUES (9, NULL, 'Global News', 'http://localhost/news/', 1)");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 85, 'poll_jobs', 'Poll', '{}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (3, 9, 'get_news', 'News', '{}')");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('deepseek', 'deepseek-v4-flash', 1)");
        return $pdo;
    }

    private function generate(array $graph, ?string $userId = '3'): string
    {
        return $this->generateWith($graph, [], $userId)['code'];
    }

    private function generateWith(array $graph, array $options, ?string $userId = '3'): array
    {
        $pdo = $this->pdo();
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Dispatcher demo', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($graph);
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        $gen = new LangGraphGenerator($pdo, $wfRepo, $graphRepo, $agentRepo);
        return $gen->generate(44, $userId, $options);
    }

    private function codeGraph(): array
    {
        return [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'poll']],
                ['id' => '2', 'node_type' => 'code', 'config' => ['type' => 'code', 'name' => 'Poll ServiceNow',
                    'code' => "def run(input, call_tool):\n    r = call_tool('servicenow', 'poll_jobs', {})\n    if r.get('job') is None:\n        return {'route': 'no_job', 'output': None}\n    return {'route': 'job', 'output': r['job']}\n",
                    'exits' => ['job', 'no_job'], 'mcp_servers' => ['ServiceNow'], 'timeout_s' => 30]],
                ['id' => '3', 'node_type' => 'output', 'config' => ['type' => 'output']],
                ['id' => '4', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [
                ['from' => '1', 'to' => '2', 'from_port' => 'output_1'],
                ['from' => '2', 'to' => '3', 'from_port' => 'output_1'],
                ['from' => '2', 'to' => '4', 'from_port' => 'output_2'],
            ],
        ];
    }

    public function testSingleFileBakesTheCodeNode(): void
    {
        $code = $this->generate($this->codeGraph());
        self::assertStringContainsString('CODE_NODES = {', $code);
        self::assertStringContainsString('"exit_targets": {"job":["3"],"no_job":["4"]}', $code);
        self::assertMatchesRegularExpression('~MCP_SLUGS = \{\s*"servicenow": "http://localhost/servicenow/\?profile=mock&toolset=jobs"\s*\}~', $code);
        self::assertStringContainsString('class CodeNode(Node):', $code);
        self::assertStringContainsString('CODE_HARNESS = types.ModuleType("code_node_harness")', $code);
        self::assertStringContainsString('"2": "code"', $code);
        self::assertStringContainsString('{**AGENTS, **PLAYBOOKS, **CODE_NODES}', $code);
        // the code node is documented like an agent: a comment block before its entry, with its declared tool
        self::assertMatchesRegularExpression('~CODE_NODES = \{\n    # ---- node 2: Poll ServiceNow \(code\) -+\n    #   tools          : servicenow\.\*\n(    #[^\n]*\n)*    "2": \{~', $code);
        $file = tempnam(sys_get_temp_dir(), 'lgcn') . '.py';
        file_put_contents($file, $code);
        exec('python3 -m py_compile ' . escapeshellarg($file) . ' 2>&1', $out, $rc);
        self::assertSame(0, $rc, implode("\n", $out));
    }

    public function testWorkflowsWithoutCodeNodesAreUnchanged(): void
    {
        $graph = ['nodes' => [$this->codeGraph()['nodes'][0], $this->codeGraph()['nodes'][2]],
                  'edges' => [['from' => '1', 'to' => '3', 'from_port' => 'output_1']]];
        $code = $this->generate($graph);
        self::assertStringNotContainsString('CODE_HARNESS', $code);
        self::assertStringNotContainsString('class CodeNode', $code);
    }

    public function testUnsupportedPackagingsRefuse(): void
    {
        foreach ([['a2a' => true]] as $opts) {
            try {
                $this->generateWith($this->codeGraph(), $opts);
                self::fail('A2A accepted a code node');
            } catch (\RuntimeException $e) {
                self::assertStringContainsString('Code nodes are not supported by the A2A', $e->getMessage());
            }
        }
    }

    public function testModularBakesACodeModule(): void
    {
        $files = $this->generateWith($this->codeGraph(), ['modular' => true])['files'];
        $byPath = array_column($files, 'code', 'path');
        $module = $byPath['agents/poll_servicenow.py'] ?? '';
        self::assertStringContainsString('"kind": "code"', $module);
        self::assertStringContainsString('run_node = make_node(NODE).run', $module);
        self::assertStringContainsString('class CodeNode(Node):', $byPath['common.py']);
        self::assertStringContainsString('MCP_SLUGS = ', $byPath['common.py']);
        self::assertStringContainsString('"exit_targets": {"job":["3"],"no_job":["4"]}', $byPath['workflow.py']);
    }

    public function testADispatchersCodeChildIsOnItsMenu(): void
    {
        // A code child of a dispatcher runs only when the dispatcher picks it (as in the editor).
        $g = $this->codeGraph();
        $g['nodes'][] = ['id' => '9', 'node_type' => '', 'config' => ['type' => 'agent-template', 'agent_name' => 'Front desk',
            'agent_type' => 'dispatcher', 'instructions' => 'Route.', 'agent_provider' => 'claude', 'model' => 'claude-sonnet-4-6',
            'tools' => [], 'settings' => ['temperature' => 0.7, 'max_tokens' => 4096]]];
        $g['edges'] = [['from' => '1', 'to' => '9', 'from_port' => 'output_1'], ['from' => '9', 'to' => '2', 'from_port' => 'output_1'],
                       ['from' => '2', 'to' => '3', 'from_port' => 'output_1'], ['from' => '2', 'to' => '4', 'from_port' => 'output_2']];
        $code = $this->generate($g);
        self::assertStringContainsString('"dispatch": [{"id": "2", "name": "Poll ServiceNow", "description": ""}]', $code);
        $byPath = array_column($this->generateWith($g, ['modular' => true])['files'], 'code', 'path');
        self::assertStringContainsString('"dispatch": [{"id":"2","name":"Poll ServiceNow"}]', $byPath['workflow.py']);
    }
    /** A code node's arguments (a component's settings) and a Start option's Start args reach the compiled code as ARGS. */
    public function testArgumentsAreCompiledIn(): void
    {
        $g = $this->codeGraph();
        $g['nodes'][1]['config']['args'] = ['folder' => 'Didier'];
        $code = $this->generate($g);
        self::assertStringContainsString('"args": {"folder":"Didier"}', $code);

        $raw = ['nodes' => [
                ['id' => '17', 'node_type' => 'start', 'config' => ['type' => 'start', 'start_option' => 5,
                    'start_args' => ['folder' => 'To SharePoint', 'done_folder' => 'Filed']]],
                ['id' => '18', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ], 'edges' => [['from_node_id' => '17', 'to_node_id' => '18', 'from_port' => 'output_1']]];
        $opt = StartOptionGraph::expand($raw, fn(int $id) => ['name' => 'Outlook: get dropped email',
            'code' => "def run(input, call_tool):\n    return {'route': 'mail', 'output': ARGS}\n",
            'exits' => ['mail', 'no_mail'], 'mcp_servers' => ['ServiceNow'], 'timeout_s' => 30,
            'start_trigger' => ['label' => 'Outlook: get dropped email', 'work_exit' => 'mail']]);
        self::assertStringContainsString('"args": {"folder":"To SharePoint","done_folder":"Filed"}', $this->generate($opt));
    }

    /**
     * The argument declarations are compiled in as Python (a "required": true declaration imports: no NameError
     * on true), in both packagings, and the node's run fills ARGS from its parents' meta and the declared default.
     */
    public function testNodeLiteralHasArgDeclsAndExecutePassesMeta(): void
    {
        $g = $this->codeGraph();
        $g['nodes'][1]['config']['arg_decls'] = [['name' => 'folder', 'required' => true], ['name' => 'note', 'default' => null]];
        $g['nodes'][1]['config']['args'] = ['flag' => false];
        $code = $this->generate($g);
        self::assertStringContainsString('"arg_decls": [{"name":"folder","required":True},{"name":"note","default":None}]', $code);
        self::assertStringContainsString('"args": {"flag":False}', $code);
        self::assertStringContainsString('meta=CODE_HARNESS.received_meta(', $code);
        self::assertStringContainsString('"arg_decls": []', $this->generate($this->codeGraph()));
        $dir = sys_get_temp_dir() . '/lgdecl' . uniqid();
        mkdir("$dir/single", 0777, true);
        file_put_contents("$dir/single/wf.py", $code);
        foreach ($this->generateWith($g, ['modular' => true])['files'] as $f) {
            if (str_ends_with($f['path'], '.py')) {
                @mkdir(dirname("$dir/modular/{$f['path']}"), 0777, true);
                file_put_contents("$dir/modular/{$f['path']}", $f['code']);
            }
        }
        exec('python3 -m compileall -q ' . escapeshellarg($dir) . ' 2>&1', $out, $rc);
        self::assertSame(0, $rc, implode("\n", $out));
        // the NODE literals evaluate: the declarations come back as Python values
        exec('python3 -c ' . escapeshellarg('import re,sys; s=open(sys.argv[1]).read(); '
            . 'print(eval(re.search(r\'"arg_decls": (\\[.*\\]),   #\', s).group(1)))') . ' ' . escapeshellarg("$dir/single/wf.py") . ' 2>&1', $ev, $rc);
        self::assertSame(0, $rc, implode("\n", $ev));
        exec('rm -rf ' . escapeshellarg($dir));
        self::assertSame("[{'name': 'folder', 'required': True}, {'name': 'note', 'default': None}]", implode("\n", $ev));
    }

    /** A compiled node whose argument is required and declared with a default runs with that default in ARGS. */
    public function testTheCompiledRunAppliesADeclaredDefault(): void
    {
        $venv = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';
        if (!is_executable($venv)) {
            self::markTestSkipped('venv python missing');
        }
        $g = $this->codeGraph();
        $g['nodes'][1]['config'] = ['type' => 'code', 'name' => 'Echo args', 'exits' => ['next'], 'mcp_servers' => [],
            'timeout_s' => 30, 'args' => [],
            'arg_decls' => [['name' => 'folder', 'default' => 'Inbox', 'required' => true]],
            'code' => "def run(input, call_tool):\n    return 'folder=' + str(ARGS.get('folder'))\n"];
        $g['edges'] = [['from' => '1', 'to' => '2', 'from_port' => 'output_1'], ['from' => '2', 'to' => '3', 'from_port' => 'output_1']];
        array_pop($g['nodes']);
        $dir = sys_get_temp_dir() . '/lgdflt' . uniqid();
        mkdir($dir);
        file_put_contents("$dir/wf.py", $this->generate($g));
        exec('cd ' . escapeshellarg($dir) . ' && RUNS_DIR=' . escapeshellarg("$dir/runs") . ' ' . escapeshellarg($venv)
            . ' wf.py --once go 2>&1', $out, $rc);
        exec('rm -rf ' . escapeshellarg($dir));
        self::assertSame(0, $rc, implode("\n", $out));
        self::assertStringContainsString('folder=Inbox', implode("\n", $out));
    }

    /** The compiled script hands the arguments to run() (the same ARGS the editor and the server give it). */
    public function testTheCompiledCodeReadsItsArguments(): void
    {
        $venv = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';
        if (!is_executable($venv)) {
            self::markTestSkipped('venv python missing');
        }
        $g = $this->codeGraph();
        $g['nodes'][1]['config'] = ['type' => 'code', 'name' => 'Echo args', 'exits' => ['next'], 'mcp_servers' => [],
            'timeout_s' => 30, 'args' => ['folder' => 'Didier'],
            'code' => "def run(input, call_tool):\n    return 'folder=' + str(ARGS.get('folder'))\n"];
        $g['edges'] = [['from' => '1', 'to' => '2', 'from_port' => 'output_1'], ['from' => '2', 'to' => '3', 'from_port' => 'output_1']];
        array_pop($g['nodes']);
        $dir = sys_get_temp_dir() . '/lgargs' . uniqid();
        mkdir($dir);
        file_put_contents("$dir/wf.py", $this->generate($g));
        exec('cd ' . escapeshellarg($dir) . ' && RUNS_DIR=' . escapeshellarg("$dir/runs") . ' ' . escapeshellarg($venv)
            . ' wf.py --once go 2>&1', $out, $rc);
        exec('rm -rf ' . escapeshellarg($dir));
        self::assertSame(0, $rc, implode("\n", $out));
        self::assertStringContainsString('folder=Didier', implode("\n", $out));
    }
    /**
     * The Output takes a node once, and only through the exit it took (as the editor and the server runner do):
     * Convert(2) took done -> Store(5); its error link to the Output carries nothing, and Store's two exits
     * linked to the same Output give one answer, verbatim.
     */
    public function testTheOutputTakesANodeOnceAndOnlyThroughTheExitItTook(): void
    {
        $venv = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';
        if (!is_executable($venv)) {
            self::markTestSkipped('venv python missing');
        }
        $code = fn(string $route, string $text) => ['type' => 'code', 'exits' => ['done', 'error'], 'mcp_servers' => [], 'timeout_s' => 30,
            'code' => "def run(input, call_tool):\n    return {'route': '$route', 'output': '$text'}\n"];
        $g = ['nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'go']],
                ['id' => '2', 'node_type' => 'code', 'config' => ['name' => 'Convert'] + $code('done', 'PACKAGE')],
                ['id' => '5', 'node_type' => 'code', 'config' => ['name' => 'Store'] + $code('done', 'STORED')],
                ['id' => '3', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ], 'edges' => [
                ['from' => '1', 'to' => '2', 'from_port' => 'output_1'],
                ['from' => '2', 'to' => '5', 'from_port' => 'output_1'],
                ['from' => '2', 'to' => '3', 'from_port' => 'output_2'],
                ['from' => '5', 'to' => '3', 'from_port' => 'output_1'],
                ['from' => '5', 'to' => '3', 'from_port' => 'output_2'],
            ]];
        $dir = sys_get_temp_dir() . '/lgout' . uniqid();
        mkdir($dir);
        file_put_contents("$dir/wf.py", $this->generate($g));
        exec('cd ' . escapeshellarg($dir) . ' && RUNS_DIR=' . escapeshellarg("$dir/runs") . ' ' . escapeshellarg($venv)
            . ' wf.py --once go 2>&1', $out, $rc);
        $text = implode("\n", $out);
        self::assertSame(0, $rc, $text);
        self::assertMatchesRegularExpression('~FINAL OUTPUT\n=+\nSTORED\n~', $text);
        self::assertStringNotContainsString('PACKAGE', substr($text, strpos($text, 'FINAL OUTPUT')));
    }

    /**
     * A branch that was not taken is not a parent: Check(2) took no_mail straight to the Output, so File(5),
     * also linked to the Output, never ran and the answer is Check's text verbatim (no "## Check" heading).
     */
    public function testABranchNotTakenIsNotAParentOfTheOutput(): void
    {
        $venv = '/Users/didierphmartin/Documents/synergyAI/python/.venv/bin/python';
        if (!is_executable($venv)) {
            self::markTestSkipped('venv python missing');
        }
        $code = fn(array $exits, string $route, string $text) => ['type' => 'code', 'exits' => $exits, 'mcp_servers' => [],
            'timeout_s' => 30, 'code' => "def run(input, call_tool):\n    return {'route': '$route', 'output': '$text'}\n"];
        $g = ['nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'go']],
                ['id' => '2', 'node_type' => 'code', 'config' => ['name' => 'Check'] + $code(['new_mail', 'no_mail'], 'no_mail', 'NO MAIL')],
                ['id' => '5', 'node_type' => 'code', 'config' => ['name' => 'File'] + $code(['next'], 'next', 'FILED')],
                ['id' => '3', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ], 'edges' => [
                ['from' => '1', 'to' => '2', 'from_port' => 'output_1'],
                ['from' => '2', 'to' => '5', 'from_port' => 'output_1'],
                ['from' => '2', 'to' => '3', 'from_port' => 'output_2'],
                ['from' => '5', 'to' => '3', 'from_port' => 'output_1'],
            ]];
        $dir = sys_get_temp_dir() . '/lgout' . uniqid();
        mkdir($dir);
        file_put_contents("$dir/wf.py", $this->generate($g));
        exec('cd ' . escapeshellarg($dir) . ' && RUNS_DIR=' . escapeshellarg("$dir/runs") . ' ' . escapeshellarg($venv)
            . ' wf.py --once go 2>&1', $out, $rc);
        $text = implode("\n", $out);
        self::assertSame(0, $rc, $text);
        self::assertMatchesRegularExpression('~FINAL OUTPUT\n=+\nNO MAIL\n~', $text);
    }
}
