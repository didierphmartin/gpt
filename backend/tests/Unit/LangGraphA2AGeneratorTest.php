<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Tests\Unit;

use PHPUnit\Framework\TestCase;
use AgentTeam\Models\Workflow;
use AgentTeam\Services\AgentRepository;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\WorkflowGraphRepository;
use AgentTeam\Services\WorkflowRepository;

/**
 * LangGraph compiler, A2A mode: one self-contained A2A agent server per
 * agent/playbook node under agents/, one orchestrator.py driving them.
 */
class LangGraphA2AGeneratorTest extends TestCase
{
    public const PLAYBOOK = "Title: Time Off\n\nTrigger: PTO.\n\nInstructions:\n1. #Get PTO Balance for the requester.\n2. #Request Approval from the manager then #Resolve Request.\n\nTools used: Workday\n\nActions used: #Get PTO Balance; #Request Approval; #Resolve Request\n";

    public static function pdo(): \PDO
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)');
        $pdo->exec('CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)');
        $pdo->exec('CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)');
        $pdo->exec("INSERT INTO mcp_servers VALUES (85, '3', 'Workday', 'http://localhost/mockstack/index.php/workday', 1)");
        $pdo->exec("INSERT INTO mcp_servers VALUES (9, NULL, 'News', 'http://localhost/news/', 1)");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (1, 85, 'get_pto_balance', 'Get balances', '{\"type\":\"object\",\"properties\":{\"email\":{\"type\":\"string\"}}}')");
        $pdo->exec("INSERT INTO mcp_server_tools VALUES (2, 9, 'get_news', 'News', '{}')");
        $pdo->exec("INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)");
        return $pdo;
    }

    /** Dispatcher-demo shape: start -> dispatcher -> {IT claims, Human resources -> playbook} -> output. */
    public static function graph(): array
    {
        $agent = fn(string $name, string $type = 'standard', array $tools = [], array $extra = []) => [
            'type' => 'agent-template', 'agent_name' => $name, 'agent_type' => $type,
            'instructions' => "You are {$name}.", 'agent_provider' => 'claude', 'model' => 'claude-sonnet-4-5',
            'tools' => $tools, 'settings' => ['temperature' => 0.7, 'max_tokens' => 4096],
        ] + $extra;
        return [
            'nodes' => [
                ['id' => '1', 'node_type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'I want to take some vacations']],
                ['id' => '2', 'node_type' => '', 'config' => $agent('techBuddy', 'dispatcher')],
                // Skill-bound (html): run_skill_script must be baked into the tool
                // catalog and "skills" onto NODE (see testAgentFileIsASelfContainedA2AServer).
                ['id' => '3', 'node_type' => '', 'config' => $agent('IT claims', 'standard', ['mcp_get_news', 'run_skill_script'],
                    ['bound_skill' => ['dir_name' => 'html']])],
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

    public static function generator(): LangGraphGenerator
    {
        $t = new self('x');
        $wfRepo = $t->createMock(WorkflowRepository::class);
        $wfRepo->method('findById')->willReturn(new Workflow(['id' => 44, 'name' => 'Dispatcher demo', 'user_id' => '3']));
        $graphRepo = $t->createMock(WorkflowGraphRepository::class);
        $graphRepo->method('getGraph')->willReturn(self::graph());
        $agentRepo = $t->createMock(AgentRepository::class);
        $agentRepo->method('findById')->willReturn(null);
        return new LangGraphGenerator(self::pdo(), $wfRepo, $graphRepo, $agentRepo);
    }

    /** Facts as analyzeForEmit() returns them (private): reached through reflection. */
    public static function facts(): array
    {
        $gen = self::generator();
        $m = new \ReflectionMethod($gen, 'analyzeForEmit');
        $m->setAccessible(true);
        return $m->invoke($gen, 44, '3');
    }

    public function testLayoutNamesOneAgentFilePerAgentOrPlaybookNode(): void
    {
        $layout = LangGraphGenerator::a2aLayout(self::facts());
        $this->assertSame('dispatcher_demo_a2a', $layout['root']);
        // PHP coerces canonical-decimal string keys ("2", "3", ...) to int on array
        // assignment, so array_keys() always returns ints here regardless of how
        // a2aLayout() builds the array; normalise before the strict comparison.
        $this->assertSame(['2', '3', '4', '5'], array_map('strval', array_keys($layout['agents'])), 'ORDER order, no start/output');
        $this->assertSame('agents/2_techbuddy.py', $layout['agents']['2']['file']);
        $this->assertSame('agents/4_human-resources.py', $layout['agents']['4']['file']);
        $this->assertSame('agents/5_playbook-hr.py', $layout['agents']['5']['file']);
        $this->assertSame([8701, 8702, 8703, 8704], array_column($layout['agents'], 'port'));
        $this->assertSame('dispatcher', $layout['agents']['2']['kind']);
        $this->assertSame('agent', $layout['agents']['3']['kind']);
        $this->assertSame('playbook', $layout['agents']['5']['kind']);
    }

    public function testSingleFileOutputUnchangedWithoutOption(): void
    {
        $code = self::generator()->generate(44, '3')['code'];
        $this->assertStringContainsString('"""Standalone LangGraph workflow: Dispatcher demo', $code);
        $this->assertStringContainsString('PLAYBOOKS = {', $code);
    }

    private function agentFile(string $nid): string
    {
        $gen = self::generator();
        $facts = self::facts();
        $m = new \ReflectionMethod($gen, 'emitA2AAgentFile');
        $m->setAccessible(true);
        return $m->invoke($gen, $facts, LangGraphGenerator::a2aLayout($facts), $nid);
    }

    private function assertCompiles(string $code, string $label): void
    {
        $base = tempnam(sys_get_temp_dir(), 'a2a');
        $tmp = $base . '.py';
        file_put_contents($tmp, $code);
        exec('python3 -m py_compile ' . escapeshellarg($tmp) . ' 2>&1', $out, $rc);
        @unlink($tmp);
        @unlink($base);
        $this->assertSame(0, $rc, "{$label}: " . implode("\n", $out));
    }

    public function testAgentFileIsASelfContainedA2AServer(): void
    {
        $code = $this->agentFile('3');
        foreach (['"""A2A agent "IT claims" -- node 3 of workflow "Dispatcher demo"',
                  'from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes',
                  'new_task_from_user_message', 'class NodeExecutor(AgentExecutor)', 'def build_agent_card',
                  'AGENT_CARD = build_agent_card(', 'Skill id:   node-3', 'def _make_llm(', 'def _call_mcp_tool(',
                  'def build_tools_from_catalog', 'async def run_node(', 'uvicorn.run(', '"--port"',
                  '# ---- node 3: IT claims (agent-template)', 'NODE = {', '"kind": "agent"',
                  '<== this agent', 'A2A SERVING', 'A2A_GATE_TIMEOUT_S',
                  // A follow-up on a task with no paused run (completed/expired) must be rejected,
                  // not silently started as a second run under the same task id (live-run fix).
                  'task {tid} is not waiting for input'] as $needle) {
            $this->assertStringContainsString($needle, $code, "missing: {$needle}");
        }
        // Only this node's tools are baked.
        $this->assertStringContainsString('"get_news"', $code);
        $this->assertStringNotContainsString('get_pto_balance', $code);
        // No playbook runtime in a plain agent file.
        $this->assertStringNotContainsString('def build_playbook_tools', $code);
        // Skill-bound node: run_skill_script is registered into the catalog (the
        // local, non-MCP tool build_tools_from_catalog() itself never produces)
        // and the skill binding is baked onto NODE.
        $this->assertStringContainsString('catalog["run_skill_script"] = RUN_SKILL_SCRIPT_TOOL', $code);
        $this->assertStringContainsString('"skills": [{"dir":"html"}]', $code);
        $this->assertCompiles($code, 'agent 3');
    }

    public function testDispatcherAgentFileCarriesTheMenu(): void
    {
        $code = $this->agentFile('2');
        $this->assertStringContainsString('"kind": "dispatcher"', $code);
        $this->assertStringContainsString('"dispatch": [{"id": "3", "name": "IT claims"}, {"id": "4", "name": "Human resources"}]', $code);
        $this->assertStringContainsString('async def _run_dispatcher(', $code);
        $this->assertStringContainsString('## Routing', $code);
        $this->assertCompiles($code, 'agent 2');
    }

    public function testPlaybookAgentFileBridgesGatesToA2A(): void
    {
        $code = $this->agentFile('5');
        $this->assertStringContainsString('"kind": "playbook"', $code);
        $this->assertStringContainsString('def build_playbook_tools', $code);
        $this->assertStringContainsString('"workday__get_pto_balance"', $code);
        $this->assertStringContainsString('def _a2a_gate(run, kind: str, name: str, args: dict) -> dict:', $code);
        $this->assertStringContainsString('_playbook_gate = _a2a_gate', $code);
        $this->assertStringContainsString('requires_input(', $code);
        $this->assertCompiles($code, 'agent 5');
    }

    private function orchestrator(): string
    {
        $gen = self::generator();
        $facts = self::facts();
        $m = new \ReflectionMethod($gen, 'emitA2AOrchestrator');
        $m->setAccessible(true);
        return $m->invoke($gen, $facts, LangGraphGenerator::a2aLayout($facts));
    }

    public function testOrchestratorDrivesAgentsOverA2A(): void
    {
        $code = $this->orchestrator();
        foreach (['"""A2A orchestrator for workflow "Dispatcher demo"', 'AGENT ENDPOINTS', 'A2A RUN',
                  'from a2a.client import create_client, ClientConfig', 'class AgentSupervisor', 'async def _run_remote_node(',
                  'def _handle_gate(', 'add_conditional_edges', 'A2A_AGENT_2_URL', '"file": "agents/2_techbuddy.py"',
                  '"port": 8701', '--keep-serving', '--no-spawn', 'TASK_STATE_INPUT_REQUIRED', '[gate] ', '[gate-answer] ',
                  '# ---- node 2: techBuddy (agent-template)', 'elif ntype in ("agent", "playbook"):', 'PLAYBOOK_GATE_MODE',
                  // AGENTS dict keys must be strings ("2", not 2) so they match ORDER/NODE_TYPES/state (live-run fix).
                  '    "2": {"display": "techBuddy"',
                  // Documentation nits from the Task 3 review: docstrings + the NODE_DURATIONS comment.
                  "def _is_local(url: str) -> bool:\n    \"\"\"True when `url` is a loopback address",
                  "def _stream_kind(ev: \"T.StreamResponse\") -> str:\n    \"\"\"Which oneof field is set",
                  'NODE_DURATIONS = {}   # display name -> seconds of A2A round trip (RUN SUMMARY)'] as $needle) {
            $this->assertStringContainsString($needle, $code, "missing: {$needle}");
        }
        $this->assertStringNotContainsString('def build_playbook_tools', $code, 'the orchestrator runs no node logic itself');
        $this->assertCompiles($code, 'orchestrator');
    }

    public function testA2AOptionReturnsAManifest(): void
    {
        $m = self::generator()->generate(44, '3', ['a2a' => true]);
        $this->assertSame('dispatcher_demo_a2a', $m['root']);
        $this->assertSame(['orchestrator.py', 'api.py', 'agents/2_techbuddy.py', 'agents/3_it-claims.py', 'agents/4_human-resources.py', 'agents/5_playbook-hr.py'],
            array_column($m['files'], 'path'));
        foreach ($m['files'] as $f) {
            $this->assertStringContainsString('PROVENANCE', $f['code'], $f['path']);
            $this->assertStringContainsString('GRAPH EDGES', $f['code'], $f['path']);
            $this->assertCompiles($f['code'], $f['path']);
        }
        $this->assertStringContainsString('<== this agent', $m['files'][2]['code']);
        $this->assertStringContainsString('AGENT ENDPOINTS', $m['files'][0]['code']);
        // api.py: same run contract as the modular package, plus the A2A supervisor lifecycle.
        $api = $m['files'][1]['code'];
        foreach (['@app.post("/runs")', '@app.get("/runs/{run_id}/events")', '@app.post("/runs/{run_id}/tool-result")',
                  '@app.get("/.well-known/workflow.json")', 'class RunState', 'AgentSupervisor',
                  'from orchestrator import run as run_workflow, AgentSupervisor, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME',
                  'from orchestrator import set_event_sink, resolve_gate', 'def _ensure_agents() -> None:',
                  '_SUPERVISOR = AgentSupervisor(spawn=True)'] as $needle) {
            $this->assertStringContainsString($needle, $api, "missing: {$needle}");
        }
        $this->assertStringNotContainsString('Authorization', $api, 'the run server has no auth');
    }
}
