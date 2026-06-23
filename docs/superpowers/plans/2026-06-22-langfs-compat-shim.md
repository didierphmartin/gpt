# langfs compat-shim + default package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give langfs the two stateless tools gpt's existing loader speaks (`list_files` + `read_file`, **text-out**) and ship all **10** provider descriptors (the "default package"), so the gpt loader can enumerate + read `local` files through langfs and list every provider.

**Architecture:** `list_files`/`read_file` are thin handlers routing to the existing `BlobSource.enumerate`/`read_bytes` + `extract_text`, returned through the existing `_wrap` envelope. Six descriptor-only providers are added; the registry marks any provider without a source implementation `available: false` and skips it from the functional registry instead of raising.

**Tech Stack:** Python 3.11+, FastAPI, existing langfs modules (`handlers.py`, `server.py`, `sources/registry.py`, `parsing/extract.py`, `descriptors.py`), pytest.

**Spec:** `docs/superpowers/specs/2026-06-22-langfs-ingestion-integration-design.md` §3.

## Global Constraints

- **Project:** `/Applications/XAMPP/xamppfiles/htdocs/langfs/` (its own git repo, `master`). Tests: `./.venv/bin/python -m pytest`; `pyproject.toml` sets `pythonpath=["."]`; output must stay **pristine**.
- **Stateless shim:** `list_files`/`read_file` take **no** `client_id`/cursor — gpt's `readRound` keeps owning the cursor (same as UniversalFS today). Do NOT touch `read_next`/the session store.
- **Read format:** `read_file` returns extracted **text** by default; `format="base64"` returns base64 of raw bytes.
- **Envelope (unchanged):** every tool result is wrapped `{"content":[{"type":"text","text": json.dumps(payload)}]}` via the existing `_wrap`. `list_files` payload = `{"files":[...]}`; `read_file` payload = `{"content": <text>, "format": <fmt>}`; errors = `{"error": true, "code"?, "message"}`. (gpt `json_decode`s the text.)
- **Functional providers (verbatim):** `local`, `s3`, `gcs`, `azure`. The 6 new (`drive`, `onedrive`, `sharepoint`, `dropbox`, `box`, `github`) are **descriptor-only**, `available: false`, not in the functional registry.
- **`enumerate` returns a tuple** `(list[FileDescriptor], truncated)` (from the §23 fix) — unpack it.
- **Descriptor required fields:** `name, label, kind, description, enumerable, recursive, scope_schema, auth_method, credential_fields, default_formats, pip_packages, system_deps`. `kind` ∈ `{object_store, drive, web, knowledge_store}`; `auth_method` ∈ `{none, api_key, connection_string, oauth2, service_account_json}`; `name` must equal the filename.

---

## File Structure

```
langfs/
  providers/                 # + 6 descriptor JSON files
    drive.json onedrive.json sharepoint.json dropbox.json box.json github.json
  sources/registry.py        # _available → false for non-source providers  (modify)
  handlers.py                # + list_files() and read_file()                (modify)
  server.py                  # + list_files/read_file in TOOLS + dispatch    (modify)
  tests/
    test_registry.py         # 10 listed, 4 functional                       (modify)
    test_handlers.py         # list_files/read_file behavior                 (modify)
    test_server_http.py      # tools/list shows 6 tools; call shim tools     (modify)
```

---

### Task 1: Default package — 6 descriptors + registry tolerates descriptor-only

**Files:**
- Create: `langfs/providers/drive.json`, `onedrive.json`, `sharepoint.json`, `dropbox.json`, `box.json`, `github.json`
- Modify: `langfs/sources/registry.py`
- Modify: `langfs/tests/test_registry.py`

**Interfaces:**
- Consumes: `descriptors.load_descriptors`, `config.AppConfig`.
- Produces: `providers_payload(cfg)` returns **10** entries (the 6 new with `available: false`); `build_registry(cfg)` contains only the 4 functional providers and does **not** raise on the descriptor-only ones.

- [ ] **Step 1: Write the failing test**

Edit `langfs/tests/test_registry.py` — add:
```python
def test_payload_lists_all_ten_providers(tmp_path):
    payload = {p["name"]: p for p in providers_payload(AppConfig(allowed_roots=[str(tmp_path)]))}
    assert set(payload) == {"local", "s3", "gcs", "azure",
                            "drive", "onedrive", "sharepoint", "dropbox", "box", "github"}
    # the six not-yet-implemented providers are listed but unavailable
    for name in ("drive", "onedrive", "sharepoint", "dropbox", "box", "github"):
        assert payload[name]["available"] is False
    assert payload["local"]["available"] is True


def test_registry_builds_only_functional(tmp_path):
    reg = build_registry(AppConfig(allowed_roots=[str(tmp_path)]))
    assert set(reg) == {"local", "s3", "gcs", "azure"}  # descriptor-only skipped, no raise
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_registry.py -v`
Expected: FAIL — either the 6 descriptors don't exist (payload set mismatch) or `build_registry` raises `ValueError: no source implementation for provider 'drive'`.

- [ ] **Step 3: Create the 6 descriptor files**

Create `langfs/providers/drive.json`:
```json
{
  "name": "drive", "label": "Google Drive", "kind": "drive",
  "description": "Google Drive (not yet available — Phase 2)",
  "enumerable": true, "recursive": true,
  "scope_schema": {"fields": [{"name": "folder_id", "label": "Folder ID", "required": false}]},
  "auth_method": "oauth2",
  "credential_fields": [{"name": "oauth_token", "label": "OAuth token", "type": "oauth", "required": true}],
  "default_formats": ["pdf", "word", "text", "csv", "html"],
  "pip_packages": ["langchain-googledrive"], "system_deps": false
}
```
Create `langfs/providers/onedrive.json`:
```json
{
  "name": "onedrive", "label": "OneDrive", "kind": "drive",
  "description": "Microsoft OneDrive (not yet available — Phase 2)",
  "enumerable": true, "recursive": true,
  "scope_schema": {"fields": [{"name": "folder_id", "label": "Folder ID / path", "required": false}]},
  "auth_method": "oauth2",
  "credential_fields": [{"name": "oauth_token", "label": "OAuth token", "type": "oauth", "required": true}],
  "default_formats": ["pdf", "word", "text", "csv", "html"],
  "pip_packages": ["o365"], "system_deps": false
}
```
Create `langfs/providers/sharepoint.json`:
```json
{
  "name": "sharepoint", "label": "SharePoint", "kind": "drive",
  "description": "Microsoft SharePoint (not yet available — Phase 2)",
  "enumerable": true, "recursive": true,
  "scope_schema": {"fields": [{"name": "document_library", "label": "Document library / folder", "required": false}]},
  "auth_method": "oauth2",
  "credential_fields": [{"name": "oauth_token", "label": "OAuth token", "type": "oauth", "required": true}],
  "default_formats": ["pdf", "word", "text", "csv", "html"],
  "pip_packages": ["o365"], "system_deps": false
}
```
Create `langfs/providers/dropbox.json`:
```json
{
  "name": "dropbox", "label": "Dropbox", "kind": "drive",
  "description": "Dropbox (not yet available — Phase 3)",
  "enumerable": true, "recursive": true,
  "scope_schema": {"fields": [{"name": "path", "label": "Folder path", "required": false}]},
  "auth_method": "api_key",
  "credential_fields": [{"name": "access_token", "label": "Access token", "type": "password", "required": true, "mask": true}],
  "default_formats": ["pdf", "word", "text", "csv", "html"],
  "pip_packages": ["dropbox"], "system_deps": false
}
```
Create `langfs/providers/box.json`:
```json
{
  "name": "box", "label": "Box", "kind": "drive",
  "description": "Box (not yet available — Phase 3)",
  "enumerable": true, "recursive": true,
  "scope_schema": {"fields": [{"name": "folder_id", "label": "Folder ID", "required": false}]},
  "auth_method": "oauth2",
  "credential_fields": [{"name": "oauth_token", "label": "OAuth token", "type": "oauth", "required": true}],
  "default_formats": ["pdf", "word", "text", "csv", "html"],
  "pip_packages": ["langchain-box"], "system_deps": false
}
```
Create `langfs/providers/github.json`:
```json
{
  "name": "github", "label": "GitHub / Git", "kind": "knowledge_store",
  "description": "GitHub repository files (not yet available — Phase 3)",
  "enumerable": true, "recursive": true,
  "scope_schema": {"fields": [
    {"name": "repo", "label": "owner/repo", "required": true},
    {"name": "branch", "label": "Branch", "required": false}]},
  "auth_method": "api_key",
  "credential_fields": [{"name": "token", "label": "Access token (blank for public)", "type": "password", "required": false, "mask": true}],
  "default_formats": ["pdf", "word", "text", "csv", "html"],
  "pip_packages": ["PyGithub"], "system_deps": false
}
```

- [ ] **Step 4: Update `_available` in `sources/registry.py`**

Replace the `_CLOUD` constant + `_available` function with:
```python
_CLOUD = {"s3", "gcs", "azure"}
_FUNCTIONAL = {"local"} | _CLOUD  # providers that have a source implementation


def _available(desc: ProviderDescriptor) -> bool:
    if desc.name not in _FUNCTIONAL:
        return False  # descriptor-only (default package, source lands in a later phase)
    if desc.name in _CLOUD:
        return importlib.util.find_spec("cloudpathlib") is not None
    return True  # local
```
`build_registry` already filters by `_available`, so descriptor-only providers are skipped before reaching `_build_one` — no `ValueError`. Leave `build_registry`, `providers_payload`, and `_build_one` unchanged.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_registry.py tests/test_descriptors.py -v`
Expected: PASS (the new tests + existing registry/descriptor tests; the 6 new descriptors load + validate).

- [ ] **Step 6: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add providers/ sources/registry.py tests/test_registry.py
git commit -m "feat(langfs): default package — 6 descriptor-only providers; registry tolerates them (10 listed, 4 functional)"
```

---

### Task 2: Compat-shim tools — `list_files` + `read_file` (text-out)

**Files:**
- Modify: `langfs/handlers.py`
- Modify: `langfs/server.py`
- Modify: `langfs/tests/test_handlers.py`
- Modify: `langfs/tests/test_server_http.py`

**Interfaces:**
- Consumes: `Handlers.registry` (sources), `sources.base.PathOutsideRoot`, `parsing.types.suffixes_for`, `parsing.extract.extract_text`, `base64`.
- Produces (on `Handlers`):
  - `list_files(args: dict) -> dict` — `args {provider, path, types?}` → `{"files":[{"id","name","type":"file"}]}` or `{"error":true,"code"?,"message"}`.
  - `read_file(args: dict) -> dict` — `args {provider, file_id, format?}` → `{"content": <text|base64>, "format": <fmt>}` or `{"error":true,"code"?,"message"}`.
- `server.py` `TOOLS` gains `list_files` + `read_file`; `tools/call` dispatches both through `_wrap`.

- [ ] **Step 1: Write the failing test (handlers)**

Edit `langfs/tests/test_handlers.py` — add (the `H` fixture builds `Handlers(AppConfig(allowed_roots=[str(tree)]))`, and `tree` has `a.txt`="alpha", `b.txt`="bravo", `sub/c.txt`="charlie"):
```python
def test_list_files_local_recursive(H, tree):
    out = H.list_files({"provider": "local", "path": str(tree)})
    names = sorted(f["name"] for f in out["files"])
    assert names == ["a.txt", "b.txt", "c.txt"]          # recursive, files only
    assert all(f["type"] == "file" for f in out["files"])


def test_list_files_unknown_provider(H, tree):
    out = H.list_files({"provider": "drive", "path": str(tree)})
    assert out["error"] is True and out["code"] == "unknown_provider"


def test_list_files_path_outside_root(H, tmp_path):
    out = H.list_files({"provider": "local", "path": str(tmp_path.parent / "nope")})
    assert out["error"] is True and out["code"] == "path_outside_root"


def test_read_file_text(H, tree):
    out = H.read_file({"provider": "local", "file_id": str(tree / "a.txt")})
    assert out == {"content": "alpha", "format": "text"}


def test_read_file_base64(H, tree):
    import base64
    out = H.read_file({"provider": "local", "file_id": str(tree / "a.txt"), "format": "base64"})
    assert base64.b64decode(out["content"]) == b"alpha" and out["format"] == "base64"


def test_read_file_unknown_provider(H, tree):
    out = H.read_file({"provider": "drive", "file_id": "x"})
    assert out["error"] is True and out["code"] == "unknown_provider"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_handlers.py -v`
Expected: FAIL with `AttributeError: 'Handlers' object has no attribute 'list_files'`.

- [ ] **Step 3: Implement `list_files` + `read_file` in `handlers.py`**

Add these two methods to the `Handlers` class (alongside `list_providers`/`read_next`/`test_connection`):
```python
    def list_files(self, args: dict) -> dict:
        source = self.registry.get(str(args.get("provider", "")))
        if source is None:
            return {"error": True, "code": "unknown_provider", "message": "unknown provider"}
        path = str(args.get("path", ""))
        suffixes = suffixes_for(args.get("types") or None)
        try:
            conn = source.connect(args.get("credentials") or {})
            descriptors, _truncated = source.enumerate(conn, {"path": path}, suffixes)
        except PathOutsideRoot as e:
            return {"error": True, "code": "path_outside_root", "message": str(e)}
        return {"files": [{"id": d.id, "name": d.name, "type": "file"} for d in descriptors]}

    def read_file(self, args: dict) -> dict:
        source = self.registry.get(str(args.get("provider", "")))
        if source is None:
            return {"error": True, "code": "unknown_provider", "message": "unknown provider"}
        file_id = str(args.get("file_id", ""))
        fmt = str(args.get("format", "text"))
        try:
            conn = source.connect(args.get("credentials") or {})
            data = source.read_bytes(conn, file_id)
            if fmt == "base64":
                content = base64.b64encode(data).decode("ascii")
            else:
                name = file_id.rsplit("/", 1)[-1]
                content = extract_text(name, data)
        except PathOutsideRoot as e:
            return {"error": True, "code": "path_outside_root", "message": str(e)}
        except Exception as e:  # noqa: BLE001 — surface parse/read failure as a tool error
            return {"error": True, "message": str(e)}
        return {"content": content, "format": fmt}
```
(`base64`, `suffixes_for`, `extract_text`, `PathOutsideRoot` are already imported at the top of `handlers.py`.)

- [ ] **Step 4: Run handler test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_handlers.py -v`
Expected: PASS (the 6 new tests + existing).

- [ ] **Step 5: Write the failing server test**

Edit `langfs/tests/test_server_http.py` — update the tool-count test and add a shim round-trip:
```python
def test_tools_list_advertises_six_tools(client):
    c, _ = client
    body = c.post("/", json=rpc("tools/list")).json()
    names = {t["name"] for t in body["result"]["tools"]}
    assert names == {"list_providers", "read_next", "reset", "test_connection",
                     "list_files", "read_file"}


def test_tools_call_list_then_read_file(client):
    c, tree = client          # fixture writes a.txt="alpha", b.txt="bravo"
    listed = _payload(c.post("/", json=rpc("tools/call",
        {"name": "list_files", "arguments": {"provider": "local", "path": str(tree)}})))
    ids = sorted(f["id"] for f in listed["files"])
    got = _payload(c.post("/", json=rpc("tools/call",
        {"name": "read_file", "arguments": {"provider": "local", "file_id": ids[0]}})))
    assert got["format"] == "text" and got["content"] in ("alpha", "bravo")
```
(If a prior test named `test_tools_list_advertises_four_tools` exists, replace it with the six-tool version above.)

- [ ] **Step 6: Run server test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_server_http.py -v`
Expected: FAIL — tool set is missing `list_files`/`read_file`; `tools/call` for them hits the unknown-tool `-32601`.

- [ ] **Step 7: Add the tools to `server.py`**

In `server.py`, append two entries to the `TOOLS` list:
```python
    {
        "name": "list_files",
        "description": "Enumerate files under a path for a provider (recursive, files only). Stateless.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "provider": {"type": "string"},
                "path": {"type": "string"},
                "types": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["provider", "path"],
        },
    },
    {
        "name": "read_file",
        "description": "Read one file's extracted text (or base64 raw bytes). Stateless.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "provider": {"type": "string"},
                "file_id": {"type": "string"},
                "format": {"type": "string", "enum": ["text", "base64"]},
            },
            "required": ["provider", "file_id"],
        },
    },
```
And in the `tools/call` dispatch (after the `test_connection` branch, before the unknown-tool `err`):
```python
            if name == "list_files":
                return ok(req_id, _wrap(handlers.list_files(args)))
            if name == "read_file":
                return ok(req_id, _wrap(handlers.read_file(args)))
```

- [ ] **Step 8: Run the focused test, then the FULL suite**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_server_http.py -v`
Expected: PASS.
Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest -v`
Expected: ALL pass, output PRISTINE.

- [ ] **Step 9: Live curl check against the running pattern**

Run:
```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
ROOT=$(mktemp -d); printf 'hello shim' > "$ROOT/x.txt"
LANGFS_ROOTS="$ROOT" ./.venv/bin/python server.py & SRV=$!; sleep 2; trap "kill $SRV" EXIT
curl -s localhost:8077/mcp -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"list_files\",\"arguments\":{\"provider\":\"local\",\"path\":\"$ROOT\"}}}"
echo
curl -s localhost:8077/mcp -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"read_file\",\"arguments\":{\"provider\":\"local\",\"file_id\":\"$ROOT/x.txt\"}}}"
echo
```
Expected: `list_files` → content text is `{"files":[{"id":"…/x.txt","name":"x.txt","type":"file"}]}`; `read_file` → content text is `{"content":"hello shim","format":"text"}`.

- [ ] **Step 10: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add handlers.py server.py tests/test_handlers.py tests/test_server_http.py
git commit -m "feat(langfs): compat-shim tools list_files + read_file (text-out) for gpt loader"
```

---

## Follow-up (separate plan, NOT in this plan)

**gpt loader wiring** (spec §4): render the loader's provider list from `list_providers` (10 providers, `local` enabled / 9 disabled), point the storage MCP + `buildLoaderClosures` at langfs, and switch the `read_file` closure to consume text (`json_decode` → `content`) so `decode()` becomes a passthrough. gpt JS/PHP — its own spec→plan cycle.

## Self-Review

**Spec coverage (§3):**
- §3.1 compat-shim `list_files`/`read_file` text-out → Task 2. ✓
- §3.2 six default-package descriptors → Task 1 (6 JSON, `available:false`). ✓
- §3.3 registry tolerates descriptor-only (no raise) → Task 1 (`_available` → false for non-`_FUNCTIONAL`). ✓
- Envelope uniform via `_wrap`; gpt `json_decode`s → Task 2 payload shapes. ✓
- Stateless (no cursor) → Task 2 (no client_id). ✓
- 10 listed / 4 functional → Task 1 tests. ✓

**Placeholder scan:** none — full JSON + code + commands in every step. `pip_packages` on the 6 descriptors are real package names documenting the future dependency (not placeholders; unused while `available:false`).

**Type consistency:** `list_files`→`{"files":[{id,name,type}]}` and `read_file`→`{"content","format"}` defined in Task 2 interfaces, implemented in Step 3, asserted in Steps 1/5. `_FUNCTIONAL`/`_available` defined in Task 1 Step 4, exercised in Task 1 tests. `enumerate` tuple-unpack `(descriptors, _truncated)` matches the post-§23 signature. `_wrap` dispatch matches the existing pattern (Steps 7). ✓
