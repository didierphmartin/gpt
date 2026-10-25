<?php
/**
 * Differential oracle: compile fixture workflows with a PHP compiler, no database.
 *
 *   php php_compile.php [--target=langgraph|adk|maf|nooa] <fixture.json> [<fixture.json> ...]
 *
 * --target (default langgraph) picks the compiler. LangGraph compiles the modes the fixture lists (default
 * single, modular, a2a) through generate($id, $user, ['a2a' => ..., 'modular' => ...]); ADK, MAF and NOOA
 * compile all three, as WorkflowController::compiledTargetResponse() does: single = generate(),
 * modular = generatePackage(), a2a = generateA2A().
 *
 * Prints {"<fixture name>": {"<mode>": <generate() result> | {"error": "<message>"}}} as JSON.
 * Each fixture names a workflow row, its graph, the agent records it references,
 * the code components a Start option expands to, and SQL rows for the tables the
 * compiler reads (schema.sql beside this script, in an in-memory SQLite). The
 * Python twin (tests/unit/test_lang_graph_compiler_differential.py) builds the
 * same inputs and compares every emitted file byte for byte.
 */
declare(strict_types=1);

require __DIR__ . '/php_compile_lib.php';

use AgentTeam\Services\ADKGenerator;
use AgentTeam\Services\LangGraphGenerator;
use AgentTeam\Services\MAFGenerator;
use AgentTeam\Services\NOOAGenerator;

$target = 'langgraph';
$paths = [];
foreach (array_slice($argv, 1) as $arg) {
    if (str_starts_with($arg, '--target=')) {
        $target = substr($arg, 9);
    } else {
        $paths[] = $arg;
    }
}
$class = ['langgraph' => LangGraphGenerator::class, 'adk' => ADKGenerator::class, 'maf' => MAFGenerator::class,
    'nooa' => NOOAGenerator::class][$target] ?? null;
if ($class === null) {
    fwrite(STDERR, "unknown --target {$target}\n");
    exit(2);
}

$out = [];
foreach ($paths as $path) {
    $fx = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    $name = basename($path, '.json');
    $skillsRoot = __DIR__ . '/skills';
    $results = [];
    $modes = $target === 'langgraph' ? ($fx['modes'] ?? ['single', 'modular', 'a2a']) : ['single', 'modular', 'a2a'];
    foreach ($modes as $mode) {
        $gen = new $class(
            fixturePdo($fx['sql'] ?? []),
            new FixtureWorkflowRepo($fx['workflow']),
            new FixtureGraphRepo($fx['graph'], $fx['code_components'] ?? []),
            new FixtureAgentRepo($fx['agents'] ?? []),
            $skillsRoot,
            // A Start document is copied from storage/synergyaichatroot/<user folder>/ (no universalFS adapter).
            isset($fx['document_store'])
                ? new \AgentTeam\Services\StartDocumentStore((string) $fx['document_store']['user_folder'], null, __DIR__ . '/storage')
                : null
        );
        try {
            $id = (int) $fx['workflow']['id'];
            $user = (string) ($fx['user_id'] ?? '3');
            $results[$mode] = match (true) {
                $target === 'langgraph' => $gen->generate($id, $user, ['a2a' => $mode === 'a2a', 'modular' => $mode === 'modular']),
                $mode === 'a2a' => $gen->generateA2A($id, $user),
                $mode === 'modular' => $gen->generatePackage($id, $user),
                default => $gen->generate($id, $user),
            };
        } catch (Throwable $e) {
            $results[$mode] = ['error' => $e->getMessage()];
        }
    }
    $out[$name] = $results;
}
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PRETTY_PRINT), "\n";
