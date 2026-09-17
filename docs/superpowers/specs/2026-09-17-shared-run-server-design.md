# A shared run server for every compiled target — design

Date: 2026-09-17. Branch: feat/backend-python. Status: draft for review.

Gives **ADK, MAF and NOOA** compiled packages a run server, so all three answer in the
conversational overlay and open documents in the viewer, exactly as LangGraph does. Scope: batch
(`orchestration = "workflow"`) only. Swarm for ADK and MAF is separate work with its own specs;
NOOA stays batch-only permanently.

## 1. What is actually missing

ADK, MAF and NOOA each emit **one Python script** with a CLI entry point. There is no `api.py`, no
`POST /runs`, no SSE — the string `api.py` does not appear in any of the three generators. They are run by `POST /api/run-file`, which streams stdout into the diagnostic output
modal. That modal is a log, not a conversation.

LangGraph's multi-file targets have had a run server since the compiled-workflow work: `api.py`
serves `POST /runs` and `GET /runs/{run_id}/events` with a 500-frame ring and `Last-Event-ID`
replay. Everything the editor does on top of it — the conversation overlay, the scrim and its three
phases, the document viewer, the one-shot batch turn — is built on that protocol and nothing else.

So this is not three features. It is one missing component, missing three times.

## 2. Why this is smaller than it looks

Three facts, each verified in the code rather than assumed, collapse most of the apparent work.

**The editor already speaks only the protocol.** `_runCompiled`, `_compiledTurn`, the overlay, the
scrim, the document extractor and the document viewer know about `POST /runs` and an SSE stream.
None of them knows which framework is behind it. A target that serves the protocol is
conversational with **no frontend change at all**, beyond telling the manifest fetcher which
target to ask for.

**The runner already accepts any package.** `_resolve_package_dir` requires one path segment under
`scripts/` containing an `api.py`. It has no notion of LangGraph. `POST /api/workflow-server/start`
will spawn an ADK package the day one exists, unchanged.

**A batch conversation needs almost nothing from the graph.** The overlay shows **one bubble — the
end node's output** and deliberately suppresses per-node trace; that is the batch-conversation
spec's §3a and §3c, already shipped. `_compiledTurn`'s batch branch renders from the terminal
`done` frame, and the document extractor runs on that same text. A target that emits **zero
events** therefore produces a completely correct batch conversation, documents included.

## 3. The contract

A compiled package is conversational when it provides:

```python
async def run_workflow(prompt: str, session: str | None = None) -> str
```

That is the whole contract. `session` is accepted and ignored — a batch workflow terminates and has
nothing to resume — and exists so the signature matches the swarm's, which is what lets one
`api.py` drive both.

How far each target already is from that differs, and the difference matters for sequencing:

| target | today | work to meet the contract |
|---|---|---|
| **ADK** | `async def main(user_prompt)` ending in `return final` | a rename |
| **NOOA** | `async def main(prompt: str = DEFAULT_PROMPT) -> str`, returning the joined parts | a rename |
| **MAF** | **no function at all** — the entry point is the `if __name__ == "__main__":` block, which inlines `create_workflow()`, `asyncio.run(...)`, terminal-output extraction, HTML detection and saving | a real extraction: split that block into `run_workflow()` and a thin `__main__` that calls it |

So two of the three are a rename plus a package wrapper. MAF is not, and pretending otherwise
would have put the one piece of genuine refactoring behind an estimate that assumed three renames.

### 3a. The sink is emitted but idle

`api.py` installs an event sink exactly as it does for LangGraph, and `common.py` carries
`set_event_sink()` / `emit_event()`. The three targets will not call `emit_event` — they print to
stdout as they do today — so the sink stays idle and only the terminal frame reaches the client.

This looks like dead code and is not. It is the seam the swarm ports need: when ADK grows a swarm
target it adds `emit_event` calls and `api.py` does not change. Emitting the hook now costs a few
lines and saves revisiting a shared file from three separate projects later.

## 4. What each generator emits

Each target moves from returning one script to returning the manifest shape LangGraph already
uses — `{root, files: [{path, code}]}`:

| file | what it is |
|---|---|
| `workflow.py` | today's single script, exposing `run_workflow` (see §3 — a rename for ADK and NOOA, an extraction for MAF) |
| `api.py` | the shared run server, byte-identical across targets |
| `common.py` | the event-sink hooks, and whatever the target already shares |
| `__init__.py` | PEP 420: a regular `agents/` package elsewhere on `sys.path` beats a local namespace portion. The swarm work lost a day to this |

**The single-file download stays.** It is the same code with a `__main__` block, and it is the only
way to run these targets outside the editor. Only the packaging is new.

## 5. Where `api.py` comes from

Extracted from `LangGraphGenerator::emitModularApi()` into a shared emitter that all four
generators call.

**LangGraph's emitted bytes must not move.** The existing generator pins are the test, and any
movement in them means the extraction changed behaviour rather than location. This is the same
whole-output discipline that caught a cross-language defect during the swarm work, when a text
assertion did not.

## 6. The pending indicator

With no events, the overlay is silent from the prompt until the answer lands — a minute of nothing
on a slow ADK run.

The feed therefore renders a **pending bubble immediately after the user's prompt**: animated dots,
replaced by the answer when it arrives, removed on error. Owner's shape: *"dancing dots displayed
after the prompt."*

Two things about it matter:

- It is **client-side and target-independent**, so it improves the LangGraph targets already in use
  as much as the new ones. It lands first for that reason.
- It is **one small element with a CSS animation**, never an edge or a canvas node. The canvas's
  existing dash-offset animation has been measured at hundreds of main-thread paints per second;
  nothing in this design adds to that.

## 7. What the editor changes

`_fetchManifest(mode)` currently hard-codes `generate-python?modular=1|a2a=1`. It gains a target so
it can ask `generate-adk`, `generate-maf` or `generate-nooa` for a manifest. `_writeManifest` is
already generic over `{root, files}` and does not change.

Everything else — `_runCompiled`, `_acquireRunTarget`, `_compiledTurn`, the overlay, the scrim, the
document viewer, the document extractor — is untouched. That is the measure of whether this design
is right: if a change is needed there, the protocol boundary has been broken somewhere.

## 8. Risks worth naming before implementation

**Importability.** `api.py` imports `workflow.py` and calls `run_workflow()`. These scripts have only
ever run as `__main__`. Module-level `asyncio.run(...)`, global state initialised on import, or
work done at import time will break that, and each target may break differently. A compile probe
that **executes** the emitted package is the only way to find out; it is not optional here.

**Three packages that have never existed.** ADK, MAF and NOOA have run as single files and nothing
else. Import paths, relative imports and dependency resolution inside a package directory are all
unexercised.

**MAF's entry block does more than run the workflow.** It also extracts the terminal output from
`WorkflowRunResult.get_outputs()`, detects an HTML document in the text, and saves it to the output
folder. Splitting it means deciding what belongs to `run_workflow()` (running, and returning the
text) and what belongs to `__main__` (saving, printing). Getting that line wrong changes what a CLI
run writes to disk, which nothing in the editor would reveal.

**A useful precedent, already in the tree.** MAF's entry block detects a document with
`(?is)<!doctype html.*?</html\s*>` falling back to `(?is)<html[\s>].*?</html\s*>` — the same
extraction, including the closing-tag guard, that the editor's `_extractDocument()` arrived at
independently today. Whatever `run_workflow()` returns should stay compatible with it rather than
pre-stripping, so the editor and the CLI keep agreeing about what the answer is.

**Silence is still silence.** The pending indicator says *working*, not *what is happening*. A user
watching a four-node ADK workflow sees dots for the whole run. That is acceptable per the owner and
is the honest cost of Approach 1; the fix, if it is ever wanted, is the event port the swarm work
needs anyway.

## 9. Out of scope

- **Swarm for any target.** ADK and MAF each get their own spec; the run server is their
  prerequisite, which is why it comes first.
- **NOOA swarm**, permanently. The original exclusion stands by the owner's decision.
- **Gates and per-node trace** on the three new targets. Both need the event port.
- **The TypeScript and Python backend twins.** PHP is the reference; the twins follow under the
  existing parity policy, after this lands.

## 10. Tests

**Per target:** generator pins on the new package output — file list, and the content of each file.

**LangGraph:** its emitted output is **byte-identical** to before. This is the whole test of the
extraction, and the only one that can prove it was inert.

**A compile probe per target**, which writes the package and **runs it**: start the server, `POST
/runs`, read the stream, assert a terminal frame with the expected output. Text assertions cannot
see an import-time failure, and §8 says that is the likeliest failure here.

**The pending indicator**, in the existing node harness: a bubble appears on send, is gone once the
answer renders, and is gone after an error.

**Manual, by the owner:** run one workflow on each of the three targets in compiled mode. Confirm
the overlay opens, the dots appear, one bubble arrives, and a workflow producing a document opens
the viewer.

## 11. Sequencing

1. **The pending indicator.** Independent of every generator, improves what is already shipped, and
   means the silent-overlay cost is paid for before it is incurred.
2. **Extract the shared `api.py` emitter**, with LangGraph's output proven byte-identical.
3. **ADK**: package output, `run_workflow`, compile probe. A rename, so it proves the shared
   `api.py` against the simplest target.
4. **MAF**: the extraction in §3's table plus the split in §8. Second, not last, deliberately — it
   is the only target whose shape could force a change to the shared contract, and discovering that
   with one target left to do is cheaper than with none.
5. **NOOA**: a rename, by which point nothing about the shape is in question.

ADK first and MAF second is the ordering that puts the two different kinds of risk early: ADK
surfaces whether these scripts survive being imported at all, MAF surfaces whether the contract
holds for a target that was never written around a function.
