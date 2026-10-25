<?php
/**
 * The PHP side of tests/CompilerGraphParity.test.ts for LangGraphArchitectureDoc::build(): the fixture's
 * analyzeForEmit() facts (the workflow kept as its Workflow object, which build() calls) built in every mode.
 *
 *   php doc_call.php <fixture.json>  -> {"ok": true, "result": {"single": text | {"error"}, "modular": ..., "a2a": ...}}
 */
declare(strict_types=1);

require __DIR__ . '/php_compile.php';

try {
    $fx = fixture_load($argv[1]);
    $gen = fixture_generator($fx);
    $m = new ReflectionMethod($gen, 'analyzeForEmit');
    $facts = $m->invoke($gen, (int) $fx['workflow']['id'], isset($fx['user_id']) ? (string) $fx['user_id'] : null);
    $out = [];
    foreach (['single', 'modular', 'a2a'] as $mode) {
        try {
            $out[$mode] = \AgentTeam\Services\LangGraphArchitectureDoc::build($facts, $mode);
        } catch (\Throwable $e) {
            $out[$mode] = ['error' => $e->getMessage()];
        }
    }
    out(['ok' => true, 'result' => $out]);
} catch (\Throwable $e) {
    out(['ok' => false, 'error' => $e->getMessage(), 'class' => get_class($e)]);
}
