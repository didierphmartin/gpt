# langfs — LangChain blob-provider MCP server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Python MCP (streamable-HTTP) server that encapsulates LangChain's `FileSystemBlobLoader`, enumerates a folder recursively with a doc-type filter, and returns documents **one at a time as text** (blob fallback), holding the enumeration cursor **per client**.

**Architecture:** FastAPI app exposing one JSON-RPC endpoint (`tools/call`). Three tools — `list_providers`, `read_next`, `reset`. Enumeration uses LangChain `FileSystemBlobLoader`; bytes are read via LangChain `Blob`; text is extracted by a small suffix-dispatched extractor (`pypdf`/`docx2txt`/`bs4`). A per-`client_id` cursor store (owner + fingerprint verified, TTL-evicted) makes the server hand back the next document on each call. Read-only by charter.

**Tech Stack:** Python 3.11+, FastAPI, uvicorn, `langchain-community` 0.4.x (`FileSystemBlobLoader`), `langchain-core` (`Blob`), `pypdf`, `docx2txt`, `beautifulsoup4`, pytest.

**Spec:** `docs/superpowers/specs/2026-06-20-langfs-blob-mcp-design.md`

## Global Constraints

- **Location:** new standalone project at `/Applications/XAMPP/xamppfiles/htdocs/langfs/` (sibling of `gpt/`, NOT inside it). Its own venv, separate from `langchain_runner`.
- **Python:** 3.11+.
- **Dependencies:** `fastapi`, `uvicorn`, `langchain-community>=0.4,<0.5`, `langchain-core>=1.4`, `pypdf>=6`, `docx2txt>=0.8`, `beautifulsoup4>=4.12`, `pytest`, `httpx` (TestClient). **Do NOT add `unstructured` or `pymupdf`/`fitz`.**
- **Read-only:** no tool or method may write, move, rename, or delete. `BlobSource` exposes only `enumerate` and `read_bytes`.
- **MCP envelope:** gpt's `MCPToolsLoader` POSTs JSON-RPC `{"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":T,"arguments":{...}}}` and reads the text from `result.content[0].text`. Every tool result MUST be returned as `{"content":[{"type":"text","text": <string>}]}`, where `<string>` is `json.dumps(payload)`. Application-level outcomes (`done`, per-file error, `client_id_conflict`) are FIELDS inside that JSON payload — NOT JSON-RPC errors. JSON-RPC `error` is reserved for protocol faults (unknown method/tool).
- **Provider name is a parameter:** `read_next` takes `provider`; only `"local"` is valid at launch.
- **Supported types & suffixes (verbatim):**
  ```
  pdf  → .pdf        word → .docx .doc     text → .txt
  csv  → .csv        html → .html .htm
  ```
- **Enumeration glob:** recursive default `**/[!.]*` (skips dotfiles); one-file path handled directly.
- **Client id:** caller-named (`{userId}:{runId}`); cursor is a rebuildable cache keyed by it.

---

## File Structure

```
langfs/
  requirements.txt        # pinned deps
  README.md               # run + register instructions
  config.py               # AppConfig: allowed roots, cursor TTL, host/port
  parsing/
    __init__.py
    types.py              # TYPE_SUFFIXES, ALL_SUFFIXES, suffixes_for()
    extract.py            # extract_text(name, data) suffix dispatch; UnsupportedType
  sources/
    __init__.py
    base.py               # FileDescriptor dataclass, BlobSource protocol, PathOutsideRoot
    local.py              # LocalBlobSource (FileSystemBlobLoader + Blob + root guard)
    registry.py           # build_registry(), providers_payload()
  cursors.py              # CursorStore, Entry, ClientIdConflict
  handlers.py             # list_providers(), read_next(), reset() — pure dict in/out
  server.py               # FastAPI JSON-RPC endpoint + envelope wrapping + main()
  tests/
    __init__.py
    conftest.py           # fixture tree builder
    fixtures/             # created by conftest at runtime (tmp), plus committed samples
    test_types.py
    test_extract.py
    test_local_source.py
    test_cursors.py
    test_handlers.py
    test_server_http.py   # JSON-RPC envelope via FastAPI TestClient
```

---

### Task 1: Project scaffold + dependencies

**Files:**
- Create: `langfs/requirements.txt`
- Create: `langfs/README.md`
- Create: `langfs/config.py`
- Create: `langfs/__init__.py`, `langfs/parsing/__init__.py`, `langfs/sources/__init__.py`, `langfs/tests/__init__.py`
- Test: `langfs/tests/test_config.py`

**Interfaces:**
- Produces: `config.AppConfig` dataclass with fields `allowed_roots: list[str]`, `cursor_ttl_seconds: int`, `host: str`, `port: int`; classmethod `AppConfig.from_env() -> AppConfig`.

- [ ] **Step 1: Create the venv and install deps**

Create `langfs/requirements.txt`:
```
fastapi>=0.110
uvicorn>=0.29
langchain-community>=0.4,<0.5
langchain-core>=1.4
pypdf>=6
docx2txt>=0.8
beautifulsoup4>=4.12
pytest>=8
httpx>=0.27
```

Run:
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```
Expected: installs without error.

- [ ] **Step 2: Create the package `__init__.py` files (empty)**

Create empty `langfs/__init__.py`, `langfs/parsing/__init__.py`, `langfs/sources/__init__.py`, `langfs/tests/__init__.py`.

- [ ] **Step 3: Write the failing test for config**

Create `langfs/tests/test_config.py`:
```python
import os
from config import AppConfig


def test_from_env_reads_roots_and_ttl(monkeypatch):
    monkeypatch.setenv("LANGFS_ROOTS", "/tmp/a:/tmp/b")
    monkeypatch.setenv("LANGFS_CURSOR_TTL", "120")
    cfg = AppConfig.from_env()
    assert cfg.allowed_roots == ["/tmp/a", "/tmp/b"]
    assert cfg.cursor_ttl_seconds == 120


def test_from_env_defaults(monkeypatch):
    monkeypatch.delenv("LANGFS_ROOTS", raising=False)
    monkeypatch.delenv("LANGFS_CURSOR_TTL", raising=False)
    cfg = AppConfig.from_env()
    assert cfg.allowed_roots == []
    assert cfg.cursor_ttl_seconds == 3600
    assert cfg.port == 8077
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'config'`.

- [ ] **Step 5: Implement `config.py`**

Create `langfs/config.py`:
```python
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class AppConfig:
    allowed_roots: list[str]
    cursor_ttl_seconds: int = 3600
    host: str = "127.0.0.1"
    port: int = 8077

    @classmethod
    def from_env(cls) -> "AppConfig":
        roots_raw = os.environ.get("LANGFS_ROOTS", "").strip()
        roots = [r for r in roots_raw.split(":") if r] if roots_raw else []
        return cls(
            allowed_roots=roots,
            cursor_ttl_seconds=int(os.environ.get("LANGFS_CURSOR_TTL", "3600")),
            host=os.environ.get("LANGFS_HOST", "127.0.0.1"),
            port=int(os.environ.get("LANGFS_PORT", "8077")),
        )
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_config.py -v`
Expected: PASS (2 passed).

- [ ] **Step 7: Write the README**

Create `langfs/README.md`:
```markdown
# langfs — LangChain blob-provider MCP server

Read-only MCP (streamable-HTTP) server over LangChain blob loaders. Enumerates a
folder recursively with a doc-type filter and returns one document at a time as
text (base64 fallback). Holds the enumeration cursor per client.

## Run

    python3 -m venv .venv
    ./.venv/bin/pip install -r requirements.txt
    LANGFS_ROOTS=/path/to/allowed/root ./.venv/bin/python server.py

Server listens on http://127.0.0.1:8077/ (override with LANGFS_HOST/LANGFS_PORT).

## Register in gpt

Add an MCP server in gpt pointing at http://127.0.0.1:8077/ . Tools discovered:
list_providers, read_next, reset.

## Tools

- list_providers() -> {providers:[{name,kind,description,requires_credentials}]}
- read_next(provider, path, client_id, types?, format?, reset?) -> one document
- reset(client_id) -> {reset:true}

Read-only: no write/move/rename/delete.
```

- [ ] **Step 8: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git init -q 2>/dev/null || true
git add requirements.txt README.md config.py __init__.py parsing/__init__.py sources/__init__.py tests/__init__.py tests/test_config.py
git commit -q -m "feat(langfs): scaffold project + AppConfig"
```

---

### Task 2: Document-type → suffix mapping

**Files:**
- Create: `langfs/parsing/types.py`
- Test: `langfs/tests/test_types.py`

**Interfaces:**
- Produces:
  - `TYPE_SUFFIXES: dict[str, list[str]]`
  - `ALL_SUFFIXES: list[str]`
  - `suffixes_for(types: list[str] | None) -> list[str]` — empty/None → all supported; unknown types contribute nothing.

- [ ] **Step 1: Write the failing test**

Create `langfs/tests/test_types.py`:
```python
from parsing.types import suffixes_for, ALL_SUFFIXES


def test_empty_means_all():
    assert sorted(suffixes_for(None)) == sorted(ALL_SUFFIXES)
    assert sorted(suffixes_for([])) == sorted(ALL_SUFFIXES)


def test_filter_maps_doctypes_to_suffixes():
    assert sorted(suffixes_for(["pdf", "word"])) == [".doc", ".docx", ".pdf"]


def test_unknown_type_ignored():
    assert suffixes_for(["nope"]) == []
    assert sorted(suffixes_for(["pdf", "nope"])) == [".pdf"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_types.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'parsing.types'`.

- [ ] **Step 3: Implement `parsing/types.py`**

Create `langfs/parsing/types.py`:
```python
from __future__ import annotations

TYPE_SUFFIXES: dict[str, list[str]] = {
    "pdf": [".pdf"],
    "word": [".docx", ".doc"],
    "text": [".txt"],
    "csv": [".csv"],
    "html": [".html", ".htm"],
}

ALL_SUFFIXES: list[str] = [s for sl in TYPE_SUFFIXES.values() for s in sl]


def suffixes_for(types: list[str] | None) -> list[str]:
    """Map ticked doc-types to file suffixes. Empty/None → all supported."""
    if not types:
        return list(ALL_SUFFIXES)
    out: list[str] = []
    for t in types:
        out.extend(TYPE_SUFFIXES.get(t, []))
    return out
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_types.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add parsing/types.py tests/test_types.py
git commit -m "feat(langfs): doc-type to suffix mapping"
```

---

### Task 3: Text extraction (suffix dispatch)

**Files:**
- Create: `langfs/parsing/extract.py`
- Test: `langfs/tests/test_extract.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class UnsupportedType(Exception)`
  - `extract_text(name: str, data: bytes) -> str` — dispatch on the suffix of `name`. pdf→pypdf, docx/doc→docx2txt, html/htm→bs4 text, txt/csv→utf-8 decode (errors="replace"). Unknown suffix → raise `UnsupportedType`.

- [ ] **Step 1: Write the failing test**

Create `langfs/tests/test_extract.py`:
```python
import pytest
from parsing.extract import extract_text, UnsupportedType


def test_txt_passthrough():
    assert extract_text("a.txt", b"hello world") == "hello world"


def test_csv_passthrough():
    assert extract_text("a.csv", b"x,y\n1,2") == "x,y\n1,2"


def test_html_to_text():
    out = extract_text("a.html", b"<h1>Title</h1><p>Body</p><script>x=1</script>")
    assert "Title" in out and "Body" in out
    assert "x=1" not in out  # script stripped


def test_docx_extracts_text(tmp_path):
    # build a minimal .docx with python (docx2txt reads the zip)
    import docx
    p = tmp_path / "d.docx"
    document = docx.Document()
    document.add_paragraph("Hello from docx")
    document.save(p)
    assert "Hello from docx" in extract_text("d.docx", p.read_bytes())


def test_unsupported_raises():
    with pytest.raises(UnsupportedType):
        extract_text("a.png", b"\x89PNG")
```

Note: `test_docx_extracts_text` needs `python-docx` to *author* the fixture. Add it to the dev install:
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/pip install python-docx
```
(Authoring-only; not a server runtime dep — keep it out of `requirements.txt`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_extract.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'parsing.extract'`.

- [ ] **Step 3: Implement `parsing/extract.py`**

Create `langfs/parsing/extract.py`:
```python
from __future__ import annotations

import io
import os
import tempfile


class UnsupportedType(Exception):
    """Raised when a file's suffix has no text extractor."""


def _suffix(name: str) -> str:
    dot = name.rfind(".")
    return name[dot:].lower() if dot != -1 else ""


def _pdf(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    return "\n\n".join((page.extract_text() or "") for page in reader.pages).strip()


def _docx(data: bytes) -> str:
    import docx2txt

    # docx2txt needs a real path; write to a temp file.
    fd, path = tempfile.mkstemp(suffix=".docx")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        return (docx2txt.process(path) or "").strip()
    finally:
        os.unlink(path)


def _html(data: bytes) -> str:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(data, "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()
    return soup.get_text(" ", strip=True)


def _plain(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")


_DISPATCH = {
    ".pdf": _pdf,
    ".docx": _docx,
    ".doc": _docx,
    ".html": _html,
    ".htm": _html,
    ".txt": _plain,
    ".csv": _plain,
}


def extract_text(name: str, data: bytes) -> str:
    fn = _DISPATCH.get(_suffix(name))
    if fn is None:
        raise UnsupportedType(f"no text extractor for '{name}'")
    return fn(data)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_extract.py -v`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add parsing/extract.py tests/test_extract.py
git commit -m "feat(langfs): suffix-dispatched text extraction"
```

---

### Task 4: LocalBlobSource (enumerate + read, root-guarded)

**Files:**
- Create: `langfs/sources/base.py`
- Create: `langfs/sources/local.py`
- Test: `langfs/tests/test_local_source.py`

**Interfaces:**
- Consumes: `parsing.types.suffixes_for`.
- Produces:
  - `base.FileDescriptor` dataclass: `id: str`, `name: str`.
  - `base.PathOutsideRoot(Exception)`.
  - `base.BlobSource` Protocol: attrs `name: str`, `kind: str`, `description: str`, `requires_credentials: bool`; methods `enumerate(self, path: str, suffixes: list[str]) -> list[FileDescriptor]`, `read_bytes(self, file_id: str) -> bytes`.
  - `local.LocalBlobSource(allowed_roots: list[str])` implementing `BlobSource` with `name="local"`, `kind="text"`, `requires_credentials=False`. Enumeration uses `FileSystemBlobLoader` (recursive `**/[!.]*`) for a directory, or a single descriptor for a file. Every `path`/`file_id` is resolved and confirmed under an allowed root (or raises `PathOutsideRoot`). `id`/`name` are the absolute path / basename.

- [ ] **Step 1: Write the failing test**

Create `langfs/tests/test_local_source.py`:
```python
import os
import pytest
from sources.base import PathOutsideRoot, FileDescriptor
from sources.local import LocalBlobSource
from parsing.types import suffixes_for


@pytest.fixture
def tree(tmp_path):
    (tmp_path / "a.pdf").write_bytes(b"%PDF-1.4")
    (tmp_path / "b.txt").write_text("hi")
    (tmp_path / ".hidden.txt").write_text("nope")
    sub = tmp_path / "sub"
    sub.mkdir()
    (sub / "c.txt").write_text("deep")
    (sub / "skip.png").write_bytes(b"x")
    return tmp_path


def test_enumerate_recursive_flatten_files_only(tree):
    src = LocalBlobSource([str(tree)])
    descs = src.enumerate(str(tree), suffixes_for(None))
    names = sorted(d.name for d in descs)
    assert names == ["a.pdf", "b.txt", "c.txt"]  # recursive, dotfile + png excluded
    # ids are absolute paths
    assert all(os.path.isabs(d.id) for d in descs)


def test_enumerate_type_filter(tree):
    src = LocalBlobSource([str(tree)])
    descs = src.enumerate(str(tree), suffixes_for(["text"]))
    assert sorted(d.name for d in descs) == ["b.txt", "c.txt"]


def test_enumerate_single_file(tree):
    src = LocalBlobSource([str(tree)])
    descs = src.enumerate(str(tree / "b.txt"), suffixes_for(None))
    assert [d.name for d in descs] == ["b.txt"]


def test_read_bytes(tree):
    src = LocalBlobSource([str(tree)])
    assert src.read_bytes(str(tree / "b.txt")) == b"hi"


def test_path_outside_root_rejected(tree, tmp_path):
    src = LocalBlobSource([str(tree / "sub")])  # only sub/ allowed
    with pytest.raises(PathOutsideRoot):
        src.enumerate(str(tree), suffixes_for(None))
    with pytest.raises(PathOutsideRoot):
        src.read_bytes(str(tree / "b.txt"))
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_local_source.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'sources.base'`.

- [ ] **Step 3: Implement `sources/base.py`**

Create `langfs/sources/base.py`:
```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass
class FileDescriptor:
    id: str
    name: str


class PathOutsideRoot(Exception):
    """A requested path resolves outside every allowed root."""


@runtime_checkable
class BlobSource(Protocol):
    name: str
    kind: str
    description: str
    requires_credentials: bool

    def enumerate(self, path: str, suffixes: list[str]) -> list[FileDescriptor]: ...

    def read_bytes(self, file_id: str) -> bytes: ...
```

- [ ] **Step 4: Implement `sources/local.py`**

Create `langfs/sources/local.py`:
```python
from __future__ import annotations

import os
from pathlib import Path

from langchain_community.document_loaders.blob_loaders import FileSystemBlobLoader
from langchain_core.documents.base import Blob

from sources.base import BlobSource, FileDescriptor, PathOutsideRoot


class LocalBlobSource:
    name = "local"
    kind = "text"
    description = "Local filesystem via LangChain FileSystemBlobLoader"
    requires_credentials = False

    def __init__(self, allowed_roots: list[str]) -> None:
        self._roots = [Path(r).resolve() for r in allowed_roots]

    def _check(self, raw: str) -> Path:
        p = Path(raw).resolve()
        for root in self._roots:
            if p == root or root in p.parents:
                return p
        raise PathOutsideRoot(f"path outside allowed roots: {raw}")

    def enumerate(self, path: str, suffixes: list[str]) -> list[FileDescriptor]:
        target = self._check(path)
        if target.is_file():
            if suffixes and target.suffix.lower() not in suffixes:
                return []
            return [FileDescriptor(id=str(target), name=target.name)]
        loader = FileSystemBlobLoader(
            str(target), glob="**/[!.]*", suffixes=suffixes or None
        )
        out: list[FileDescriptor] = []
        for blob in loader.yield_blobs():            # lazy; no bytes read here
            bp = Path(str(blob.path))
            out.append(FileDescriptor(id=str(bp), name=bp.name))
        return out

    def read_bytes(self, file_id: str) -> bytes:
        target = self._check(file_id)
        return Blob.from_path(str(target)).as_bytes()


# Static assertion that the class satisfies the protocol.
_: BlobSource = LocalBlobSource([])
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_local_source.py -v`
Expected: PASS (5 passed).

- [ ] **Step 6: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add sources/base.py sources/local.py tests/test_local_source.py
git commit -m "feat(langfs): LocalBlobSource — recursive enumerate + read, root-guarded"
```

---

### Task 5: Provider registry

**Files:**
- Create: `langfs/sources/registry.py`
- Test: `langfs/tests/test_registry.py`

**Interfaces:**
- Consumes: `config.AppConfig`, `sources.local.LocalBlobSource`, `sources.base.BlobSource`.
- Produces:
  - `build_registry(cfg: AppConfig) -> dict[str, BlobSource]` — `{"local": LocalBlobSource(cfg.allowed_roots)}`.
  - `providers_payload(registry: dict[str, BlobSource]) -> list[dict]` — one `{name, kind, description, requires_credentials}` per source.

- [ ] **Step 1: Write the failing test**

Create `langfs/tests/test_registry.py`:
```python
from config import AppConfig
from sources.registry import build_registry, providers_payload


def test_registry_has_local():
    reg = build_registry(AppConfig(allowed_roots=["/tmp"]))
    assert "local" in reg
    assert reg["local"].name == "local"


def test_providers_payload_shape():
    reg = build_registry(AppConfig(allowed_roots=["/tmp"]))
    payload = providers_payload(reg)
    assert payload == [{
        "name": "local",
        "kind": "text",
        "description": "Local filesystem via LangChain FileSystemBlobLoader",
        "requires_credentials": False,
    }]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_registry.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'sources.registry'`.

- [ ] **Step 3: Implement `sources/registry.py`**

Create `langfs/sources/registry.py`:
```python
from __future__ import annotations

from config import AppConfig
from sources.base import BlobSource
from sources.local import LocalBlobSource


def build_registry(cfg: AppConfig) -> dict[str, BlobSource]:
    return {"local": LocalBlobSource(cfg.allowed_roots)}


def providers_payload(registry: dict[str, BlobSource]) -> list[dict]:
    return [
        {
            "name": s.name,
            "kind": s.kind,
            "description": s.description,
            "requires_credentials": s.requires_credentials,
        }
        for s in registry.values()
    ]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_registry.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add sources/registry.py tests/test_registry.py
git commit -m "feat(langfs): provider registry + list_providers payload"
```

---

### Task 6: Cursor store (per-client, owner+fingerprint verified, TTL)

**Files:**
- Create: `langfs/cursors.py`
- Test: `langfs/tests/test_cursors.py`

**Interfaces:**
- Consumes: `sources.base.FileDescriptor`.
- Produces:
  - `class ClientIdConflict(Exception)`.
  - `Entry` dataclass: `owner: str`, `fingerprint: str`, `descriptors: list[FileDescriptor]`, `cursor: int`, `updated_at: float`.
  - `class CursorStore(ttl_seconds: int, *, clock: Callable[[], float] = time.monotonic)`:
    - `staticmethod fingerprint(owner: str, provider: str, path: str, types: list[str] | None) -> str` — sha256 hex of `owner\x00provider\x00normalized_path\x00sorted(types)`.
    - `get_or_create(client_id, owner, fingerprint, build: Callable[[], list[FileDescriptor]], reset: bool) -> Entry` — verify owner+fingerprint on an existing entry (raise `ClientIdConflict` on mismatch unless `reset`); create via `build()` when missing/reset/expired. Touches `updated_at`.
    - `advance(client_id) -> None` — `cursor += 1`, touch `updated_at`.
    - `reset(client_id) -> None` — drop the entry (idempotent).
  - `clock` is injectable so tests control TTL without sleeping.

- [ ] **Step 1: Write the failing test**

Create `langfs/tests/test_cursors.py`:
```python
import pytest
from sources.base import FileDescriptor
from cursors import CursorStore, ClientIdConflict


def descs(n):
    return [FileDescriptor(id=f"/x/{i}.txt", name=f"{i}.txt") for i in range(n)]


def fp(store, owner="u", provider="local", path="/x", types=None):
    return store.fingerprint(owner, provider, path, types)


def test_create_then_advance():
    s = CursorStore(ttl_seconds=100)
    e = s.get_or_create("c1", "u", fp(s), lambda: descs(3), reset=False)
    assert e.cursor == 0 and len(e.descriptors) == 3
    s.advance("c1")
    e2 = s.get_or_create("c1", "u", fp(s), lambda: descs(3), reset=False)
    assert e2.cursor == 1  # same entry, cursor advanced, NOT rebuilt


def test_build_called_once_when_continuing():
    s = CursorStore(ttl_seconds=100)
    calls = {"n": 0}

    def build():
        calls["n"] += 1
        return descs(2)

    s.get_or_create("c1", "u", fp(s), build, reset=False)
    s.get_or_create("c1", "u", fp(s), build, reset=False)
    assert calls["n"] == 1  # cached, not re-enumerated


def test_owner_mismatch_conflicts():
    s = CursorStore(ttl_seconds=100)
    s.get_or_create("c1", "alice", fp(s, owner="alice"), lambda: descs(1), reset=False)
    with pytest.raises(ClientIdConflict):
        s.get_or_create("c1", "bob", fp(s, owner="bob"), lambda: descs(1), reset=False)


def test_fingerprint_mismatch_conflicts():
    s = CursorStore(ttl_seconds=100)
    s.get_or_create("c1", "u", fp(s, path="/x"), lambda: descs(1), reset=False)
    with pytest.raises(ClientIdConflict):
        s.get_or_create("c1", "u", fp(s, path="/y"), lambda: descs(1), reset=False)


def test_reset_overrides_conflict():
    s = CursorStore(ttl_seconds=100)
    s.get_or_create("c1", "u", fp(s, path="/x"), lambda: descs(1), reset=False)
    e = s.get_or_create("c1", "u", fp(s, path="/y"), lambda: descs(5), reset=True)
    assert e.cursor == 0 and len(e.descriptors) == 5


def test_ttl_eviction_rebuilds():
    t = {"now": 0.0}
    s = CursorStore(ttl_seconds=10, clock=lambda: t["now"])
    s.get_or_create("c1", "u", fp(s), lambda: descs(3), reset=False)
    s.advance("c1")
    t["now"] = 100.0  # past TTL
    calls = {"n": 0}

    def build():
        calls["n"] += 1
        return descs(3)

    e = s.get_or_create("c1", "u", fp(s), build, reset=False)
    assert calls["n"] == 1 and e.cursor == 0  # expired → rebuilt fresh
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_cursors.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'cursors'`.

- [ ] **Step 3: Implement `cursors.py`**

Create `langfs/cursors.py`:
```python
from __future__ import annotations

import hashlib
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

from sources.base import FileDescriptor


class ClientIdConflict(Exception):
    """client_id reused for a different owner or source."""


@dataclass
class Entry:
    owner: str
    fingerprint: str
    descriptors: list[FileDescriptor]
    cursor: int
    updated_at: float


class CursorStore:
    def __init__(self, ttl_seconds: int, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._ttl = ttl_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[str, Entry] = {}

    @staticmethod
    def fingerprint(owner: str, provider: str, path: str, types: list[str] | None) -> str:
        norm_path = os.path.normpath(path)
        norm_types = ",".join(sorted(types or []))
        raw = "\x00".join([owner, provider, norm_path, norm_types])
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def _expired(self, e: Entry) -> bool:
        return (self._clock() - e.updated_at) > self._ttl

    def get_or_create(
        self,
        client_id: str,
        owner: str,
        fingerprint: str,
        build: Callable[[], list[FileDescriptor]],
        reset: bool,
    ) -> Entry:
        with self._lock:
            e = self._entries.get(client_id)
            if e is not None and self._expired(e):
                e = None
            if e is not None and not reset:
                if e.owner != owner or e.fingerprint != fingerprint:
                    raise ClientIdConflict(
                        f"client_id '{client_id}' already in use for a different owner/source"
                    )
                e.updated_at = self._clock()
                return e
            # missing, expired, or reset → (re)build
            entry = Entry(
                owner=owner,
                fingerprint=fingerprint,
                descriptors=build(),
                cursor=0,
                updated_at=self._clock(),
            )
            self._entries[client_id] = entry
            return entry

    def advance(self, client_id: str) -> None:
        with self._lock:
            e = self._entries.get(client_id)
            if e is not None:
                e.cursor += 1
                e.updated_at = self._clock()

    def reset(self, client_id: str) -> None:
        with self._lock:
            self._entries.pop(client_id, None)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_cursors.py -v`
Expected: PASS (6 passed).

- [ ] **Step 5: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add cursors.py tests/test_cursors.py
git commit -m "feat(langfs): per-client cursor store with owner+fingerprint verification + TTL"
```

---

### Task 7: Tool handlers (list_providers / read_next / reset)

**Files:**
- Create: `langfs/handlers.py`
- Test: `langfs/tests/test_handlers.py`

**Interfaces:**
- Consumes: `sources.registry` (`providers_payload`), `sources.base` (`BlobSource`, `PathOutsideRoot`), `cursors` (`CursorStore`, `ClientIdConflict`), `parsing.types.suffixes_for`, `parsing.extract` (`extract_text`, `UnsupportedType`).
- Produces a `Handlers` class holding `registry` + `store`, with pure dict-in/dict-out methods:
  - `list_providers(args: dict) -> dict` → `{"providers": [...]}`.
  - `read_next(args: dict, owner: str) -> dict` → one of:
    - success: `{"index", "count", "source", "name", "format", "content", "done": False}`
    - exhausted: `{"index", "count", "done": True}`
    - per-file error: `{"index", "count", "source", "error": True, "message", "done": False}` (cursor still advanced)
    - conflict: `{"error": True, "code": "client_id_conflict", "message"}`
    - bad provider/args: `{"error": True, "code": "...", "message"}`
  - `reset(args: dict) -> dict` → `{"reset": True}`.
  - `owner` is supplied by the server layer (Task 8) from the request; tests pass it directly.

- [ ] **Step 1: Write the failing test**

Create `langfs/tests/test_handlers.py`:
```python
import pytest
from config import AppConfig
from sources.registry import build_registry
from cursors import CursorStore
from handlers import Handlers


@pytest.fixture
def tree(tmp_path):
    (tmp_path / "a.txt").write_text("alpha")
    (tmp_path / "b.txt").write_text("bravo")
    sub = tmp_path / "sub"
    sub.mkdir()
    (sub / "c.txt").write_text("charlie")
    return tmp_path


@pytest.fixture
def H(tree):
    cfg = AppConfig(allowed_roots=[str(tree)])
    return Handlers(build_registry(cfg), CursorStore(ttl_seconds=100))


def test_list_providers(H):
    out = H.list_providers({})
    assert [p["name"] for p in out["providers"]] == ["local"]


def test_read_next_walks_all_then_done(H, tree):
    args = {"provider": "local", "path": str(tree), "client_id": "u:r1"}
    seen = []
    for _ in range(3):
        r = H.read_next(dict(args), owner="u")
        assert r["done"] is False
        seen.append(r["content"])
    assert sorted(seen) == ["alpha", "bravo", "charlie"]
    last = H.read_next(dict(args), owner="u")
    assert last["done"] is True
    assert "content" not in last


def test_read_next_index_and_count(H, tree):
    args = {"provider": "local", "path": str(tree), "client_id": "u:r2"}
    r = H.read_next(dict(args), owner="u")
    assert r["index"] == 0 and r["count"] == 3 and r["format"] == "text"


def test_read_next_per_client_cursor(H, tree):
    a = {"provider": "local", "path": str(tree), "client_id": "u:A"}
    b = {"provider": "local", "path": str(tree), "client_id": "u:B"}
    H.read_next(dict(a), owner="u")            # A advances to 1
    rb = H.read_next(dict(b), owner="u")       # B independent, starts at 0
    assert rb["index"] == 0


def test_read_next_type_filter(H, tree):
    (tree / "d.pdf").write_bytes(b"%PDF-1.4")
    args = {"provider": "local", "path": str(tree), "client_id": "u:r3", "types": ["text"]}
    r = H.read_next(dict(args), owner="u")
    assert r["count"] == 3  # only .txt counted


def test_read_next_unknown_provider(H, tree):
    r = H.read_next({"provider": "s3", "path": str(tree), "client_id": "u:r4"}, owner="u")
    assert r["error"] is True and r["code"] == "unknown_provider"


def test_read_next_conflict(H, tree):
    a = {"provider": "local", "path": str(tree), "client_id": "u:r5"}
    H.read_next(dict(a), owner="u")
    other = {"provider": "local", "path": str(tree / "sub"), "client_id": "u:r5"}
    r = H.read_next(dict(other), owner="u")
    assert r["error"] is True and r["code"] == "client_id_conflict"


def test_read_next_reset_restarts(H, tree):
    args = {"provider": "local", "path": str(tree), "client_id": "u:r6"}
    H.read_next(dict(args), owner="u")
    H.read_next(dict(args), owner="u")
    r = H.read_next({**args, "reset": True}, owner="u")
    assert r["index"] == 0


def test_read_next_base64(H, tree):
    import base64
    args = {"provider": "local", "path": str(tree / "a.txt"),
            "client_id": "u:r7", "format": "base64"}
    r = H.read_next(dict(args), owner="u")
    assert base64.b64decode(r["content"]) == b"alpha"


def test_read_next_path_outside_root(H, tmp_path):
    outside = tmp_path.parent / "elsewhere"
    r = H.read_next({"provider": "local", "path": str(outside), "client_id": "u:r8"}, owner="u")
    assert r["error"] is True and r["code"] == "path_outside_root"


def test_reset_tool(H, tree):
    assert H.reset({"client_id": "anything"}) == {"reset": True}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_handlers.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'handlers'`.

- [ ] **Step 3: Implement `handlers.py`**

Create `langfs/handlers.py`:
```python
from __future__ import annotations

import base64

from cursors import ClientIdConflict, CursorStore
from parsing.extract import UnsupportedType, extract_text
from parsing.types import suffixes_for
from sources.base import BlobSource, PathOutsideRoot
from sources.registry import providers_payload


class Handlers:
    def __init__(self, registry: dict[str, BlobSource], store: CursorStore) -> None:
        self.registry = registry
        self.store = store

    def list_providers(self, args: dict) -> dict:
        return {"providers": providers_payload(self.registry)}

    def reset(self, args: dict) -> dict:
        self.store.reset(str(args.get("client_id", "")))
        return {"reset": True}

    def read_next(self, args: dict, owner: str) -> dict:
        provider = str(args.get("provider", ""))
        path = str(args.get("path", ""))
        client_id = str(args.get("client_id", ""))
        types = args.get("types") or None
        fmt = str(args.get("format", "text"))
        reset = bool(args.get("reset", False))

        source = self.registry.get(provider)
        if source is None:
            return {"error": True, "code": "unknown_provider",
                    "message": f"unknown provider '{provider}'"}
        if not client_id:
            return {"error": True, "code": "missing_client_id",
                    "message": "client_id is required"}

        suffixes = suffixes_for(types)
        fingerprint = self.store.fingerprint(owner, provider, path, types)

        try:
            entry = self.store.get_or_create(
                client_id, owner, fingerprint,
                build=lambda: source.enumerate(path, suffixes),
                reset=reset,
            )
        except ClientIdConflict as e:
            return {"error": True, "code": "client_id_conflict", "message": str(e)}
        except PathOutsideRoot as e:
            return {"error": True, "code": "path_outside_root", "message": str(e)}

        count = len(entry.descriptors)
        idx = entry.cursor
        if idx >= count:
            return {"index": idx, "count": count, "done": True}

        desc = entry.descriptors[idx]
        self.store.advance(client_id)  # advance regardless, so a bad file can't stall

        try:
            data = source.read_bytes(desc.id)
            if fmt == "base64":
                content = base64.b64encode(data).decode("ascii")
            else:
                content = extract_text(desc.name, data)
        except (UnsupportedType, PathOutsideRoot, Exception) as e:  # noqa: BLE001
            return {"index": idx, "count": count, "source": desc.id,
                    "error": True, "message": str(e), "done": False}

        return {"index": idx, "count": count, "source": desc.id, "name": desc.name,
                "format": fmt, "content": content, "done": False}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_handlers.py -v`
Expected: PASS (11 passed).

- [ ] **Step 5: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add handlers.py tests/test_handlers.py
git commit -m "feat(langfs): tool handlers — list_providers, read_next, reset"
```

---

### Task 8: MCP JSON-RPC server (FastAPI) + envelope

**Files:**
- Create: `langfs/server.py`
- Test: `langfs/tests/test_server_http.py`

**Interfaces:**
- Consumes: `config.AppConfig`, `sources.registry.build_registry`, `cursors.CursorStore`, `handlers.Handlers`.
- Produces:
  - `create_app(cfg: AppConfig) -> FastAPI` — POST `/` handles JSON-RPC `initialize`, `tools/list`, `tools/call`, `ping`, and the `notifications/*` no-ops. `tools/call` dispatches by tool name to `Handlers` and wraps the returned dict as `{"content":[{"type":"text","text": json.dumps(payload)}]}`. Owner is derived from the `Authorization` header (sha256 of the bearer token; empty string when absent).
  - `main()` — `uvicorn.run` using `AppConfig.from_env()`.
- The TOOLS list (name + JSON input schema) is defined here for `tools/list` discovery.

- [ ] **Step 1: Write the failing test**

Create `langfs/tests/test_server_http.py`:
```python
import json
import pytest
from fastapi.testclient import TestClient
from config import AppConfig
from server import create_app


@pytest.fixture
def client(tmp_path):
    (tmp_path / "a.txt").write_text("alpha")
    (tmp_path / "b.txt").write_text("bravo")
    cfg = AppConfig(allowed_roots=[str(tmp_path)])
    return TestClient(create_app(cfg)), tmp_path


def rpc(method, params=None, id=1):
    return {"jsonrpc": "2.0", "id": id, "method": method, "params": params or {}}


def _payload(resp):
    """Unwrap the MCP content envelope back to the handler's dict."""
    body = resp.json()
    text = body["result"]["content"][0]["text"]
    return json.loads(text)


def test_tools_list_advertises_three_tools(client):
    c, _ = client
    body = c.post("/", json=rpc("tools/list")).json()
    names = {t["name"] for t in body["result"]["tools"]}
    assert names == {"list_providers", "read_next", "reset"}


def test_initialize_ok(client):
    c, _ = client
    body = c.post("/", json=rpc("initialize")).json()
    assert body["result"]["serverInfo"]["name"] == "langfs"


def test_tools_call_list_providers(client):
    c, _ = client
    resp = c.post("/", json=rpc("tools/call",
                  {"name": "list_providers", "arguments": {}}))
    payload = _payload(resp)
    assert payload["providers"][0]["name"] == "local"


def test_tools_call_read_next_returns_text(client):
    c, tree = client
    args = {"provider": "local", "path": str(tree), "client_id": "u:r1"}
    payload = _payload(c.post("/", json=rpc("tools/call",
                       {"name": "read_next", "arguments": args})))
    assert payload["content"] in ("alpha", "bravo")
    assert payload["count"] == 2 and payload["done"] is False


def test_tools_call_unknown_tool_is_jsonrpc_error(client):
    c, _ = client
    body = c.post("/", json=rpc("tools/call",
                  {"name": "nope", "arguments": {}})).json()
    assert "error" in body and body["error"]["code"] == -32601


def test_ping_ok(client):
    c, _ = client
    body = c.post("/", json=rpc("ping")).json()
    assert body["result"] == {}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_server_http.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'server'`.

- [ ] **Step 3: Implement `server.py`**

Create `langfs/server.py`:
```python
from __future__ import annotations

import hashlib
import json

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from config import AppConfig
from cursors import CursorStore
from handlers import Handlers
from sources.registry import build_registry

PROTOCOL_VERSION = "2025-06-18"

TOOLS = [
    {
        "name": "list_providers",
        "description": "List available blob/text providers.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "read_next",
        "description": (
            "Return the next document for this client's recursive enumeration of "
            "(provider, path, types), advancing a server-held per-client cursor. "
            "Returns extracted text by default (base64 fallback). done=true when exhausted."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "provider": {"type": "string", "description": "Provider name, e.g. 'local'."},
                "path": {"type": "string", "description": "Root folder or single file."},
                "client_id": {"type": "string", "description": "Caller-named id, e.g. '{userId}:{runId}'."},
                "types": {"type": "array", "items": {"type": "string"},
                          "description": "Doc-type filter: pdf,word,text,csv,html. Empty = all."},
                "format": {"type": "string", "enum": ["text", "base64"], "description": "Default 'text'."},
                "reset": {"type": "boolean", "description": "Re-enumerate from item 0."},
            },
            "required": ["provider", "path", "client_id"],
        },
    },
    {
        "name": "reset",
        "description": "Drop a client's enumeration cursor.",
        "inputSchema": {
            "type": "object",
            "properties": {"client_id": {"type": "string"}},
            "required": ["client_id"],
        },
    },
]


def _owner_from_request(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if not auth:
        return ""
    return hashlib.sha256(auth.encode("utf-8")).hexdigest()


def _wrap(payload: dict) -> dict:
    """Wrap a handler payload in the MCP text-content envelope gpt expects."""
    return {"content": [{"type": "text", "text": json.dumps(payload)}]}


def create_app(cfg: AppConfig) -> FastAPI:
    app = FastAPI(title="langfs")
    handlers = Handlers(build_registry(cfg), CursorStore(cfg.cursor_ttl_seconds))

    def ok(req_id, result):
        return JSONResponse({"jsonrpc": "2.0", "id": req_id, "result": result})

    def err(req_id, code, message):
        return JSONResponse(
            {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}
        )

    @app.post("/")
    async def rpc(request: Request):
        body = await request.json()
        req_id = body.get("id")
        method = body.get("method")
        params = body.get("params") or {}

        if method == "initialize":
            return ok(req_id, {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "langfs", "version": "0.1.0"},
            })
        if method in ("notifications/initialized", "notifications/cancelled"):
            return JSONResponse({"jsonrpc": "2.0", "id": req_id, "result": {}})
        if method == "ping":
            return ok(req_id, {})
        if method == "tools/list":
            return ok(req_id, {"tools": TOOLS})
        if method == "tools/call":
            name = params.get("name")
            args = params.get("arguments") or {}
            if name == "list_providers":
                return ok(req_id, _wrap(handlers.list_providers(args)))
            if name == "read_next":
                owner = _owner_from_request(request)
                return ok(req_id, _wrap(handlers.read_next(args, owner)))
            if name == "reset":
                return ok(req_id, _wrap(handlers.reset(args)))
            return err(req_id, -32601, f"unknown tool '{name}'")

        return err(req_id, -32601, f"unknown method '{method}'")

    return app


def main() -> None:  # pragma: no cover
    import uvicorn

    cfg = AppConfig.from_env()
    uvicorn.run(create_app(cfg), host=cfg.host, port=cfg.port)


if __name__ == "__main__":  # pragma: no cover
    main()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_server_http.py -v`
Expected: PASS (6 passed).

- [ ] **Step 5: Run the full suite**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest -v`
Expected: PASS (all tasks' tests green).

- [ ] **Step 6: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add server.py tests/test_server_http.py
git commit -m "feat(langfs): MCP JSON-RPC server (initialize/tools/list/tools/call) + envelope"
```

---

### Task 9: Live smoke test against a running server

**Files:**
- Create: `langfs/tests/smoke.sh`

**Interfaces:**
- Consumes: the running `server.py`. No new code interfaces.

- [ ] **Step 1: Create a sample tree + smoke script**

Create `langfs/tests/smoke.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(mktemp -d)"
printf 'hello alpha' > "$ROOT/a.txt"
mkdir -p "$ROOT/sub"
printf 'deep charlie' > "$ROOT/sub/c.txt"

LANGFS_ROOTS="$ROOT" ../.venv/bin/python ../server.py &
SRV=$!
sleep 2
trap 'kill $SRV' EXIT

echo "--- list_providers ---"
curl -s localhost:8077/ -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_providers","arguments":{}}}'
echo; echo "--- read_next #1 ---"
curl -s localhost:8077/ -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"read_next\",\"arguments\":{\"provider\":\"local\",\"path\":\"$ROOT\",\"client_id\":\"u:smoke\"}}}"
echo; echo "--- read_next #2 ---"
curl -s localhost:8077/ -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"read_next\",\"arguments\":{\"provider\":\"local\",\"path\":\"$ROOT\",\"client_id\":\"u:smoke\"}}}"
echo; echo "--- read_next #3 (expect done) ---"
curl -s localhost:8077/ -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"read_next\",\"arguments\":{\"provider\":\"local\",\"path\":\"$ROOT\",\"client_id\":\"u:smoke\"}}}"
echo
```

- [ ] **Step 2: Run the smoke test**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs/tests && chmod +x smoke.sh && ./smoke.sh`
Expected output (order of the two files may vary):
- list_providers → content text contains `"name": "local"`.
- read_next #1 and #2 → `"content"` of `hello alpha` and `deep charlie`, `"count": 2`, `"done": false`.
- read_next #3 → `"done": true`, no `content`.

- [ ] **Step 3: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add tests/smoke.sh
git commit -m "test(langfs): live JSON-RPC smoke script"
```

---

## Follow-up (separate plan, NOT in this plan)

**gpt integration.** Register `langfs` as the ingestion read MCP server and refactor `IngestionLoader`/`IngestionController::readRound` from the PHP-held `list_files`/`read_file` cursor to calling `read_next(provider, path, types, client_id)` with `client_id = {userId}:{runId}`. Back the loader-form provider dropdown with `list_providers`. Remove the now-dead PHP recursion + text-path `decode()`. This is its own spec → plan → implementation cycle; it touches gpt PHP and is independently reviewable.

---

## Self-Review

**Spec coverage:**
- §1.1 encapsulate LangChain blob loaders → Task 4 (`FileSystemBlobLoader`, `Blob`). ✓
- §1.2 text preferred / blob fallback → Task 3 + Task 7 (`format` text/base64). ✓
- §1.3 server holds cursor, one doc per call → Task 6 + Task 7 (`read_next`). ✓
- §1.4 provider name is a parameter → Task 7/8 (`provider` arg, schema `required`). ✓
- §1.5 per-client cursor → Task 6 (`client_id` keyed), Task 7 (`test_read_next_per_client_cursor`). ✓
- §1.6 read-only → Task 4 (`BlobSource` has only enumerate/read_bytes), Global Constraints. ✓
- §1.7 list_providers → Task 5 + Task 7 + Task 8. ✓
- §5.1/5.2/5.3 tool contract → Task 7/8 (schemas + handlers). ✓
- §6 client identity + collision (owner+fingerprint, reset override, TTL rebuild) → Task 6 tests. ✓
- §7 enumeration semantics (recursive flatten, files only, dotfiles excluded) → Task 4 `test_enumerate_recursive_flatten_files_only`. ✓
- §8 doc-type filter → Task 2 + Task 4 `test_enumerate_type_filter`. ✓
- §9 text extraction (pdf/docx/html/txt/csv) → Task 3. ✓
- §10 read-only guarantee → Task 4 protocol surface. ✓
- §12 error handling (unknown provider, conflict, path traversal, per-file error) → Task 7 tests. ✓
- §14 testing (unit + live round-trip) → Tasks 1-9. ✓
- MCP envelope (`result.content[0].text`) → Task 8 `_payload` unwrap test. ✓

**Placeholder scan:** none — every step has full code/commands.

**Type consistency:** `FileDescriptor(id,name)` used identically in Tasks 4/6/7. `CursorStore.get_or_create/advance/reset/fingerprint` signatures match between Task 6 definition and Task 7 use. `Handlers.read_next(args, owner)` signature matches between Task 7 and Task 8 call site. Envelope `_wrap` matches the unwrap in Task 8's test. ✓

**Deviation noted:** spec §9 named `MimeTypeBasedParser`; the plan uses a suffix-dispatched extractor instead because `Blob.from_path` yields `mimetype=None` and the LangChain docx parser pulls in `unstructured`. Enumeration and byte-reading still go through LangChain (`FileSystemBlobLoader` + `Blob`), preserving "encapsulate LangChain blob loaders." This is a faithful, lighter implementation of the same behavior.
