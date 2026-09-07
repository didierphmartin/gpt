# Backend Python Port — Phase 6 (Generators + Ingestion) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the code generators (`LangGraphGenerator` incl. A2A + playbook modes, `ADKGenerator`, `MAFGenerator`, `NOOAGenerator`, `PythonEmitHelpers`, `WorkflowGraphAnalyzer`) and the ingestion pipeline (`IngestionCompiler`, `IngestionLoader`, `IngestionSplitter`, `VectorMcpStore`, `IngestionController`) so `GET /workflows/{id}/generate-{python,adk,maf,nooa}` and the 10 `/workflows/{id}/ingestion/*` routes produce byte-identical output to PHP.

**Architecture:** One Python module per PHP file under `app/agent_team/services/` (+ `app/agent_team/controllers/ingestion_controller.py`), same class and camelCase method names. The generators are pure string emitters over the workflow graph: the strongest possible check is a byte-for-byte differential of the generated code for every workflow user 3 owns, on both backends. The PHP unit tests (`LangGraphParityTest`, `LangGraphA2AGeneratorTest`, `LangGraphGeneratorPlaybookTest`, `GeneratedDocParityTest`, `AdkGenerator{Emit,Compile}Test`, `MafGenerator{Emit,Compile}Test`, `NooaGenerator{Emit,Compile}Test`, `PythonEmitHelpers{,Pin}Test`, `WorkflowGraphAnalyzer{,Analyze}Test`, `backend/tests/Unit/adk_diamond.golden.py`) are ported as the Python unit tests — they are the oracle.

**Tech Stack:** Python 3.13, pytest; ingestion loaders use the same external services PHP calls (langfs / vector MCP over HTTP via httpx).

**Spec:** `docs/superpowers/specs/2026-09-05-backend-python-port-design.md` (§4 phase 6 row). Memories that bind: `never-patch-compiled` (fix the generator, never its output), `never-override-agent-form-params`, `langgraph-playbook-dispatcher` (A2A compile mode; uniform generated-script docs), `adk-compiler`, `nooa-compiler`, `skill-pipeline-execution`.

## Global Constraints

- Phase 1–5 Global Constraints apply.
- **Byte-identical emission.** Generated Python/text must equal PHP's output byte for byte: same indentation, line endings, quoting (`var_export`/`json_encode` of strings and arrays → port `PythonEmitHelpers` first and pin it against `PythonEmitHelpersPinTest`), same ordering of dict keys/iteration (PHP arrays are insertion-ordered; Python dicts too — keep every builder in the same order), same float formatting (`PythonEmitHelpers` rules), same `date()` stamps only where PHP emits them (frozen in tests).
- **Compile checks:** the PHP `*CompileTest`s run `python -m py_compile` on the emitted code — port those as-is (the venv has Python).
- **Differential:** for EVERY workflow of user 3 (`SELECT id FROM agent_workflows WHERE user_id = 3`), `GET /workflows/{id}/generate-python|adk|maf|nooa` on both backends → response JSON equal AND the code field byte-equal; plus each generator's query-string modes PHP supports (`?mode=a2a`, playbook, etc. — read the controller). No LLM calls. Ingestion: validation cases exact; `loader-text`/`splitter-chunks` on `backend/tests/fixtures/loader-sample.pdf` (multipart or path per the controller) exact; `store-*`/`run-*` need the vector MCP + langfs services running — gate on env `DIFF_INGESTION=1`, else skip with a truthful reason.
- Commit trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Kt6CcZ1BFdJvxZacT4bfJ8
  ```

## Porting rules

Phase 2b table + later additions. Additions for emitters:

| PHP | Python |
|---|---|
| `var_export($s, true)` | `PythonEmitHelpers.pyStr` (port; PHP single-quote escaping rules) |
| `json_encode($v, JSON_PRETTY_PRINT \| JSON_UNESCAPED_SLASHES \| JSON_UNESCAPED_UNICODE)` | `phpjson.dumps_pretty(v)` (4-space, PHP's `": "`/`": ` spacing — implement and pin) |
| `implode("\n", $lines)` | `'\n'.join(lines)` |
| `str_repeat(' ', 4 * $n)` | `' ' * (4 * n)` |
| `sprintf('%.2f')` / `number_format` | port the exact helper in `PythonEmitHelpers` |
| `preg_replace` in identifiers (`slug`, `pyIdent`) | `re.sub` with the same pattern (watch `\w` Unicode differences: use `[A-Za-z0-9_]` where PHP's pattern is ASCII) |
| `ucfirst`/`lcfirst`/`ucwords` | `ucfirst` (phpcompat) / `s[:1].lower()+s[1:]` / `string.capwords` per site |

## Tasks

### Task 1: `PythonEmitHelpers` + `WorkflowGraphAnalyzer`
Port `PythonEmitHelpers.php` (756) and `WorkflowGraphAnalyzer.php` (543); tests = ported `PythonEmitHelpersTest`, `PythonEmitHelpersPinTest`, `WorkflowGraphAnalyzerTest`, `WorkflowGraphAnalyzerAnalyzeTest`. Commit `feat(py): PythonEmitHelpers + WorkflowGraphAnalyzer`.

### Task 2: `LangGraphGenerator` (incl. A2A + playbook)
Port `LangGraphGenerator.php` (3314) in two commits if needed (base emitter; A2A/playbook modes); tests = ported `LangGraphParityTest`, `LangGraphA2AGeneratorTest`, `LangGraphGeneratorPlaybookTest`, `GeneratedDocParityTest` (LangGraph part). Commit `feat(py): LangGraphGenerator`.

### Task 3: `ADKGenerator` + `MAFGenerator` + `NOOAGenerator`
Port the three (1203 + 1394 + 891); tests = ported `Adk/Maf/Nooa{Emit,Compile}Test` + `adk_diamond.golden.py` fixture + `GeneratedDocParityTest` (rest). Commit `feat(py): ADK, MAF, NOOA generators`.

### Task 4: `WorkflowController::generatePython/Adk/Maf/Nooa` + routes + differential
Replace the Phase 4 stubs (PHP 240–472); routes 351–354; `tests/differential/test_generators.py` per the Global Constraints (all of user 3's workflows × 4 generators × modes). A byte mismatch is a generator bug: fix the generator, never the output. Commit `feat(py): generate-* routes with byte-identical output`.

### Task 5: Ingestion services
Port `IngestionCompiler.php` (403), `IngestionLoader.php` (233), `IngestionSplitter.php` (176), `VectorMcpStore.php` (156); tests = the PHP `backend/scripts/test-ingestion-*.php` scenarios turned into pytest cases with `MockTransport` for the remote services + `loader-sample.pdf`. Commit `feat(py): ingestion compiler/loader/splitter + VectorMcpStore`.

### Task 6: `IngestionController` + routes
Port `IngestionController.php` (1231: `nodeCode`, `compile`, `saveScript`, `loaderText`, `splitterChunks`, `storeChunks`, `storeFind`, `runStream`, `runStart`, `runWorker`); routes 357–373; unit validation cases per method; differential per the Global Constraints. Commit `feat(py): IngestionController`.

### Task 7: Docs, verification
README Phase 6 paragraph; tracker rows (emit-helper pins, ingestion gating); unit + differential (no LLM). Commit `docs(py): Phase 6 status + parity rows`.

## Self-review notes
- Coverage of umbrella §4 phase 6: generators T1–T4, ingestion T5–T6, endpoints T4/T6.
- Oracles: the PHP unit tests exist for every generator and the emit helpers; porting them is mandatory, not optional.
