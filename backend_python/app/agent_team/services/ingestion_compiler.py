"""Standalone, config-driven RAG ingestion compiler.

Unlike LangGraphGenerator's ingestion-script path (which re-reads the SAVED
graph), this compiler is fed each node's OWN config directly by the frontend.
It is fully self-contained: emits Python scripts that orchestrate langfs
(load/extract) + mcp_qrant (embed/store), plus two entry points:

  - compileNodeChunk(kind, config): the Python chunk for ONE node (the
    incremental per-node "Output" tab in the editor).
  - compileScript(loader, splitter, store): the full runnable standalone
    script (download / run-anywhere).

Ported from backend/src/AgentTeam/Services/IngestionCompiler.php.
"""
from __future__ import annotations

import re

from app.support.phpcompat import php_empty, php_intval, php_strval, php_trim, php_values, ucfirst
from app.support.phpjson import dumps as _php_json_lit

from ._ingestion_compat import php_array_cast as _phpArrayCast

_ASCII_UPPER_TO_LOWER = str.maketrans(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'
)


def _strtolower(s: str) -> str:
    """PHP strtolower(): byte-wise, ASCII A-Z only -- unlike Python's .lower()
    it never touches non-ASCII letters (accents, etc.)."""
    return s.translate(_ASCII_UPPER_TO_LOWER)


def _coalesce(v, default):
    """PHP's `$x ?? $default` -- default only when v is None (missing/null),
    NOT when v is merely falsy (0, '', False all pass through unchanged)."""
    return default if v is None else v


# Fixed template pieces of the emitted standalone script, captured verbatim
# from IngestionCompiler.php's heredoc (`php -r` diff-verified 2026-09-07)
# so the interpolated LANGFS..WORKERS block is the only moving part.
_SCRIPT_HEADER = ('#!/usr/bin/env python3\n"""Standalone RAG ingestion \u2014 generated from the workflow nodes.\n'
    'Orchestrates langfs (extract) + mcp_qrant (embed/store); the only in-process\n'
    'LangChain is the recursive splitter. Independent of the PHP interpreter.\n'
    'Deps: langchain-text-splitters (+ Python stdlib)."""\n'
    'import json, urllib.request\n'
    'from concurrent.futures import ThreadPoolExecutor\n'
    'from langchain_text_splitters import RecursiveCharacterTextSplitter\n')

_SCRIPT_TAIL = ('EXT_TYPE = {"pdf": "pdf", "docx": "word", "doc": "word", "txt": "text", "csv": "csv", "html": "html", "htm": "html"}\n'
    '\n'
    '_split = RecursiveCharacterTextSplitter(chunk_size=CHUNK, chunk_overlap=OVERLAP)\n'
    '\n'
    '\n'
    'def _parse(raw):\n'
    '    try:\n'
    '        return json.loads(raw)\n'
    '    except Exception:\n'
    '        for line in raw.splitlines():\n'
    '            line = line.strip()\n'
    '            if line.startswith("data:"):\n'
    '                d = line[5:].strip()\n'
    '                if d:\n'
    '                    try:\n'
    '                        return json.loads(d)\n'
    '                    except Exception:\n'
    '                        pass\n'
    '    return {}\n'
    '\n'
    '\n'
    'def _payload(url, tool, args):\n'
    '    """Call an MCP tool and return the decoded payload from the\n'
    '    {content:[{text:json}]} envelope. Raises on JSON-RPC error."""\n'
    '    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",\n'
    '                       "params": {"name": tool, "arguments": args}}).encode("utf-8")\n'
    '    req = urllib.request.Request(url, data=body, method="POST", headers={\n'
    '        "Content-Type": "application/json",\n'
    '        "Accept": "application/json, text/event-stream"})\n'
    '    with urllib.request.urlopen(req, timeout=300) as resp:\n'
    '        obj = _parse(resp.read().decode("utf-8", "replace"))\n'
    '    if isinstance(obj, dict) and obj.get("error"):\n'
    '        raise RuntimeError(f"{tool}: {(obj[\'error\'] or {}).get(\'message\', \'MCP error\')}")\n'
    '    result = obj.get("result") if isinstance(obj, dict) else None\n'
    '    result = result if result is not None else obj\n'
    '    text = None\n'
    '    if isinstance(result, dict):\n'
    '        content = result.get("content")\n'
    '        if isinstance(content, list) and content and isinstance(content[0], dict):\n'
    '            text = content[0].get("text")\n'
    '    if isinstance(text, str):\n'
    '        try:\n'
    '            return json.loads(text)\n'
    '        except Exception:\n'
    '            return {"content": text}\n'
    '    return result if isinstance(result, dict) else {}\n'
    '\n'
    '\n'
    'def detect(name):\n'
    '    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""\n'
    '    return EXT_TYPE.get(ext)\n'
    '\n'
    '\n'
    'def list_files():\n'
    '    """Recursive walk via langfs list_files (one level per call)."""\n'
    '    out, seen = [], set()\n'
    '\n'
    '    def walk(folder, depth):\n'
    '        if depth > 64 or folder in seen:\n'
    '            return\n'
    '        seen.add(folder)\n'
    '        args = {"provider": PROVIDER}\n'
    '        if folder:\n'
    '            args["path"] = folder\n'
    '        data = _payload(LANGFS, "list_files", args)\n'
    '        for it in (data.get("files") or []):\n'
    '            if not isinstance(it, dict):\n'
    '                continue\n'
    '            fid = it.get("id") or it.get("source")\n'
    '            nm = it.get("name") or (fid or "")\n'
    '            if it.get("type") == "folder":\n'
    '                if fid:\n'
    '                    walk(fid, depth + 1)\n'
    '            else:\n'
    '                t = detect(nm)\n'
    '                if t and (not TYPES or t in TYPES) and fid:\n'
    '                    out.append(fid)\n'
    '\n'
    '    if IS_DIR:\n'
    '        walk(PATH, 0)\n'
    '    else:\n'
    '        nm = PATH.rsplit("/", 1)[-1]\n'
    '        t = detect(nm)\n'
    '        if t and (not TYPES or t in TYPES):\n'
    '            out.append(PATH)\n'
    '    return out\n'
    '\n'
    '\n'
    'def read_text(src):\n'
    '    """langfs read_file with format=text \u2014 langfs returns extracted text."""\n'
    '    data = _payload(LANGFS, "read_file", {"provider": PROVIDER, "file_id": src, "format": "text"})\n'
    '    return str((data.get("content") if isinstance(data, dict) else "") or "")\n'
    '\n'
    '\n'
    'def store(items):\n'
    '    args = {"provider": VS_PROVIDER, "connection": CONNECTION, "collection": COLLECTION, "items": items}\n'
    '    if EMBEDDING:\n'
    '        args["embedding"] = EMBEDDING\n'
    '    data = _payload(MCPQRANT, "store", args)\n'
    '    if not isinstance(data, dict) or "stored" not in data:\n'
    '        raise RuntimeError("store: response had no {stored} field (transport/endpoint problem)")\n'
    '    if data.get("error"):\n'
    '        raise RuntimeError(f"store: {data.get(\'message\', \'store failed\')}")\n'
    '    return int(data.get("stored", 0))\n'
    '\n'
    '\n'
    'def process_file(src):\n'
    '    try:\n'
    '        chunks = [c for c in _split.split_text(read_text(src)) if c.strip()]\n'
    '        if not chunks:\n'
    '            return src, 0, None\n'
    '        n = store([{"text": c, "metadata": {"source": src}} for c in chunks])\n'
    '        return src, n, None\n'
    '    except Exception as e:\n'
    '        return src, 0, str(e)\n'
    '\n'
    '\n'
    'if __name__ == "__main__":\n'
    '    files = list_files()\n'
    '    workers = WORKERS or 8\n'
    '    print(f"{len(files)} file(s) to ingest with {workers} worker(s)")\n'
    '    total = 0\n'
    '    with ThreadPoolExecutor(max_workers=workers) as ex:\n'
    '        for src, n, err in ex.map(process_file, files):\n'
    '            total += n\n'
    '            print(f"  {src}: {n} chunk(s)" + (f"  ERROR: {err}" if err else ""))\n'
    '    print(f"done -- {total} chunk(s) stored")')


class IngestionCompiler:

    @staticmethod
    def _splitterDispatch() -> dict:
        """Splitter dispatch: strategy -> {import, body} where `body` sets `chunks`."""
        return {
            'recursive': {
                'import': 'from langchain_text_splitters import RecursiveCharacterTextSplitter',
                'body': (
                    'splitter = RecursiveCharacterTextSplitter(\n'
                    '    chunk_size=int(SPLITTER.get("chunk_size", 1000)),\n'
                    '    chunk_overlap=int(SPLITTER.get("overlap", 150)),\n'
                    ')\n'
                    'chunks = [c for c in splitter.split_text(text) if c.strip()]'
                ),
            },
        }

    @staticmethod
    def _jsonLit(v) -> str:
        """json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) -- compact,
        literal slashes, literal non-ASCII. phpjson.dumps() already matches this exactly
        (ensure_ascii=False, compact separators, no slash-escaping)."""
        return _php_json_lit(v)

    @staticmethod
    def _strOrDefault(v, default: str) -> str:
        """`(string) ($v ?? $default) ?: $default` -- None/missing AND any falsy
        string result ('', '0') both fall back to default."""
        s = php_strval(v) if v is not None else default
        return default if php_empty(s) else s

    @staticmethod
    def _toObject(v) -> dict:
        """`(object) ((array) $v)` -- (array) first: None/missing becomes [];
        a scalar is wrapped as a one-element list; dict/list pass through.
        Then (object): a dict passes through; a list is cast to an object with
        string-index keys (PHP's array-to-object cast). Always returns a dict
        so json-encoding never collapses to `[]`."""
        casted = _phpArrayCast(v)
        if isinstance(casted, dict):
            return dict(casted)
        return {str(i): item for i, item in enumerate(casted)}

    @staticmethod
    def compileNodeChunk(kind: str, config: dict | None = None) -> str:
        """Compile the Python chunk for a SINGLE node, from that node's own config.

        kind: one of start, loader, splitter, vectorstore.
        config: the node's own config (the 'start' header takes no config).

        Raises RuntimeError (PHP's \\RuntimeException) on unknown kind / strategy.
        """
        config = config if isinstance(config, dict) else {}

        # A disabled node is a passthrough -- it forwards its input unchanged so
        # the rest of the pipeline still runs. Lets you isolate a faulty stage.
        if kind != 'start' and not php_empty(config.get('disabled')):
            label = ucfirst(kind)
            return (
                f"# {label} \u2014 DISABLED (skipped for debugging)\n"
                "# This stage is a passthrough; its input is forwarded unchanged."
            )

        if kind == 'start':
            return "import json, os\n# (common header \u2014 shared by the stages below)"

        if kind == 'loader':
            provider = IngestionCompiler._strOrDefault(config.get('provider'), 'local')
            isDir = not php_empty(config.get('is_dir'))
            types = [v for v in php_values(_phpArrayCast(config.get('types'))) if isinstance(v, str)]
            j = IngestionCompiler._jsonLit({
                'provider': provider,
                'path': _coalesce(config.get('path'), ''),
                'is_dir': isDir,
                'types': types,
            })
            return (
                f"# Loader \u2014 langfs (provider: {provider}" + (", recursive folder" if isDir else "") + ")\n"
                "# langfs enumerates + EXTRACTS text; no local decoders here.\n"
                f"LOADER = {j}\n"
                "# files  = list_files(provider, path, types)        -> [source, ...]\n"
                "# text   = read_file(provider, file_id, format='text')  -> extracted text\n"
                "# (text per file) -> handed to the Splitter"
            )

        if kind == 'splitter':
            strategy = php_strval(_coalesce(config.get('strategy'), 'recursive'))
            table = IngestionCompiler._splitterDispatch()
            if strategy not in table:
                raise RuntimeError(
                    f"IngestionCompiler: no fragment for splitter strategy '{strategy}' yet "
                    "— add it to the splitter dispatch table."
                )
            S = table[strategy]
            j = IngestionCompiler._jsonLit({
                'strategy': strategy,
                'chunk_size': _coalesce(config.get('chunk_size'), 1000),
                'overlap': _coalesce(config.get('overlap'), 150),
            })
            return (
                f"# Splitter \u2014 strategy: {strategy}\n"
                f"{S['import']}\n\n"
                f"SPLITTER = {j}\n"
                f"{S['body']}\n"
                "# chunks : list[str]  -> handed to the Vector store"
            )

        if kind == 'vectorstore':
            vsProvider = IngestionCompiler._strOrDefault(config.get('provider'), 'qdrant')
            j = IngestionCompiler._jsonLit({
                'provider': vsProvider,
                'connection': IngestionCompiler._toObject(config.get('connection')),
                'collection': php_strval(_coalesce(config.get('collection'), '')),
                'embedding': php_strval(_coalesce(config.get('embedding'), '')),
            })
            return (
                f"# Vector store \u2014 mcp_qrant \"store\" (provider: {vsProvider})\n"
                "# mcp_qrant EMBEDS + upserts; no embeddings/vector-store libs here.\n"
                f"STORE = {j}\n"
                "# \"store\"(provider, connection, collection,\n"
                "#          items=[{\"text\": c, \"metadata\": {\"source\": src}} for c in chunks],\n"
                "#          embedding) -> {\"stored\": int, \"errors\": int}"
            )

        raise RuntimeError(
            f"IngestionCompiler: unknown node kind '{kind}' (expected start, loader, splitter, vectorstore)."
        )

    @staticmethod
    def compileNodeView(kind: str, config: dict) -> dict:
        """Compile the three-panel "node view" for the editor's per-node tabs:
        Input (code received from the previous stage), Generated (ONLY this
        node's own chunk) and Output (Input + Generated).

        Returns {input, generated, output}.
        """
        generated = IngestionCompiler.compileNodeChunk(kind, config)

        if kind == 'loader':
            # The loader receives the start node's contribution -- the common
            # header (import json, os ...).
            input_ = IngestionCompiler.compileNodeChunk('start')
            output = input_ + "\n\n" + generated
        else:
            # TODO: cumulative input from upstream stages
            input_ = ''
            output = generated

        return {'input': input_, 'generated': generated, 'output': output}

    @staticmethod
    def compileView(stages: list) -> dict:
        """Compile the Input / Generated / Output view for a node given the ORDERED
        pipeline stages from start through that node. Input = the cumulative code
        of all UPSTREAM stages; Generated = the target (last) stage's own chunk;
        Output = Input + Generated.
        """
        if not stages:
            return {'input': '', 'generated': '', 'output': ''}
        chunks = []
        for s in stages:
            s = s if isinstance(s, dict) else {}
            kind = s.get('node_type')
            if kind is None:
                kind = s.get('type')
            if kind is None:
                kind = ''
            kind = php_strval(kind)
            # PHP: $cfg = (array) ($s['config'] ?? []); a scalar config casts to a
            # list, which compileNodeChunk normalizes to {} anyway (no string keys
            # to find on it) -- applying the cast here is for parity, not behaviour.
            cfg = _phpArrayCast(s.get('config'))
            chunks.append(IngestionCompiler.compileNodeChunk(kind, cfg if isinstance(cfg, dict) else {}))
        generated = chunks.pop()   # the target (last) stage
        input_ = "\n\n".join(chunks)   # all upstream stages
        output = generated if input_ == '' else input_ + "\n\n" + generated
        return {'input': input_, 'generated': generated, 'output': output}

    @staticmethod
    def compileScript(loaderCfg: dict, splitterCfg: dict, storeCfg: dict, ctx: dict | None = None) -> dict:
        """Compile the full, self-contained, runnable ingestion script from the
        three node configs.

        loaderCfg: {storage_mcp_url, provider, path, types, is_dir, workers}
        splitterCfg: {strategy, chunk_size, overlap}
        storeCfg: {store, provider, connection, collection, embedding}
        ctx: {langfs_url, mcpqrant_url}

        Returns {filename, code}.
        """
        loaderCfg = loaderCfg if isinstance(loaderCfg, dict) else {}
        splitterCfg = splitterCfg if isinstance(splitterCfg, dict) else {}
        storeCfg = storeCfg if isinstance(storeCfg, dict) else {}
        ctx = ctx if isinstance(ctx, dict) else {}

        langfsUrl = php_strval(_coalesce(ctx.get('langfs_url'), _coalesce(loaderCfg.get('storage_mcp_url'), '')))
        mcpqUrl = php_strval(_coalesce(ctx.get('mcpqrant_url'), ''))
        provider = IngestionCompiler._strOrDefault(loaderCfg.get('provider'), 'local')
        path = php_strval(_coalesce(loaderCfg.get('path'), ''))
        isDir = not php_empty(loaderCfg.get('is_dir'))
        types = [v for v in php_values(_phpArrayCast(loaderCfg.get('types'))) if isinstance(v, str)]
        chunk = max(1, php_intval(_coalesce(splitterCfg.get('chunk_size'), 1000)))
        overlap = max(0, php_intval(_coalesce(splitterCfg.get('overlap'), 150)))
        vsProvider = IngestionCompiler._strOrDefault(storeCfg.get('provider'), 'qdrant')
        connection = _phpArrayCast(storeCfg.get('connection'))
        collection = php_trim(php_strval(_coalesce(storeCfg.get('collection'), '')))
        embedding = php_trim(php_strval(_coalesce(storeCfg.get('embedding'), '')))
        workersInt = php_intval(_coalesce(loaderCfg.get('workers'), 0))

        pyLangfs = IngestionCompiler._jsonLit(langfsUrl)
        pyMcpq = IngestionCompiler._jsonLit(mcpqUrl)
        pyProv = IngestionCompiler._jsonLit(provider)
        pyPath = IngestionCompiler._jsonLit(path)
        isDirPy = 'True' if isDir else 'False'
        pyTypes = '[]' if types == [] else IngestionCompiler._jsonLit(types)
        pyVsProv = IngestionCompiler._jsonLit(vsProvider)
        pyConn = '{}' if not connection else IngestionCompiler._jsonLit(connection)
        pyColl = IngestionCompiler._jsonLit(collection)
        pyEmb = IngestionCompiler._jsonLit(embedding)
        pyWorkers = str(workersInt) if workersInt > 0 else 'None'

        varBlock = (
            f"LANGFS = {pyLangfs}\n"
            f"MCPQRANT = {pyMcpq}\n"
            f"PROVIDER = {pyProv}\n"
            f"PATH = {pyPath}\n"
            f"IS_DIR = {isDirPy}\n"
            f"TYPES = {pyTypes}\n"
            f"CHUNK = {chunk}\n"
            f"OVERLAP = {overlap}\n"
            f"VS_PROVIDER = {pyVsProv}\n"
            f"CONNECTION = {pyConn}\n"
            f"COLLECTION = {pyColl}\n"
            f"EMBEDDING = {pyEmb}\n"
            f"WORKERS = {pyWorkers}\n"
        )

        code = _SCRIPT_HEADER + "\n" + varBlock + "\n" + _SCRIPT_TAIL

        slug = IngestionCompiler._slugify(collection)
        filename = 'ingestion_' + (slug if slug != '' else 'pipeline') + '.py'

        return {'filename': filename, 'code': code}

    @staticmethod
    def _slugify(name: str) -> str:
        slug = _strtolower(php_trim(name))
        slug = re.sub(r'[^a-z0-9]+', '_', slug)
        return php_trim(slug, '_')
