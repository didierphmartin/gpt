<?php
/**
 * The PHP side of tests/CompilerGraphParity.test.ts for DispatcherDecisionFacts::of(): over a fixture's in-memory
 * SQLite and agent repository stub (php_compile.php), of() for every node of the fixture's graph with each
 * stdin-given override of the node's settings, with and without a database / an agent repository.
 *
 *   php ddf_call.php <fixture.json>  (stdin: {"settings": [null | {...}, ...]})
 *     -> {"ok": true, "result": [{"node", "settings", "db", "repo", "facts"}, ...]}
 */
declare(strict_types=1);

require __DIR__ . '/php_compile.php';

try {
    $fx = fixture_load($argv[1]);
    $req = json_decode((string) stream_get_contents(STDIN), true) ?: [];
    $gen = fixture_generator($fx);
    $get = fn(string $p) => (new ReflectionProperty($gen, $p))->getValue($gen);
    $pdo = $get('db');
    $repo = $get('agentRepo');
    $wfName = (string) $fx['workflow']['name'];
    $out = [];
    foreach ($fx['graph']['nodes'] as $node) {
        foreach ($req['settings'] ?? [null] as $si => $settings) {
            $n = $node;
            if ($settings !== null) {
                $n['config']['settings'] = $settings;
            }
            foreach ([[true, true], [false, true], [true, false]] as [$useDb, $useRepo]) {
                $out[] = ['node' => (string) $node['id'], 'settings' => $si, 'db' => $useDb, 'repo' => $useRepo,
                    'facts' => \AgentTeam\Services\DispatcherDecisionFacts::of($useDb ? $pdo : null, $useRepo ? $repo : null, $n, $wfName)];
            }
        }
    }
    out(['ok' => true, 'result' => $out]);
} catch (\Throwable $e) {
    out(['ok' => false, 'error' => $e->getMessage(), 'class' => get_class($e)]);
}
