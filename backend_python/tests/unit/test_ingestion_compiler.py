"""Ported from backend/scripts/test-ingestion-compiler.php PLUS additional
edge-case scenarios captured directly from IngestionCompiler.php via `php -r`
(2026-09-07), since the PHP harness only asserts substring containment
(str_contains checks) -- for a byte-identical generator port this test pins
the FULL exact `code`/`filename` output as literals instead, which is a
strictly stronger check that subsumes every str_contains assertion in the
PHP script.

IngestionCompiler.compileScript emits a template with ONLY the
LANGFS..WORKERS variable block interpolated; everything else (imports, the
_payload/list_files/store/process_file helpers, the __main__ driver) is a
fixed literal copied from the PHP heredoc byte-for-byte.
"""
from __future__ import annotations

import py_compile
import tempfile
from pathlib import Path

import pytest

from app.agent_team.services.ingestion_compiler import IngestionCompiler


# ---------------------------------------------------------------------------
# compileScript -- full script, byte-identical to `php backend/scripts/
# test-ingestion-compiler.php`'s scenario (loader/splitter/store as in that
# script), pinned via `php -r 'echo IngestionCompiler::compileScript(...)'`.
# ---------------------------------------------------------------------------

def test_compile_script_matches_php_scenario():
    loader = {
        'provider': 'local', 'path': '/srv/docs', 'is_dir': True,
        'types': ['pdf', 'html'], 'workers': 4,
        'storage_mcp_url': 'http://127.0.0.1:8077/mcp',
    }
    splitter = {'chunk_size': 800, 'overlap': 120}
    store = {
        'store': 'mcp:45', 'provider': 'qdrant', 'connection': {},
        'collection': 'docs', 'embedding': '',
    }
    ctx = {'langfs_url': 'http://127.0.0.1:8077/mcp', 'mcpqrant_url': 'http://127.0.0.1:8008/mcp'}

    r = IngestionCompiler.compileScript(loader, splitter, store, ctx)

    assert r['filename'] == 'ingestion_docs.py'
    # spot checks mirroring the PHP harness's str_contains assertions
    code = r['code']
    assert 'http://127.0.0.1:8077/mcp' in code
    assert 'http://127.0.0.1:8008/mcp' in code
    assert '"list_files"' in code
    assert '"format": "text"' in code
    assert '"store"' in code
    assert 'items' in code and 'VS_PROVIDER' in code and 'CONNECTION' in code and 'COLLECTION' in code
    assert 'RecursiveCharacterTextSplitter' in code and 'split_text' in code
    assert 'ThreadPoolExecutor' in code
    assert '800' in code and '120' in code
    assert 'CONNECTION = {}' in code
    assert 'qdrant-store' not in code
    assert 'ProcessPoolExecutor' not in code
    assert 'pypdf' not in code and 'docx2txt' not in code and 'markdownify' not in code
    assert 'base64' not in code and 'UFS' not in code
    assert 'langchain_community' not in code and 'langchain_postgres' not in code

    # byte-identical to the PHP oracle output (`php -r`, 2026-09-07)
    assert code == (
        '#!/usr/bin/env python3\n'
        '"""Standalone RAG ingestion \u2014 generated from the workflow nodes.\n'
        'Orchestrates langfs (extract) + mcp_qrant (embed/store); the only in-process\n'
        'LangChain is the recursive splitter. Independent of the PHP interpreter.\n'
        'Deps: langchain-text-splitters (+ Python stdlib)."""\n'
        'import json, urllib.request\n'
        'from concurrent.futures import ThreadPoolExecutor\n'
        'from langchain_text_splitters import RecursiveCharacterTextSplitter\n'
        '\n'
        'LANGFS = "http://127.0.0.1:8077/mcp"\n'
        'MCPQRANT = "http://127.0.0.1:8008/mcp"\n'
        'PROVIDER = "local"\n'
        'PATH = "/srv/docs"\n'
        'IS_DIR = True\n'
        'TYPES = ["pdf","html"]\n'
        'CHUNK = 800\n'
        'OVERLAP = 120\n'
        'VS_PROVIDER = "qdrant"\n'
        'CONNECTION = {}\n'
        'COLLECTION = "docs"\n'
        'EMBEDDING = ""\n'
        'WORKERS = 4\n'
        '\n'
        'EXT_TYPE = {"pdf": "pdf", "docx": "word", "doc": "word", "txt": "text", "csv": "csv", "html": "html", "htm": "html"}\n'
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
        '    print(f"done -- {total} chunk(s) stored")'
    )


def test_compile_script_py_compiles():
    r = IngestionCompiler.compileScript(
        {'provider': 'local', 'path': '/srv/docs', 'is_dir': True, 'types': ['pdf', 'html'], 'workers': 4,
         'storage_mcp_url': 'http://127.0.0.1:8077/mcp'},
        {'chunk_size': 800, 'overlap': 120},
        {'provider': 'qdrant', 'connection': {}, 'collection': 'docs', 'embedding': ''},
        {'langfs_url': 'http://127.0.0.1:8077/mcp', 'mcpqrant_url': 'http://127.0.0.1:8008/mcp'},
    )
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / 'ingest_compile_test.py'
        path.write_text(r['code'], encoding='utf-8')
        py_compile.compile(str(path), doraise=True)  # raises on syntax error


# ---------------------------------------------------------------------------
# compileScript edge cases -- defaults, clamping, unicode slugify, non-empty
# connection, workers=0 (pinned via `php -r`, 2026-09-07).
# ---------------------------------------------------------------------------

def test_compile_script_defaults_all_missing_config():
    r = IngestionCompiler.compileScript({}, {}, {})
    assert r['filename'] == 'ingestion_pipeline.py'
    assert 'LANGFS = ""' in r['code']
    assert 'MCPQRANT = ""' in r['code']
    assert 'PROVIDER = "local"' in r['code']
    assert 'PATH = ""' in r['code']
    assert 'IS_DIR = False' in r['code']
    assert 'TYPES = []' in r['code']
    assert 'CHUNK = 1000' in r['code']
    assert 'OVERLAP = 150' in r['code']
    assert 'VS_PROVIDER = "qdrant"' in r['code']
    assert 'CONNECTION = {}' in r['code']
    assert 'COLLECTION = ""' in r['code']
    assert 'EMBEDDING = ""' in r['code']
    assert 'WORKERS = None' in r['code']


def test_compile_script_clamps_and_slugifies_and_workers_zero():
    r = IngestionCompiler.compileScript(
        {'provider': '', 'path': 'a/b.pdf', 'is_dir': False, 'types': [], 'workers': 0},
        {'chunk_size': -5, 'overlap': -3},
        {'provider': '', 'connection': {'mode': 'local', 'path': '/tmp/q'},
         'collection': '  Caf\u00e9 \u00dcn\u00efcode!! Docs  ', 'embedding': 'hf:x'},
    )
    # PHP strtolower is ASCII-only: accented uppercase (Ü) stays non-a-z0-9 and
    # collapses into an underscore run just like the accented lowercase chars.
    assert r['filename'] == 'ingestion_caf_n_code_docs.py'
    assert 'PROVIDER = "local"' in r['code']   # '' falls back to 'local'
    assert 'CHUNK = 1' in r['code']             # negative chunk_size clamped to >= 1
    assert 'OVERLAP = 0' in r['code']           # negative overlap clamped to >= 0
    assert 'VS_PROVIDER = "qdrant"' in r['code']  # '' falls back to 'qdrant'
    assert 'CONNECTION = {"mode":"local","path":"/tmp/q"}' in r['code']
    assert 'COLLECTION = "Caf\u00e9 \u00dcn\u00efcode!! Docs"' in r['code']  # trimmed, not slugified
    assert 'EMBEDDING = "hf:x"' in r['code']
    assert 'WORKERS = None' in r['code']        # workers=0 -> None (falls back to 8 at runtime)


# ---------------------------------------------------------------------------
# compileNodeChunk -- per-node "Generated code" fragments
# ---------------------------------------------------------------------------

def test_compile_node_chunk_start():
    assert IngestionCompiler.compileNodeChunk('start') == (
        "import json, os\n# (common header \u2014 shared by the stages below)"
    )


def test_compile_node_chunk_loader_default():
    assert IngestionCompiler.compileNodeChunk('loader', {}) == (
        "# Loader \u2014 langfs (provider: local)\n"
        "# langfs enumerates + EXTRACTS text; no local decoders here.\n"
        'LOADER = {"provider":"local","path":"","is_dir":false,"types":[]}\n'
        "# files  = list_files(provider, path, types)        -> [source, ...]\n"
        "# text   = read_file(provider, file_id, format='text')  -> extracted text\n"
        "# (text per file) -> handed to the Splitter"
    )


def test_compile_node_chunk_loader_filters_non_string_types():
    got = IngestionCompiler.compileNodeChunk(
        'loader', {'provider': 'gdrive', 'path': 'x', 'is_dir': False, 'types': ['pdf', 123, 'html', None]}
    )
    assert got == (
        "# Loader \u2014 langfs (provider: gdrive)\n"
        "# langfs enumerates + EXTRACTS text; no local decoders here.\n"
        'LOADER = {"provider":"gdrive","path":"x","is_dir":false,"types":["pdf","html"]}\n'
        "# files  = list_files(provider, path, types)        -> [source, ...]\n"
        "# text   = read_file(provider, file_id, format='text')  -> extracted text\n"
        "# (text per file) -> handed to the Splitter"
    )


def test_compile_node_chunk_loader_dir_appends_recursive_note():
    got = IngestionCompiler.compileNodeChunk('loader', {'provider': 'local', 'path': '/srv/docs', 'is_dir': True})
    assert got.startswith("# Loader \u2014 langfs (provider: local, recursive folder)\n")


def test_compile_node_chunk_splitter_default():
    got = IngestionCompiler.compileNodeChunk('splitter', {})
    assert got == (
        "# Splitter \u2014 strategy: recursive\n"
        "from langchain_text_splitters import RecursiveCharacterTextSplitter\n\n"
        'SPLITTER = {"strategy":"recursive","chunk_size":1000,"overlap":150}\n'
        "splitter = RecursiveCharacterTextSplitter(\n"
        '    chunk_size=int(SPLITTER.get("chunk_size", 1000)),\n'
        '    chunk_overlap=int(SPLITTER.get("overlap", 150)),\n'
        ")\n"
        "chunks = [c for c in splitter.split_text(text) if c.strip()]\n"
        "# chunks : list[str]  -> handed to the Vector store"
    )
    assert 'RecursiveCharacterTextSplitter' in got and 'split_text' in got


def test_compile_node_chunk_vectorstore_default():
    got = IngestionCompiler.compileNodeChunk('vectorstore', {})
    assert got == (
        '# Vector store \u2014 mcp_qrant "store" (provider: qdrant)\n'
        "# mcp_qrant EMBEDS + upserts; no embeddings/vector-store libs here.\n"
        'STORE = {"provider":"qdrant","connection":{},"collection":"","embedding":""}\n'
        '# "store"(provider, connection, collection,\n'
        '#          items=[{"text": c, "metadata": {"source": src}} for c in chunks],\n'
        '#          embedding) -> {"stored": int, "errors": int}'
    )
    assert '"store"' in got and 'items' in got
    assert 'PGVector' not in got and 'OpenAIEmbeddings' not in got


def test_compile_node_chunk_vectorstore_list_connection_casts_to_object():
    # PHP: (object)((array) $connection) -- a PHP list cast to an object gets
    # string-index keys, so a JSON list connection value encodes as an object.
    got = IngestionCompiler.compileNodeChunk('vectorstore', {'connection': ['a', 'b', 'c']})
    assert 'STORE = {"provider":"qdrant","connection":{"0":"a","1":"b","2":"c"},"collection":"","embedding":""}' in got


def test_compile_node_chunk_disabled_is_passthrough():
    assert IngestionCompiler.compileNodeChunk('loader', {'disabled': True}) == (
        "# Loader \u2014 DISABLED (skipped for debugging)\n"
        "# This stage is a passthrough; its input is forwarded unchanged."
    )


def test_compile_node_chunk_start_ignores_disabled():
    # 'start' never passes through disabled -- it has no config of its own.
    assert IngestionCompiler.compileNodeChunk('start', {'disabled': True}) == (
        "import json, os\n# (common header \u2014 shared by the stages below)"
    )


def test_compile_node_chunk_unknown_kind_raises():
    with pytest.raises(RuntimeError) as exc:
        IngestionCompiler.compileNodeChunk('bogus')
    assert str(exc.value) == (
        "IngestionCompiler: unknown node kind 'bogus' (expected start, loader, splitter, vectorstore)."
    )


def test_compile_node_chunk_unknown_splitter_strategy_raises():
    with pytest.raises(RuntimeError) as exc:
        IngestionCompiler.compileNodeChunk('splitter', {'strategy': 'semantic'})
    assert str(exc.value) == (
        "IngestionCompiler: no fragment for splitter strategy 'semantic' yet "
        "\u2014 add it to the splitter dispatch table."
    )


# ---------------------------------------------------------------------------
# compileNodeView / compileView -- Input / Generated / Output panes
# ---------------------------------------------------------------------------

def test_compile_node_view_loader_includes_start_header_as_input():
    view = IngestionCompiler.compileNodeView('loader', {'provider': 'local', 'path': 'x'})
    assert view['input'] == "import json, os\n# (common header \u2014 shared by the stages below)"
    assert view['generated'] == IngestionCompiler.compileNodeChunk('loader', {'provider': 'local', 'path': 'x'})
    assert view['output'] == view['input'] + "\n\n" + view['generated']


def test_compile_node_view_non_loader_has_empty_input():
    view = IngestionCompiler.compileNodeView('splitter', {'chunk_size': 500})
    assert view['input'] == ''
    assert view['output'] == view['generated']


def test_compile_view_empty_stages():
    assert IngestionCompiler.compileView([]) == {'input': '', 'generated': '', 'output': ''}


def test_compile_view_upstream_plus_target():
    view = IngestionCompiler.compileView([
        {'node_type': 'start', 'config': {}},
        {'node_type': 'loader', 'config': {'provider': 'local', 'path': '/srv/docs', 'is_dir': True}},
        {'node_type': 'splitter', 'config': {'chunk_size': 800, 'overlap': 120}},
    ])
    assert 'list_files' in view['output']
    assert 'split_text' in view['generated']
    start_chunk = IngestionCompiler.compileNodeChunk('start')
    loader_chunk = IngestionCompiler.compileNodeChunk(
        'loader', {'provider': 'local', 'path': '/srv/docs', 'is_dir': True}
    )
    splitter_chunk = IngestionCompiler.compileNodeChunk('splitter', {'chunk_size': 800, 'overlap': 120})
    assert view['input'] == start_chunk + "\n\n" + loader_chunk
    assert view['generated'] == splitter_chunk
    assert view['output'] == view['input'] + "\n\n" + splitter_chunk


def test_compile_view_falls_back_to_type_key_when_node_type_absent():
    # compileView reads $s['node_type'] ?? $s['type'] ?? ''
    view = IngestionCompiler.compileView([{'type': 'start', 'config': {}}])
    assert view['generated'] == IngestionCompiler.compileNodeChunk('start')
