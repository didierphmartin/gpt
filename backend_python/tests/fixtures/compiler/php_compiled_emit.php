<?php
/**
 * Differential oracle for the shared emitters the ADK, MAF and NOOA targets build on (CompiledRuntimeEmit,
 * CompiledA2AEmit, CompiledArchitectureDoc, CompiledPackage, DispatcherDecisionFacts, StartTriggerFacts,
 * PlaybookEmit, RunServerEmitter, WorkflowGraphAnalyzer::dispatchMenus / serverIndex / availableToolsById,
 * LangGraphGenerator::llmFactoryLines), no database.
 *
 *   php php_compiled_emit.php <fixture.json> [...]
 *
 * For each fixture: the analysis ADKGenerator::analyzeWorkflow() makes (WorkflowGraphAnalyzer::analyze, the
 * playbook nodes, CompiledRuntimeEmit::analyzeRuntime), then a fixed list of calls on it. Prints
 * {"<fixture>": {"<call>": <result> | {"error": "<message>"}}} as JSON. tests/unit/test_compiled_emit_differential.py
 * makes the same calls on the Python port and compares every result.
 */
declare(strict_types=1);

require __DIR__ . '/php_compile_lib.php';

use AgentTeam\Services\CodeNodeEmit;
use AgentTeam\Services\CompiledA2AEmit;
use AgentTeam\Services\CompiledArchitectureDoc;
use AgentTeam\Services\CompiledPackage;
use AgentTeam\Services\CompiledRuntimeEmit;
use AgentTeam\Services\DispatcherDecisionFacts;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\LangGraphPackage;
use AgentTeam\Services\PlaybookEmit;
use AgentTeam\Services\RunServerEmitter;
use AgentTeam\Services\StartTriggerFacts;
use AgentTeam\Services\WorkflowGraphAnalyzer;

$out = [];
foreach (array_slice($argv, 1) as $path) {
    $fx = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    $name = basename($path, '.json');
    $r = [];
    $call = function (string $key, callable $fn) use (&$r) {
        try {
            $r[$key] = $fn();
        } catch (Throwable $e) {
            $r[$key] = ['error' => $e->getMessage()];
        }
    };
    $wfId = (int) $fx['workflow']['id'];
    $userId = (string) ($fx['user_id'] ?? '3');
    $pdo = fixturePdo($fx['sql'] ?? []);
    $graphRepo = new FixtureGraphRepo($fx['graph'], $fx['code_components'] ?? []);
    $agentRepo = new FixtureAgentRepo($fx['agents'] ?? []);
    $analyzer = new WorkflowGraphAnalyzer($pdo, new FixtureWorkflowRepo($fx['workflow']), $graphRepo, $agentRepo);
    $skillsRoot = __DIR__ . '/skills';

    $analyzed = null;
    $call('analyze', function () use (&$analyzed, $analyzer, $wfId, $userId, $pdo, $graphRepo, $agentRepo) {
        $a = $analyzer->analyze($wfId, $userId);
        $defaults = [];
        foreach ($pdo->query('SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1') as $row) {
            if (!empty($row['model'])) {
                $defaults[strtolower((string) $row['provider_key'])] = (string) $row['model'];
            }
        }
        $a['playbooks'] = [];
        foreach ((array) ($a['byId'] ?? []) as $pid => $pnode) {
            if (WorkflowGraphAnalyzer::typeOf($pnode) !== 'playbook') {
                continue;
            }
            $a['playbooks'][(string) $pid] = PlaybookEmit::nodeData($pnode, $analyzer->availableToolsById($userId), $defaults, $userId);
        }
        $analyzed = CompiledRuntimeEmit::analyzeRuntime($a, $analyzer, $pdo, $agentRepo, $graphRepo->getGraph($wfId), $wfId, $userId);
        return array_intersect_key($analyzed, array_flip(['order', 'layers', 'startNodeId', 'agents', 'usedCatalog', 'usedServers',
            'startPrompt', 'startDocuments', 'playbooks', 'code', 'serverSlugs', 'decisions', 'startMode', 'defaultCron',
            'defaultWatch', 'triggerNodeId']));
    });
    $call('serverIndex', fn() => $analyzer->serverIndex($userId));
    $call('availableToolsById', fn() => $analyzer->availableToolsById($userId));
    $call('llmFactoryLines', fn() => LangGraphGenerator::llmFactoryLines());
    $call('runServer.emit', fn() => RunServerEmitter::emit((string) $fx['workflow']['name'], "doc body\nline 2", 'from workflow import run_workflow', 'WORKFLOW_VERSION = "1"'));
    $call('runServer.emitListen', fn() => RunServerEmitter::emit((string) $fx['workflow']['name'], 'doc', 'from workflow import x', 'WORKFLOW_VERSION = "2"', true));
    $call('runServer.package', fn() => RunServerEmitter::package(['code' => "print(1)\n"], (string) $fx['workflow']['name'], 'adk', 'Doc line'));
    $call('runServer.packageCommon', fn() => RunServerEmitter::package(['code' => 'x'], 'Ünïcode — Name', 'maf', 'D', "common\n", true));
    if ($analyzed !== null) {
        $a = $analyzed;
        $call('dispatchMenus', fn() => WorkflowGraphAnalyzer::dispatchMenus($a));
        foreach (array_keys(WorkflowGraphAnalyzer::dispatchMenus($a)['menus']) as $did) {
            $call("decisionFacts.$did", fn() => DispatcherDecisionFacts::of($pdo, $agentRepo, (array) $a['byId'][$did], (string) $a['workflow']['name']));
            $call("decisionFactsNoDb.$did", fn() => DispatcherDecisionFacts::of(null, null, (array) $a['byId'][$did], 'Other'));
        }
        $call('startTriggerFacts', fn() => StartTriggerFacts::of($pdo, $wfId,
            array_map(fn($id) => ['id' => (string) $id] + (array) $a['byId'][$id], (array) $a['order']), $a['serverSlugs']));
        $call('cre.mcpClientBlock', fn() => CompiledRuntimeEmit::mcpClientBlock($a));
        $call('cre.codeHarnessBlock.package', fn() => CompiledRuntimeEmit::codeHarnessBlock(true));
        $call('cre.codeHarnessBlock.single', fn() => CompiledRuntimeEmit::codeHarnessBlock(false));
        $call('cre.recordingBlock', fn() => CompiledRuntimeEmit::recordingBlock($a));
        $call('cre.recordingBlock.callbacks', fn() => CompiledRuntimeEmit::recordingBlock($a, true));
        $call('cre.packageListenBlock', fn() => CompiledRuntimeEmit::packageListenBlock());
        $call('cre.packageListenBlock.hooks', fn() => CompiledRuntimeEmit::packageListenBlock("def _cli_begin(p):\n    pass\n"));
        $call('cre.moduleLayout', fn() => CompiledRuntimeEmit::moduleLayout($a));
        $call('cre.displayName', fn() => array_map(fn($id) => CompiledRuntimeEmit::displayName($a, (string) $id), (array) $a['order']));
        $call('cre.codeNodeLiterals', fn() => CompiledRuntimeEmit::codeNodeLiterals($a));
        $call('cre.codeNodesLiteral', fn() => CompiledRuntimeEmit::codeNodesLiteral($a));
        $call('cre.codeNodesLiteral.package', fn() => CompiledRuntimeEmit::codeNodesLiteral(['package' => true] + $a));
        $call('cre.codeNodesLiteral.split', fn() => CompiledRuntimeEmit::codeNodesLiteral(['split' => true] + $a));
        $call('cre.decisionBlock', fn() => CompiledRuntimeEmit::decisionBlock($a));
        $call('cre.decisionBlock.split', fn() => CompiledRuntimeEmit::decisionBlock(['split' => true] + $a));
        $call('cre.idRecordingHelpers', fn() => CompiledRuntimeEmit::idRecordingHelpers());
        $call('cre.packageCommonWithRuntime', fn() => CompiledRuntimeEmit::packageCommonWithRuntime(["HEAD = 1\n", 'A = 2', 'B = 3']));
        $tables = [];
        foreach (CompiledRuntimeEmit::moduleLayout($a) as $nid => $m) {
            $tables['NODE'][1][(string) $nid] = '{"id": ' . json_encode((string) $nid) . '}';
        }
        $tables['NODE'][0] = 'NODES';
        $tables = ['NODE' => [$tables['NODE'][0], $tables['NODE'][1] ?? []], 'CODE_NODE' => ['CODE_NODES', CompiledRuntimeEmit::codeNodeLiterals($a)]];
        $call('cre.tablePackage', fn() => CompiledRuntimeEmit::tablePackage($a, ["# head\n", 'X = 1'], ['ASSEMBLY = 1', 'def run_workflow(): pass'],
            $tables, [array_key_first(CompiledRuntimeEmit::moduleLayout($a)) ?? 'none' => 'PRELUDE = True'], 'Google ADK', 'its ADK agent', 'ADK models, MCP'));
        $call('a2a.version', fn() => CompiledA2AEmit::version($a));
        $call('a2a.layout', fn() => CompiledA2AEmit::layout($a));
        $call('a2a.refuse', function () use ($a) { CompiledA2AEmit::refuse($a); return 'ok'; });
        $call('a2a.orchestrator', fn() => CompiledA2AEmit::orchestrator($a, 'Google ADK'));
        $call('a2a.api', fn() => CompiledA2AEmit::api($a, 'Microsoft Agent Framework'));
        foreach (array_keys(CompiledA2AEmit::layout($a)) as $nid) {
            $call("a2a.server.$nid", fn() => CompiledA2AEmit::server($a, (string) $nid, "def run_node(text, trace):\n    return {}\n\n", 'NVIDIA NOOA'));
        }
        $call('a2a.dispatcherHelpers', fn() => CompiledA2AEmit::dispatcherHelpers());
        $runNodes = [];
        foreach (array_keys(CompiledA2AEmit::layout($a)) as $nid) {
            $runNodes[(string) $nid] = "def run_node():\n    pass\n";
        }
        $call('a2a.package', fn() => CompiledA2AEmit::package($a, ["W\n", "C\n", [['path' => 'agents/x.py', 'code' => 'x']]], $runNodes,
            [['path' => 'requirements.txt', 'code' => "r\n"]], 'root_adk_a2a', 'Google ADK'));
        $docs = LangGraphPackage::startDocuments($a['startDocuments'] ?? [], null);
        $target = ['key' => 'adk', 'title' => 'Google ADK', 'framework' => ['google-adk', 'litellm']];
        foreach (['modular', 'a2a'] as $layout) {
            $call("package.files.$layout", fn() => CompiledPackage::files(['package' => true] + $a, $skillsRoot, $docs['files'], $target, $layout));
        }
        $call('package.singleFiles', fn() => CompiledPackage::singleFiles($a, $target, 'root_adk.py'));
        $call('package.pipInstall', fn() => CompiledPackage::pipInstall($a, $target));
        foreach (array_keys((array) $a['code']) as $nid) {
            $call("package.codePath.$nid", fn() => CompiledPackage::codePath($a, (string) $nid));
        }
        $call('playbook.docNodes', fn() => PlaybookEmit::docNodes($a));
        $call('playbook.requirementNames', fn() => PlaybookEmit::requirementNames($a));
        $call('playbook.supportBlock', fn() => PlaybookEmit::supportBlock(true));
        $call('playbook.supportBlock.noMcp', fn() => PlaybookEmit::supportBlock(false));
        $call('playbook.metadataBlock', fn() => PlaybookEmit::metadataBlock($a['playbooks']));
        $call('playbook.runtimeBlock', fn() => PlaybookEmit::runtimeBlock());
        foreach ($a['playbooks'] as $pid => $_) {
            $call("playbook.refuse.$pid", function () use ($a, $pid, $graphRepo, $wfId) {
                PlaybookEmit::refuseLangGraphOnly((array) $a['byId'][$pid], $graphRepo->getGraph($wfId)['edges'] ?? []);
                return 'ok';
            });
        }
        // ARCHITECTURE.md over files the shared emitters produce, for every target x mode.
        $single = ['filename' => 'wf_adk.py', 'code' => CompiledRuntimeEmit::mcpClientBlock($a) . "\n" . CompiledRuntimeEmit::recordingBlock($a)
            . "\ndef run_workflow():\n    pass\nclass Listener:\n    pass\n_make_model = None\nasync def _run_graph():\n    pass\n"];
        $package = ['root' => 'wf_x', 'files' => [['path' => 'workflow.py', 'code' => "def run_workflow():\n    pass\n"],
            ['path' => 'common.py', 'code' => CompiledRuntimeEmit::packageCommonBlock() . "\nclass ProviderClients:\n    pass\n"],
            ['path' => 'api.py', 'code' => 'x'], ['path' => '__init__.py', 'code' => "\n"], ['path' => 'agents/__init__.py', 'code' => ''],
            ['path' => 'skills/html/SKILL.md', 'code' => 's'], ['path' => 'skills/html/a/b.txt', 'code' => 's'],
            ['path' => 'start_documents/a.pdf', 'code' => 'p'], ['path' => 'code/2_x.py', 'code' => 'c'], ['path' => 'code_harness.py', 'code' => 'h'],
            ['path' => 'requirements.txt', 'code' => 'r'], ['path' => '.env.example', 'code' => 'e'], ['path' => 'README.md', 'code' => 'm'],
            ['path' => 'weird.bin', 'code' => '']]];
        foreach (CompiledRuntimeEmit::moduleLayout($a) as $m) {
            $package['files'][] = ['path' => $m['file'], 'code' => 'n'];
        }
        $a2aPackage = $package;
        $a2aPackage['files'][] = ['path' => 'orchestrator.py', 'code' => LangGraphGenerator::a2aRemoteBlock()];
        foreach (CompiledA2AEmit::layout($a) as $e) {
            $a2aPackage['files'][] = ['path' => $e['file'], 'code' => LangGraphGenerator::a2aAgentServerBlock()];
        }
        foreach (['adk', 'maf', 'nooa'] as $target) {
            $call("archdoc.$target.single", fn() => CompiledArchitectureDoc::attach($single, $a, $target, 'single'));
            $call("archdoc.$target.modular", fn() => CompiledArchitectureDoc::attach($package, $a, $target, 'modular'));
            $call("archdoc.$target.a2a", fn() => CompiledArchitectureDoc::attach($a2aPackage, $a, $target, 'a2a'));
        }
    }
    $out[$name] = $r;
}
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PRETTY_PRINT), "\n";
