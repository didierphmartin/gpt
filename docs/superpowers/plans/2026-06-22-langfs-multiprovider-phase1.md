# langfs multi-provider extension — Phase 1 (server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the shipped single-provider (local filesystem) langfs MCP server into a **descriptor-driven multi-storage** server — JSON descriptors define each provider's credential/scope/format schema, the session store holds a **reused authenticated connection** per client, and a new `CloudBlobSource` reaches **S3, GCS, and Azure** through one adapter — plus a `test_connection` tool.

**Architecture:** One JSON descriptor per provider (`providers/*.json`) is loaded + validated at startup and becomes the data `list_providers` returns. The Part I cursor store becomes a **session store** whose entry also carries `credentials` + a live `connection` built once by `source.connect(credentials)` and closed on eviction. `CloudBlobSource` builds a per-session cloudpathlib client, binds a `CloudPath` to it, and feeds that to LangChain's `CloudBlobLoader` (no global default-client mutation, so concurrent sessions with different creds are safe). Storage and format stay orthogonal: bytes flow into the existing `parsing/extract.py`.

**Tech Stack:** Python 3.11+, FastAPI, `langchain-community` (`CloudBlobLoader`/`FileSystemBlobLoader`), `cloudpathlib[s3,gs,azure]` (+ `boto3`, `google-cloud-storage`, `azure-storage-blob`), existing `pypdf`/`docx2txt`/`beautifulsoup4`, pytest.

**Spec:** `docs/superpowers/specs/2026-06-20-langfs-blob-mcp-design.md` — Part II (§§17–25).

## Global Constraints

- **Project:** `/Applications/XAMPP/xamppfiles/htdocs/langfs/` (its own git repo, branch `master`). Run tests with `./.venv/bin/python -m pytest`. `pyproject.toml` sets `pythonpath=["."]`; output must stay **pristine** (zero warnings — the message-scoped `filterwarnings` are already configured).
- **Deployment context:** LAN / single enterprise, NOT public. Holding credentials in server memory for a session is acceptable; do NOT add TLS/secret-vault/zero-trust machinery.
- **Read-only charter:** `BlobSource` exposes only `connect` / `test_connection` / `enumerate` / `read_bytes`. No write/move/rename/delete anywhere.
- **MCP envelope:** every `tools/call` result is wrapped `{"content":[{"type":"text","text": json.dumps(payload)}]}`; application outcomes are payload fields; JSON-RPC `error` (-32601) only for unknown method/tool. (Unchanged from Part I `server.py`.)
- **Connection reuse:** authenticate ONCE per session; reuse the connection for every `read_next`; close on TTL/reset. Never re-login per call.
- **Format = UI default, not enforced:** `default_formats` only pre-checks UI boxes; server skips a file only when no extractor exists (`extract_text` raises `UnsupportedType`).
- **Phase 1 providers (verbatim):** `local` (done), `s3`, `gcs`, `azure`. S3/GCS/Azure are ONE `CloudBlobSource`. OAuth providers and package install-on-demand are out of scope (spec §25).
- **Provider descriptor fields (verbatim):** `name`, `label`, `kind` (`object_store`|`drive`|`web`|`knowledge_store`), `description`, `enumerable`, `recursive`, `scope_schema`, `auth_method` (`none`|`api_key`|`connection_string`|`oauth2`|`service_account_json`), `credential_fields[]`, `default_formats[]`, `pip_packages[]`, `system_deps`.
- **cloudpathlib client construction (verified):** S3 → `S3Client(aws_access_key_id, aws_secret_access_key, aws_session_token, endpoint_url, boto3_session)`; GCS → `GSClient(application_credentials, project)`; Azure → `AzureBlobClient(connection_string, account_url)`. A client-bound path is `client.CloudPath(url)`; `CloudBlobLoader(url=<CloudPath>, glob=...)` accepts that bound path.

---

## File Structure

```
langfs/
  requirements.txt          # + cloudpathlib[s3,gs,azure]            (modify)
  providers/                # NEW — one descriptor per provider
    local.json
    s3.json
    gcs.json
    azure.json
  descriptors.py            # NEW — ProviderDescriptor + load/validate
  sources/
    base.py                 # evolve BlobSource: connect/test_connection/scope  (modify)
    local.py                # new signatures; connect/test_connection no-ops     (modify)
    cloud.py                # NEW — CloudBlobSource (S3/GCS/Azure)
    registry.py             # build from descriptors; expand list_providers payload (modify)
  cursors.py                # session store: connection + close-on-evict + account-id fp (modify)
  handlers.py               # thread credentials/scope/connection; test_connection handler (modify)
  server.py                 # add test_connection tool + dispatch                 (modify)
  parsing/extract.py        # MIME-hint fallback dispatch                          (modify)
  tests/                    # one test file per task
```

---

### Task 1: Dependencies + provider descriptors (model, loader, JSON files)

**Files:**
- Modify: `langfs/requirements.txt`
- Create: `langfs/descriptors.py`
- Create: `langfs/providers/local.json`, `s3.json`, `gcs.json`, `azure.json`
- Test: `langfs/tests/test_descriptors.py`

**Interfaces:**
- Produces:
  - `descriptors.ProviderDescriptor` dataclass: `name:str, label:str, kind:str, description:str, enumerable:bool, recursive:bool, scope_schema:dict, auth_method:str, credential_fields:list[dict], default_formats:list[str], pip_packages:list[str], system_deps:bool`.
  - `descriptors.DescriptorError(Exception)`.
  - `descriptors.load_descriptors(dir_path:str) -> dict[str, ProviderDescriptor]` — read every `*.json`, validate, key by `name`; raise `DescriptorError` on a malformed/duplicate descriptor.

- [ ] **Step 1: Add dependencies**

Edit `langfs/requirements.txt` — add this line:
```
cloudpathlib[s3,gs,azure]>=0.18
```
Install: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/pip install -r requirements.txt`
Expected: installs `cloudpathlib`, `boto3`, `google-cloud-storage`, `azure-storage-blob` without error.

- [ ] **Step 2: Write the failing test**

Create `langfs/tests/test_descriptors.py`:
```python
import json
import pytest
from descriptors import load_descriptors, DescriptorError, ProviderDescriptor


def _write(d, name, obj):
    (d / f"{name}.json").write_text(json.dumps(obj))


def _valid(name="s3"):
    return {
        "name": name, "label": "Amazon S3", "kind": "object_store",
        "description": "x", "enumerable": True, "recursive": True,
        "scope_schema": {"fields": [{"name": "bucket", "label": "Bucket", "required": True}]},
        "auth_method": "api_key",
        "credential_fields": [{"name": "access_key", "label": "Key", "type": "text", "required": True}],
        "default_formats": ["pdf", "text"], "pip_packages": [], "system_deps": False,
    }


def test_loads_valid_descriptors(tmp_path):
    _write(tmp_path, "s3", _valid("s3"))
    _write(tmp_path, "local", {**_valid("local"), "auth_method": "none", "credential_fields": []})
    reg = load_descriptors(str(tmp_path))
    assert set(reg) == {"s3", "local"}
    assert isinstance(reg["s3"], ProviderDescriptor)
    assert reg["s3"].kind == "object_store"
    assert reg["local"].auth_method == "none"


def test_missing_required_field_raises(tmp_path):
    bad = _valid("s3"); del bad["auth_method"]
    _write(tmp_path, "s3", bad)
    with pytest.raises(DescriptorError):
        load_descriptors(str(tmp_path))


def test_bad_kind_raises(tmp_path):
    bad = _valid("s3"); bad["kind"] = "nonsense"
    _write(tmp_path, "s3", bad)
    with pytest.raises(DescriptorError):
        load_descriptors(str(tmp_path))


def test_name_must_match_filename(tmp_path):
    _write(tmp_path, "s3", _valid("DIFFERENT"))
    with pytest.raises(DescriptorError):
        load_descriptors(str(tmp_path))
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_descriptors.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'descriptors'`.

- [ ] **Step 4: Implement `descriptors.py`**

Create `langfs/descriptors.py`:
```python
from __future__ import annotations

import json
import os
from dataclasses import dataclass

VALID_KINDS = {"object_store", "drive", "web", "knowledge_store"}
VALID_AUTH = {"none", "api_key", "connection_string", "oauth2", "service_account_json"}

_REQUIRED = [
    "name", "label", "kind", "description", "enumerable", "recursive",
    "scope_schema", "auth_method", "credential_fields", "default_formats",
    "pip_packages", "system_deps",
]


class DescriptorError(Exception):
    """A provider descriptor is malformed."""


@dataclass
class ProviderDescriptor:
    name: str
    label: str
    kind: str
    description: str
    enumerable: bool
    recursive: bool
    scope_schema: dict
    auth_method: str
    credential_fields: list[dict]
    default_formats: list[str]
    pip_packages: list[str]
    system_deps: bool


def _validate(obj: dict, filename: str) -> ProviderDescriptor:
    missing = [k for k in _REQUIRED if k not in obj]
    if missing:
        raise DescriptorError(f"{filename}: missing fields {missing}")
    if obj["kind"] not in VALID_KINDS:
        raise DescriptorError(f"{filename}: invalid kind '{obj['kind']}'")
    if obj["auth_method"] not in VALID_AUTH:
        raise DescriptorError(f"{filename}: invalid auth_method '{obj['auth_method']}'")
    expected = os.path.splitext(os.path.basename(filename))[0]
    if obj["name"] != expected:
        raise DescriptorError(f"{filename}: name '{obj['name']}' must equal filename '{expected}'")
    return ProviderDescriptor(**{k: obj[k] for k in _REQUIRED})


def load_descriptors(dir_path: str) -> dict[str, ProviderDescriptor]:
    out: dict[str, ProviderDescriptor] = {}
    for fn in sorted(os.listdir(dir_path)):
        if not fn.endswith(".json"):
            continue
        path = os.path.join(dir_path, fn)
        try:
            obj = json.loads(open(path, encoding="utf-8").read())
        except json.JSONDecodeError as e:
            raise DescriptorError(f"{fn}: invalid JSON: {e}") from e
        desc = _validate(obj, fn)
        if desc.name in out:
            raise DescriptorError(f"duplicate provider name '{desc.name}'")
        out[desc.name] = desc
    return out
```

- [ ] **Step 5: Create the four descriptor JSON files**

Create `langfs/providers/local.json`:
```json
{
  "name": "local", "label": "Local filesystem", "kind": "object_store",
  "description": "Local filesystem via LangChain FileSystemBlobLoader",
  "enumerable": true, "recursive": true,
  "scope_schema": {"fields": [{"name": "path", "label": "Folder path", "required": true}]},
  "auth_method": "none", "credential_fields": [],
  "default_formats": ["pdf", "word", "text", "csv", "html"],
  "pip_packages": [], "system_deps": false
}
```

Create `langfs/providers/s3.json`:
```json
{
  "name": "s3", "label": "Amazon S3", "kind": "object_store",
  "description": "Amazon S3 via LangChain CloudBlobLoader (cloudpathlib)",
  "enumerable": true, "recursive": true,
  "scope_schema": {"fields": [
    {"name": "bucket", "label": "Bucket", "required": true},
    {"name": "prefix", "label": "Prefix (folder)", "required": false}]},
  "auth_method": "api_key",
  "credential_fields": [
    {"name": "access_key", "label": "Access key", "type": "text", "required": true},
    {"name": "secret_key", "label": "Secret key", "type": "password", "required": true, "mask": true},
    {"name": "region", "label": "Region", "type": "text", "required": false},
    {"name": "endpoint_url", "label": "Endpoint URL (S3-compatible)", "type": "text", "required": false}],
  "default_formats": ["pdf", "word", "text", "csv", "html"],
  "pip_packages": [], "system_deps": false
}
```

Create `langfs/providers/gcs.json`:
```json
{
  "name": "gcs", "label": "Google Cloud Storage", "kind": "object_store",
  "description": "Google Cloud Storage via LangChain CloudBlobLoader (cloudpathlib)",
  "enumerable": true, "recursive": true,
  "scope_schema": {"fields": [
    {"name": "bucket", "label": "Bucket", "required": true},
    {"name": "prefix", "label": "Prefix (folder)", "required": false}]},
  "auth_method": "service_account_json",
  "credential_fields": [
    {"name": "service_account_json", "label": "Service account JSON path", "type": "file", "required": true},
    {"name": "project", "label": "GCP project", "type": "text", "required": false}],
  "default_formats": ["pdf", "word", "text", "csv", "html"],
  "pip_packages": [], "system_deps": false
}
```

Create `langfs/providers/azure.json`:
```json
{
  "name": "azure", "label": "Azure Blob Storage", "kind": "object_store",
  "description": "Azure Blob Storage via LangChain CloudBlobLoader (cloudpathlib)",
  "enumerable": true, "recursive": true,
  "scope_schema": {"fields": [
    {"name": "bucket", "label": "Container", "required": true},
    {"name": "prefix", "label": "Prefix (folder)", "required": false}]},
  "auth_method": "connection_string",
  "credential_fields": [
    {"name": "connection_string", "label": "Connection string", "type": "password", "required": false, "mask": true},
    {"name": "account_url", "label": "Account URL", "type": "text", "required": false}],
  "default_formats": ["pdf", "word", "text", "csv", "html"],
  "pip_packages": [], "system_deps": false
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_descriptors.py -v`
Expected: PASS (4 passed).

- [ ] **Step 7: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add requirements.txt descriptors.py providers/ tests/test_descriptors.py
git commit -m "feat(langfs): provider descriptors — model, loader, 4 JSON files + cloudpathlib dep"
```

---

### Task 2: Evolve `BlobSource` interface + update `LocalBlobSource`

**Files:**
- Modify: `langfs/sources/base.py`
- Modify: `langfs/sources/local.py`
- Modify: `langfs/tests/test_local_source.py`

**Interfaces:**
- Consumes: `descriptors` (none directly), `parsing.types.suffixes_for`.
- Produces (the evolved protocol every source implements):
  - `base.BlobSource` Protocol: attrs `name, kind, description, requires_credentials`; methods
    - `connect(self, credentials: dict) -> object | None`
    - `test_connection(self, credentials: dict, scope: dict) -> dict` → `{"ok": bool, "message"?: str}`
    - `enumerate(self, connection, scope: dict, suffixes: list[str]) -> list[FileDescriptor]`
    - `read_bytes(self, connection, file_id: str) -> bytes`
  - `FileDescriptor` and `PathOutsideRoot` unchanged.
  - `LocalBlobSource` keeps `requires_credentials=False`; `connect` returns `None`; `test_connection` checks the scope path is under an allowed root; `enumerate`/`read_bytes` take (and ignore) the `connection` arg and read `scope["path"]`.

- [ ] **Step 1: Update the test first (drive the new signatures)**

Edit `langfs/tests/test_local_source.py`. Replace every `src.enumerate(str(tree), suffixes_for(...))` call with the new signature `src.enumerate(None, {"path": str(tree)}, suffixes_for(...))`, and `src.read_bytes(str(p))` with `src.read_bytes(None, str(p))`. Add these tests:
```python
def test_connect_is_noop(tree):
    assert LocalBlobSource([str(tree)]).connect({}) is None


def test_test_connection_ok_and_outside(tree):
    src = LocalBlobSource([str(tree)])
    assert src.test_connection({}, {"path": str(tree)})["ok"] is True
    bad = src.test_connection({}, {"path": str(tree.parent / "nope")})
    assert bad["ok"] is False
```
Keep the existing recursion/filter/uppercase/path-outside tests, updated to the new call signatures.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_local_source.py -v`
Expected: FAIL (TypeError on new signatures / missing `connect`).

- [ ] **Step 3: Update `sources/base.py`**

Replace the `BlobSource` protocol body with:
```python
@runtime_checkable
class BlobSource(Protocol):
    name: str
    kind: str
    description: str
    requires_credentials: bool

    def connect(self, credentials: dict) -> object | None: ...

    def test_connection(self, credentials: dict, scope: dict) -> dict: ...

    def enumerate(self, connection: object | None, scope: dict,
                  suffixes: list[str]) -> list["FileDescriptor"]: ...

    def read_bytes(self, connection: object | None, file_id: str) -> bytes: ...
```
(Keep the existing `FileDescriptor` dataclass and `PathOutsideRoot` exception unchanged.)

- [ ] **Step 4: Update `sources/local.py`**

Change `enumerate` and `read_bytes` to the new signatures and add `connect`/`test_connection`:
```python
    def connect(self, credentials: dict) -> None:
        return None

    def test_connection(self, credentials: dict, scope: dict) -> dict:
        try:
            self._check(scope.get("path", ""))
            return {"ok": True}
        except PathOutsideRoot as e:
            return {"ok": False, "message": str(e)}

    def enumerate(self, connection, scope: dict, suffixes: list[str]) -> list[FileDescriptor]:
        path = scope.get("path", "")
        target = self._check(path)
        # ... existing body unchanged from here (is_file branch + FileSystemBlobLoader walk + sort) ...

    def read_bytes(self, connection, file_id: str) -> bytes:
        target = self._check(file_id)
        return Blob.from_path(str(target)).as_bytes()
```
Keep `_check`, the recursive walk, the case-insensitive `.lower()` filter, and the `out.sort(key=lambda d: d.id)` exactly as they are. Update the module-level protocol assertion to still hold: `_: BlobSource = LocalBlobSource([])`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_local_source.py -v`
Expected: PASS (all, including the two new tests).

- [ ] **Step 6: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add sources/base.py sources/local.py tests/test_local_source.py
git commit -m "feat(langfs): evolve BlobSource (connect/test_connection/scope); update LocalBlobSource"
```

---

### Task 3: `CloudBlobSource` (S3 / GCS / Azure)

**Files:**
- Create: `langfs/sources/cloud.py`
- Test: `langfs/tests/test_cloud_source.py`

**Interfaces:**
- Consumes: `sources.base.BlobSource`/`FileDescriptor`, `cloudpathlib`, `CloudBlobLoader`.
- Produces: `cloud.CloudBlobSource(name, *, description="", max_files=10000)` implementing `BlobSource` for `name in {"s3","gcs","azure"}`. `requires_credentials=True`, `kind="object_store"`. `connect(credentials)` returns a cloudpathlib client; `enumerate` lists (capped, sorted, case-insensitive suffix filter) `FileDescriptor`s whose `id` is the full `scheme://…` URI; `read_bytes` reads via the client-bound `CloudPath`; `test_connection` builds a client and checks scope reachability.

- [ ] **Step 1: Write the failing test** (uses a fake client so no real cloud is needed)

Create `langfs/tests/test_cloud_source.py`:
```python
import pytest
from sources.cloud import CloudBlobSource
from sources.base import FileDescriptor


class FakeBlob:
    def __init__(self, path): self.path = path


def test_scope_url_s3():
    src = CloudBlobSource("s3")
    assert src._scope_url({"bucket": "b", "prefix": "docs/"}) == "s3://b/docs"
    assert src._scope_url({"bucket": "b"}) == "s3://b"


def test_scope_url_azure_scheme():
    assert CloudBlobSource("azure")._scope_url({"bucket": "c"}) == "az://c"


def test_enumerate_filters_sorts_and_caps(monkeypatch):
    src = CloudBlobSource("s3", max_files=2)
    blobs = [FakeBlob("s3://b/z.txt"), FakeBlob("s3://b/a.pdf"),
             FakeBlob("s3://b/skip.png"), FakeBlob("s3://b/c.txt")]
    monkeypatch.setattr("sources.cloud.CloudBlobLoader",
                        lambda url, glob: type("L", (), {"yield_blobs": lambda self: iter(blobs)})())
    # connection is a fake client whose CloudPath(url) just echoes the url
    conn = type("C", (), {"CloudPath": lambda self, u: u})()
    out = src.enumerate(conn, {"bucket": "b"}, [".pdf", ".txt"])
    ids = [d.id for d in out]
    assert ids == ["s3://b/a.pdf", "s3://b/c.txt"]  # png filtered, sorted, capped at 2


def test_unknown_provider_name_raises():
    with pytest.raises(KeyError):
        CloudBlobSource("dropbox")._scheme  # not in Phase 1 set
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_cloud_source.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'sources.cloud'`.

- [ ] **Step 3: Implement `sources/cloud.py`**

Create `langfs/sources/cloud.py`:
```python
from __future__ import annotations

from pathlib import PurePosixPath

from cloudpathlib import AzureBlobClient, GSClient, S3Client
from langchain_community.document_loaders.blob_loaders import CloudBlobLoader

from sources.base import BlobSource, FileDescriptor

_SCHEME = {"s3": "s3", "gcs": "gs", "azure": "az"}


class CloudBlobSource:
    kind = "object_store"
    requires_credentials = True

    def __init__(self, name: str, *, description: str = "", max_files: int = 10_000) -> None:
        self.name = name
        self.description = description or f"{name} via LangChain CloudBlobLoader"
        self._scheme = _SCHEME[name]          # KeyError for non-Phase-1 providers
        self._max_files = max_files

    def _make_client(self, credentials: dict):
        if self._scheme == "s3":
            boto3_session = None
            if credentials.get("region"):
                import boto3
                boto3_session = boto3.Session(region_name=credentials["region"])
            return S3Client(
                aws_access_key_id=credentials.get("access_key"),
                aws_secret_access_key=credentials.get("secret_key"),
                aws_session_token=credentials.get("session_token") or None,
                endpoint_url=credentials.get("endpoint_url") or None,
                boto3_session=boto3_session,
            )
        if self._scheme == "gs":
            return GSClient(
                application_credentials=credentials.get("service_account_json") or None,
                project=credentials.get("project") or None,
            )
        if self._scheme == "az":
            return AzureBlobClient(
                connection_string=credentials.get("connection_string") or None,
                account_url=credentials.get("account_url") or None,
            )
        raise ValueError(f"unsupported scheme {self._scheme}")

    def _scope_url(self, scope: dict) -> str:
        bucket = str(scope["bucket"]).strip("/")
        prefix = str(scope.get("prefix") or "").strip("/")
        return f"{self._scheme}://{bucket}/{prefix}" if prefix else f"{self._scheme}://{bucket}"

    def connect(self, credentials: dict):
        return self._make_client(credentials)

    def test_connection(self, credentials: dict, scope: dict) -> dict:
        try:
            client = self._make_client(credentials)
            client.CloudPath(self._scope_url(scope)).exists()
            return {"ok": True}
        except Exception as e:  # noqa: BLE001 — surface any auth/scope failure to the UI
            return {"ok": False, "message": str(e)}

    def enumerate(self, connection, scope: dict, suffixes: list[str]) -> list[FileDescriptor]:
        root = connection.CloudPath(self._scope_url(scope))
        loader = CloudBlobLoader(root, glob="**/[!.]*")
        out: list[FileDescriptor] = []
        for blob in loader.yield_blobs():            # paginates lazily under the hood
            uri = str(blob.path)
            name = PurePosixPath(uri).name
            if suffixes and PurePosixPath(name).suffix.lower() not in suffixes:
                continue
            out.append(FileDescriptor(id=uri, name=name))
            if len(out) >= self._max_files:
                break                                # cap honored — see read_round/log note
        out.sort(key=lambda d: d.id)
        return out

    def read_bytes(self, connection, file_id: str) -> bytes:
        return connection.CloudPath(file_id).read_bytes()


# Structural conformance check.
_: BlobSource = CloudBlobSource("s3")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_cloud_source.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add sources/cloud.py tests/test_cloud_source.py
git commit -m "feat(langfs): CloudBlobSource — S3/GCS/Azure via per-session client-bound CloudPath"
```

---

### Task 4: Registry from descriptors + expanded `list_providers` payload

**Files:**
- Modify: `langfs/sources/registry.py`
- Modify: `langfs/tests/test_registry.py`

**Interfaces:**
- Consumes: `descriptors.load_descriptors`/`ProviderDescriptor`, `config.AppConfig`, `sources.local.LocalBlobSource`, `sources.cloud.CloudBlobSource`.
- Produces:
  - `build_registry(cfg) -> dict[str, BlobSource]` — builds a source per loaded descriptor: `local` → `LocalBlobSource(cfg.allowed_roots)`; `s3`/`gcs`/`azure` → `CloudBlobSource(name)`. Uses `cfg.providers_dir` (default `<module dir>/providers`).
  - `providers_payload(cfg) -> list[dict]` — one entry per descriptor: `{name, label, kind, description, auth_method, credential_fields, scope_schema, default_formats, requires_credentials, available}`.
- Adds `AppConfig.providers_dir` (default the packaged `providers/` dir; env `LANGFS_PROVIDERS_DIR`).

- [ ] **Step 1: Add `providers_dir` to `config.py`**

In `langfs/config.py`, add field `providers_dir: str = ""` and in `from_env` default it to the packaged dir:
```python
        providers_dir=os.environ.get(
            "LANGFS_PROVIDERS_DIR",
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "providers"),
        ),
```
(Add `providers_dir` to the dataclass before fields with defaults are reordered — place it after `allowed_roots`.)

- [ ] **Step 2: Write the failing test**

Replace `langfs/tests/test_registry.py` with:
```python
from config import AppConfig
from sources.registry import build_registry, providers_payload
from sources.local import LocalBlobSource
from sources.cloud import CloudBlobSource


def _cfg(tmp_path):
    return AppConfig(allowed_roots=[str(tmp_path)])  # providers_dir defaults to packaged dir


def test_registry_builds_all_descriptor_providers(tmp_path):
    reg = build_registry(_cfg(tmp_path))
    assert set(reg) == {"local", "s3", "gcs", "azure"}
    assert isinstance(reg["local"], LocalBlobSource)
    assert isinstance(reg["s3"], CloudBlobSource)


def test_payload_carries_schema_for_ui(tmp_path):
    payload = {p["name"]: p for p in providers_payload(_cfg(tmp_path))}
    s3 = payload["s3"]
    assert s3["auth_method"] == "api_key"
    assert any(f["name"] == "access_key" for f in s3["credential_fields"])
    assert s3["scope_schema"]["fields"][0]["name"] == "bucket"
    assert s3["requires_credentials"] is True
    assert payload["local"]["requires_credentials"] is False
    assert s3["available"] is True  # cloudpathlib installed
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_registry.py -v`
Expected: FAIL (build_registry signature / payload keys differ).

- [ ] **Step 4: Implement `sources/registry.py`**

Replace `langfs/sources/registry.py`:
```python
from __future__ import annotations

import importlib.util

from config import AppConfig
from descriptors import ProviderDescriptor, load_descriptors
from sources.base import BlobSource
from sources.cloud import CloudBlobSource
from sources.local import LocalBlobSource

_CLOUD = {"s3", "gcs", "azure"}


def _available(desc: ProviderDescriptor) -> bool:
    # Phase 1 cloud providers all ride cloudpathlib; local needs nothing.
    if desc.name in _CLOUD:
        return importlib.util.find_spec("cloudpathlib") is not None
    return True


def _build_one(desc: ProviderDescriptor, cfg: AppConfig) -> BlobSource:
    if desc.name == "local":
        return LocalBlobSource(cfg.allowed_roots)
    if desc.name in _CLOUD:
        return CloudBlobSource(desc.name, description=desc.description)
    raise ValueError(f"no source implementation for provider '{desc.name}'")


def build_registry(cfg: AppConfig) -> dict[str, BlobSource]:
    descs = load_descriptors(cfg.providers_dir)
    return {name: _build_one(d, cfg) for name, d in descs.items() if _available(d)}


def providers_payload(cfg: AppConfig) -> list[dict]:
    descs = load_descriptors(cfg.providers_dir)
    out = []
    for d in descs.values():
        out.append({
            "name": d.name, "label": d.label, "kind": d.kind, "description": d.description,
            "auth_method": d.auth_method, "credential_fields": d.credential_fields,
            "scope_schema": d.scope_schema, "default_formats": d.default_formats,
            "requires_credentials": d.auth_method != "none",
            "available": _available(d),
        })
    return out
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_registry.py tests/test_config.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add config.py sources/registry.py tests/test_registry.py
git commit -m "feat(langfs): build registry from descriptors; list_providers payload carries UI schema"
```

---

### Task 5: MIME-hint fallback in `extract_text`

**Files:**
- Modify: `langfs/parsing/extract.py`
- Modify: `langfs/tests/test_extract.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `extract_text(name: str, data: bytes, mime: str | None = None) -> str` — unchanged suffix dispatch first; if the name has no usable suffix and `mime` is given, map common MIME types to an extractor (`application/pdf`→pdf, `…wordprocessingml.document`→docx, `text/html`→html, `text/plain`/`text/csv`→plain). Still raises `UnsupportedType` when neither suffix nor mime resolves.

- [ ] **Step 1: Add failing tests**

Append to `langfs/tests/test_extract.py`:
```python
def test_mime_used_when_no_suffix():
    assert extract_text("noext", b"hello", mime="text/plain") == "hello"
    assert "Hi" in extract_text("page", b"<p>Hi</p>", mime="text/html")


def test_mime_ignored_when_suffix_present():
    # suffix wins; a .txt with an html mime is still treated as text
    assert extract_text("a.txt", b"<p>x</p>", mime="text/html") == "<p>x</p>"


def test_no_suffix_no_mime_raises():
    with pytest.raises(UnsupportedType):
        extract_text("noext", b"data")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_extract.py -v`
Expected: FAIL (extract_text takes no `mime` kwarg).

- [ ] **Step 3: Update `parsing/extract.py`**

Add the MIME map and extend `extract_text`:
```python
_MIME_SUFFIX = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "text/html": ".html",
    "text/plain": ".txt",
    "text/csv": ".csv",
}


def extract_text(name: str, data: bytes, mime: str | None = None) -> str:
    suffix = _suffix(name)
    fn = _DISPATCH.get(suffix)
    if fn is None and mime:
        fn = _DISPATCH.get(_MIME_SUFFIX.get(mime, ""))
    if fn is None:
        raise UnsupportedType(f"no text extractor for '{name}' (mime={mime})")
    return fn(data)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_extract.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add parsing/extract.py tests/test_extract.py
git commit -m "feat(langfs): MIME-hint fallback in extract_text for extension-less items"
```

---

### Task 6: Session store — credentials + reused connection + close-on-evict + account-id fingerprint

**Files:**
- Modify: `langfs/cursors.py`
- Modify: `langfs/tests/test_cursors.py`

**Interfaces:**
- Consumes: `sources.base.FileDescriptor`.
- Produces (evolved `CursorStore`):
  - `Entry` gains `connection: object | None`.
  - `fingerprint(owner, provider, path, types, account=")")` — extra `account` (a non-secret id: bucket/account/drive) folded into the hash. Existing callers default `account=""` (behavior unchanged for local).
  - `get_or_create(client_id, owner, fingerprint, build, reset)` where `build() -> tuple[object | None, list[FileDescriptor]]` returns `(connection, descriptors)`; the entry stores both.
  - `CursorStore(ttl_seconds, *, clock=..., close_fn: Callable[[object], None] | None = None)` — `close_fn(connection)` is invoked when an entry is evicted (TTL), replaced (reset/conflict-override), or dropped (`reset`).
  - `advance`/`reset` unchanged except `reset` now closes the connection.

- [ ] **Step 1: Write failing tests**

Add to `langfs/tests/test_cursors.py`:
```python
def test_build_returns_connection_and_descriptors():
    closed = []
    s = CursorStore(ttl_seconds=100, close_fn=lambda c: closed.append(c))
    e = s.get_or_create("c1", "u", s.fingerprint("u", "s3", "/x", None, account="bkt"),
                        lambda: ("CONN", descs(2)), reset=False)
    assert e.connection == "CONN" and len(e.descriptors) == 2


def test_reset_closes_connection():
    closed = []
    s = CursorStore(ttl_seconds=100, close_fn=lambda c: closed.append(c))
    s.get_or_create("c1", "u", s.fingerprint("u", "s3", "/x", None),
                    lambda: ("CONN", descs(1)), reset=False)
    s.reset("c1")
    assert closed == ["CONN"]


def test_ttl_eviction_closes_old_connection():
    t = {"now": 0.0}; closed = []
    s = CursorStore(ttl_seconds=10, clock=lambda: t["now"], close_fn=lambda c: closed.append(c))
    s.get_or_create("c1", "u", s.fingerprint("u", "s3", "/x", None),
                    lambda: ("OLD", descs(1)), reset=False)
    t["now"] = 100.0
    s.get_or_create("c1", "u", s.fingerprint("u", "s3", "/x", None),
                    lambda: ("NEW", descs(1)), reset=False)
    assert closed == ["OLD"]


def test_account_in_fingerprint_distinguishes():
    s = CursorStore(ttl_seconds=100)
    assert s.fingerprint("u", "s3", "/x", None, account="a") != s.fingerprint("u", "s3", "/x", None, account="b")
```
Update the existing `test_cursors.py` helper calls so the `build` callbacks return a 2-tuple `(None, descs(n))` instead of just `descs(n)` (e.g. `lambda: (None, descs(3))`), and `fingerprint(...)` calls still work with the new optional `account` arg.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_cursors.py -v`
Expected: FAIL (Entry has no `connection`; build returns wrong shape; close_fn unknown).

- [ ] **Step 3: Update `cursors.py`**

- Add `connection: object | None = None` to `Entry`.
- `fingerprint` signature → `def fingerprint(owner, provider, path, types, account: str = "") -> str:` and include `account` in the hashed `raw` list.
- `__init__` → accept `close_fn: Callable[[object], None] | None = None`; store it.
- Add a private `_close(self, entry)` that calls `self._close_fn(entry.connection)` when both are set (guard exceptions: wrap in try/except, ignore close errors).
- In `get_or_create`: when an existing entry is expired, call `self._close(existing)` before discarding; when rebuilding due to `reset` over an existing entry, `self._close(existing)` first. `build()` now returns `(connection, descriptors)`; set both on the new `Entry`.
- In `reset(client_id)`: pop the entry and `self._close(entry)` if present.

Concretely, the rebuild block becomes:
```python
            e = self._entries.get(client_id)
            if e is not None and self._expired(e):
                self._close(e); e = None
            if e is not None and not reset:
                if e.owner != owner or e.fingerprint != fingerprint:
                    raise ClientIdConflict(...)
                e.updated_at = self._clock(); return e
            if e is not None:           # reset over an existing entry
                self._close(e)
            connection, descriptors = build()
            entry = Entry(owner=owner, fingerprint=fingerprint, connection=connection,
                          descriptors=descriptors, cursor=0, updated_at=self._clock())
            self._entries[client_id] = entry
            return entry
```
and `reset`:
```python
    def reset(self, client_id: str) -> None:
        with self._lock:
            e = self._entries.pop(client_id, None)
            if e is not None:
                self._close(e)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_cursors.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add cursors.py tests/test_cursors.py
git commit -m "feat(langfs): session store — reused connection, close-on-evict, account-id fingerprint"
```

---

### Task 7: Handlers — thread credentials/scope/connection + `test_connection`

**Files:**
- Modify: `langfs/handlers.py`
- Modify: `langfs/tests/test_handlers.py`

**Interfaces:**
- Consumes: evolved `sources` + `CursorStore` (build returns `(connection, descriptors)`), `parsing.extract.extract_text`.
- Produces (evolved `Handlers`):
  - Constructor `Handlers(cfg)` builds `registry = build_registry(cfg)` and `store = CursorStore(cfg.cursor_ttl_seconds, close_fn=_close_connection)`.
  - `list_providers(args) -> {"providers": providers_payload(cfg)}`.
  - `read_next(args, owner)` — args now include `credentials: dict` and `scope: dict` (replacing the bare `path`); flow: resolve provider; require `client_id`; compute fingerprint with a **non-secret account id** derived from scope (`scope.get("bucket") or scope.get("path") or ""`); `get_or_create(build = lambda: (source.connect(credentials), source.enumerate(<conn>, scope, suffixes)))` — note the connection must be built first, then passed to `enumerate`; serve `descriptors[cursor]`, advance, read via the session connection, extract text (pass `mime=None` for now). Same return shapes as Part I §5.2.
  - `test_connection(args) -> source.test_connection(credentials, scope)` (or `{"error": True, "code": "unknown_provider"}`).
  - `reset(args)` unchanged.

- [ ] **Step 1: Update tests**

Rewrite `langfs/tests/test_handlers.py` so the fixture is `Handlers(AppConfig(allowed_roots=[str(tree)]))` and `read_next` calls pass `scope` + `credentials` instead of `path`:
```python
def test_read_next_walks_all_then_done(H, tree):
    args = {"provider": "local", "scope": {"path": str(tree)}, "credentials": {}, "client_id": "u:r1"}
    ...
```
Keep all Part I assertions (walk-all-then-done, per-client cursor, type filter, base64, unknown provider, conflict, reset, path-outside-root via `scope`), updated to the new arg shape. Add:
```python
def test_test_connection_local_ok_and_bad(H, tree):
    ok = H.test_connection({"provider": "local", "scope": {"path": str(tree)}, "credentials": {}})
    assert ok["ok"] is True
    bad = H.test_connection({"provider": "local", "scope": {"path": str(tree.parent / "no")}, "credentials": {}})
    assert bad["ok"] is False

def test_connection_built_once_per_session(H, tree, monkeypatch):
    calls = {"n": 0}
    src = H.registry["local"]
    orig = src.connect
    monkeypatch.setattr(src, "connect", lambda creds: (calls.__setitem__("n", calls["n"] + 1), orig(creds))[1])
    a = {"provider": "local", "scope": {"path": str(tree)}, "credentials": {}, "client_id": "u:r9"}
    H.read_next(dict(a), owner="u"); H.read_next(dict(a), owner="u")
    assert calls["n"] == 1  # connect called once, reused
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_handlers.py -v`
Expected: FAIL (Handlers ctor + read_next arg shape changed).

- [ ] **Step 3: Update `handlers.py`**

```python
from __future__ import annotations

import base64

from config import AppConfig
from cursors import ClientIdConflict, CursorStore
from parsing.extract import UnsupportedType, extract_text  # noqa: F401 (UnsupportedType used in except)
from parsing.types import suffixes_for
from sources.base import PathOutsideRoot
from sources.registry import build_registry, providers_payload


def _close_connection(conn) -> None:
    close = getattr(conn, "close", None)
    if callable(close):
        try:
            close()
        except Exception:  # noqa: BLE001 — best-effort cleanup
            pass


class Handlers:
    def __init__(self, cfg: AppConfig) -> None:
        self.cfg = cfg
        self.registry = build_registry(cfg)
        self.store = CursorStore(cfg.cursor_ttl_seconds, close_fn=_close_connection)

    def list_providers(self, args: dict) -> dict:
        return {"providers": providers_payload(self.cfg)}

    def reset(self, args: dict) -> dict:
        self.store.reset(str(args.get("client_id", "")))
        return {"reset": True}

    def test_connection(self, args: dict) -> dict:
        source = self.registry.get(str(args.get("provider", "")))
        if source is None:
            return {"error": True, "code": "unknown_provider", "message": "unknown provider"}
        return source.test_connection(args.get("credentials") or {}, args.get("scope") or {})

    def read_next(self, args: dict, owner: str) -> dict:
        provider = str(args.get("provider", ""))
        scope = args.get("scope") or {}
        credentials = args.get("credentials") or {}
        client_id = str(args.get("client_id", ""))
        types = args.get("types") or None
        fmt = str(args.get("format", "text"))
        reset = bool(args.get("reset", False))

        source = self.registry.get(provider)
        if source is None:
            return {"error": True, "code": "unknown_provider", "message": f"unknown provider '{provider}'"}
        if not client_id:
            return {"error": True, "code": "missing_client_id", "message": "client_id is required"}

        suffixes = suffixes_for(types)
        account = str(scope.get("bucket") or scope.get("path") or "")
        fingerprint = self.store.fingerprint(owner, provider, account, types, account=account)

        def build():
            conn = source.connect(credentials)
            return conn, source.enumerate(conn, scope, suffixes)

        try:
            entry = self.store.get_or_create(client_id, owner, fingerprint, build=build, reset=reset)
        except ClientIdConflict as e:
            return {"error": True, "code": "client_id_conflict", "message": str(e)}
        except PathOutsideRoot as e:
            return {"error": True, "code": "path_outside_root", "message": str(e)}

        count = len(entry.descriptors)
        idx = entry.cursor
        if idx >= count:
            return {"index": idx, "count": count, "done": True}

        desc = entry.descriptors[idx]
        self.store.advance(client_id)
        try:
            data = source.read_bytes(entry.connection, desc.id)
            content = base64.b64encode(data).decode("ascii") if fmt == "base64" else extract_text(desc.name, data)
        except Exception as e:  # noqa: BLE001 — one bad file must not stall the run
            return {"index": idx, "count": count, "source": desc.id,
                    "error": True, "message": str(e), "done": False}
        return {"index": idx, "count": count, "source": desc.id, "name": desc.name,
                "format": fmt, "content": content, "done": False}
```
Note: `PathOutsideRoot` raised inside `build()` (local `enumerate`) surfaces through `get_or_create`; the `read_bytes` failure path stays the catch-all per-file error (Part I behavior).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_handlers.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add handlers.py tests/test_handlers.py
git commit -m "feat(langfs): handlers thread credentials/scope + reuse connection + test_connection"
```

---

### Task 8: Server — `test_connection` tool + ctor change + full suite

**Files:**
- Modify: `langfs/server.py`
- Modify: `langfs/tests/test_server_http.py`

**Interfaces:**
- Consumes: `Handlers(cfg)` (new ctor), `AppConfig`.
- Produces: `create_app(cfg)` builds `Handlers(cfg)`; `TOOLS` gains a `test_connection` entry; `tools/call` dispatches `test_connection` through `_wrap`. `read_next`/`reset`/`list_providers` dispatch unchanged (envelope identical).

- [ ] **Step 1: Update tests**

In `langfs/tests/test_server_http.py`: the `client` fixture must build `create_app(AppConfig(allowed_roots=[str(tmp_path)]))` (providers_dir defaults to packaged). Update `test_tools_list_advertises_*` to expect `{"list_providers","read_next","reset","test_connection"}`. Update the `read_next` HTTP test to pass `scope`/`credentials`. Add:
```python
def test_tools_call_test_connection(client):
    c, tree = client
    payload = _payload(c.post("/", json=rpc("tools/call", {
        "name": "test_connection",
        "arguments": {"provider": "local", "scope": {"path": str(tree)}, "credentials": {}}})))
    assert payload["ok"] is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_server_http.py -v`
Expected: FAIL (4-tool list / ctor / arg shape).

- [ ] **Step 3: Update `server.py`**

- `create_app`: `handlers = Handlers(cfg)` (drop the old `build_registry`/`CursorStore` wiring — `Handlers` owns it now).
- Add to `TOOLS`:
```python
    {
        "name": "test_connection",
        "description": "Validate a provider's credentials + scope before a run.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "provider": {"type": "string"},
                "credentials": {"type": "object"},
                "scope": {"type": "object"},
            },
            "required": ["provider"],
        },
    },
```
- In the `tools/call` dispatch, add before the unknown-tool fallthrough:
```python
            if name == "test_connection":
                return ok(req_id, _wrap(handlers.test_connection(args)))
```
- Update the `read_next` tool's `inputSchema` `properties`: replace `path` with `scope` (`{"type": "object"}`) and add `credentials` (`{"type": "object"}`); `required` becomes `["provider", "scope", "client_id"]`.

- [ ] **Step 4: Run the focused test, then the FULL suite**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest tests/test_server_http.py -v`
Expected: PASS.
Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs && ./.venv/bin/python -m pytest -v`
Expected: ALL pass, output PRISTINE (zero warnings).

- [ ] **Step 5: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add server.py tests/test_server_http.py
git commit -m "feat(langfs): add test_connection MCP tool; Handlers(cfg) ctor; scope/credentials in read_next schema"
```

---

### Task 9: Live cloud smoke (S3, creds-permitting) + README

**Files:**
- Create: `langfs/tests/smoke_cloud.sh`
- Modify: `langfs/README.md`

**Interfaces:** Consumes the running server. No new code interfaces.

- [ ] **Step 1: Document the providers + add a guarded cloud smoke script**

Add a "Providers" section to `README.md` listing local + s3/gcs/azure, the `LANGFS_PROVIDERS_DIR` env, and that cloud providers need `cloudpathlib` extras (already in requirements). Note credentials are entered per-session (loader-node form) and held for the session.

Create `langfs/tests/smoke_cloud.sh` that **skips with a clear message unless** `LANGFS_SMOKE_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` are set; when set, it boots the server and runs `test_connection` then two `read_next` calls against `s3://$LANGFS_SMOKE_S3_BUCKET` with a `client_id`, asserting `ok:true` and text content. (Mirror `smoke.sh`'s start/trap/curl structure.)

- [ ] **Step 2: Run it**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/langfs/tests && ./smoke_cloud.sh`
Expected (no creds): prints "SKIP — set LANGFS_SMOKE_S3_BUCKET + AWS creds to run" and exits 0.
Expected (creds set): `test_connection` → `ok:true`; `read_next` → text content with a working cursor.

- [ ] **Step 3: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/langfs
git add tests/smoke_cloud.sh README.md
git commit -m "test(langfs): guarded S3 live smoke + README providers section"
```

---

## Follow-up (separate plans, NOT in this plan)

- **gpt loader-node UI (Phase 1 integration):** render the loader node's form dynamically from `list_providers` (credential fields + scope fields + pre-checked default formats), call `test_connection`, and drive `read_next` with `{provider, scope, credentials, client_id={userId}:{runId}}`. gpt-side JS/PHP (`frontend/assets/js/workflow-editor.js` + loader node config) — its own spec→plan cycle.
- **Phase 2 (OAuth: Drive/OneDrive)** and **Phase 3 (install-from-allowlist + long tail)** per spec §25.

## Self-Review

**Spec coverage (Part II §§17–25):**
- §18 descriptor JSON (all fields) → Task 1 (model + 4 files). ✓
- §19 `list_providers` grows → Task 4 (`providers_payload`). §19.1 catalog (local/s3/gcs/azure Phase 1) → Tasks 1+4. ✓
- §20 session store (connection reuse, close-on-evict, account-id fingerprint) → Task 6. ✓
- §21 `BlobSource` connect/test_connection + `CloudBlobSource` + `test_connection` tool → Tasks 2, 3, 7, 8. ✓
- §22 scope (descriptor-driven) + format UI-default-not-enforced → Tasks 2/3/7 (scope), extract_text skip-only-when-no-extractor preserved. ✓
- §23 pagination/caps (`max_files`) → Task 3; MIME detection → Task 5; URI provenance (`id = scheme://…`) → Task 3. ✓
- §24 testing (descriptor validate, CloudBlobSource mocked, connection reuse, test_connection, pagination cap, MIME, fingerprint conflict, live S3) → Tasks 1,3,6,7,8,9. ✓
- §25 forward-compat (OAuth/install) → out of scope, noted in Follow-up. ✓
- §17 LAN context → Global Constraints (no extra security machinery). ✓

**Placeholder scan:** none — every step has concrete code/commands. The descriptor `pip_packages`/`system_deps` fields are empty/false intentionally (Phase-1 packages pre-installed; install story is Phase 3), not placeholders.

**Type consistency:** `FileDescriptor(id,name)` consistent across Tasks 2/3/6/7. `BlobSource.{connect,test_connection,enumerate(connection,scope,suffixes),read_bytes(connection,file_id)}` defined in Task 2, implemented in Tasks 2 (local) and 3 (cloud), consumed in Task 7. `CursorStore.fingerprint(...,account="")`, `get_or_create(build→(connection,descriptors))`, `close_fn` defined in Task 6, used in Task 7. `providers_payload(cfg)` (Task 4) consumed by `Handlers.list_providers` (Task 7) and server (Task 8). `extract_text(name,data,mime=None)` (Task 5) called by handlers (Task 7, mime=None for now). Envelope `_wrap` unchanged (Task 8). ✓

**Deviation note:** spec §21 says "`CloudBlobSource` wraps `CloudBlobLoader`." Verified detail added to the plan: credentials are injected by passing a **client-bound `CloudPath`** (`client.CloudPath(url)`) to `CloudBlobLoader` (which accepts an `AnyPath`), since `CloudBlobLoader` has no client/credentials parameter and a global default client would break concurrent multi-session use. Faithful to the spec, just the concrete mechanism.
