<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Standalone, config-driven RAG ingestion compiler.
 *
 * Unlike LangGraphGenerator::generateIngestionScript (which re-reads the SAVED
 * graph and is buggy), this compiler is fed each node's OWN config directly by
 * the frontend. It is fully self-contained: dispatch tables for
 * loaders/splitters/embeddings/stores, plus two entry points:
 *
 *   - compileNodeChunk(kind, config): the Python chunk for ONE node (the
 *     incremental per-node "Output" tab in the editor).
 *   - compileScript(loader, splitter, store): the full runnable standalone
 *     script (download / run-anywhere).
 *
 * EXTENSION POINTS (add a new loader source / splitter strategy / store /
 * embeddings provider): add ONE entry to the matching dispatch table below
 * (import + Python fragment) and the matching editor dropdown. Everything else
 * is choice-agnostic. Future: web/sql/mcp loaders, markdown/auto/rows
 * splitters, faiss/chroma stores, ollama/hf embeddings.
 */
final class IngestionCompiler
{
    /**
     * Loader dispatch: source → { import, load } where `load` sets `docs`.
     *
     * @return array<string,array{import:string,load:string}>
     */
    private static function loaderDispatch(): array
    {
        return [
            'pdf' => [
                'import' => 'from langchain_community.document_loaders import PyPDFLoader',
                'load'   => 'docs = PyPDFLoader(LOADER["path"]).load()',
            ],
            'word' => [
                'import' => 'from langchain_community.document_loaders import Docx2txtLoader',
                'load'   => 'docs = Docx2txtLoader(LOADER["path"]).load()',
            ],
            'text' => [
                'import' => 'from langchain_community.document_loaders import TextLoader',
                'load'   => 'docs = TextLoader(LOADER["path"], encoding="utf-8").load()',
            ],
            'csv' => [
                'import' => 'from langchain_community.document_loaders import CSVLoader',
                'load'   => 'docs = CSVLoader(LOADER["path"]).load()',
            ],
        ];
    }

    /**
     * Resolve the loader fragment for a source, choosing a single-file loader or
     * a whole-folder DirectoryLoader when $isDir is true. For a folder we reuse
     * the per-type loader class (PyPDFLoader, …) with a matching glob so every
     * file of that type in the folder is loaded.
     *
     * @return array{import:string,load:string}
     * @throws \RuntimeException on unknown source
     */
    private static function loaderFragment(string $source, bool $isDir): array
    {
        $table = self::loaderDispatch();
        if (!isset($table[$source])) {
            throw new \RuntimeException(
                "IngestionCompiler: no fragment for loader source '{$source}' yet — add it to the loader dispatch table."
            );
        }
        if (!$isDir) {
            return $table[$source];
        }
        // Folder load: DirectoryLoader + the single-file loader class as loader_cls.
        $dir = [
            'pdf'  => ['cls' => 'PyPDFLoader',    'glob' => '**/*.pdf'],
            'word' => ['cls' => 'Docx2txtLoader', 'glob' => '**/*.docx'],
            'text' => ['cls' => 'TextLoader',     'glob' => '**/*.txt'],
            'csv'  => ['cls' => 'CSVLoader',      'glob' => '**/*.csv'],
        ][$source];
        return [
            'import' => "from langchain_community.document_loaders import DirectoryLoader\n" . $table[$source]['import'],
            'load'   => "docs = DirectoryLoader(LOADER[\"path\"], glob=\"{$dir['glob']}\", loader_cls={$dir['cls']}).load()",
        ];
    }

    /**
     * Splitter dispatch: strategy → { import, body } where `body` sets `chunks`.
     *
     * @return array<string,array{import:string,body:string}>
     */
    private static function splitterDispatch(): array
    {
        return [
            'recursive' => [
                'import' => 'from langchain_text_splitters import RecursiveCharacterTextSplitter',
                'body'   => "splitter = RecursiveCharacterTextSplitter(\n"
                    . "    chunk_size=int(SPLITTER.get(\"chunk_size\", 1000)),\n"
                    . "    chunk_overlap=int(SPLITTER.get(\"overlap\", 150)),\n"
                    . ")\n"
                    . "chunks = splitter.split_documents(docs)",
            ],
        ];
    }

    /**
     * Embeddings dispatch: provider → { import, body } where `body` sets
     * `embeddings`.
     *
     * @return array<string,array{import:string,body:string}>
     */
    private static function embeddingsDispatch(): array
    {
        return [
            'openai' => [
                'import' => 'from langchain_openai import OpenAIEmbeddings',
                'body'   => "emb_model = (STORE.get(\"embeddings\") or \"openai:text-embedding-3-small\").partition(\":\")[2]\n"
                    . "embeddings = OpenAIEmbeddings(model=emb_model or \"text-embedding-3-small\")",
            ],
        ];
    }

    /**
     * Store dispatch: store → { import, body } where `body` writes chunks and
     * sets `result`.
     *
     * @return array<string,array{import:string,body:string}>
     */
    private static function storeDispatch(): array
    {
        return [
            'pgvector' => [
                'import' => 'from langchain_postgres import PGVector',
                'body'   => "dsn = os.environ.get(\"VECTOR_DB_DSN\")\n"
                    . "if not dsn:\n"
                    . "    raise RuntimeError(\"VECTOR_DB_DSN is not set\")\n"
                    . "collection = STORE.get(\"collection\") or \"default\"\n"
                    . "PGVector.from_documents(\n"
                    . "    documents=chunks,\n"
                    . "    embedding=embeddings,\n"
                    . "    collection_name=collection,\n"
                    . "    connection=dsn,\n"
                    . "    use_jsonb=True,\n"
                    . ")\n"
                    . "result = {\"store\": \"pgvector\", \"collection\": collection, \"chunks\": len(chunks)}",
            ],
        ];
    }

    private static function jsonLit(array $data): string
    {
        return (string) json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    /**
     * Compile the Python chunk for a SINGLE node, from that node's own config.
     *
     * @param string $kind   one of: start, loader, splitter, vectorstore
     * @param array<string,mixed> $config the node's own config (the 'start'
     *        header takes no config, so it defaults to [])
     *
     * @throws \RuntimeException on unknown kind / source / strategy / store
     */
    public static function compileNodeChunk(string $kind, array $config = []): string
    {
        // A disabled node is a passthrough — it forwards its input unchanged so
        // the rest of the pipeline still runs. Lets you isolate a faulty stage.
        if ($kind !== 'start' && !empty($config['disabled'])) {
            $label = ucfirst($kind);
            return "# {$label} — DISABLED (skipped for debugging)\n"
                . "# This stage is a passthrough; its input is forwarded unchanged.";
        }

        switch ($kind) {
            case 'start':
                return "import json, os\n# (common header — shared by the stages below)";

            case 'loader':
                $source = (string) ($config['source'] ?? 'pdf');
                $isDir = !empty($config['is_dir']);
                $L = self::loaderFragment($source, $isDir);
                $json = self::jsonLit([
                    'source' => $source,
                    'path'   => $config['path'] ?? null,
                    'is_dir' => $isDir,
                ]);
                return "# Loader — document type: {$source}" . ($isDir ? ' (whole folder)' : '') . "\n"
                    . "{$L['import']}\n\n"
                    . "LOADER = {$json}\n"
                    . "{$L['load']}\n"
                    . "# docs : list[Document]  -> handed to the Splitter";

            case 'splitter':
                $strategy = (string) ($config['strategy'] ?? 'recursive');
                $table = self::splitterDispatch();
                if (!isset($table[$strategy])) {
                    throw new \RuntimeException(
                        "IngestionCompiler: no fragment for splitter strategy '{$strategy}' yet — add it to the splitter dispatch table."
                    );
                }
                $S = $table[$strategy];
                $json = self::jsonLit([
                    'strategy'   => $strategy,
                    'chunk_size' => $config['chunk_size'] ?? 1000,
                    'overlap'    => $config['overlap'] ?? 150,
                ]);
                return "# Splitter — strategy: {$strategy}\n"
                    . "{$S['import']}\n\n"
                    . "SPLITTER = {$json}\n"
                    . "{$S['body']}\n"
                    . "# chunks : list[Document]  -> handed to the Vector store";

            case 'vectorstore':
                $store = (string) ($config['store'] ?? 'pgvector');
                $storeTable = self::storeDispatch();
                if (!isset($storeTable[$store])) {
                    throw new \RuntimeException(
                        "IngestionCompiler: no fragment for vector store '{$store}' yet — add it to the store dispatch table."
                    );
                }
                $embeddings = (string) ($config['embeddings'] ?? 'openai:text-embedding-3-small');
                $json = self::jsonLit([
                    'store'      => $store,
                    'embeddings' => $embeddings,
                    'collection' => $config['collection'] ?? null,
                ]);
                return "# Vector store — {$store} (embeddings {$embeddings})\n"
                    . "from langchain_openai import OpenAIEmbeddings\n"
                    . "from langchain_postgres import PGVector\n\n"
                    . "STORE = {$json}\n"
                    . "emb_model = (STORE.get(\"embeddings\") or \"openai:text-embedding-3-small\").partition(\":\")[2]\n"
                    . "embeddings = OpenAIEmbeddings(model=emb_model or \"text-embedding-3-small\")\n"
                    . "dsn = os.environ.get(\"VECTOR_DB_DSN\")\n"
                    . "if not dsn:\n"
                    . "    raise RuntimeError(\"VECTOR_DB_DSN is not set\")\n"
                    . "collection = STORE.get(\"collection\") or \"default\"\n"
                    . "PGVector.from_documents(documents=chunks, embedding=embeddings, collection_name=collection, connection=dsn, use_jsonb=True)\n"
                    . "result = {\"store\": \"pgvector\", \"collection\": collection, \"chunks\": len(chunks)}";

            default:
                throw new \RuntimeException(
                    "IngestionCompiler: unknown node kind '{$kind}' (expected start, loader, splitter, vectorstore)."
                );
        }
    }

    /**
     * Compile the three-panel "node view" for the editor's per-node tabs:
     * Input (code received from the previous stage), Generated (ONLY this
     * node's own chunk) and Output (Input + Generated = code up to and
     * including this stage; a later node's Input is the prior node's Output).
     *
     * @param string $kind   one of: start, loader, splitter, vectorstore
     * @param array<string,mixed> $config the node's own config
     *
     * @return array{input:string,generated:string,output:string}
     *
     * @throws \RuntimeException on unknown kind / source / strategy / store
     */
    public static function compileNodeView(string $kind, array $config): array
    {
        $generated = self::compileNodeChunk($kind, $config);

        if ($kind === 'loader') {
            // The loader receives the start node's contribution — the common
            // header (import json, os …).
            $input = self::compileNodeChunk('start');
            $output = $input . "\n\n" . $generated;
        } else {
            // TODO: cumulative input from upstream stages
            $input = '';
            $output = $generated;
        }

        return [
            'input'     => $input,
            'generated' => $generated,
            'output'    => $output,
        ];
    }

    /**
     * Compile the Input / Generated / Output view for a node given the ORDERED
     * pipeline stages from start through that node. Input = the cumulative code
     * of all UPSTREAM stages; Generated = the target (last) stage's own chunk;
     * Output = Input + Generated. So a stage's Output is the next stage's Input.
     *
     * @param array<int,array{node_type?:string,type?:string,config?:array}> $stages
     * @return array{input:string,generated:string,output:string}
     */
    public static function compileView(array $stages): array
    {
        if (empty($stages)) {
            return ['input' => '', 'generated' => '', 'output' => ''];
        }
        $chunks = [];
        foreach ($stages as $s) {
            $kind = (string) ($s['node_type'] ?? $s['type'] ?? '');
            $cfg = (array) ($s['config'] ?? []);
            $chunks[] = self::compileNodeChunk($kind, $cfg);
        }
        $generated = (string) array_pop($chunks);   // the target (last) stage
        $input = implode("\n\n", $chunks);           // all upstream stages
        $output = $input === '' ? $generated : $input . "\n\n" . $generated;
        return ['input' => $input, 'generated' => $generated, 'output' => $output];
    }

    /**
     * Compile the full, self-contained, runnable ingestion script from the
     * three node configs.
     *
     * @param array<string,mixed> $loaderCfg   {source,path}
     * @param array<string,mixed> $splitterCfg {strategy,chunk_size,overlap}
     * @param array<string,mixed> $storeCfg    {store,embeddings,collection}
     *
     * @return array{filename:string,code:string}
     *
     * @throws \RuntimeException on unknown source / strategy / store / provider
     */
    public static function compileScript(array $loaderCfg, array $splitterCfg, array $storeCfg, array $ctx = []): array
    {
        $js = static fn($v): string => (string) json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        $langfsUrl  = (string) ($ctx['langfs_url'] ?? $loaderCfg['storage_mcp_url'] ?? '');
        $mcpqUrl    = (string) ($ctx['mcpqrant_url'] ?? '');
        $provider   = ((string) ($loaderCfg['provider'] ?? 'local')) ?: 'local';
        $path       = (string) ($loaderCfg['path'] ?? '');
        $isDir      = !empty($loaderCfg['is_dir']) ? 'True' : 'False';
        $types      = array_values(array_filter((array) ($loaderCfg['types'] ?? []), 'is_string'));
        $chunk      = max(1, (int) ($splitterCfg['chunk_size'] ?? 1000));
        $overlap    = max(0, (int) ($splitterCfg['overlap'] ?? 150));
        $vsProvider = ((string) ($storeCfg['provider'] ?? 'qdrant')) ?: 'qdrant';
        $connection = (array) ($storeCfg['connection'] ?? []);
        $collection = trim((string) ($storeCfg['collection'] ?? ''));
        $embedding  = trim((string) ($storeCfg['embedding'] ?? ''));
        $workersInt = (int) ($loaderCfg['workers'] ?? 0);

        $pyLangfs  = $js($langfsUrl);
        $pyMcpq    = $js($mcpqUrl);
        $pyProv    = $js($provider);
        $pyPath    = $js($path);
        $pyTypes   = $types === [] ? '[]' : $js($types);
        $pyVsProv  = $js($vsProvider);
        $pyConn    = $connection === [] ? '{}' : $js($connection);
        $pyColl    = $js($collection);
        $pyEmb     = $js($embedding);
        $pyWorkers = $workersInt > 0 ? (string) $workersInt : 'None';

        $code = <<<PY
#!/usr/bin/env python3
"""Standalone RAG ingestion — generated from the workflow nodes.
Orchestrates langfs (extract) + mcp_qrant (embed/store); the only in-process
LangChain is the recursive splitter. Independent of the PHP interpreter.
Deps: langchain-text-splitters (+ Python stdlib)."""
import json, urllib.request
from concurrent.futures import ThreadPoolExecutor
from langchain_text_splitters import RecursiveCharacterTextSplitter

LANGFS = {$pyLangfs}
MCPQRANT = {$pyMcpq}
PROVIDER = {$pyProv}
PATH = {$pyPath}
IS_DIR = {$isDir}
TYPES = {$pyTypes}
CHUNK = {$chunk}
OVERLAP = {$overlap}
VS_PROVIDER = {$pyVsProv}
CONNECTION = {$pyConn}
COLLECTION = {$pyColl}
EMBEDDING = {$pyEmb}
WORKERS = {$pyWorkers}

EXT_TYPE = {"pdf": "pdf", "docx": "word", "doc": "word", "txt": "text", "csv": "csv", "html": "html", "htm": "html"}

_split = RecursiveCharacterTextSplitter(chunk_size=CHUNK, chunk_overlap=OVERLAP)


def _parse(raw):
    try:
        return json.loads(raw)
    except Exception:
        for line in raw.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                d = line[5:].strip()
                if d:
                    try:
                        return json.loads(d)
                    except Exception:
                        pass
    return {}


def _payload(url, tool, args):
    """Call an MCP tool and return the decoded payload from the
    {content:[{text:json}]} envelope. Raises on JSON-RPC error."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": tool, "arguments": args}}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        obj = _parse(resp.read().decode("utf-8", "replace"))
    if isinstance(obj, dict) and obj.get("error"):
        raise RuntimeError(f"{tool}: {(obj['error'] or {}).get('message', 'MCP error')}")
    result = obj.get("result") if isinstance(obj, dict) else None
    result = result if result is not None else obj
    text = None
    if isinstance(result, dict):
        content = result.get("content")
        if isinstance(content, list) and content and isinstance(content[0], dict):
            text = content[0].get("text")
    if isinstance(text, str):
        try:
            return json.loads(text)
        except Exception:
            return {"content": text}
    return result if isinstance(result, dict) else {}


def detect(name):
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return EXT_TYPE.get(ext)


def list_files():
    """Recursive walk via langfs list_files (one level per call)."""
    out, seen = [], set()

    def walk(folder, depth):
        if depth > 64 or folder in seen:
            return
        seen.add(folder)
        args = {"provider": PROVIDER}
        if folder:
            args["path"] = folder
        data = _payload(LANGFS, "list_files", args)
        for it in (data.get("files") or []):
            if not isinstance(it, dict):
                continue
            fid = it.get("id") or it.get("source")
            nm = it.get("name") or (fid or "")
            if it.get("type") == "folder":
                if fid:
                    walk(fid, depth + 1)
            else:
                t = detect(nm)
                if t and (not TYPES or t in TYPES) and fid:
                    out.append(fid)

    if IS_DIR:
        walk(PATH, 0)
    else:
        nm = PATH.rsplit("/", 1)[-1]
        t = detect(nm)
        if t and (not TYPES or t in TYPES):
            out.append(PATH)
    return out


def read_text(src):
    """langfs read_file with format=text — langfs returns extracted text."""
    data = _payload(LANGFS, "read_file", {"provider": PROVIDER, "file_id": src, "format": "text"})
    return str((data.get("content") if isinstance(data, dict) else "") or "")


def store(items):
    args = {"provider": VS_PROVIDER, "connection": CONNECTION, "collection": COLLECTION, "items": items}
    if EMBEDDING:
        args["embedding"] = EMBEDDING
    data = _payload(MCPQRANT, "store", args)
    if not isinstance(data, dict) or "stored" not in data:
        raise RuntimeError("store: response had no {stored} field (transport/endpoint problem)")
    if data.get("error"):
        raise RuntimeError(f"store: {data.get('message', 'store failed')}")
    return int(data.get("stored", 0))


def process_file(src):
    try:
        chunks = [c for c in _split.split_text(read_text(src)) if c.strip()]
        if not chunks:
            return src, 0, None
        n = store([{"text": c, "metadata": {"source": src}} for c in chunks])
        return src, n, None
    except Exception as e:
        return src, 0, str(e)


if __name__ == "__main__":
    files = list_files()
    workers = WORKERS or 8
    print(f"{len(files)} file(s) to ingest with {workers} worker(s)")
    total = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for src, n, err in ex.map(process_file, files):
            total += n
            print(f"  {src}: {n} chunk(s)" + (f"  ERROR: {err}" if err else ""))
    print(f"done -- {total} chunk(s) stored")
PY;

        $slug = self::slugify($collection);
        $filename = 'ingestion_' . ($slug !== '' ? $slug : 'pipeline') . '.py';

        return ['filename' => $filename, 'code' => $code];
    }

    private static function slugify(string $name): string
    {
        $slug = strtolower(trim($name));
        $slug = preg_replace('/[^a-z0-9]+/', '_', $slug) ?? '';
        return trim($slug, '_');
    }
}
