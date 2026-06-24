<?php

declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

use AgentTeam\Services\VectorMcpStore;

/**
 * VectorMcpStore unit tests — the store node's writer/reader. The MCP dispatch
 * is injected so no live vector server is needed. Verifies the unified `store`
 * (one batch call per file, items:[{text,metadata}]) and `find` contract, and
 * the mcp_qrant envelope decode (payload in content[0].text; errors ride INSIDE
 * the payload as {error:true,...}).
 */
$failures = 0;
$checks = 0;
function check(string $label, bool $cond): void
{
    global $failures, $checks;
    $checks++;
    echo ($cond ? "  PASS  " : "  FAIL  ") . $label . "\n";
    if (!$cond) {
        $failures++;
    }
}

/** Wrap a payload in the mcp_qrant envelope the dispatch callable returns. */
function envelope(array $payload): array
{
    return ['content' => [['type' => 'text', 'text' => json_encode($payload)]]];
}

// --- store: ONE `store` call carrying items[{text,metadata}] + provider/connection ---
$calls = [];
$dispatch = function (int $serverId, string $tool, array $args) use (&$calls) {
    $calls[] = compact('serverId', 'tool', 'args');
    return envelope(['stored' => 3, 'errors' => 0]);
};
$store = new VectorMcpStore($dispatch);
$res = $store->store(7, ['alpha', 'beta', '   ', 'gamma'], [
    'provider'   => 'qdrant',
    'connection' => ['mode' => 'local', 'path' => '/tmp/q'],
    'collection' => 'docs',
    'metadata'   => ['source' => 'a/x.pdf'],
]);

check('one store call total (batch per file)', count($calls) === 1);
check('uses the `store` tool', $calls[0]['tool'] === 'store');
check('targets the server id', $calls[0]['serverId'] === 7);
check('passes provider', $calls[0]['args']['provider'] === 'qdrant');
check('passes connection', ($calls[0]['args']['connection']['path'] ?? null) === '/tmp/q');
check('passes collection', $calls[0]['args']['collection'] === 'docs');
check('items skip the blank chunk (3 items)', count($calls[0]['args']['items']) === 3);
check('item carries text', $calls[0]['args']['items'][0]['text'] === 'alpha');
check('item carries metadata (provenance)', ($calls[0]['args']['items'][0]['metadata']['source'] ?? null) === 'a/x.pdf');
check('omits embedding when unset', !array_key_exists('embedding', $calls[0]['args']));
check('returns stored from payload', $res['stored'] === 3);
check('returns errors from payload', $res['errors'] === 0);
check('returns collection', $res['collection'] === 'docs');

// --- store: empty / all-blank chunks => no call ---
$calls2 = [];
$store2 = new VectorMcpStore(function (int $s, string $t, array $a) use (&$calls2) {
    $calls2[] = $a;
    return envelope(['stored' => 0, 'errors' => 0]);
});
$res2 = $store2->store(1, ['   ', ''], ['provider' => 'qdrant', 'connection' => [], 'collection' => 'c']);
check('all-blank chunks -> 0 stored, no call', $res2['stored'] === 0 && count($calls2) === 0);

// --- store: embedding forwarded when set ---
$ecalls = [];
(new VectorMcpStore(function (int $s, string $t, array $a) use (&$ecalls) {
    $ecalls[] = $a;
    return envelope(['stored' => 1, 'errors' => 0]);
}))->store(1, ['x'], ['provider' => 'pgvector', 'connection' => [], 'collection' => 'c', 'embedding' => 'hf:all-MiniLM-L6-v2']);
check('forwards embedding when set', ($ecalls[0]['embedding'] ?? null) === 'hf:all-MiniLM-L6-v2');

// --- store: payload error throws (error rides INSIDE the payload) ---
$threw = false;
try {
    (new VectorMcpStore(fn($s, $t, $a) => envelope(['error' => true, 'code' => 'store_failed', 'message' => 'boom'])))
        ->store(1, ['x'], ['provider' => 'qdrant', 'connection' => [], 'collection' => 'c']);
} catch (\RuntimeException $e) {
    $threw = $e->getMessage() === 'boom';
}
check('payload error throws', $threw);

// --- store: transport error (normalized {error:true}) throws ---
$threwT = false;
try {
    (new VectorMcpStore(fn($s, $t, $a) => ['error' => true, 'message' => 'HTTP 500']))
        ->store(1, ['x'], ['provider' => 'qdrant', 'connection' => [], 'collection' => 'c']);
} catch (\RuntimeException $e) {
    $threwT = $e->getMessage() === 'HTTP 500';
}
check('transport error throws', $threwT);

// --- find: builds args and maps results {text,metadata,score} ---
$fcalls = [];
$finder = new VectorMcpStore(function (int $s, string $t, array $a) use (&$fcalls) {
    $fcalls[] = compact('t', 'a');
    return envelope(['results' => [
        ['text' => 'solar power', 'metadata' => ['source' => 'energy.txt'], 'score' => 0.91],
        ['text' => 'no score', 'metadata' => [], 'score' => null],
    ]]);
});
$fr = $finder->find(5, 'renewable energy', [
    'provider' => 'qdrant', 'connection' => ['mode' => 'local'], 'collection' => 'docs',
]);
check('find uses the `find` tool', $fcalls[0]['t'] === 'find');
check('find passes query', $fcalls[0]['a']['query'] === 'renewable energy');
check('find default limit = 5', $fcalls[0]['a']['limit'] === 5);
check('find maps text', $fr['results'][0]['text'] === 'solar power');
check('find maps metadata', ($fr['results'][0]['metadata']['source'] ?? null) === 'energy.txt');
check('find maps score', $fr['results'][0]['score'] === 0.91);
check('find tolerates null score', $fr['results'][1]['score'] === null);

// --- find: payload error throws ---
$threwF = false;
try {
    (new VectorMcpStore(fn($s, $t, $a) => envelope(['error' => true, 'message' => 'find boom'])))
        ->find(1, 'q', ['provider' => 'qdrant', 'connection' => [], 'collection' => 'c']);
} catch (\RuntimeException $e) {
    $threwF = $e->getMessage() === 'find boom';
}
check('find payload error throws', $threwF);

// --- store: a response with NO {stored} field is a hard error (not silent 0) ---
// This is the class of bug a 307 redirect / wrong endpoint produced: an empty
// or non-MCP body that used to map to {stored:0} with no error.
$threwEmpty = false;
try {
    (new VectorMcpStore(fn($s, $t, $a) => []))   // {} — e.g. a redirect/non-MCP body
        ->store(1, ['x'], ['provider' => 'qdrant', 'connection' => [], 'collection' => 'c']);
} catch (\RuntimeException $e) {
    $threwEmpty = str_contains($e->getMessage(), 'no {stored}');
}
check('store: empty/non-MCP response throws (no silent stored:0)', $threwEmpty);

$threwOk = false;
try {
    (new VectorMcpStore(fn($s, $t, $a) => envelope(['ok' => true])))   // valid-looking, no `stored`
        ->store(1, ['x'], ['provider' => 'qdrant', 'connection' => [], 'collection' => 'c']);
} catch (\RuntimeException $e) {
    $threwOk = str_contains($e->getMessage(), 'no {stored}');
}
check('store: response without {stored} throws', $threwOk);

// --- find: a response with NO {results} field is a hard error (not "0 matches") ---
$threwFindEmpty = false;
try {
    (new VectorMcpStore(fn($s, $t, $a) => []))
        ->find(1, 'q', ['provider' => 'qdrant', 'connection' => [], 'collection' => 'c']);
} catch (\RuntimeException $e) {
    $threwFindEmpty = str_contains($e->getMessage(), 'no {results}');
}
check('find: empty/non-MCP response throws (no silent 0 matches)', $threwFindEmpty);

echo "\n$checks checks, $failures failures\n";
exit($failures === 0 ? 0 : 1);
