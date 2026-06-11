# Compiler TODO — pending ports from install scripts

Quick instrumentation / fixes that were applied directly to a
generated script in `~/Documents/synergyAI/python/scripts/` to iterate
faster. Each item must be ported into `LangGraphGenerator.php` so that
the next regeneration of any workflow picks up the same behaviour.

Workflow: edit install script → verify the change helps → port to
generator (specific PHP lines noted below) → regenerate → confirm same
behaviour.

---

## Pending

(empty — port everything below the "Done" line as it lands)

---

## Done (already in compiler)

### 1. Tool-result log: smart summary instead of 120-char truncation
- Ported 2026-05-13. `_summarize_tool_result()` helper + smart `[tool] -> / ←`
  logging (argv preview ≤250 chars, JSON-aware summary, byte count, timing)
  now emitted by `toolBuilderBlock()`.

### 2. Per-agent debug instrumentation
- Ported 2026-05-13. Inside `runBodyBlock()`'s `make_agent._run`:
  start log shows provider + model, `inputs:` line shows system/context
  char counts, `agent.ainvoke` wrapped with `time.monotonic()`, end log
  shows `<X> chars (<N> LLM rounds, <T> tool results, <S>s)`, and full
  `result["messages"]` dumped to `<install>/outputs/_debug/<stem>_<node-id>_<ts>.json`.

### 3. Field-name fixes (editor → generator) and Kimi/multi-provider correctness
- 2026-05-13: generator now reads `cfg.tools` (editor) as fallback to
  `cfg.selectedTools` (legacy), strips `mcp_` prefix, and reads
  `cfg.agent_provider` as fallback to `cfg.llm_provider`/`cfg.provider`.
- 2026-05-13: Kimi base URL switched to `api.moonshot.ai/v1` (matches
  PHP `KimiProvider`). K2 models force `temperature=0.6`, `top_p=0.95`,
  and `thinking: disabled` via `model_kwargs.extra_body` (mirrors PHP).
- 2026-05-13: per-agent `temperature` / `max_tokens` read from
  `cfg.settings` and threaded through `_make_llm` for all providers.

### 4. Output save location
- 2026-05-13: generator's `main()` now calls `script_io.write_output()`
  so result files land in `<install>/outputs/<stem>_<ts>.<ext>` (with
  auto HTML/MD detection) instead of polluting `scripts/`.
