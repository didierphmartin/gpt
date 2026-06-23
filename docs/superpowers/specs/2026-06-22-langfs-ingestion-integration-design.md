# langfs ↔ gpt ingestion integration (design)

- **Date:** 2026-06-22
- **Status:** Approved direction; spec for implementation.
- **Branch context:** `feat/rag-ingestion-full` (gpt); langfs on its own `master`.

## 1. Summary

Wire the gpt ingestion **loader node** to the **langfs** MCP server so files are
enumerated and read through langfs instead of UniversalFS. Scope of this cut:
the **file-system (`local`) provider works end-to-end**, and the loader's
provider list shows **all 10 providers** (the langfs "default package"), with the
other 9 visible but disabled ("coming soon"). Text comes back already extracted.

This is the **Path A (compat-shim)** integration: langfs exposes the stateless
`list_files` / `read_file` tools gpt's existing loader already speaks, so gpt's
ingestion machinery (preview stepper, run, compile) keeps working with minimal
change. langfs's `read_next` / session-store / `test_connection` (already built)
stay in place for the later cloud phase.

Context: langfs is already built, running (`http://127.0.0.1:8077/`), and
**registered + connected** in gpt (tools discovered). The loader UI is still the
original (UniversalFS storage + hard-coded `local/gdrive/s3/onedrive`); this spec
adapts it.

## 2. Decisions (settled)

- **Path A — compat shim.** langfs adds stateless `list_files` + `read_file`.
- **Read format: text-out.** `read_file` returns extracted **text**; gpt's PHP
  `decode()` becomes a passthrough for langfs sources (starts retiring it).
  `format="base64"` remains for raw bytes.
- **Functional set: `local` only** this cut. The other 9 are listed but disabled.
- **Default package: 10 descriptors.** langfs ships all 10; `list_providers`
  drives the UI list. `available` flags which are usable.
- **Provider list is dynamic** from `list_providers` — no hard-coded radios.

## 3. langfs changes (3 items)

### 3.1 Compat-shim tools (`server.py` + `handlers.py` + tests)
Two stateless MCP tools routing to the existing `BlobSource` + `extract_text`:

- **`list_files(provider, path, types?)`** → `{"files":[{"id","name","type":"file"}]}`.
  Maps to `source.enumerate(source.connect({}), {"path": path}, suffixes_for(types))`
  for `local` (no credentials). `id` = absolute path, `name` = basename. (For
  cloud later, `path` generalizes to scope + credentials; out of scope now.)
- **`read_file(provider, file_id, format="text")`** → **text**
  (`extract_text(name, source.read_bytes(conn, file_id))`), or base64 of raw bytes
  when `format="base64"`. Unknown/parse failure → `{"error":true,"message"}`.

Both are **stateless** (no client_id/cursor) — gpt's `readRound` keeps owning the
cursor, exactly as it does with UniversalFS today. Errors use the same
`{"error":true,...}` shape gpt already checks.

### 3.2 Six default-package descriptors (`providers/*.json`)
Add `drive`, `onedrive`, `sharepoint`, `dropbox`, `box`, `github` — descriptor
only, each `available` resolving to **false** (no source implementation yet). They
appear in `list_providers` so the UI lists all 10; they are not selectable/usable
until their phase.

### 3.3 Registry tolerates descriptor-only providers (`sources/registry.py`)
Today `build_registry` raises `ValueError` for a descriptor whose name has no
source. Change: a descriptor with no source implementation is reported
`available: false` in `providers_payload` and **skipped** from the functional
registry (not an error). `_available` becomes: `local` → true; `s3/gcs/azure` →
`cloudpathlib` present; the 6 others → false (no source). `providers_payload`
lists all 10; `build_registry` contains only the functional ones.

## 4. gpt changes

### 4.1 Loader UI — dynamic provider list (`frontend/assets/js/workflow-editor.js`)
- Replace the hard-coded `_ufsKnownProviders` (`local/gdrive/s3/onedrive`) and its
  static radios with a list rendered from langfs **`list_providers`** (the loader
  already calls this tool — make it authoritative).
- Render **all 10**: `local` enabled/selectable; the other 9 **disabled**
  ("coming soon", greyed, still labeled). Selecting `local` keeps the existing
  path field + type checkboxes.
- Point the loader's **storage MCP** at the registered langfs server (reuse the
  existing storage picker; no new mechanism).
- Keep the Output stepper, run, and compile flows unchanged.

### 4.2 Backend — point the read path at langfs (`IngestionController.php`)
`buildLoaderClosures` already wraps `list_files` / `read_file` MCP calls — it now
resolves them against the langfs server. One change: because langfs `read_file`
returns **text**, the `readFile` closure stops base64-decoding and the
`IngestionLoader::decode()` step becomes a **passthrough** for langfs sources
(the bytes already are text). `readRound` / `enumerateFiles` / preview / run /
compile are otherwise unchanged.

## 5. Scope & non-goals

- **In:** `local` end-to-end through langfs; all 10 listed; text-out; the 3 langfs
  items + the gpt UI/backend wiring above.
- **Out (later phases):** cloud providers *functional* (needs the dynamic
  credential/scope form + the compat shim passing credentials, or the `read_next`
  cutover); the 6 descriptor-only providers' source implementations; retiring the
  PHP `decode()` for non-langfs sources; OAuth/install (langfs spec §25).

## 6. Decomposition (two plans)

1. **langfs plan** — §3.1–3.3 (compat-shim tools, 6 descriptors, registry tweak).
   Independently testable (pytest + curl); ships first.
2. **gpt plan** — §4.1–4.2 (dynamic provider list + backend point-at-langfs).
   Consumes langfs's new tools; verified by running an ingestion of `local` files
   through the loader and seeing text in the Output tab.

## 7. Testing

- **langfs:** pytest for `list_files`/`read_file` (local enumerate + text/base64);
  `providers_payload` returns 10 with correct `available`; `build_registry` skips
  descriptor-only without raising. Live curl: `list_files`/`read_file` against a
  demo folder.
- **gpt:** loader modal lists 10 providers (1 enabled, 9 disabled) sourced from
  `list_providers`; selecting `local` + a path + types, the Output stepper shows
  extracted text read **through langfs**; a full run ingests local files.
- **End-to-end:** register langfs → pick `local` → path → run → text reaches the
  pipeline.

## 8. Open item

- **Read-cursor for preview.** gpt's `readRound` re-enumerates per round (its
  existing model) — preserved here because the compat shim is stateless. No change
  needed this cut; the `read_next` server-cursor model is only adopted in the
  cloud phase.
