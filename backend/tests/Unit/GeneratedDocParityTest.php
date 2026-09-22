<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Models\Workflow;
use AgentTeam\Services\ADKGenerator;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\MAFGenerator;
use AgentTeam\Services\NOOAGenerator;
use AgentTeam\Services\WorkflowGraphAnalyzer;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;

/**
 * Every compile target documents the generated script the same way, for any
 * workflow shape: PROVENANCE, GRAPH NODES, GRAPH EDGES, EXECUTION ORDER,
 * DATA FLOW, TO RUN in the module docstring, and a uniform comment block
 * before each node definition. Also pins the analyzer fix that made
 * editor-saved agent nodes (DB node_type '') vanish from ADK/MAF/NOOA.
 */
class GeneratedDocParityTest extends TestCase
{
    private const PLAYBOOK = "Title: Time Off\n\nTrigger: PTO.\n\nInstructions:\n1. #Get PTO Balance for the requester.\n2. #Request Approval from the manager then #Resolve Request.\n\nTools used: Workday\n\nActions used: #Get PTO Balance; #Request Approval; #Resolve Request\n";

    /** The Dispatcher-demo shape, with the '' node_type the editor really saves. */
    private function graph(): array
    {
        $agent = fn(string $name, string $type = 'standard') => [
            'type' => 'agent-template', 'agent_name' => $name, 'agent_type' => $type,
            'instructions' => "You are {$name}.", 'agent_provider' => 'claude', 'model' => 'claude-sonnet-4-5',
            'tools' => [], 'settings' => ['temperature' => 0.7, 'max_tokens' => 4096],
        ];
        return [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'I want to take some vacations']],
                ['id' => '2', 'node_type' => '', 'config' => $agent('techBuddy', 'dispatcher')],
                ['id' => '3', 'node_type' => '', 'config' => $agent('IT claims')],
                ['id' => '4', 'node_type' => '', 'config' => $agent('Human resources')],
                ['id' => '5', 'node_type' => 'playbook', 'config' => ['type' => 'playbook', 'name' => 'Playbook HR',
                    'playbook' => self::PLAYBOOK, 'agent_provider' => 'deepseek', 'model' => 'deepseek-v4-flash', 'writes_enabled' => true]],
                ['id' => '6', 'node_type' => 'output', 'config' => ['type' => 'output']],
            ],
            'edges' => [
                ['from' => '1', 'to' => '2'], ['from' => '2', 'to' => '3'], ['from' => '2', 'to' => '4'],
                ['from' => '3', 'to' => '6'], ['from' => '4', 'to' => '5'], ['from' => '5', 'to' => '6'],
            ],
        ];
    }

    private function pdo(): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (85, '3', 'Workday', 'http://localhost/mockstack/index.php/workday', 1)");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 85, 'get_pto_balance', 'Get balances', '{\"type\":\"object\",\"properties\":{\"email\":{\"type\":\"string\"}}}')");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)");
        return $pdo;
    }

    /** @return array<string,string> target => generated code */
    private function generateAll(): array
    {
        $pdo = $this->pdo();
        $wfRepo = $this->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Dispatcher demo', 'user_id' => '3']));
        $graphRepo = $this->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn($this->graph());
        $agentRepo = $this->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        $out = [];
        foreach (['LangGraph' => LangGraphGenerator::class, 'ADK' => ADKGenerator::class,
                  'MAF' => MAFGenerator::class, 'NOOA' => NOOAGenerator::class] as $label => $cls) {
            $out[$label] = (new $cls($pdo, $wfRepo, $graphRepo, $agentRepo))->generate(44, '3')['code'];
        }
        return $out;
    }

    public function testAnalyzerReadsEmptyNodeTypeFromConfig(): void
    {
        $this->assertSame('agent-template', WorkflowGraphAnalyzer::typeOf(['node_type' => '', 'config' => ['type' => 'agent-template']]));
        $this->assertSame('playbook', WorkflowGraphAnalyzer::typeOf(['node_type' => 'playbook', 'config' => ['type' => 'agent']]));
        $this->assertSame('agent', WorkflowGraphAnalyzer::typeOf(['config' => []]));
    }

    public function testEveryTargetCarriesTheSameDocumentationSections(): void
    {
        foreach ($this->generateAll() as $target => $code) {
            $doc = substr($code, 0, strpos($code, '"""', 3));
            foreach (['PROVENANCE', 'GRAPH NODES', 'GRAPH EDGES', 'EXECUTION ORDER', 'DATA FLOW', 'TO RUN',
                      'Workflow:   Dispatcher demo (id 44)', 'This file is a frozen snapshot',
                      'techBuddy -- claude/claude-sonnet-4-5, temp 0.7, max_tokens 4096, 0 tool(s), DISPATCHER -> one of: IT claims | Human resources',
                      'Start (1) -> techBuddy (2)', 'techBuddy (2) -> IT claims (3)   (dispatcher menu:',
                      'layer 2:  IT claims  ||  Human resources',
                      'ANTHROPIC_API_KEY (claude)', 'Output storage (Output node setting): OFF'] as $needle) {
                $this->assertStringContainsString($needle, $doc, "{$target}: docstring lacks {$needle}");
            }
            $this->assertMatchesRegularExpression('/Generated:  \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ by the SynergyAI workflow editor/', $doc, $target);
            // Uniform per-node comment block before every agent definition.
            $this->assertStringContainsString('# ---- node 2: techBuddy (agent-template) ', $code, $target);
            $this->assertStringContainsString('#   provider/model : claude / claude-sonnet-4-5   temp 0.7   max_tokens 4096   thinking default', $code, $target);
            $this->assertStringContainsString('#   dispatcher     : routes to one of: IT claims | Human resources', $code, $target);
            $this->assertStringContainsString('#   children       : IT claims (3) | Human resources (4)', $code, $target);
            $this->assertStringContainsString('#   parents        : techBuddy (2)', $code, $target);
        }
    }

    public function testAgentsWithEmptyDbNodeTypeCompileOnEveryTarget(): void
    {
        foreach ($this->generateAll() as $target => $code) {
            $this->assertStringContainsString('You are Human resources.', $code, "{$target} lost the agent node");
        }
    }

    public function testPlaybookAndDispatcherSupportIsStatedHonestly(): void
    {
        $all = $this->generateAll();
        $lg = $all['LangGraph'];
        $this->assertStringContainsString('playbook "Time Off", 1 bound / 0 unbound action(s), writes ON', $lg);
        $this->assertStringContainsString('(dispatcher: only the chosen one runs)', $lg);
        // Both node kinds now run on every target, and none of them may still
        // claim otherwise. Each target reaches them its own way -- nested
        // sub_agents, a routed message, an if/elif -- but the interpreter and
        // the menu semantics are one shared implementation, so the honest
        // statement is the same everywhere.
        foreach (['LangGraph', 'ADK', 'MAF', 'NOOA'] as $t) {
            $code = $all[$t];
            $this->assertStringNotContainsString('NOT RUN BY THIS TARGET', $code, $t);
            $this->assertStringNotContainsString('menu NOT honoured by this target', $code, $t);
            $this->assertStringNotContainsString('dispatcher menu not honoured by this target', $code, $t);
            $this->assertStringContainsString('PLAYBOOK_GATE_MODE', $code, "{$t}: the playbook gates must be reachable");
            $this->assertStringContainsString('DEEPSEEK_API_KEY', $code, "{$t}: the playbook node's provider key belongs in the run notes");
        }
        // The three ported targets carry the shared interpreter verbatim;
        // LangGraph calls it through its own node machinery instead.
        foreach (['ADK', 'MAF', 'NOOA'] as $t) {
            $this->assertStringContainsString('async def run_playbook_node(', $all[$t], $t);
            $this->assertStringContainsString('PLAYBOOKS = {', $all[$t], $t);
            $this->assertStringContainsString('pip install langchain-core langgraph', $all[$t], "{$t}: the interpreter's requirement must be stated");
        }
    }

    /**
     * Every target ROUTES the menu: a dispatcher's children must be reachable
     * only through the choice, never scheduled beside one another. Each target
     * expresses that differently -- a conditional edge (LangGraph), nested
     * sub_agents (ADK), a routed message (MAF), an if/elif chain (NOOA) -- so
     * the assertions are per target, but the rule behind them is one rule.
     */
    public function testEveryTargetRoutesTheDispatcherMenu(): void
    {
        $all = $this->generateAll();
        $this->assertStringContainsString('add_conditional_edges', $all['LangGraph']);
        // ADK: the menu is nested under the dispatcher, so the children are NOT
        // layer members -- a ParallelAgent over them would be the fan-out again.
        $adk = $all['ADK'];
        $this->assertStringContainsString('_DispatcherAgent(', $adk);
        $this->assertStringContainsString('IT claims', $adk);
        $this->assertStringNotContainsString('ParallelAgent(name="layer_2"', $adk);
        // MAF: the edges stay drawn; the choice travels in the message.
        $maf = $all['MAF'];
        $this->assertStringContainsString('DispatcherNodeExecutor(', $maf);
        $this->assertStringContainsString('route_to', $maf);
        // NOOA: one explicit branch per menu entry, and no gather over them.
        $nooa = $all['NOOA'];
        $this->assertStringContainsString('run_dispatcher(', $nooa);
        $this->assertStringContainsString('routes to EXACTLY ONE of', $nooa);
    }

    /**
     * No target may reference a module global it never defines.
     *
     * py_compile does NOT catch this -- a NameError is a runtime failure, so a
     * generated script imports and dies on the first call. It bit exactly once
     * and in the way you would expect: the playbook interpreter reuses
     * LangGraph's model factory, that factory reads MODEL_NAME_OVERRIDE, and
     * the three ported targets had never defined it. A block moved between
     * generators brings its globals with it or it breaks, and that is what this
     * test pins.
     *
     * The allowlist is the set of names the runtime deliberately probes for and
     * guards (try/except NameError, or "x in globals()"): the event sink and
     * gate rendezvous exist only when a host installed them.
     */
    public function testNoTargetReferencesAnUndefinedGlobal(): void
    {
        $allowed = ['SkillRuntime', '_CURRENT_NODE', '_SINK', '__file__',
                    'emit_event', 'open_gate', 'take_gate_answer'];
        $checker = <<<'PYCODE'
import ast, builtins, sys
tree = ast.parse(open(sys.argv[1]).read())
known = set(dir(builtins))
for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        known.add(node.name)
    elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
        known.add(node.id)
    elif isinstance(node, (ast.Import, ast.ImportFrom)):
        for a in node.names:
            known.add((a.asname or a.name).split(".")[0])
    elif isinstance(node, ast.ExceptHandler) and node.name:
        known.add(node.name)
    elif isinstance(node, ast.arg):
        known.add(node.arg)
    elif isinstance(node, ast.Global):
        known.update(node.names)
used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
print(" ".join(sorted(used - known)))
PYCODE;
        $checkerPath = tempnam(sys_get_temp_dir(), 'chk') . '.py';
        file_put_contents($checkerPath, $checker);
        foreach ($this->generateAll() as $target => $code) {
            $tmp = tempnam(sys_get_temp_dir(), 'gen') . '.py';
            file_put_contents($tmp, $code);
            $out = [];
            exec('python3 ' . escapeshellarg($checkerPath) . ' ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
            @unlink($tmp);
            $this->assertSame(0, $rc, "{$target}: checker failed: " . implode("\n", $out));
            $names = array_values(array_diff(preg_split('/\s+/', trim(implode(' ', $out)), -1, PREG_SPLIT_NO_EMPTY), $allowed));
            $this->assertSame([], $names,
                "{$target} references globals it never defines: " . implode(', ', $names));
        }
        @unlink($checkerPath);
    }

    public function testEveryTargetStillEmitsValidPython(): void
    {
        foreach ($this->generateAll() as $target => $code) {
            $tmp = tempnam(sys_get_temp_dir(), 'gen') . '.py';
            file_put_contents($tmp, $code);
            exec('python3 -m py_compile ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
            @unlink($tmp);
            $this->assertSame(0, $rc, "{$target}: " . implode("\n", $out));
        }
    }
}
