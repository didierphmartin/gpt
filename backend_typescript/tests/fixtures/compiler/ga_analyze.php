<?php
/**
 * The PHP side of tests/CompilerGraphParity.test.ts for the DB-backed WorkflowGraphAnalyzer methods: builds the
 * analyzer the way ADKGenerator / MAFGenerator do (over php_compile.php's in-memory SQLite and repository stubs)
 * and prints analyze(), serverIndex() and availableToolsById() for a fixture.
 *
 *   php ga_analyze.php <fixture.json>
 *     -> {"ok": true, "analyze": ..., "serverIndex": ..., "serverIndexGlobal": ..., "availableToolsById": ..., "availableToolsGlobal": ...}
 */
declare(strict_types=1);

require __DIR__ . '/php_compile.php';

try {
    $fx = fixture_load($argv[1]);
    $gen = fixture_generator($fx);
    $get = fn(string $p) => (new ReflectionProperty($gen, $p))->getValue($gen);
    $an = new \AgentTeam\Services\WorkflowGraphAnalyzer($get('db'), $get('workflowRepo'), $get('graphRepo'), $get('agentRepo'));
    $uid = isset($fx['user_id']) ? (string) $fx['user_id'] : null;
    out([
        'ok' => true,
        'analyze' => $an->analyze((int) $fx['workflow']['id'], $uid),
        'serverIndex' => $an->serverIndex($uid),
        'serverIndexGlobal' => $an->serverIndex(null),
        'availableToolsById' => $an->availableToolsById($uid),
        'availableToolsGlobal' => $an->availableToolsById(null),
    ]);
} catch (\Throwable $e) {
    out(['ok' => false, 'error' => $e->getMessage(), 'class' => get_class($e)]);
}
