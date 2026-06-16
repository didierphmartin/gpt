<?php
declare(strict_types=1);
require dirname(__DIR__) . '/vendor/autoload.php';
use AgentTeam\Services\VectorMcpStore;

// Inject a fake MCP dispatcher so the test needs no live server.
$calls = [];
$fakeDispatch = function (int $serverId, string $tool, array $args) use (&$calls) {
    $calls[] = compact('serverId', 'tool', 'args');
    return ['stored' => count($args['chunks'] ?? []), 'collection' => $args['collection'] ?? null];
};
$store = new VectorMcpStore($fakeDispatch);
$res = $store->store(7, ['a', 'b', 'c'], ['embeddings' => 'openai:text-embedding-3-small', 'collection' => 'docs']);
assert($res['stored'] === 3, 'expected 3 stored');
assert($calls[0]['serverId'] === 7, 'expected server 7');
echo "OK\n";
