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
     * @param array<string,mixed> $config the node's own config
     *
     * @throws \RuntimeException on unknown kind / source / strategy / store
     */
    public static function compileNodeChunk(string $kind, array $config): string
    {
        switch ($kind) {
            case 'start':
                return "import json, os\n# (common header — shared by the stages below)";

            case 'loader':
                $source = (string) ($config['source'] ?? 'pdf');
                $table = self::loaderDispatch();
                if (!isset($table[$source])) {
                    throw new \RuntimeException(
                        "IngestionCompiler: no fragment for loader source '{$source}' yet — add it to the loader dispatch table."
                    );
                }
                $L = $table[$source];
                $json = self::jsonLit([
                    'source' => $source,
                    'path'   => $config['path'] ?? null,
                ]);
                return "# Loader — document type: {$source}\n"
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
    public static function compileScript(array $loaderCfg, array $splitterCfg, array $storeCfg): array
    {
        $loaderJson = [
            'source' => (string) ($loaderCfg['source'] ?? 'pdf'),
            'path'   => $loaderCfg['path'] ?? null,
        ];
        $splitterJson = [
            'strategy'   => (string) ($splitterCfg['strategy'] ?? 'recursive'),
            'chunk_size' => $splitterCfg['chunk_size'] ?? 1000,
            'overlap'    => $splitterCfg['overlap'] ?? 150,
        ];
        $storeJson = [
            'store'      => (string) ($storeCfg['store'] ?? 'pgvector'),
            'embeddings' => (string) ($storeCfg['embeddings'] ?? 'openai:text-embedding-3-small'),
            'collection' => $storeCfg['collection'] ?? 'default',
        ];

        $source = $loaderJson['source'];
        $strategy = $splitterJson['strategy'];
        $store = $storeJson['store'];
        $embProvider = strtok($storeJson['embeddings'], ':') ?: 'openai';

        $loaderTable = self::loaderDispatch();
        $splitterTable = self::splitterDispatch();
        $embeddingsTable = self::embeddingsDispatch();
        $storeTable = self::storeDispatch();

        foreach ([
            ['loader source', $source, $loaderTable],
            ['splitter strategy', $strategy, $splitterTable],
            ['embeddings provider', $embProvider, $embeddingsTable],
            ['vector store', $store, $storeTable],
        ] as [$label, $choice, $table]) {
            if (!isset($table[$choice])) {
                throw new \RuntimeException(
                    "IngestionCompiler: no fragment for {$label} '{$choice}' yet — add it to the dispatch table."
                );
            }
        }

        $L = $loaderTable[$source];
        $S = $splitterTable[$strategy];
        $E = $embeddingsTable[$embProvider];
        $V = $storeTable[$store];

        // Dedup imports (json/os come from the skeleton header), stable order.
        $importBlock = implode("\n", array_values(array_unique([
            $L['import'],
            $S['import'],
            $E['import'],
            $V['import'],
        ])));

        $loaderLit = self::jsonLit($loaderJson);
        $splitterLit = self::jsonLit($splitterJson);
        $storeLit = self::jsonLit($storeJson);

        $loaderBlock = "if not LOADER.get(\"path\"):\n"
            . "    raise RuntimeError(\"loader path is empty (set the loader Path or the Start node's document)\")\n"
            . $L['load'];
        $splitterBlock = $S['body'];
        $embeddingsBlock = $E['body'];
        $storeBlock = $V['body'];

        $code = <<<PY
# Standalone RAG ingestion script — generated from node configs.
# Composed from the chosen loader/splitter/embeddings/store fragments.
import json, os
{$importBlock}

LOADER = {$loaderLit}
SPLITTER = {$splitterLit}
STORE = {$storeLit}

# 1. Load → docs
{$loaderBlock}

# 2. Split → chunks
{$splitterBlock}

# 3. Embeddings → embeddings
{$embeddingsBlock}

# 4. Store (writes chunks, sets `result`)
{$storeBlock}

print(json.dumps(result))
PY;

        $slug = self::slugify((string) ($storeJson['collection'] ?? ''));
        $filename = 'ingestion_' . ($slug !== '' ? $slug : 'temp') . '.py';

        return [
            'filename' => $filename,
            'code'     => $code,
        ];
    }

    private static function slugify(string $name): string
    {
        $slug = strtolower(trim($name));
        $slug = preg_replace('/[^a-z0-9]+/', '_', $slug) ?? '';
        return trim($slug, '_');
    }
}
