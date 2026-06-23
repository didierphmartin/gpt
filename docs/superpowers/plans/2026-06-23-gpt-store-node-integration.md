# gpt store-node integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the workflow-editor store node + backend `VectorMcpStore` + `IngestionController` to the new `mcp_qrant` unified `store`/`find` tools (hard cut), with a dynamic provider/connection/embeddings UI mirroring the langfs loader.

**Architecture:** `VectorMcpStore` is rewritten to call the provider-agnostic `store`/`find` tools (one batch `store` call per file; `find` returns JSON). `IngestionController`'s store paths pass `provider`/`connection`/`embedding` through. The store node renders its provider list, connection form, and embeddings dropdown dynamically from `list_providers` / `connection_schema` / `list_embeddings`, reusing a shared MCP-proxy helper factored out of the loader.

**Tech Stack:** PHP 8 (backend, `declare(strict_types=1)`), vanilla JS (workflow-editor.js, Drawflow), the `mcp_qrant` Python MCP (already shipped), Qdrant (local).

## Global Constraints

- **Hard cut.** Remove every reference to `qdrant-store` / `qdrant-find`, and the now-dead `storeParallel`, `storeArgs`, `parseQdrantFind`, `callMcpToolBatch`. No compatibility alias.
- **mcp_qrant envelope:** a `tools/call` result is `{"content":[{"type":"text","text":"<json>"}]}`. After `interpretToolResult`, the dispatch callable returns that `result` object. Errors ride **inside** the decoded payload as `{"error":true,"code"?,"message"}` — NOT as JSON-RPC `isError` — so callers must decode `content[0].text` and check `error`.
- **`store` contract:** one call per file. Args `{provider, connection, collection, items:[{text,metadata}], embedding?}` → payload `{stored, errors}`.
- **`find` contract:** args `{provider, connection, collection, query, limit?, embedding?}` → payload `{results:[{text, metadata, score}]}`.
- **Store node config keys:** `{ store: "mcp:<id>", provider, connection: {…}, embedding: "", collection: "", disabled }`. `provider` and `connection` are new; `embedding` (selected list id, blank when the provider self-embeds) replaces the old free-text `embeddings` and the old `model` key.
- **Embeddings dropdown** is shown only when the chosen provider has `embeds_internally: false` (hidden for Qdrant). A blank `embedding` is sent as null/omitted.
- **`find` retrieval-test `limit` = 5** (constant).
- **Secrets** in `connection` (e.g. `api_key`) ride per request and are never logged. LAN-only posture: the connection is persisted in the node's workflow-config JSON.
- **Mirror the loader.** Reuse its `/mcp/proxy` call shape and `_parseListProviders`; do not write a parallel copy. Provider radios are gated on `available` (greyed when false), exactly like the loader.
- Backend tests run via `php backend/scripts/test-vector-mcp-store.php` (exit 0 = pass). Frontend has no JS test runner in this repo; frontend tasks are verified by explicit live browser steps (the same way the loader integration was verified).

---

### Task 1: Rewrite `VectorMcpStore` to the unified `store`/`find` contract

**Files:**
- Modify: `backend/src/AgentTeam/Services/VectorMcpStore.php` (full rewrite of the class body)
- Test: `backend/scripts/test-vector-mcp-store.php` (rewrite)

**Interfaces:**
- Consumes: the injected `dispatch` callable `fn(int $serverId, string $tool, array $args): array` — returns the MCP `result` object `{content:[{text:"<json>"}]}` (or a normalized `{error:true,message}` on transport/tool error).
- Produces:
  - `store(int $serverId, array $chunks, array $cfg): array{stored:int,errors:int,collection:?string}` — `$cfg` keys: `provider`, `connection` (array), `collection` (?string), `embedding` (?string), `metadata` (array, applied to every chunk).
  - `find(int $serverId, string $query, array $cfg): array{results:list<array{text:string,metadata:array,score:?float}>}` — `$cfg` keys: `provider`, `connection`, `collection`, `embedding` (?string), `limit` (int, default 5).
  - Removed: `storeParallel`, `storeArgs`.

- [ ] **Step 1: Rewrite the test file to the new contract**

Replace the entire contents of `backend/scripts/test-vector-mcp-store.php` with:

```php
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

echo "\n$checks checks, $failures failures\n";
exit($failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `php backend/scripts/test-vector-mcp-store.php`
Expected: FAIL — the old class still has `qdrant-store` / `storeParallel`; new assertions (`store` tool, `items`, `find`) fail or error.

- [ ] **Step 3: Rewrite `VectorMcpStore` to the new contract**

Replace the entire contents of `backend/src/AgentTeam/Services/VectorMcpStore.php` with:

```php
<?php
declare(strict_types=1);
namespace AgentTeam\Services;

/**
 * Read/write chunks to a registered vector-store MCP server (the LangChain
 * `mcp_qrant` server) through its provider-agnostic `store` / `find` tools. The
 * actual MCP call is injected (a callable) so this is unit-testable and so the
 * dispatch mechanism stays the single source of truth for how tools are invoked.
 *
 * The injected dispatch returns the MCP `result` object — the mcp_qrant envelope
 * `{content:[{type:text,text:"<json>"}]}`. Tool-level errors ride INSIDE that
 * payload as `{error:true,code?,message}` (not as JSON-RPC isError), so we decode
 * content[0].text and check `error` ourselves.
 */
final class VectorMcpStore
{
    /** @var callable(int,string,array):array */
    private $dispatch;

    /** @param callable(int $serverId, string $tool, array $args):array $dispatch */
    public function __construct(callable $dispatch)
    {
        $this->dispatch = $dispatch;
    }

    /**
     * Store all chunks for one file in a SINGLE `store` call. Blank chunks are
     * skipped; every stored chunk carries the same per-file metadata (provenance).
     * The server self-embeds for providers with embeds_internally (Qdrant); for
     * others the chosen `embedding` id is passed through and the MCP embeds.
     *
     * @param int                 $serverId  vector-store MCP server id (from store: "mcp:<id>")
     * @param array<int,string>   $chunks    text chunks
     * @param array<string,mixed> $cfg       {provider, connection, collection, embedding?, metadata?}
     * @return array{stored:int,errors:int,collection:?string}
     */
    public function store(int $serverId, array $chunks, array $cfg): array
    {
        $collection = $cfg['collection'] ?? null;
        $metadata = is_array($cfg['metadata'] ?? null) ? $cfg['metadata'] : [];

        $items = [];
        foreach ($chunks as $chunk) {
            $text = (string) $chunk;
            if (trim($text) === '') {
                continue;
            }
            $items[] = ['text' => $text, 'metadata' => $metadata];
        }
        if ($items === []) {
            return ['stored' => 0, 'errors' => 0, 'collection' => $collection];
        }

        $args = [
            'provider'   => (string) ($cfg['provider'] ?? ''),
            'connection' => (array) ($cfg['connection'] ?? []),
            'collection' => (string) ($collection ?? ''),
            'items'      => $items,
        ];
        $embedding = $cfg['embedding'] ?? null;
        if ($embedding !== null && $embedding !== '') {
            $args['embedding'] = (string) $embedding;
        }

        $payload = $this->decode(($this->dispatch)($serverId, 'store', $args));
        if (!empty($payload['error'])) {
            throw new \RuntimeException((string) ($payload['message'] ?? 'store failed'));
        }
        return [
            'stored'     => (int) ($payload['stored'] ?? 0),
            'errors'     => (int) ($payload['errors'] ?? 0),
            'collection' => $collection,
        ];
    }

    /**
     * Semantic search via `find`. Maps the payload's results to a normalized
     * shape; tolerates a missing/non-numeric score.
     *
     * @param array<string,mixed> $cfg  {provider, connection, collection, embedding?, limit?}
     * @return array{results:list<array{text:string,metadata:array,score:?float}>}
     */
    public function find(int $serverId, string $query, array $cfg): array
    {
        $args = [
            'provider'   => (string) ($cfg['provider'] ?? ''),
            'connection' => (array) ($cfg['connection'] ?? []),
            'collection' => (string) ($cfg['collection'] ?? ''),
            'query'      => $query,
            'limit'      => (int) ($cfg['limit'] ?? 5),
        ];
        $embedding = $cfg['embedding'] ?? null;
        if ($embedding !== null && $embedding !== '') {
            $args['embedding'] = (string) $embedding;
        }

        $payload = $this->decode(($this->dispatch)($serverId, 'find', $args));
        if (!empty($payload['error'])) {
            throw new \RuntimeException((string) ($payload['message'] ?? 'find failed'));
        }
        $results = [];
        foreach ((array) ($payload['results'] ?? []) as $r) {
            if (!is_array($r)) {
                continue;
            }
            $results[] = [
                'text'     => (string) ($r['text'] ?? ''),
                'metadata' => is_array($r['metadata'] ?? null) ? $r['metadata'] : [],
                'score'    => isset($r['score']) && is_numeric($r['score']) ? (float) $r['score'] : null,
            ];
        }
        return ['results' => $results];
    }

    /**
     * Decode the mcp_qrant envelope: pull content[0].text and json-decode it to
     * the payload. A transport/tool error already normalized to {error:true,...}
     * passes through unchanged (callers check `error`). If there's no envelope,
     * the input is returned as-is.
     *
     * @param array<string,mixed> $res
     * @return array<string,mixed>
     */
    private function decode(array $res): array
    {
        if (!empty($res['error'])) {
            return $res;
        }
        $text = $res['content'][0]['text'] ?? null;
        if (is_string($text)) {
            $decoded = json_decode($text, true);
            if (is_array($decoded)) {
                return $decoded;
            }
        }
        return $res;
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `php backend/scripts/test-vector-mcp-store.php`
Expected: PASS — final line `N checks, 0 failures`, exit 0.

- [ ] **Step 5: Lint and commit**

Run: `php -l backend/src/AgentTeam/Services/VectorMcpStore.php`
Expected: `No syntax errors detected`

```bash
git add backend/src/AgentTeam/Services/VectorMcpStore.php backend/scripts/test-vector-mcp-store.php
git commit -m "feat(ingestion): VectorMcpStore — unified store/find contract (batch-per-file, JSON envelope)"
```

---

### Task 2: Wire `IngestionController` store paths to the new contract

**Files:**
- Modify: `backend/src/AgentTeam/Controllers/IngestionController.php` — `storeChunks` (~298-395), `runStream` (~407-564), `runStart` (~684-756), `runWorker` (~766-884), `storeFind` (~573-624); remove `parseQdrantFind` (~634-672) and `callMcpToolBatch` (~1135-1185).

**Interfaces:**
- Consumes: `VectorMcpStore::store(int,array,array)` and `VectorMcpStore::find(int,string,array)` from Task 1; existing `openMcpSession`, `callMcpTool`, `callMcpServer`, `mcpBaseHeaders`.
- Produces: store paths now read `provider`/`connection`/`embedding` from the `vectorstore` config and pass them through; `storeFind` returns `results:[{content,source,score}]` (unchanged shape for the frontend) sourced from the new `find`.

- [ ] **Step 1: `storeChunks` — read new config keys and call `store` once**

In `storeChunks`, replace the model read (line ~326) and the store dispatch block (lines ~363-388). First, replace:

```php
        $collection = trim((string) ($storeCfg['collection'] ?? ''));
        $model = trim((string) ($storeCfg['model'] ?? ''));
```
with:
```php
        $collection = trim((string) ($storeCfg['collection'] ?? ''));
        $provider = trim((string) ($storeCfg['provider'] ?? ''));
        $connection = (array) ($storeCfg['connection'] ?? []);
        $embedding = trim((string) ($storeCfg['embedding'] ?? ''));
```

Then replace the block from `// One session for this file's chunk writes.` through the end of the `[store]` log line (the `$sess`/`$vs`/`$storeBatch`/`storeParallel` block, lines ~363-388) with:

```php
                // One session for this file's chunk writes.
                $sess = $this->openMcpSession((string) $srv['url'], $this->mcpBaseHeaders($srv['headers'] ?? null));
                if (!empty($sess['error'])) {
                    throw new \RuntimeException('Vector store connection failed: ' . ($sess['message'] ?? 'session error'));
                }
                $sessHeaders = $sess['headers'];
                $vs = new VectorMcpStore(function (int $sid, string $tool, array $args) use ($srv, $sessHeaders): array {
                    return $this->callMcpTool((string) $srv['url'], $sessHeaders, $tool, $args);
                });
                $r = $vs->store($serverId, $chunks, [
                    'provider'   => $provider,
                    'connection' => $connection,
                    'collection' => $collection !== '' ? $collection : null,
                    'embedding'  => $embedding !== '' ? $embedding : null,
                    'metadata'   => ['source' => $cur['source']],
                ]);
                $out['current'] = [
                    'source'      => $cur['source'],
                    'type'        => $cur['type'],
                    'chunk_count' => count($chunks),
                    'stored'      => $r['stored'],
                    'collection'  => $r['collection'],
                ];
                $coll = $r['collection'] ?? '(server default)';
                $logs[] = "[store] {$cur['source']}: wrote {$r['stored']} chunk(s)" . ($r['errors'] ? " ({$r['errors']} failed)" : '') . " → collection \"{$coll}\" on mcp:{$serverId}";
```

- [ ] **Step 2: `runStream` — read new config keys and call `store`**

Replace (lines ~450-451):
```php
        $collection = trim((string) ($storeCfg['collection'] ?? ''));
        $model = trim((string) ($storeCfg['model'] ?? ''));
```
with:
```php
        $collection = trim((string) ($storeCfg['collection'] ?? ''));
        $provider = trim((string) ($storeCfg['provider'] ?? ''));
        $connection = (array) ($storeCfg['connection'] ?? []);
        $embedding = trim((string) ($storeCfg['embedding'] ?? ''));
```

Replace the session/dispatch setup (lines ~501-506) — remove the `$storeBatch` closure:
```php
            $vs = new VectorMcpStore(function (int $sid, string $tool, array $args) use ($srv, $sessHeaders): array {
                return $this->callMcpTool((string) $srv['url'], $sessHeaders, $tool, $args);
            });
            $storeBatch = function (array $argsList) use ($srv, $sessHeaders): array {
                return $this->callMcpToolBatch((string) $srv['url'], $sessHeaders, 'qdrant-store', $argsList);
            };
```
with:
```php
            $vs = new VectorMcpStore(function (int $sid, string $tool, array $args) use ($srv, $sessHeaders): array {
                return $this->callMcpTool((string) $srv['url'], $sessHeaders, $tool, $args);
            });
```
Also remove the now-unused `$storeBatch = null;` initializer line (~493) so it reads just `$vs = null;`.

Replace the store call (lines ~540-544):
```php
                    $r = $vs->storeParallel($serverId, $ch, [
                        'collection' => $collection !== '' ? $collection : null,
                        'metadata'   => ['source' => $desc['source']],
                        'model'      => $model !== '' ? $model : null,
                    ], $storeBatch);
```
with:
```php
                    $r = $vs->store($serverId, $ch, [
                        'provider'   => $provider,
                        'connection' => $connection,
                        'collection' => $collection !== '' ? $collection : null,
                        'embedding'  => $embedding !== '' ? $embedding : null,
                        'metadata'   => ['source' => $desc['source']],
                    ]);
```

- [ ] **Step 3: `runStart` — persist the new config keys for workers**

In `runStart`, replace the `$config` assembly (lines ~745-746):
```php
            'collection'     => trim((string) ($storeCfg['collection'] ?? '')),
            'model'          => trim((string) ($storeCfg['model'] ?? '')),
```
with:
```php
            'collection'     => trim((string) ($storeCfg['collection'] ?? '')),
            'provider'       => trim((string) ($storeCfg['provider'] ?? '')),
            'connection'     => (array) ($storeCfg['connection'] ?? []),
            'embedding'      => trim((string) ($storeCfg['embedding'] ?? '')),
```

- [ ] **Step 4: `runWorker` — read new config keys and call `store`**

Replace the session/dispatch setup (lines ~823-828) — remove `$storeBatch`:
```php
            $vs = new VectorMcpStore(function (int $sid, string $tool, array $args) use ($url, $sessHeaders): array {
                return $this->callMcpTool($url, $sessHeaders, $tool, $args);
            });
            $storeBatch = function (array $argsList) use ($url, $sessHeaders): array {
                return $this->callMcpToolBatch($url, $sessHeaders, 'qdrant-store', $argsList);
            };
```
with:
```php
            $vs = new VectorMcpStore(function (int $sid, string $tool, array $args) use ($url, $sessHeaders): array {
                return $this->callMcpTool($url, $sessHeaders, $tool, $args);
            });
```
Also remove the now-unused `$storeBatch = null;` initializer (~812) so it reads just `$vs = null;`.

Replace the config reads (lines ~834-835):
```php
        $collection = (string) ($config['collection'] ?? '');
        $model = (string) ($config['model'] ?? '');
```
with:
```php
        $collection = (string) ($config['collection'] ?? '');
        $provider = (string) ($config['provider'] ?? '');
        $connection = (array) ($config['connection'] ?? []);
        $embedding = (string) ($config['embedding'] ?? '');
```

Replace the store call (lines ~864-868):
```php
                    $r = $vs->storeParallel($serverId, $ch, [
                        'collection' => $collection !== '' ? $collection : null,
                        'metadata'   => ['source' => $src],
                        'model'      => $model !== '' ? $model : null,
                    ], $storeBatch);
```
with:
```php
                    $r = $vs->store($serverId, $ch, [
                        'provider'   => $provider,
                        'connection' => $connection,
                        'collection' => $collection !== '' ? $collection : null,
                        'embedding'  => $embedding !== '' ? $embedding : null,
                        'metadata'   => ['source' => $src],
                    ]);
```

- [ ] **Step 5: `storeFind` — call the new `find` and map to the frontend shape**

In `storeFind`, replace the config reads (lines ~590-591):
```php
        $query = trim((string) ($body['query'] ?? ''));
        $collection = trim((string) ($storeCfg['collection'] ?? ''));
```
with:
```php
        $query = trim((string) ($body['query'] ?? ''));
        $collection = trim((string) ($storeCfg['collection'] ?? ''));
        $provider = trim((string) ($storeCfg['provider'] ?? ''));
        $connection = (array) ($storeCfg['connection'] ?? []);
        $embedding = trim((string) ($storeCfg['embedding'] ?? ''));
```

Replace the find dispatch + return (lines ~607-623) — from the `// The local Qdrant double accepts ONLY` comment through the closing `];`:
```php
        // The local Qdrant double accepts ONLY `query` (collection fixed by env);
        // send collection_name only when the user set one (PHP/cloud servers).
        $args = ['query' => $query];
        if ($collection !== '') {
            $args['collection_name'] = $collection;
        }

        @set_time_limit(60);
        $res = $this->callMcpServer((string) $srv['url'], $srv['headers'] ?? null, 'qdrant-find', $args);
        if (!empty($res['error'])) {
            return ['success' => false, 'error' => (string) $res['message'], 'status_code' => 400];
        }
        return [
            'success' => true,
            'data'    => ['query' => $query, 'results' => $this->parseQdrantFind($res)],
            'status_code' => 200,
        ];
```
with:
```php
        @set_time_limit(60);
        $vs = new VectorMcpStore(function (int $sid, string $tool, array $args) use ($srv): array {
            return $this->callMcpServer((string) $srv['url'], $srv['headers'] ?? null, $tool, $args);
        });
        try {
            $find = $vs->find($serverId, $query, [
                'provider'   => $provider,
                'connection' => $connection,
                'collection' => $collection,
                'embedding'  => $embedding !== '' ? $embedding : null,
                'limit'      => 5,
            ]);
        } catch (\Throwable $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 400];
        }
        // Map the MCP's {text,metadata,score} to the Search panel's {content,source,score}.
        $results = array_map(static fn(array $r): array => [
            'content' => $r['text'],
            'source'  => $r['metadata']['source'] ?? null,
            'score'   => $r['score'],
        ], $find['results']);
        return [
            'success' => true,
            'data'    => ['query' => $query, 'results' => $results],
            'status_code' => 200,
        ];
```

- [ ] **Step 6: Delete the dead `parseQdrantFind` and `callMcpToolBatch` methods**

Delete the entire `parseQdrantFind` method (the docblock at ~626 through its closing brace at ~672) and the entire `callMcpToolBatch` method (the docblock at ~1124 through its closing brace at ~1185). Both are now unreferenced.

- [ ] **Step 7: Verify the hard cut + lint**

Run: `grep -n "qdrant-store\|qdrant-find\|storeParallel\|storeArgs\|parseQdrantFind\|callMcpToolBatch" backend/src/AgentTeam/Controllers/IngestionController.php`
Expected: no output (zero matches).

Run: `php -l backend/src/AgentTeam/Controllers/IngestionController.php`
Expected: `No syntax errors detected`

Run: `php backend/scripts/test-vector-mcp-store.php`
Expected: PASS (Task 1's tests still green — the contract is unchanged).

- [ ] **Step 8: Commit**

```bash
git add backend/src/AgentTeam/Controllers/IngestionController.php
git commit -m "feat(ingestion): controller store paths call mcp_qrant store/find (provider+connection+embedding); drop qdrant-store/find + batch fan-out"
```

---

### Task 3: Extract a shared MCP-proxy tool-call helper; refactor the loader to use it

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js` — add `_mcpProxyToolCall` near `_parseListProviders` (~6259); refactor the loader's `refreshAvailability` (~6210-6238) to use it.

**Interfaces:**
- Produces: `async _mcpProxyToolCall(chosen, toolName, args = {})` → the JSON-RPC rpc result object (the proxy's `data.response`, falling back to `data`), or `null` on any failure. `chosen` is `{id, url, name}`.

- [ ] **Step 1: Add the shared helper**

Insert this method immediately before `_parseListProviders(res)` (~line 6259):

```javascript
    /**
     * Call ONE tool on a specific MCP server via the backend /mcp/proxy gateway,
     * scoped by server_url + server_id so a different registered server can't
     * answer. Returns the JSON-RPC result object (data.response || data), or null
     * on any failure — callers must tolerate null and never throw.
     */
    async _mcpProxyToolCall(chosen, toolName, args = {}) {
        try {
            if (!chosen || !chosen.url || !window.mcpClient
                || typeof window.mcpClient.request !== 'function') return null;
            const data = await window.mcpClient.request('/mcp/proxy', {
                method: 'POST',
                body: JSON.stringify({
                    action: 'proxy',
                    server_url: chosen.url,
                    server_id: chosen.id,
                    user_id: (typeof window.mcpClient.getUserId === 'function')
                        ? window.mcpClient.getUserId() : undefined,
                    jsonrpc: {
                        jsonrpc: '2.0', id: 1, method: 'tools/call',
                        params: { name: toolName, arguments: args || {} },
                    },
                }),
            });
            return (data && data.response) ? data.response : data;
        } catch (e) {
            console.warn(`[ingestion] ${toolName} proxy call failed:`, e);
            return null;
        }
    }
```

- [ ] **Step 2: Refactor the loader's `refreshAvailability` to use the helper**

Replace the body of `refreshAvailability` (lines ~6210-6238) with:

```javascript
        const refreshAvailability = async () => {
            const rpc = await this._mcpProxyToolCall(chosen, 'list_providers', {});
            if (!rpc) return;             // no chosen server / call failed — keep defaults
            const parsed = this._parseListProviders(rpc);
            if (parsed && parsed.length) {
                providers = parsed;       // the langfs default package (all 10, with `available`)
                renderProviders();
            }
        };
```

- [ ] **Step 3: Live-verify the loader still lists providers**

Hard-refresh the workflow editor (2-3 times; cache can be stale). Open a loader node's Config tab.
Expected: the Provider radios still render from langfs `list_providers` (e.g. `local` selectable; cloud providers greyed "(coming soon)") exactly as before. No console errors from `_mcpProxyToolCall`.

- [ ] **Step 4: Commit**

```bash
git add frontend/assets/js/workflow-editor.js
git commit -m "refactor(ingestion): extract shared _mcpProxyToolCall; loader uses it (DRY for the store node)"
```

---

### Task 4: Store node — dynamic provider/connection/embeddings form + Test connection

**Files:**
- Modify: `frontend/assets/js/workflow-editor.js` — vectorstore `fieldsHtml` (~6439-6455); the post-insert wiring (~6552-6561); `_parseListProviders` norm (~6260-6266); add `_isVectorStoreMcpServer`, `_wireStoreProviderAndConnection`, `_readStoreConnection`, `_parseListEmbeddings`; config save (~6666-6671); `_readIngestionFormConfig` vectorstore case (~7280-7286); remove `_populateVectorStoreMcpOptions` (~6297-6326).

**Interfaces:**
- Consumes: `_mcpProxyToolCall` (Task 3); `_parseListProviders`; `window.mcpClient.servers`.
- Produces: store node config `{ store:"mcp:<id>", provider, connection:{…}, embedding:"", collection:"", disabled }`. `searchVectorStore` is unchanged (backend maps `find` → `{content,source,score}`).

- [ ] **Step 1: Extend `_parseListProviders` to carry the extra descriptor fields**

The shared parser currently keeps only `{name, available}`. Extend its `norm` (lines ~6260-6266) so providers carry the fields the store node needs (the loader ignores the extras). Replace:

```javascript
        const norm = (arr) => Array.isArray(arr)
            ? arr.map(x => {
                if (typeof x === 'string') return { name: x, available: true };
                const name = x && (x.name || x.id);
                return name ? { name, available: x.available !== false } : null;
            }).filter(Boolean)
            : [];
```
with:
```javascript
        const norm = (arr) => Array.isArray(arr)
            ? arr.map(x => {
                if (typeof x === 'string') return { name: x, available: true };
                const name = x && (x.name || x.id);
                if (!name) return null;
                return {
                    name,
                    label: x.label || name,
                    available: x.available !== false,
                    embeds_internally: x.embeds_internally === true,
                    connection_schema: (x.connection_schema && typeof x.connection_schema === 'object') ? x.connection_schema : null,
                };
            }).filter(Boolean)
            : [];
```

- [ ] **Step 2: Replace the vectorstore `fieldsHtml`**

Replace the `else if (nodeType === 'vectorstore') { fieldsHtml = ` block (lines ~6439-6455) with:

```javascript
        } else if (nodeType === 'vectorstore') {
            fieldsHtml = `
                <div class="storage-config-folder" id="ingestion-vs-provider-wrap">
                    <label>Vector DB</label>
                    <div id="ingestion-vs-provider-host" class="ingestion-loader-provider-radios"></div>
                    <input type="hidden" id="ingestion-vs-store" value="${this.escapeHtml(config.store || '')}">
                </div>
                <div class="storage-config-folder full" id="ingestion-vs-connection-wrap">
                    <label>Connection</label>
                    <div id="ingestion-vs-connection-host"></div>
                </div>
                <div class="storage-config-folder" id="ingestion-vs-embeddings-wrap" style="display:none;">
                    <label for="ingestion-vs-embedding">Embeddings</label>
                    <select id="ingestion-vs-embedding"></select>
                </div>
                <div class="storage-config-folder">
                    <label for="ingestion-vs-collection">Collection</label>
                    <input type="text" id="ingestion-vs-collection" value="${this.escapeHtml(config.collection || '')}" placeholder="Collection name">
                </div>
                <div class="storage-config-folder full">
                    <button type="button" id="ingestion-vs-test" class="storage-config-btn cancel" style="padding:4px 14px;">Test connection</button>
                    <span id="ingestion-vs-test-result" style="margin-left:8px;font-size:12px;color:#9ca3af;"></span>
                </div>
            `;
        }
```

- [ ] **Step 3: Replace the post-insert wiring for the store node**

Replace the `if (nodeType === 'vectorstore') { this._populateVectorStoreMcpOptions(...) ... }` block (lines ~6552-6561) with:

```javascript
        if (nodeType === 'vectorstore') {
            this._wireStoreProviderAndConnection(config);
            // Retrieval test panel: query the vector store via `find`.
            const searchBtn = document.getElementById('ingestion-search-btn');
            const searchInput = document.getElementById('ingestion-search-query');
            if (searchBtn) searchBtn.addEventListener('click', () => this.searchVectorStore(nodeId));
            if (searchInput) searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); this.searchVectorStore(nodeId); }
            });
        }
```

- [ ] **Step 4: Add `_isVectorStoreMcpServer` and `_wireStoreProviderAndConnection`**

Delete the entire `_populateVectorStoreMcpOptions(selected)` method (lines ~6297-6326) and in its place add:

```javascript
    /** Heuristic: is this MCP server a vector-store server? (name/desc/url). */
    _isVectorStoreMcpServer(server) {
        if (!server) return false;
        const hay = `${server.name || ''} ${server.description || ''} ${server.url || ''}`.toLowerCase();
        return /\b(vector|qdrant|qdant|mcp_qrant|pgvector)\b/.test(hay)
            || /vector|qdrant|mcp_qrant|pgvector/.test(hay);
    }

    /**
     * Wire the store node's "Vector DB" provider radios + dynamic connection form
     * + conditional embeddings dropdown + Test connection. Mirrors the loader:
     * the vector-store MCP server is auto-resolved into a hidden input (store:
     * "mcp:<id>"); providers/connection/embeddings come from list_providers /
     * connection_schema / list_embeddings. Everything degrades gracefully — a
     * missing mcpClient or a failing call must never throw.
     */
    _wireStoreProviderAndConnection(config = {}) {
        const storeInput = document.getElementById('ingestion-vs-store');
        const providerHost = document.getElementById('ingestion-vs-provider-host');
        const connHost = document.getElementById('ingestion-vs-connection-host');
        const embWrap = document.getElementById('ingestion-vs-embeddings-wrap');
        const embSel = document.getElementById('ingestion-vs-embedding');
        if (!storeInput || !providerHost || !connHost) return;

        const savedConn = (config.connection && typeof config.connection === 'object') ? config.connection : {};
        const savedProvider = config.provider || '';
        const savedEmbedding = config.embedding || '';

        // --- 1. Resolve the vector-store MCP server (sync, from mcpClient.servers). ---
        const collectServers = () => {
            const out = [];
            try {
                const map = window.mcpClient && window.mcpClient.servers;
                if (map && typeof map.forEach === 'function') {
                    map.forEach(s => { if (this._isVectorStoreMcpServer(s)) out.push(s); });
                }
            } catch (e) { console.warn('[ingestion/store] server collect failed:', e); }
            return out;
        };
        const savedId = String(config.store || '').startsWith('mcp:') ? String(config.store).slice(4) : '';
        let chosen = null; // {id, url, name}
        const resolveServer = () => {
            const servers = collectServers();
            const pick = servers.find(s => savedId && String(s.id) === savedId)
                || servers.find(s => /mcp_qrant|qdrant/i.test(`${s.name || ''} ${s.url || ''}`))
                || servers[0] || null;
            chosen = pick ? { id: String(pick.id), url: pick.url || '', name: pick.name || `server ${pick.id}` } : null;
            storeInput.value = chosen ? `mcp:${chosen.id}` : '';
            if (chosen) storeInput.dataset.url = chosen.url;
        };

        // --- providers (from list_providers; gated on `available`). ---
        let providers = [];
        const providerByName = (name) => providers.find(p => p.name === name) || null;

        const renderConnection = () => {
            const checked = providerHost.querySelector('input[name="ingestion-vs-provider"]:checked');
            const prov = checked ? providerByName(checked.value) : null;
            const fields = (prov && prov.connection_schema && Array.isArray(prov.connection_schema.fields))
                ? prov.connection_schema.fields : [];
            connHost.innerHTML = fields.map(f => {
                const name = f.name;
                const label = this.escapeHtml(f.label || name);
                const req = f.required ? ' *' : '';
                const cur = savedConn[name] != null ? String(savedConn[name]) : '';
                if (f.type === 'select' && Array.isArray(f.options)) {
                    const opts = f.options.map(o => `<option value="${this.escapeHtml(String(o))}" ${cur === String(o) ? 'selected' : ''}>${this.escapeHtml(String(o))}</option>`).join('');
                    return `<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#9ca3af;">${label}${req}</label>`
                        + `<select data-conn-field="${this.escapeHtml(name)}">${opts}</select></div>`;
                }
                const inputType = (f.mask || f.type === 'password') ? 'password' : (f.type === 'number' ? 'number' : 'text');
                return `<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#9ca3af;">${label}${req}</label>`
                    + `<input type="${inputType}" data-conn-field="${this.escapeHtml(name)}" value="${this.escapeHtml(cur)}"></div>`;
            }).join('') || '<span style="font-size:12px;color:#6b7280;">No connection fields for this provider.</span>';
        };

        const toggleEmbeddings = () => {
            const checked = providerHost.querySelector('input[name="ingestion-vs-provider"]:checked');
            const prov = checked ? providerByName(checked.value) : null;
            // Self-embedding providers (Qdrant) hide the dropdown; others show it.
            if (!prov || prov.embeds_internally) {
                if (embWrap) embWrap.style.display = 'none';
                return;
            }
            if (embWrap) embWrap.style.display = '';
            if (embSel && embSel.options.length === 0) {
                this._mcpProxyToolCall(chosen, 'list_embeddings', {}).then(rpc => {
                    const embs = this._parseListEmbeddings(rpc);
                    embSel.innerHTML = embs.map(e =>
                        `<option value="${this.escapeHtml(e.id)}" ${e.id === savedEmbedding ? 'selected' : ''}>${this.escapeHtml(e.label || e.id)}</option>`).join('');
                });
            }
        };

        const renderProviders = () => {
            providerHost.style.display = 'grid';
            providerHost.style.gridTemplateColumns = '1fr 1fr';
            providerHost.style.columnGap = '16px';
            providerHost.style.rowGap = '8px';
            providerHost.innerHTML = providers.map(p => {
                const disabled = !p.available;
                const checked = (p.name === savedProvider && !disabled) ? 'checked' : '';
                const suffix = disabled ? ' (coming soon)' : '';
                const style = `display:flex;align-items:center;gap:6px;` + (disabled ? 'opacity:.5;cursor:not-allowed;' : '');
                return `<label class="ingestion-loader-provider-radio${disabled ? ' disabled' : ''}" style="${style}">`
                    + `<input type="radio" name="ingestion-vs-provider" value="${this.escapeHtml(p.name)}" ${checked} ${disabled ? 'disabled' : ''}>`
                    + `<span>${this.escapeHtml(p.label || p.name)}${suffix}</span></label>`;
            }).join('');
            if (!providerHost.querySelector('input[name="ingestion-vs-provider"]:checked')) {
                const firstEnabled = providerHost.querySelector('input[name="ingestion-vs-provider"]:not([disabled])');
                if (firstEnabled) firstEnabled.checked = true;
            }
            providerHost.querySelectorAll('input[name="ingestion-vs-provider"]').forEach(r => {
                r.addEventListener('change', () => { renderConnection(); toggleEmbeddings(); });
            });
            renderConnection();
            toggleEmbeddings();
        };

        const refreshProviders = async () => {
            const rpc = await this._mcpProxyToolCall(chosen, 'list_providers', {});
            if (!rpc) return;
            const parsed = this._parseListProviders(rpc);
            if (parsed && parsed.length) { providers = parsed; renderProviders(); }
        };

        // Wire the Test connection button.
        const testBtn = document.getElementById('ingestion-vs-test');
        const testOut = document.getElementById('ingestion-vs-test-result');
        if (testBtn) testBtn.addEventListener('click', async () => {
            const checked = providerHost.querySelector('input[name="ingestion-vs-provider"]:checked');
            const provider = checked ? checked.value : '';
            if (!provider) { if (testOut) testOut.textContent = 'Pick a provider first.'; return; }
            if (testOut) testOut.textContent = 'Testing…';
            const rpc = await this._mcpProxyToolCall(chosen, 'test_connection', { provider, connection: this._readStoreConnection() });
            let ok = false, msg = 'no response';
            try {
                // test_connection payload is {ok:bool,message?} inside content[0].text.
                const result = (rpc && rpc.result !== undefined) ? rpc.result : rpc;
                let payload = result;
                const content = result && result.content;
                if (Array.isArray(content) && content[0] && typeof content[0].text === 'string') {
                    try { payload = JSON.parse(content[0].text); } catch (e) { /* ignore */ }
                }
                ok = !!(payload && payload.ok);
                msg = (payload && payload.message) ? payload.message : (ok ? 'OK' : 'failed');
            } catch (e) { msg = String(e); }
            if (testOut) { testOut.textContent = ok ? '✓ OK' : `✗ ${msg}`; testOut.style.color = ok ? '#34d399' : '#f87171'; }
        });

        // Resolve + render synchronously, then refresh from the live server list.
        resolveServer();
        renderProviders();
        try {
            if (window.mcpClient && typeof window.mcpClient.loadServers === 'function') {
                window.mcpClient.loadServers()
                    .then(() => { resolveServer(); refreshProviders(); })
                    .catch(e => console.warn('[ingestion/store] loadServers failed:', e));
            }
        } catch (e) { console.warn('[ingestion/store] loadServers threw:', e); }
        refreshProviders();
    }

    /** Gather the store node's connection form into a {field: value} object. */
    _readStoreConnection() {
        const host = document.getElementById('ingestion-vs-connection-host');
        const out = {};
        if (!host) return out;
        host.querySelectorAll('[data-conn-field]').forEach(el => {
            const k = el.getAttribute('data-conn-field');
            const v = (el.value != null ? String(el.value) : '').trim();
            if (k && v !== '') out[k] = v;
        });
        return out;
    }

    /**
     * Defensively parse a list_embeddings result into [{id,label}]. Handles the
     * MCP content[0].text JSON framing and {embeddings:[...]}. Returns [] on fail.
     */
    _parseListEmbeddings(res) {
        const norm = (arr) => Array.isArray(arr)
            ? arr.map(x => {
                const id = x && (x.id || x.name);
                return id ? { id, label: x.label || id } : null;
            }).filter(Boolean)
            : [];
        try {
            if (!res) return [];
            const result = (res.result !== undefined) ? res.result : res;
            if (!result) return [];
            if (Array.isArray(result.embeddings)) return norm(result.embeddings);
            const content = result.content;
            if (Array.isArray(content)) {
                for (const part of content) {
                    if (part && typeof part.text === 'string') {
                        try {
                            const obj = JSON.parse(part.text);
                            if (Array.isArray(obj)) return norm(obj);
                            if (obj && Array.isArray(obj.embeddings)) return norm(obj.embeddings);
                        } catch (e) { /* not JSON */ }
                    }
                }
            }
        } catch (e) { console.warn('[ingestion/store] parse list_embeddings failed:', e); }
        return [];
    }
```

- [ ] **Step 5: Update the config save block**

Replace the vectorstore branch of the save handler (lines ~6666-6671):

```javascript
            } else if (nodeType === 'vectorstore') {
                newConfig = {
                    store: document.getElementById('ingestion-vs-store').value,
                    embeddings: document.getElementById('ingestion-vs-embeddings').value.trim(),
                    collection: document.getElementById('ingestion-vs-collection').value.trim(),
                };
            } else {
```
with:
```javascript
            } else if (nodeType === 'vectorstore') {
                newConfig = this._readIngestionFormConfig('vectorstore', config);
            } else {
```

- [ ] **Step 6: Update `_readIngestionFormConfig` vectorstore case**

Replace the vectorstore case (lines ~7280-7286):

```javascript
        if (nodeType === 'vectorstore') {
            return {
                store: val('ingestion-vs-store', fallback.store || 'pgvector'),
                embeddings: (val('ingestion-vs-embeddings', fallback.embeddings || '') || '').trim(),
                collection: (val('ingestion-vs-collection', fallback.collection || '') || '').trim(),
                disabled,
            };
        }
```
with:
```javascript
        if (nodeType === 'vectorstore') {
            const storeEl = document.getElementById('ingestion-vs-store');
            const store = storeEl ? (storeEl.value || '') : (fallback.store || '');
            const provEl = document.querySelector('input[name="ingestion-vs-provider"]:checked');
            const provider = provEl ? provEl.value : (fallback.provider || '');
            const connection = document.getElementById('ingestion-vs-connection-host')
                ? this._readStoreConnection()
                : (fallback.connection || {});
            const embWrap = document.getElementById('ingestion-vs-embeddings-wrap');
            const embSel = document.getElementById('ingestion-vs-embedding');
            const embedding = (embWrap && embWrap.style.display !== 'none' && embSel)
                ? (embSel.value || '')
                : (fallback.embedding || '');
            return {
                store,
                provider,
                connection,
                embedding,
                collection: (val('ingestion-vs-collection', fallback.collection || '') || '').trim(),
                disabled,
            };
        }
```

- [ ] **Step 7: Update the default store config seed**

The new-node default (line ~5733) seeds the old keys. Replace:
```javascript
            vectorstore: { store: 'pgvector', embeddings: 'openai:text-embedding-3-small', collection: '' },
```
with:
```javascript
            vectorstore: { store: '', provider: 'qdrant', connection: {}, embedding: '', collection: '' },
```

- [ ] **Step 8: Verify the hard cut on the frontend + syntax**

Run: `grep -n "_populateVectorStoreMcpOptions\|ingestion-vs-embeddings\b\|qdrant-find" frontend/assets/js/workflow-editor.js`
Expected: no matches for `_populateVectorStoreMcpOptions` or `qdrant-find`. (`ingestion-vs-embeddings-wrap` is the new id and may match the `-wrap` suffix — confirm only the `-wrap`/`embedding` ids remain, not the old `ingestion-vs-embeddings` text input.)

Run: `node --check frontend/assets/js/workflow-editor.js`
Expected: no output (valid syntax).

- [ ] **Step 9: Commit**

```bash
git add frontend/assets/js/workflow-editor.js
git commit -m "feat(ingestion): store node dynamic provider/connection/embeddings form + Test connection (mirrors loader)"
```

---

### Task 5: End-to-end acceptance — register the server and run loader→split→store→find

**Files:** none (operational verification).

**Interfaces:**
- Consumes: everything from Tasks 1-4; the running `mcp_qrant` server (:8008) and a local Qdrant; the langfs loader (:8077).

- [ ] **Step 1: Start the servers**

Ensure `mcp_qrant` is running (default `http://127.0.0.1:8008`, MCP at `/mcp`) and langfs is running. Confirm `mcp_qrant` responds:

Run: `curl -s -X POST http://127.0.0.1:8008/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_providers","arguments":{}}}'`
Expected: a JSON/SSE body whose `content[0].text` is JSON with `"providers"` listing 10 entries, `qdrant` having `"available":true`.

- [ ] **Step 2: Register `mcp_qrant` in the MCP catalog**

In the gpt MCP servers UI (or via the existing registration flow), add a server named so `_isVectorStoreMcpServer` matches — e.g. `vector_mcp_qrant` — with URL `http://127.0.0.1:8008/mcp`. Enable it.
Expected: it appears in `GET /mcp/servers` and `window.mcpClient.servers`.

- [ ] **Step 3: Configure the store node in the editor**

Hard-refresh the editor. Open the store node's Config tab.
Expected:
- The "Vector DB" radios render with **Qdrant** selectable and the other 9 greyed "(coming soon)".
- Selecting Qdrant renders the connection form: a **Mode** select (local/remote), **Local storage path**, **Remote URL**, **API key** (masked).
- The Embeddings dropdown is **hidden** (Qdrant self-embeds).
- Set Mode = `local`, Local storage path = a writable path (e.g. `/Users/<you>/qdrant-mcp/storage`), Collection = `learn_docs`.

- [ ] **Step 4: Test connection**

Click **Test connection**.
Expected: `✓ OK` (the path is reachable). Set a bogus remote URL to confirm it shows `✗ <message>`, then restore the local config.

- [ ] **Step 5: Run the pipeline and verify storage**

Point the loader at a small folder of text/pdf files; save the workflow; click ▶ Start.
Expected: per-file logs show `[loader] … [splitter] … [store] …: wrote N chunk(s) → collection "learn_docs" on mcp:<id>`, with no errors.

- [ ] **Step 6: Retrieval test (`find`)**

Open the store node's **Search** tab, enter a query matching the ingested content, click Search.
Expected: results render with scores and `[source]` tags — i.e. `find` returned `{results:[{text,metadata,score}]}` mapped to the Search panel. This closes the loop (loader→split→store→find).

- [ ] **Step 7: Confirm the run-worker (parallel) path**

With "Parallel workers" > 1 on the loader, run ▶ Start again.
Expected: the same successful store/find behavior across the worker streams (the `runWorker` path uses the persisted `provider`/`connection`/`embedding`).

- [ ] **Step 8: Commit any docs/notes (if applicable)**

If the acceptance run surfaced a setup note worth recording (e.g. the exact server name/URL convention), add it to the spec's §11 and commit. Otherwise no commit.

---

## Self-Review

**1. Spec coverage:**
- §3 dynamic store node (provider/connection/embeddings + Test) → Task 4. ✓
- §3 `VectorMcpStore` rewrite → Task 1. ✓
- §3 controller passthrough → Task 2. ✓
- §3 removal of `qdrant-store`/`qdrant-find` + XML parser → Task 2 (steps 6-7). ✓
- §3 shared frontend proxy helper (no parallel copy) → Task 3. ✓
- §5 contract mapping (batch-per-file, items, JSON find) → Tasks 1-2. ✓
- §6 connection from `connection_schema`, embeddings gated on `embeds_internally`, Test button → Task 4. ✓
- §7 `store`/`find` arg shapes + envelope decode → Task 1. ✓
- §8 controller reads provider/connection/embedding across all paths → Task 2 (storeChunks/runStream/runStart/runWorker/storeFind). ✓
- §9 error handling (errors surfaced, secrets not logged) → Task 1 (throws on payload error), Task 2 (logs counts, never logs connection). ✓
- §10 tests → Task 1 (PHP unit) + Task 5 (E2E). ✓
- §11 setup note → Task 5 step 2. ✓
- §12 open items: find limit = 5 (Global Constraints + Task 1); Qdrant path left to the user (Task 5 step 3 — no pre-fill). ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. ✓

**3. Type consistency:** `store(int,array,array)→{stored,errors,collection}` and `find(int,string,array)→{results:[{text,metadata,score}]}` used identically in Tasks 1 and 2. Config keys `{store,provider,connection,embedding,collection,disabled}` consistent across Task 4 save/read and Task 2 controller reads. The dispatch callable signature `fn(int,string,array):array` matches the existing `callMcpTool`/`callMcpServer` usage. ✓
