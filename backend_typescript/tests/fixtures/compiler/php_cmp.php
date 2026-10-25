<?php
/**
 * The PHP side of tests/CompiledEmitParity.test.ts (CompiledRuntimeEmit, CompiledA2AEmit, CompiledArchitectureDoc,
 * CompiledPackage): builds a fixture's $analyzed the way backend's ADKGenerator::analyzeWorkflow() does, and calls
 * the Compiled* static methods on it.
 *
 *   php php_cmp.php analyzed <fixture.json>  -> {pre, index, graph, analyzed, adk, error, adkError, sql, agents,
 *                                               workflowId, userId}: the analyzer's array before analyzeRuntime (with
 *                                               providerDefaultModels and playbooks), the user's serverIndex, the
 *                                               graph, analyzeRuntime's result, ADKGenerator::analyzeWorkflow()'s
 *                                               own result (to check `analyzed`), the database statements and the
 *                                               fixture's agent records (for the TypeScript analyzeRuntime)
 *   php php_cmp.php wf64                      -> AdkCodeNodeTest::wf64Analyzed() (copied: no PHPUnit here)
 *   php php_cmp.php call                      -> stdin {"class", "method", "args"}: a static method's return value
 *                                               (private ones too). An argument {"$analyzed": "<fixture.json>",
 *                                               "set": {...}} is that fixture's analyzed array with the keys of
 *                                               "set" replaced; {"$wf64": true, "set": {...}} the wf64 array;
 *                                               {"$skillsRoot": "<fixture.json>"} a directory holding its skills.
 *                                               {"class", "const"} reads a class constant instead.
 *   php php_cmp.php batch                     -> stdin {"calls": [call, ...]}: [{ok, result} | {ok: false, error}]
 */
declare(strict_types=1);

require __DIR__ . '/php_compile.php';

use AgentTeam\Services\CompiledRuntimeEmit;
use AgentTeam\Services\PlaybookEmit;
use AgentTeam\Services\WorkflowGraphAnalyzer;

/** The repositories fixture_generator() builds, for ADKGenerator and the analyzer. */
function cmp_repos(array $fx): array
{
    $wf = new \AgentTeam\Models\Workflow($fx['workflow']);
    $wfRepo = new class($wf) extends \AgentTeam\Services\WorkflowRepository {
        public function __construct(private \AgentTeam\Models\Workflow $wf) {}
        public function findById(int $id, bool $includeGraph = false): ?\AgentTeam\Models\Workflow
        {
            return $this->wf;
        }
    };
    $graphRepo = new class($fx) extends \AgentTeam\Services\WorkflowGraphRepository {
        public function __construct(private array $fx) {}
        public function getGraph(int $workflowId): array
        {
            $components = $this->fx['code_components'] ?? [];
            return \AgentTeam\Services\StartOptionGraph::expand($this->fx['graph'],
                fn(int $id): ?array => $components[(string) $id] ?? null);
        }
    };
    $agentRepo = new class($fx['agents'] ?? []) extends \AgentTeam\Services\AgentRepository {
        public function __construct(private array $agents) {}
        public function findById(int $id): ?\AgentTeam\Models\Agent
        {
            return isset($this->agents[(string) $id]) ? new \AgentTeam\Models\Agent($this->agents[(string) $id]) : null;
        }
    };
    return [$wfRepo, $graphRepo, $agentRepo];
}

/** ADKGenerator::analyzeWorkflow(), step by step (its body, lines 63-97), so the pre-analyzeRuntime array is seen too. */
function cmp_analyzed(string $path): array
{
    $fx = json_decode((string) file_get_contents($path), true);
    $pdo = fixture_pdo($fx);
    [$wfRepo, $graphRepo, $agentRepo] = cmp_repos($fx);
    $wid = (int) $fx['workflow']['id'];
    $uid = isset($fx['user_id']) ? (string) $fx['user_id'] : null;
    $analyzer = new WorkflowGraphAnalyzer($pdo, $wfRepo, $graphRepo, $agentRepo);
    $analyzed = $analyzer->analyze($wid, $uid);
    $defaults = [];
    foreach ($pdo->query("SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1") as $row) {
        if (!empty($row['model'])) {
            $defaults[strtolower((string) $row['provider_key'])] = (string) $row['model'];
        }
    }
    $analyzed['providerDefaultModels'] = $defaults;
    $analyzed['playbooks'] = [];
    foreach ((array) ($analyzed['byId'] ?? []) as $pid => $pnode) {
        if (WorkflowGraphAnalyzer::typeOf($pnode) !== 'playbook') {
            continue;
        }
        PlaybookEmit::refuseLangGraphOnly($pnode, $graphRepo->getGraph($wid)['edges'] ?? []);
        $analyzed['playbooks'][(string) $pid] = PlaybookEmit::nodeData($pnode, $analyzer->availableToolsById($uid), $defaults, $uid);
    }
    $graph = $graphRepo->getGraph($wid);
    $index = $analyzer->serverIndex($uid);
    $error = $adkError = null;
    $full = $viaAdk = null;
    try {
        $full = CompiledRuntimeEmit::analyzeRuntime($analyzed, $analyzer, $pdo, $agentRepo, $graph, $wid, $uid);
    } catch (\RuntimeException $e) {
        $error = $e->getMessage();   // analyzeRuntime's refusal (e.g. two servers on one URL)
    }
    if ($full !== null) {
        try {
            $adk = new \AgentTeam\Services\ADKGenerator($pdo, $wfRepo, $graphRepo, $agentRepo, fixture_skills_root($fx));
            $m = new ReflectionMethod($adk, 'analyzeWorkflow');
            $viaAdk = $m->invoke($adk, $wid, $uid);
        } catch (\RuntimeException $e) {
            $adkError = $e->getMessage();   // ADK refuses the workflow (a swarm...)
        }
    }
    return ['pre' => $analyzed, 'index' => $index, 'graph' => $graph, 'analyzed' => $full, 'adk' => $viaAdk, 'error' => $error,
        'adkError' => $adkError,
        'sql' => array_merge(BASE_SCHEMA, $fx['sql'] ?? []), 'agents' => $fx['agents'] ?? [], 'workflowId' => $wid, 'userId' => $uid];
}

/** AdkCodeNodeTest::wf64Analyzed(), copied. */
function cmp_wf64(): array
{
    $code = "def run(input, call_tool):\n    return {'output': input}\n";
    $graph = ['nodes' => [
        ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'GO']],
        ['id' => '10', 'type' => 'code', 'config' => ['type' => 'code', 'name' => 'T', 'code' => "def run(input, call_tool):\n    return {'route': 'new_mail', 'output': {'subject': 'hi'}}\n", 'exits' => ['new_mail', 'no_mail'], 'mcp_servers' => []]],
        ['id' => '2', 'type' => 'agent', 'config' => ['type' => 'agent', 'agent_name' => 'D', 'agent_type' => 'dispatcher', 'provider' => 'claude', 'model' => 'm']],
        ['id' => '3', 'type' => 'code', 'config' => ['type' => 'code', 'name' => 'A', 'code' => $code, 'exits' => ['next'], 'mcp_servers' => []]],
        ['id' => '4', 'type' => 'code', 'config' => ['type' => 'code', 'name' => 'B', 'code' => $code, 'exits' => ['next'], 'mcp_servers' => []]],
        ['id' => '5', 'type' => 'output', 'config' => ['type' => 'output']],
    ], 'edges' => [
        ['from' => '1', 'to' => '10', 'from_port' => 'output_1'],
        ['from' => '10', 'to' => '2', 'from_port' => 'output_1'],
        ['from' => '2', 'to' => '3'], ['from' => '2', 'to' => '4'],
        ['from' => '3', 'to' => '5'], ['from' => '4', 'to' => '5'],
    ]];
    $a = array_merge(WorkflowGraphAnalyzer::analyzeGraph($graph), [
        'workflow' => ['id' => 64, 'name' => 'wf64'], 'generated_at' => '2026-01-01 00:00:00 UTC',
        'usedCatalog' => [], 'usedServers' => [], 'serverSlugs' => [],
        'startPrompt' => 'GO', 'startDocuments' => [], 'playbooks' => [],
        'agents' => ['2' => ['name' => 'D', 'systemPrompt' => 'Route the email.', 'provider' => 'claude', 'model' => 'm',
            'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '',
            'output_schema_id' => null, 'documents' => []]],
    ]);
    $ids = ['1', '10', '2', '3', '4', '5'];
    $byId = array_column($graph['nodes'], null, 'id');
    $a['code'] = [];
    foreach (['10', '3', '4'] as $cid) {
        $a['code'][$cid] = \AgentTeam\Services\CodeNodeEmit::nodeData($byId[$cid], $graph['edges'], [], $ids);
    }
    return $a;
}

function cmp_skills_root(string $path): string
{
    return fixture_skills_root(json_decode((string) file_get_contents($path), true));
}

$cache = [];
$arg = function ($a) use (&$cache) {
    if (!is_array($a)) {
        return $a;
    }
    if (isset($a['$analyzed']) || isset($a['$wf64'])) {
        $key = $a['$analyzed'] ?? '$wf64';
        $cache[$key] ??= isset($a['$wf64']) ? cmp_wf64() : cmp_analyzed($a['$analyzed'])['analyzed'];
        $v = $cache[$key];
        foreach ($a['set'] ?? [] as $k => $x) {
            $v[$k] = $x;
        }
        foreach ($a['unset'] ?? [] as $k) {
            unset($v[$k]);
        }
        return $v;
    }
    if (isset($a['$skillsRoot'])) {
        return cmp_skills_root($a['$skillsRoot']);
    }
    return $a;
};

$invoke = function (array $req) use ($arg): array {
    try {
        $args = array_map($arg, $req['args'] ?? []);
        $class = (str_contains($req['class'], '\\') ? '' : 'AgentTeam\\Services\\') . $req['class'];
        if (isset($req['const'])) {
            return ['ok' => true, 'result' => (new ReflectionClassConstant($class, $req['const']))->getValue()];
        }
        $m = new ReflectionMethod($class, $req['method']);
        return ['ok' => true, 'result' => $m->invokeArgs(null, $args)];
    } catch (\Throwable $e) {
        return ['ok' => false, 'error' => $e->getMessage(), 'class' => get_class($e)];
    }
};

$cmd = $argv[1] ?? '';
try {
    switch ($cmd) {
        case 'analyzed':
            out(cmp_analyzed($argv[2]));
            break;
        case 'wf64':
            out(cmp_wf64());
            break;
        case 'call':
            $req = json_decode((string) stream_get_contents(STDIN), true);
            out($invoke($req));
            break;
        case 'batch':   // stdin {"calls": [call, ...]} -> [{ok, result} | {ok: false, error}, ...]
            $req = json_decode((string) stream_get_contents(STDIN), true);
            out(array_map($invoke, $req['calls']));
            break;
        default:
            fwrite(STDERR, "usage: php_cmp.php analyzed <fixture.json> | wf64 | call\n");
            exit(2);
    }
} catch (\Throwable $e) {
    out(['ok' => false, 'error' => $e->getMessage(), 'class' => get_class($e)]);
}
