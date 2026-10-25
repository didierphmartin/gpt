<?php
/**
 * Differential oracle: compile fixture workflows with the PHP LangGraph compiler, no database.
 *
 *   php php_compile.php <fixture.json> [<fixture.json> ...]
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

use AgentTeam\Services\LangGraphGenerator;

$out = [];
foreach (array_slice($argv, 1) as $path) {
    $fx = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    $name = basename($path, '.json');
    $skillsRoot = __DIR__ . '/skills';
    $results = [];
    foreach ($fx['modes'] ?? ['single', 'modular', 'a2a'] as $mode) {
        $gen = new LangGraphGenerator(
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
            $results[$mode] = $gen->generate((int) $fx['workflow']['id'], (string) ($fx['user_id'] ?? '3'),
                ['a2a' => $mode === 'a2a', 'modular' => $mode === 'modular']);
        } catch (Throwable $e) {
            $results[$mode] = ['error' => $e->getMessage()];
        }
    }
    $out[$name] = $results;
}
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PRETTY_PRINT), "\n";
