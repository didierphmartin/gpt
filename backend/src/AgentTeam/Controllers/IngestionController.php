<?php

declare(strict_types=1);

namespace AgentTeam\Controllers;

use AgentTeam\Services\IngestionCompiler;
use AgentTeam\Services\IngestionLoader;
use AgentTeam\Services\IngestionSplitter;
use AgentTeam\Services\VectorMcpStore;
use AgentTeam\Services\WorkflowRepository;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;
use PDO;

/**
 * Dedicated RAG ingestion endpoints — separate from the agent run/compile
 * controller (WorkflowController). Each chunk/script is compiled from the
 * node configs the FRONTEND sends, NOT from the saved graph. The real
 * separation lives in IngestionCompiler; this controller only auth-gates and
 * relays.
 *
 * Constructor signature matches every other AgentTeam controller so the
 * front-controller dispatcher (backend/index.php: `new $controllerClass($pdo,
 * $config)`) instantiates it the same way.
 */
final class IngestionController
{
    private PDO $db;
    private array $config;
    private WorkflowRepository $workflowRepository;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
        $this->workflowRepository = new WorkflowRepository($db);
    }

    /**
     * POST /api/v1/workflows/{id}/ingestion/node-code
     * Compile the Python chunk for a SINGLE node from the config the frontend
     * sends. Body: { node_type: string, config: object }.
     */
    public function nodeCode(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        if (!$workflowId) {
            return ['success' => false, 'error' => 'Workflow ID is required', 'status_code' => 400];
        }
        if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
            return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
        }

        $body = $request['body'] ?? [];
        $stages = $body['stages'] ?? null;

        try {
            if (is_array($stages) && !empty($stages)) {
                // Ordered pipeline stages (start … target) → cumulative view.
                $view = IngestionCompiler::compileView($stages);
                $last = end($stages);
                $nodeType = (string) ($last['node_type'] ?? $last['type'] ?? 'loader');
            } else {
                // Single node fallback.
                $nodeType = (string) ($body['node_type'] ?? 'loader');
                $view = IngestionCompiler::compileNodeView($nodeType, (array) ($body['config'] ?? []));
            }
            return [
                'success'     => true,
                'data'        => array_merge(['node' => $nodeType], $view),
                'status_code' => 200,
            ];
        } catch (\Throwable $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 400];
        }
    }

    /**
     * POST /api/v1/workflows/{id}/ingestion/compile
     * Compile the full runnable standalone script from the three node configs
     * the frontend sends. Body: { loader: object, splitter: object,
     * vectorstore: object }. Best-effort writes it under langchain_runner/.
     */
    public function compile(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        if (!$workflowId) {
            return ['success' => false, 'error' => 'Workflow ID is required', 'status_code' => 400];
        }
        if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
            return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
        }

        $body = $request['body'] ?? [];
        $loader = (array) ($body['loader'] ?? []);
        $splitter = (array) ($body['splitter'] ?? []);
        $store = (array) ($body['vectorstore'] ?? []);

        // Resolve the runtime URLs the emitted script needs: langfs (from the
        // loader's storage MCP) and mcp_qrant (from store:"mcp:<id>").
        $ctx = [];
        if (!empty($loader['storage_mcp_url'])) {
            $ctx['langfs_url'] = (string) $loader['storage_mcp_url'];
        }
        if (preg_match('/^mcp:(\d+)$/', (string) ($store['store'] ?? ''), $m)) {
            $stmt = $this->db->prepare("SELECT url FROM mcp_servers WHERE id = ? AND enabled = 1");
            $stmt->execute([(int) $m[1]]);
            $row = $stmt->fetch(\PDO::FETCH_ASSOC);
            if ($row) {
                $ctx['mcpqrant_url'] = (string) $row['url'];
            }
        }

        try {
            $r = IngestionCompiler::compileScript($loader, $splitter, $store, $ctx);

            $path = dirname(__DIR__, 4) . '/langchain_runner/' . basename($r['filename']);
            $written = @file_put_contents($path, $r['code']);

            return [
                'success' => true,
                'data'    => [
                    'filename' => $r['filename'],
                    'path'     => $written !== false ? $path : null,
                    'written'  => $written !== false,
                    'code'     => $r['code'],
                ],
                'status_code' => 200,
            ];
        } catch (\Throwable $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 400];
        }
    }

    /**
     * POST /api/v1/workflows/{id}/ingestion/save-script
     *
     * Store an already-compiled ingestion script to a chosen location. The
     * default target is the `langchain_runner/` Python environment (the field
     * the UI pre-fills); the user may point it anywhere they can write (LAN /
     * authenticated context — no path sandbox). Body: { code, dest?, filename? }.
     */
    public function saveScript(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        if (!$workflowId || !$this->workflowRepository->canUserAccess($userId, $workflowId)) {
            return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
        }

        $body = $request['body'] ?? [];
        $code = (string) ($body['code'] ?? '');
        $dest = trim((string) ($body['dest'] ?? ''));
        $filename = basename(trim((string) ($body['filename'] ?? '')));
        if ($code === '') {
            return ['success' => false, 'error' => 'Nothing to save (empty script).', 'status_code' => 400];
        }
        if ($filename === '') {
            $filename = 'ingestion_pipeline.py';
        }
        if (!str_ends_with($filename, '.py')) {
            $filename .= '.py';
        }

        $repoRoot = dirname(__DIR__, 4);            // …/gpt
        $defaultDir = $repoRoot . '/langchain_runner';

        // Resolve the destination: blank → default env; a path ending in .py is a
        // full file path; an absolute dir is used as-is; a relative dir resolves
        // against the gpt repo root.
        if ($dest === '') {
            $dir = $defaultDir;
        } elseif (str_ends_with($dest, '.py')) {
            $dir = dirname($dest);
            $filename = basename($dest);
        } elseif ($dest[0] === '/' || $dest[0] === '~') {
            $dir = str_starts_with($dest, '~') ? (getenv('HOME') . substr($dest, 1)) : $dest;
        } else {
            $dir = $repoRoot . '/' . $dest;
        }
        $dir = rtrim($dir, '/');

        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            return ['success' => false, 'error' => "Could not create directory: {$dir}", 'status_code' => 400];
        }
        $path = $dir . '/' . $filename;
        if (@file_put_contents($path, $code) === false) {
            return ['success' => false, 'error' => "Could not write to: {$path}", 'status_code' => 400];
        }
        return ['success' => true, 'data' => ['path' => $path, 'default_dir' => $defaultDir], 'status_code' => 200];
    }

    /**
     * POST /api/v1/workflows/{id}/ingestion/loader-text
     *
     * The LOADER node's interpreter (first node of the PHP interpreter, built
     * node-by-node): enumerate the source (single file, or a folder walked
     * recursively) through the langfs MCP and transform each file into TEXT —
     * the content shown in the loader's Output tab and, later, fed to the
     * splitter. Body: { config: { provider, path, is_dir, types[],
     * storage_mcp_id, storage_mcp_url, ufskey } }.
     */
    public function loaderText(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        if (!$workflowId) {
            return ['success' => false, 'error' => 'Workflow ID is required', 'status_code' => 400];
        }
        if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
            return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
        }

        $body = $request['body'] ?? [];
        $cfg = (array) ($body['config'] ?? []);
        $cursor = max(0, (int) ($body['cursor'] ?? 0));
        $provider = (string) ($cfg['provider'] ?? 'local') ?: 'local';
        $path = trim((string) ($cfg['path'] ?? ''));
        $isDir = !empty($cfg['is_dir']);
        $types = array_values(array_filter((array) ($cfg['types'] ?? []), 'is_string'));

        if ($path === '') {
            return ['success' => false, 'error' => 'Choose a file or folder in the loader first.', 'status_code' => 400];
        }

        [$listFiles, $readFile] = $this->buildLoaderClosures($userId, (string) ($cfg['storage_mcp_id'] ?? ''));

        @set_time_limit(120);
        try {
            // One round = one file's text (the store clocks the loop; here the
            // Output tab's stepper supplies the cursor).
            $round = IngestionLoader::readRound($listFiles, $readFile, $provider, $path, $types, $isDir, $cursor);
            $cur = $round['current'];
            if ($cur === null) {
                $round['logs'] = ['[loader] ' . ($round['count'] === 0 ? 'no matching files (check Source + File types)' : 'done — ' . $round['count'] . ' file(s)')];
            } elseif (isset($cur['error'])) {
                $round['logs'] = ["[loader] {$cur['source']}: ERROR — {$cur['error']}"];
            } else {
                $round['logs'] = ['[loader] file ' . ($round['cursor'] + 1) . "/{$round['count']}: {$cur['source']} → {$cur['type']}, {$cur['chars']} chars"];
            }
            return ['success' => true, 'data' => $round, 'status_code' => 200];
        } catch (\Throwable $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 400];
        }
    }

    /**
     * POST /api/v1/workflows/{id}/ingestion/splitter-chunks
     *
     * The SPLITTER node's interpreter: read one file's text from the upstream
     * loader (round `cursor`), then chunk it with the recursive splitter — the
     * chunks shown in the splitter's Output tab and, later, fed to the store.
     * Body: { loader: {...loader config...}, splitter: { chunk_size, overlap },
     * cursor }.
     */
    public function splitterChunks(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        if (!$workflowId) {
            return ['success' => false, 'error' => 'Workflow ID is required', 'status_code' => 400];
        }
        if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
            return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
        }

        $body = $request['body'] ?? [];
        $loaderCfg = (array) ($body['loader'] ?? []);
        $splitterCfg = (array) ($body['splitter'] ?? []);
        $cursor = max(0, (int) ($body['cursor'] ?? 0));

        $provider = (string) ($loaderCfg['provider'] ?? 'local') ?: 'local';
        $path = trim((string) ($loaderCfg['path'] ?? ''));
        $isDir = !empty($loaderCfg['is_dir']);
        $types = array_values(array_filter((array) ($loaderCfg['types'] ?? []), 'is_string'));
        $chunkSize = max(1, (int) ($splitterCfg['chunk_size'] ?? 1000));
        $overlap = max(0, (int) ($splitterCfg['overlap'] ?? 150));

        if ($path === '') {
            return ['success' => false, 'error' => 'The upstream loader has no Source set — pick a file or folder first.', 'status_code' => 400];
        }

        [$listFiles, $readFile] = $this->buildLoaderClosures($userId, (string) ($loaderCfg['storage_mcp_id'] ?? ''));

        @set_time_limit(120);
        try {
            // Full text for this file (no display clipping — the splitter needs
            // the whole document), then chunk it.
            $round = IngestionLoader::readRound($listFiles, $readFile, $provider, $path, $types, $isDir, $cursor, 5_000_000);
            $cur = $round['current'];
            $out = [
                'count'   => $round['count'],
                'cursor'  => $round['cursor'],
                'sources' => $round['sources'],
                'current' => null,
            ];
            $logs = [];
            if ($cur === null) {
                $logs[] = '[splitter] ' . ($round['count'] === 0 ? 'no files to chunk' : 'done');
            } elseif (isset($cur['error'])) {
                $out['current'] = ['source' => $cur['source'], 'type' => $cur['type'] ?? null, 'error' => $cur['error']];
                $logs[] = "[loader] {$cur['source']}: ERROR — {$cur['error']}";
            } else {
                $logs[] = '[loader] file ' . ($round['cursor'] + 1) . "/{$round['count']}: {$cur['source']} → {$cur['type']}, " . mb_strlen($cur['text']) . ' chars';
                $chunks = IngestionSplitter::recursiveSplit($cur['text'], $chunkSize, $overlap);
                // Cap what we ship to the Output panel (full count kept).
                $maxChunks = 200;
                $maxLen = 2000;
                $shown = array_slice($chunks, 0, $maxChunks);
                $shown = array_map(static function (string $c) use ($maxLen): array {
                    $len = mb_strlen($c);
                    return ['chars' => $len, 'text' => $len > $maxLen ? mb_substr($c, 0, $maxLen) : $c, 'clipped' => $len > $maxLen];
                }, $shown);
                $out['current'] = [
                    'source'      => $cur['source'],
                    'type'        => $cur['type'],
                    'chunk_count' => count($chunks),
                    'chunks'      => $shown,
                    'truncated'   => count($chunks) > $maxChunks,
                ];
                $logs[] = "[splitter] {$cur['source']}: " . count($chunks) . " chunk(s) (size={$chunkSize}, overlap={$overlap})";
            }
            $out['logs'] = $logs;
            return ['success' => true, 'data' => $out, 'status_code' => 200];
        } catch (\Throwable $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 400];
        }
    }

    /**
     * POST /api/v1/workflows/{id}/ingestion/store-chunks
     *
     * The STORE node's interpreter (terminal node): loader round → split →
     * write each chunk to the chosen vector-DB MCP (store/find contract).
     * WRITES. Body: { loader, splitter, vectorstore: { store:"mcp:<id>",
     * collection, provider, connection, embedding }, cursor }.
     */
    public function storeChunks(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        if (!$workflowId) {
            return ['success' => false, 'error' => 'Workflow ID is required', 'status_code' => 400];
        }
        if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
            return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
        }

        $body = $request['body'] ?? [];
        $loaderCfg = (array) ($body['loader'] ?? []);
        $splitterCfg = (array) ($body['splitter'] ?? []);
        $storeCfg = (array) ($body['vectorstore'] ?? []);
        $cursor = max(0, (int) ($body['cursor'] ?? 0));

        $provider = (string) ($loaderCfg['provider'] ?? 'local') ?: 'local';
        $path = trim((string) ($loaderCfg['path'] ?? ''));
        $isDir = !empty($loaderCfg['is_dir']);
        $types = array_values(array_filter((array) ($loaderCfg['types'] ?? []), 'is_string'));
        $chunkSize = max(1, (int) ($splitterCfg['chunk_size'] ?? 1000));
        $overlap = max(0, (int) ($splitterCfg['overlap'] ?? 150));
        $collection = trim((string) ($storeCfg['collection'] ?? ''));
        $vsProvider = trim((string) ($storeCfg['provider'] ?? ''));
        $connection = (array) ($storeCfg['connection'] ?? []);
        $embedding = trim((string) ($storeCfg['embedding'] ?? ''));

        if ($path === '') {
            return ['success' => false, 'error' => 'The upstream loader has no Source set.', 'status_code' => 400];
        }
        if (!preg_match('/^mcp:(\d+)$/', (string) ($storeCfg['store'] ?? ''), $m)) {
            return ['success' => false, 'error' => 'Pick a vector-DB MCP server in the store node.', 'status_code' => 400];
        }
        $serverId = (int) $m[1];
        $stmt = $this->db->prepare("SELECT url, headers FROM mcp_servers WHERE id = ? AND enabled = 1");
        $stmt->execute([$serverId]);
        $srv = $stmt->fetch(\PDO::FETCH_ASSOC);
        if (!$srv) {
            return ['success' => false, 'error' => "Vector MCP server #{$serverId} not found or disabled.", 'status_code' => 400];
        }
        if ($collection === '') {
            return ['success' => false, 'error' => 'Set a collection name in the store node.', 'status_code' => 400];
        }

        [$listFiles, $readFile] = $this->buildLoaderClosures($userId, (string) ($loaderCfg['storage_mcp_id'] ?? ''));
        @set_time_limit(180);
        try {
            $round = IngestionLoader::readRound($listFiles, $readFile, $provider, $path, $types, $isDir, $cursor, 5_000_000);
            $out = [
                'count'   => $round['count'],
                'cursor'  => $round['cursor'],
                'sources' => $round['sources'],
                'current' => null,
            ];
            $cur = $round['current'];
            $logs = [];
            if ($cur === null) {
                $logs[] = '[store] ' . ($round['count'] === 0 ? 'no files to store' : 'done');
            } elseif (isset($cur['error'])) {
                $out['current'] = ['source' => $cur['source'], 'type' => $cur['type'] ?? null, 'error' => $cur['error']];
                $logs[] = "[loader] {$cur['source']}: ERROR — {$cur['error']}";
            } else {
                $logs[] = '[loader] file ' . ($round['cursor'] + 1) . "/{$round['count']}: {$cur['source']} → {$cur['type']}, " . mb_strlen($cur['text']) . ' chars';
                $chunks = IngestionSplitter::recursiveSplit($cur['text'], $chunkSize, $overlap);
                $logs[] = "[splitter] {$cur['source']}: " . count($chunks) . " chunk(s) (size={$chunkSize}, overlap={$overlap})";
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
                    'provider'   => $vsProvider,
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
            }
            $out['logs'] = $logs;
            return ['success' => true, 'data' => $out, 'status_code' => 200];
        } catch (\Throwable $e) {
            return ['success' => false, 'error' => $e->getMessage(), 'status_code' => 400];
        }
    }

    /**
     * POST /api/v1/workflows/{id}/ingestion/run-stream  (SSE)
     *
     * The CLOSED event loop, server-side: enumerate the source ONCE (the loader
     * as a stateful iterator), then loop loader→split→store per file — the loop
     * continuation IS the store clocking the loader (one file fully to the end
     * before the next; true backpressure, no browser cursor, no re-enumeration).
     * Streams per-file progress / logs / node-glow as SSE events so the UI stays
     * live. Body: { loader, splitter?, vectorstore? }.
     */
    public function runStream(array $request): array
    {
        header('Content-Type: text/event-stream');
        header('Cache-Control: no-cache');
        header('Connection: keep-alive');
        header('X-Accel-Buffering: no');
        while (ob_get_level()) {
            ob_end_clean();
        }
        $sse = static function (array $event): void {
            echo 'data: ' . json_encode($event) . "\n\n";
            flush();
        };
        $done = static function () use ($sse): array {
            echo "data: [DONE]\n\n";
            flush();
            return ['streaming_handled' => true];
        };

        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        if (!$userId) {
            $sse(['type' => 'error', 'error' => 'Authentication required']);
            return $done();
        }
        if (!$workflowId || !$this->workflowRepository->canUserAccess($userId, $workflowId)) {
            $sse(['type' => 'error', 'error' => 'Workflow not found or access denied']);
            return $done();
        }

        $body = $request['body'] ?? [];
        $loaderCfg = (array) ($body['loader'] ?? []);
        $hasSplitter = isset($body['splitter']);
        $hasStore = isset($body['vectorstore']);
        $splitterCfg = (array) ($body['splitter'] ?? []);
        $storeCfg = (array) ($body['vectorstore'] ?? []);

        $provider = (string) ($loaderCfg['provider'] ?? 'local') ?: 'local';
        $path = trim((string) ($loaderCfg['path'] ?? ''));
        $isDir = !empty($loaderCfg['is_dir']);
        $types = array_values(array_filter((array) ($loaderCfg['types'] ?? []), 'is_string'));
        $chunkSize = max(1, (int) ($splitterCfg['chunk_size'] ?? 1000));
        $overlap = max(0, (int) ($splitterCfg['overlap'] ?? 150));
        $collection = trim((string) ($storeCfg['collection'] ?? ''));
        $vsProvider = trim((string) ($storeCfg['provider'] ?? ''));
        $connection = (array) ($storeCfg['connection'] ?? []);
        $embedding = trim((string) ($storeCfg['embedding'] ?? ''));

        if ($path === '') {
            $sse(['type' => 'error', 'error' => 'The loader has no Source set.']);
            return $done();
        }

        // Resolve the store server up front (so we fail fast before reading files).
        $srv = null;
        $serverId = 0;
        if ($hasStore) {
            if (!preg_match('/^mcp:(\d+)$/', (string) ($storeCfg['store'] ?? ''), $m)) {
                $sse(['type' => 'error', 'error' => 'The store node needs a vector-DB MCP server selected.']);
                return $done();
            }
            $serverId = (int) $m[1];
            $stmt = $this->db->prepare("SELECT url, headers FROM mcp_servers WHERE id = ? AND enabled = 1");
            $stmt->execute([$serverId]);
            $srv = $stmt->fetch(\PDO::FETCH_ASSOC);
            if (!$srv) {
                $sse(['type' => 'error', 'error' => "Vector MCP server #{$serverId} not found or disabled."]);
                return $done();
            }
            if ($collection === '') {
                $sse(['type' => 'error', 'error' => 'Set a collection name in the store node.']);
                return $done();
            }
        }

        @set_time_limit(0);
        [$listFiles, $readFile] = $this->buildLoaderClosures($userId, (string) ($loaderCfg['storage_mcp_id'] ?? ''));

        // --- ENUMERATE ONCE (the loader's stateful iterator) ---
        try {
            $descs = IngestionLoader::enumerateFiles($listFiles, $provider, $path, $types, $isDir);
        } catch (\Throwable $e) {
            $sse(['type' => 'error', 'error' => 'Loader enumeration failed: ' . $e->getMessage()]);
            return $done();
        }
        $count = count($descs);
        $sse(['type' => 'start', 'count' => $count, 'sources' => array_map(static fn($d) => $d['source'], $descs)]);

        // Open the vector-store session ONCE for the whole run (one handshake),
        // then every chunk write reuses it — fired CONCURRENTLY via curl_multi
        // (fan-out first cut: the network-bound writes overlap).
        $vs = null;
        if ($hasStore) {
            $sess = $this->openMcpSession((string) $srv['url'], $this->mcpBaseHeaders($srv['headers'] ?? null));
            if (!empty($sess['error'])) {
                $sse(['type' => 'error', 'error' => 'Vector store connection failed: ' . ($sess['message'] ?? 'session error')]);
                return $done();
            }
            $sessHeaders = $sess['headers'];
            $vs = new VectorMcpStore(function (int $sid, string $tool, array $args) use ($srv, $sessHeaders): array {
                return $this->callMcpTool((string) $srv['url'], $sessHeaders, $tool, $args);
            });
        }

        $files = 0; $chunks = 0; $stored = 0; $errors = 0;
        foreach ($descs as $i => $desc) {
            if (connection_aborted()) {
                break;
            }
            // loader
            $sse(['type' => 'node', 'node' => 'loader', 'state' => 'active']);
            try {
                $text = IngestionLoader::loadFile($readFile, $desc);
            } catch (\Throwable $e) {
                $errors++;
                $sse(['type' => 'log', 'lines' => ["[loader] {$desc['source']}: ERROR — " . $e->getMessage()]]);
                $sse(['type' => 'node', 'node' => 'loader', 'state' => 'error']);
                continue;
            }
            $sse(['type' => 'log', 'lines' => ['[loader] file ' . ($i + 1) . "/{$count}: {$desc['source']} → {$desc['doc_type']}, " . mb_strlen($text) . ' chars']]);
            $sse(['type' => 'node', 'node' => 'loader', 'state' => 'done']);

            // splitter (chunk even with no splitter node — the store needs chunks)
            $sse(['type' => 'node', 'node' => 'splitter', 'state' => 'active']);
            $ch = IngestionSplitter::recursiveSplit($text, $chunkSize, $overlap);
            $chunks += count($ch);
            if ($hasSplitter) {
                $sse(['type' => 'log', 'lines' => ["[splitter] {$desc['source']}: " . count($ch) . " chunk(s) (size={$chunkSize}, overlap={$overlap})"]]);
            }
            $sse(['type' => 'node', 'node' => 'splitter', 'state' => 'done']);

            // store
            if ($hasStore && $vs !== null) {
                $sse(['type' => 'node', 'node' => 'vectorstore', 'state' => 'active']);
                try {
                    $r = $vs->store($serverId, $ch, [
                        'provider'   => $vsProvider,
                        'connection' => $connection,
                        'collection' => $collection !== '' ? $collection : null,
                        'embedding'  => $embedding !== '' ? $embedding : null,
                        'metadata'   => ['source' => $desc['source']],
                    ]);
                    $stored += $r['stored'];
                    $errors += $r['errors'];
                    $sse(['type' => 'log', 'lines' => ["[store] {$desc['source']}: wrote {$r['stored']} chunk(s)" . ($r['errors'] ? " ({$r['errors']} failed)" : '') . ($collection !== '' ? " → \"{$collection}\"" : '') . " on mcp:{$serverId}"]]);
                    $sse(['type' => 'node', 'node' => 'vectorstore', 'state' => 'done']);
                } catch (\Throwable $e) {
                    $errors++;
                    $sse(['type' => 'log', 'lines' => ["[store] {$desc['source']}: ERROR — " . $e->getMessage()]]);
                    $sse(['type' => 'node', 'node' => 'vectorstore', 'state' => 'error']);
                    continue;
                }
            }

            $files++;
            $sse(['type' => 'progress', 'cursor' => $i + 1, 'count' => $count, 'source' => $desc['source'], 'files' => $files, 'chunks' => $chunks, 'stored' => $stored]);
        }

        // Silence = done (the loader is exhausted → the loop ends).
        $sse(['type' => 'done', 'count' => $count, 'files' => $files, 'chunks' => $chunks, 'stored' => $stored, 'errors' => $errors, 'wrote' => $hasStore]);
        return $done();
    }

    /**
     * POST /api/v1/workflows/{id}/ingestion/store-find
     *
     * Retrieval test panel: run `find` against the store node's vector-DB
     * MCP and return the matched chunks. Body: { vectorstore: { store:"mcp:<id>",
     * collection?, provider?, connection?, embedding? }, query }.
     */
    public function storeFind(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);

        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        if (!$workflowId) {
            return ['success' => false, 'error' => 'Workflow ID is required', 'status_code' => 400];
        }
        if (!$this->workflowRepository->canUserAccess($userId, $workflowId)) {
            return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
        }

        $body = $request['body'] ?? [];
        $storeCfg = (array) ($body['vectorstore'] ?? []);
        $query = trim((string) ($body['query'] ?? ''));
        $collection = trim((string) ($storeCfg['collection'] ?? ''));
        $provider = trim((string) ($storeCfg['provider'] ?? ''));
        $connection = (array) ($storeCfg['connection'] ?? []);
        $embedding = trim((string) ($storeCfg['embedding'] ?? ''));

        if ($query === '') {
            return ['success' => false, 'error' => 'Enter a search query.', 'status_code' => 400];
        }
        if (!preg_match('/^mcp:(\d+)$/', (string) ($storeCfg['store'] ?? ''), $m)) {
            return ['success' => false, 'error' => 'Pick a vector-DB MCP server in the store node.', 'status_code' => 400];
        }
        $serverId = (int) $m[1];
        $stmt = $this->db->prepare("SELECT url, headers FROM mcp_servers WHERE id = ? AND enabled = 1");
        $stmt->execute([$serverId]);
        $srv = $stmt->fetch(\PDO::FETCH_ASSOC);
        if (!$srv) {
            return ['success' => false, 'error' => "Vector MCP server #{$serverId} not found or disabled.", 'status_code' => 400];
        }
        if ($collection === '') {
            return ['success' => false, 'error' => 'Set a collection name in the store node.', 'status_code' => 400];
        }

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
    }

    /**
     * POST /api/v1/workflows/{id}/ingestion/run-start
     *
     * Parallel run, step 1: enumerate the source ONCE and create a shared run
     * record (file list + atomic cursor on disk). Returns {run_id, count}. The
     * frontend then opens K concurrent run-worker streams that pull files from
     * the shared cursor — true multi‑core (each worker is a separate prefork
     * PHP process; auth is stateless JWT so there's no session‑lock
     * serialization). Body: { loader, splitter?, vectorstore? }.
     */
    public function runStart(array $request): array
    {
        $userId = $request['user_id'] ?? 0;
        $workflowId = (int) ($request['params']['id'] ?? 0);
        if (!$userId) {
            return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        }
        if (!$workflowId || !$this->workflowRepository->canUserAccess($userId, $workflowId)) {
            return ['success' => false, 'error' => 'Workflow not found or access denied', 'status_code' => 404];
        }

        $body = $request['body'] ?? [];
        $loaderCfg = (array) ($body['loader'] ?? []);
        $hasSplitter = isset($body['splitter']);
        $hasStore = isset($body['vectorstore']);
        $splitterCfg = (array) ($body['splitter'] ?? []);
        $storeCfg = (array) ($body['vectorstore'] ?? []);

        $provider = (string) ($loaderCfg['provider'] ?? 'local') ?: 'local';
        $path = trim((string) ($loaderCfg['path'] ?? ''));
        $isDir = !empty($loaderCfg['is_dir']);
        $types = array_values(array_filter((array) ($loaderCfg['types'] ?? []), 'is_string'));

        if ($path === '') {
            return ['success' => false, 'error' => 'The loader has no Source set.', 'status_code' => 400];
        }

        $serverId = 0;
        $srv = null;
        if ($hasStore) {
            if (!preg_match('/^mcp:(\d+)$/', (string) ($storeCfg['store'] ?? ''), $m)) {
                return ['success' => false, 'error' => 'The store node needs a vector-DB MCP server selected.', 'status_code' => 400];
            }
            $serverId = (int) $m[1];
            $stmt = $this->db->prepare("SELECT url, headers FROM mcp_servers WHERE id = ? AND enabled = 1");
            $stmt->execute([$serverId]);
            $srv = $stmt->fetch(\PDO::FETCH_ASSOC);
            if (!$srv) {
                return ['success' => false, 'error' => "Vector MCP server #{$serverId} not found or disabled.", 'status_code' => 400];
            }
            if (trim((string) ($storeCfg['collection'] ?? '')) === '') {
                return ['success' => false, 'error' => 'Set a collection name in the store node.', 'status_code' => 400];
            }
        }

        @set_time_limit(120);
        [$listFiles, $readFile] = $this->buildLoaderClosures($userId, (string) ($loaderCfg['storage_mcp_id'] ?? ''));
        try {
            $descriptors = IngestionLoader::enumerateFiles($listFiles, $provider, $path, $types, $isDir);
        } catch (\Throwable $e) {
            return ['success' => false, 'error' => 'Loader enumeration failed: ' . $e->getMessage(), 'status_code' => 400];
        }
        $count = count($descriptors);
        if ($count === 0) {
            return ['success' => true, 'data' => ['run_id' => null, 'count' => 0], 'status_code' => 200];
        }

        $runId = bin2hex(random_bytes(8));
        $config = [
            'user_id'        => (int) $userId,
            'has_splitter'   => $hasSplitter,
            'has_store'      => $hasStore,
            'chunk_size'     => max(1, (int) ($splitterCfg['chunk_size'] ?? 1000)),
            'overlap'        => max(0, (int) ($splitterCfg['overlap'] ?? 150)),
            'collection'     => trim((string) ($storeCfg['collection'] ?? '')),
            'provider'       => trim((string) ($storeCfg['provider'] ?? '')),
            'connection'     => (array) ($storeCfg['connection'] ?? []),
            'embedding'      => trim((string) ($storeCfg['embedding'] ?? '')),
            'server_id'      => $serverId,
            'server_url'     => $srv['url'] ?? null,
            'server_headers' => $srv['headers'] ?? null,
        ];
        file_put_contents($this->runFilePath($runId), json_encode(['config' => $config, 'descriptors' => $descriptors]));
        file_put_contents($this->runCursorPath($runId), '0');
        $this->cleanupOldRuns();

        return ['success' => true, 'data' => ['run_id' => $runId, 'count' => $count], 'status_code' => 200];
    }

    /**
     * POST /api/v1/workflows/{id}/ingestion/run-worker  (SSE)
     *
     * Parallel run, step 2 — ONE worker. Repeatedly CLAIMS the next file from
     * the shared atomic cursor (flock) and processes it (read→decode→split→
     * store), streaming logs/progress. K of these run concurrently = work-
     * stealing across real processes. Body: { run_id }.
     */
    public function runWorker(array $request): array
    {
        header('Content-Type: text/event-stream');
        header('Cache-Control: no-cache');
        header('X-Accel-Buffering: no');
        while (ob_get_level()) {
            ob_end_clean();
        }
        $sse = static function (array $event): void {
            echo 'data: ' . json_encode($event) . "\n\n";
            flush();
        };
        $done = static function () use ($sse): array {
            echo "data: [DONE]\n\n";
            flush();
            return ['streaming_handled' => true];
        };

        $userId = $request['user_id'] ?? 0;
        if (!$userId) {
            $sse(['type' => 'error', 'error' => 'Authentication required']);
            return $done();
        }
        $runId = (string) (($request['body'] ?? [])['run_id'] ?? '');
        if (!preg_match('/^[a-f0-9]{16}$/', $runId)) {
            $sse(['type' => 'error', 'error' => 'Invalid run id']);
            return $done();
        }
        $runPath = $this->runFilePath($runId);
        if (!is_file($runPath)) {
            $sse(['type' => 'error', 'error' => 'Run not found (it may have expired).']);
            return $done();
        }
        $run = json_decode((string) file_get_contents($runPath), true);
        $config = $run['config'] ?? [];
        $descriptors = $run['descriptors'] ?? [];
        if ((int) ($config['user_id'] ?? -1) !== (int) $userId) {
            $sse(['type' => 'error', 'error' => 'Access denied']);
            return $done();
        }
        $count = count($descriptors);
        $cursorPath = $this->runCursorPath($runId);

        [$listFiles, $readFile] = $this->buildLoaderClosures($userId, (string) (($config['loader']['storage_mcp_id']) ?? ''));

        $vs = null;
        $serverId = (int) ($config['server_id'] ?? 0);
        if (!empty($config['has_store'])) {
            $url = (string) ($config['server_url'] ?? '');
            $hdrs = $config['server_headers'] ?? null;
            $sess = $this->openMcpSession($url, $this->mcpBaseHeaders($hdrs));
            if (!empty($sess['error'])) {
                $sse(['type' => 'error', 'error' => 'Vector store connection failed: ' . ($sess['message'] ?? 'session error')]);
                return $done();
            }
            $sessHeaders = $sess['headers'];
            $vs = new VectorMcpStore(function (int $sid, string $tool, array $args) use ($url, $sessHeaders): array {
                return $this->callMcpTool($url, $sessHeaders, $tool, $args);
            });
        }

        @set_time_limit(0);
        $chunkSize = (int) $config['chunk_size'];
        $overlap = (int) $config['overlap'];
        $collection = (string) ($config['collection'] ?? '');
        $provider = (string) ($config['provider'] ?? '');
        $connection = (array) ($config['connection'] ?? []);
        $embedding = (string) ($config['embedding'] ?? '');
        $hasSplitter = !empty($config['has_splitter']);

        $files = 0; $chunks = 0; $stored = 0; $errors = 0;
        while (true) {
            if (connection_aborted()) {
                break;
            }
            $i = $this->claimNextFile($cursorPath, $count);
            if ($i === null) {
                break; // exhausted — every file claimed
            }
            $desc = $descriptors[$i];
            $src = (string) ($desc['source'] ?? '?');
            try {
                $text = IngestionLoader::loadFile($readFile, $desc);
            } catch (\Throwable $e) {
                $errors++;
                $sse(['type' => 'log', 'lines' => ["[loader] {$src}: ERROR — " . $e->getMessage()]]);
                continue;
            }
            $sse(['type' => 'log', 'lines' => ['[loader] ' . ($i + 1) . "/{$count}: {$src} → " . ($desc['doc_type'] ?? '?') . ', ' . mb_strlen($text) . ' chars']]);
            $ch = IngestionSplitter::recursiveSplit($text, $chunkSize, $overlap);
            $chunks += count($ch);
            if ($hasSplitter) {
                $sse(['type' => 'log', 'lines' => ["[splitter] {$src}: " . count($ch) . " chunk(s) (size={$chunkSize}, overlap={$overlap})"]]);
            }
            if ($vs !== null) {
                try {
                    $r = $vs->store($serverId, $ch, [
                        'provider'   => $provider,
                        'connection' => $connection,
                        'collection' => $collection !== '' ? $collection : null,
                        'embedding'  => $embedding !== '' ? $embedding : null,
                        'metadata'   => ['source' => $src],
                    ]);
                    $stored += $r['stored'];
                    $errors += $r['errors'];
                    $sse(['type' => 'log', 'lines' => ["[store] {$src}: wrote {$r['stored']} chunk(s)" . ($r['errors'] ? " ({$r['errors']} failed)" : '') . " on mcp:{$serverId}"]]);
                } catch (\Throwable $e) {
                    $errors++;
                    $sse(['type' => 'log', 'lines' => ["[store] {$src}: ERROR — " . $e->getMessage()]]);
                    continue;
                }
            }
            $files++;
            $sse(['type' => 'progress', 'index' => $i, 'count' => $count, 'files' => $files, 'chunks' => $chunks, 'stored' => $stored]);
        }

        $sse(['type' => 'done', 'files' => $files, 'chunks' => $chunks, 'stored' => $stored, 'errors' => $errors, 'wrote' => !empty($config['has_store'])]);
        return $done();
    }

    /** Shared run-state dir (file-based; no DB schema needed). */
    private function ingestionRunDir(): string
    {
        $dir = sys_get_temp_dir() . '/gpt_ingestion_runs';
        if (!is_dir($dir)) {
            @mkdir($dir, 0700, true);
        }
        return $dir;
    }

    private function runFilePath(string $runId): string
    {
        return $this->ingestionRunDir() . '/' . $runId . '.json';
    }

    private function runCursorPath(string $runId): string
    {
        return $this->ingestionRunDir() . '/' . $runId . '.cur';
    }

    /**
     * Atomically claim the next file index from the shared cursor (flock so two
     * worker processes never grab the same file). Returns the claimed index, or
     * null when the run is exhausted (cursor reached count).
     */
    private function claimNextFile(string $cursorPath, int $count): ?int
    {
        $fp = @fopen($cursorPath, 'c+');
        if (!$fp) {
            return null;
        }
        $claimed = null;
        if (flock($fp, LOCK_EX)) {
            rewind($fp);
            $cur = (int) trim((string) stream_get_contents($fp));
            if ($cur < $count) {
                $claimed = $cur;
                rewind($fp);
                ftruncate($fp, 0);
                fwrite($fp, (string) ($cur + 1));
                fflush($fp);
            }
            flock($fp, LOCK_UN);
        }
        fclose($fp);
        return $claimed;
    }

    /** Delete run files older than 2h (best-effort housekeeping). */
    private function cleanupOldRuns(): void
    {
        $cutoff = time() - 7200;
        foreach (glob($this->ingestionRunDir() . '/*') ?: [] as $f) {
            if (@filemtime($f) < $cutoff) {
                @unlink($f);
            }
        }
    }

    /**
     * Call ONE specific MCP server (by url + stored headers) for a tool. Does
     * the Streamable-HTTP SESSION handshake — initialize (capture the
     * Mcp-Session-Id response header) → notifications/initialized → tools/call
     * carrying that session — because vector-DB MCP servers (the Qdrant double
     * and the PHP server) are session-based. Returns the JSON-RPC result on
     * success, or ['error'=>true,'message'=>...] (including tool-level isError).
     *
     * @return array<string,mixed>
     */
    private function callMcpServer(string $url, ?string $headersJson, string $tool, array $args): array
    {
        $sess = $this->openMcpSession($url, $this->mcpBaseHeaders($headersJson));
        if (!empty($sess['error'])) {
            return $sess;
        }
        return $this->callMcpTool($url, $sess['headers'], $tool, $args);
    }

    /** Build the base headers (content/accept + the server's stored auth headers). */
    private function mcpBaseHeaders(?string $headersJson): array
    {
        $base = ['Content-Type: application/json', 'Accept: application/json, text/event-stream'];
        if ($headersJson) {
            $h = json_decode($headersJson, true);
            if (is_array($h)) {
                foreach ($h as $k => $v) {
                    if (is_string($k) && $k !== '' && is_scalar($v)) {
                        $base[] = preg_replace('/[\r\n:]/', '', $k) . ': ' . preg_replace('/[\r\n]/', '', (string) $v);
                    }
                }
            }
        }
        return $base;
    }

    /**
     * Open a Streamable-HTTP session ONCE: initialize (capture the
     * Mcp-Session-Id response header) → notifications/initialized. Returns
     * ['headers'=>$callHeaders] to reuse for every subsequent tools/call, so a
     * batch (e.g. N chunk writes) pays the handshake once, not per call.
     *
     * @param list<string> $base
     * @return array{headers?:list<string>,error?:bool,message?:string}
     */
    private function openMcpSession(string $url, array $base): array
    {
        $session = null;
        $init = $this->mcpPost($url, $base, [
            'jsonrpc' => '2.0', 'id' => 1, 'method' => 'initialize',
            'params'  => ['protocolVersion' => '2024-11-05', 'capabilities' => new \stdClass(), 'clientInfo' => ['name' => 'gpt-ingestion', 'version' => '1']],
        ], $session);
        if (!empty($init['error'])) {
            return $init;
        }
        $callHeaders = $base;
        if ($session) {
            $callHeaders[] = 'Mcp-Session-Id: ' . $session;
            $ignore = null;
            $this->mcpPost($url, $callHeaders, ['jsonrpc' => '2.0', 'method' => 'notifications/initialized', 'params' => new \stdClass()], $ignore);
        }
        return ['headers' => $callHeaders];
    }

    /**
     * One tools/call on an already-opened session ($callHeaders carry the
     * Mcp-Session-Id). Returns the JSON-RPC result, or ['error'=>true,...]
     * (including tool-level result.isError).
     *
     * @param list<string> $callHeaders
     * @return array<string,mixed>
     */
    private function callMcpTool(string $url, array $callHeaders, string $tool, array $args): array
    {
        $ignore = null;
        $res = $this->mcpPost($url, $callHeaders, [
            'jsonrpc' => '2.0', 'id' => 2, 'method' => 'tools/call',
            'params'  => ['name' => $tool, 'arguments' => $args === [] ? new \stdClass() : $args],
        ], $ignore);
        return $this->interpretToolResult($res);
    }

    /**
     * One JSON-RPC POST to an MCP server. Captures the Mcp-Session-Id response
     * header into $session, parses a JSON or SSE body, and normalizes a JSON-RPC
     * error to ['error'=>true,'message'=>...]. A bodyless notification ack (202)
     * returns ['ok'=>true].
     *
     * @param list<string> $headers
     * @return array<string,mixed>
     */
    private function mcpPost(string $url, array $headers, array $payload, ?string &$session): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode($payload),
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 60,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$session) {
                if (stripos($line, 'mcp-session-id:') === 0) {
                    $session = trim(substr($line, strlen('mcp-session-id:')));
                }
                return strlen($line);
            },
        ]);
        $resp = curl_exec($ch);
        $err = curl_error($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($err !== '') {
            return ['error' => true, 'message' => "MCP connection failed: {$err}"];
        }
        if ($code >= 400) {
            return ['error' => true, 'message' => "MCP server returned HTTP {$code}"];
        }
        $parsed = json_decode((string) $resp, true);
        if ($parsed === null) {
            foreach (explode("\n", (string) $resp) as $line) {
                $line = trim($line);
                if (str_starts_with($line, 'data:')) {
                    $d = trim(substr($line, 5));
                    if ($d !== '' && ($p = json_decode($d, true)) !== null) {
                        $parsed = $p;
                        break;
                    }
                }
            }
        }
        return $this->normalizeMcpBody($resp);
    }

    /** Decode a JSON or SSE MCP body into a JSON-RPC array, normalizing errors. */
    private function normalizeMcpBody(?string $resp): array
    {
        $parsed = json_decode((string) $resp, true);
        if ($parsed === null) {
            foreach (explode("\n", (string) $resp) as $line) {
                $line = trim($line);
                if (str_starts_with($line, 'data:')) {
                    $d = trim(substr($line, 5));
                    if ($d !== '' && ($p = json_decode($d, true)) !== null) {
                        $parsed = $p;
                        break;
                    }
                }
            }
        }
        if (!is_array($parsed)) {
            return ['ok' => true]; // e.g. 202 Accepted for a notification
        }
        if (isset($parsed['error'])) {
            return ['error' => true, 'message' => (string) ($parsed['error']['message'] ?? 'MCP error')];
        }
        return $parsed;
    }

    /** From a parsed JSON-RPC response, return the tool result or an error (handles result.isError). */
    private function interpretToolResult(array $res): array
    {
        if (!empty($res['error'])) {
            return $res;
        }
        $result = $res['result'] ?? $res;
        if (is_array($result) && !empty($result['isError'])) {
            $msg = '';
            foreach (($result['content'] ?? []) as $c) {
                if (isset($c['text'])) {
                    $msg .= $c['text'];
                }
            }
            return ['error' => true, 'message' => $msg !== '' ? $msg : 'MCP tool error'];
        }
        return is_array($result) ? $result : ['ok' => true];
    }

    /**
     * Build the two injected MCP callables the loader needs (list_files /
     * read_file against the registered UniversalFS storage). The MCP dispatch
     * stays the single source of truth for how tools run.
     *
     * @return array{0:callable,1:callable}
     */
    private function buildLoaderClosures($userId, ?string $storageMcpId = null): array
    {
        $mcp = new MCPToolsLoader($this->db);
        // Scope dispatch to the chosen storage server so list_files/read_file
        // resolve to langfs (not a different server that also exposes them).
        $allowed = null;
        if ($storageMcpId !== null && $storageMcpId !== '') {
            $stmt = $this->db->prepare("SELECT name FROM mcp_servers WHERE id = ?");
            $stmt->execute([$storageMcpId]);
            $name = $stmt->fetchColumn();
            if ($name !== false) {
                $allowed = [(string) $name];
            }
        }
        $mcp->loadToolsForUser((string) $userId, $allowed);

        $listFiles = static function (string $provider, string $folder) use ($mcp): array {
            $args = ['provider' => $provider];
            if ($folder !== '') {
                $args['path'] = $folder;
            }
            $res = $mcp->executeTool('list_files', $args);
            if (!empty($res['error'])) {
                throw new \RuntimeException((string) ($res['message'] ?? 'list_files failed'));
            }
            $decoded = json_decode((string) ($res['result'] ?? ''), true);
            return is_array($decoded) ? $decoded : ['files' => []];
        };

        // Read one file, tolerant of BOTH backends and surfacing real errors:
        //  - langfs: {"content":"<text>","format":"text"} (already extracted)
        //    → ['is_text' => true].
        //  - langfs error: {"error":true,"message":...} → throw that message
        //    (e.g. "path outside allowed roots"), not a generic one.
        //  - UniversalFS (legacy): base64 of raw bytes → ['is_text' => false]
        //    so the caller decodes (PDF/DOCX/…).
        // Sending both `format` and `encoding` lets each server use the param it
        // understands.
        $readFile = static function (string $provider, string $fileId) use ($mcp): array {
            $res = $mcp->executeTool('read_file', [
                'provider' => $provider,
                'file_id'  => $fileId,
                'format'   => 'text',     // langfs: extracted text
                'encoding' => 'base64',   // UniversalFS: base64 raw bytes
            ]);
            if (!empty($res['error'])) {
                throw new \RuntimeException((string) ($res['message'] ?? 'read_file failed'));
            }
            $raw = (string) ($res['result'] ?? '');
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) {
                if (!empty($decoded['error'])) {
                    throw new \RuntimeException((string) ($decoded['message'] ?? 'read_file error'));
                }
                if (array_key_exists('content', $decoded)) {
                    return ['is_text' => true, 'data' => (string) $decoded['content']];
                }
            }
            $bytes = base64_decode($raw, true);
            if ($bytes === false) {
                throw new \RuntimeException('read_file returned neither {content,format} nor valid base64');
            }
            return ['is_text' => false, 'data' => $bytes];
        };

        return [$listFiles, $readFile];
    }
}
