/**
 * Skill-genesis orchestrator — L0 (manual on-ramps).
 * Spec: gpt/docs/specs/2026-07-14-skill-genesis-design.md §6.
 *
 * window.genesisSystem.showProposal(promotion):
 *   renders the approval overlay (name, description, eval count, merge hint,
 *   parameter table when present) → on approve: POST /genesis/authorize →
 *   buildOne() → POST /genesis/record.
 *
 * The BUILD is local: write skills/<name>/SKILL.md via window.localFs (the
 *   catalog lives in the user's local FS — the server never touches it).
 * The server gate (GenesisController) is authoritative for spend.
 *
 * Merge promotions (p.is_merge === true): skill_name === merge_target, an
 *   EXISTING skill. Building one must NOT overwrite that skill's folder —
 *   instead we drop an eval-cases sidecar file into it and record the
 *   outcome as 'merged' rather than 'born'.
 */
(function () {
    'use strict';

    // i18n.t() key-echo-aware fallback: window.i18n.t() returns the key itself
    // (not empty/null) when a key is missing from the translation file, so a
    // bare `|| d` never fires. Mirror workflow-editor.js's tWithFallback().
    const t = (k, d) => {
        const v = window.i18n && window.i18n.t && window.i18n.t(k);
        return (!v || v === k) ? d : v;
    };
    const tok = () => (localStorage.getItem('token') || (window.authManager && window.authManager.token) || '');
    const hdrs = () => ({ 'Authorization': `Bearer ${tok()}`, 'Content-Type': 'application/json' });
    // Flat estimate for an L0 build (write + optional short harden pass).
    const BUILD_ESTIMATE_USD = 0.25;

    /**
     * HTML escape helper — prevents stored XSS by converting LLM-derived
     * strings to safe HTML entities before interpolation into innerHTML.
     */
    function esc(s) { const d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }

    (function injectStyles() {
        if (document.getElementById('genesis-panel-styles')) return;
        const st = document.createElement('style');
        st.id = 'genesis-panel-styles';
        st.textContent = `
        .gen-ov-backdrop{position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}
        .gen-ov{background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.3);width:min(520px,94vw);max-height:86vh;overflow:auto;padding:20px}
        .gen-ov h3{font-size:16px;font-weight:700;color:#1e293b;margin:0 0 6px}
        .gen-ov-name{font-family:ui-monospace,monospace;font-size:13px;color:#4f46e5;margin:0 0 8px}
        .gen-ov-desc{font-size:13px;color:#475569;margin:0 0 12px;white-space:pre-wrap}
        .gen-ov-meta{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:#64748b;margin:0 0 12px}
        .gen-ov-merge{font-size:12px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px;margin:0 0 12px}
        .gen-ov table{width:100%;border-collapse:collapse;font-size:12px;margin:0 0 12px}
        .gen-ov th,.gen-ov td{border:1px solid #e2e8f0;padding:4px 8px;text-align:left}
        .gen-ov-actions{display:flex;justify-content:flex-end;gap:8px}
        .gen-ov-actions button{padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none}
        .gen-btn-dismiss{background:#fff;border:1px solid #cbd5e1!important;color:#475569}
        .gen-btn-approve{background:#4f46e5;color:#fff}
        .gen-btn-approve[disabled]{opacity:.6;cursor:default}
        .gen-ov-exec{margin:12px 0;padding:10px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb}
        .gen-ov-exec-title{font-weight:600;font-size:13px;margin-bottom:6px;color:#374151}
        .gen-exec-opt{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:#374151;margin:4px 0;cursor:pointer}
        .gen-exec-opt input{margin-top:2px}
        .gen-exec-hint{margin:6px 0 0;font-size:11px;color:#6b7280}
        #genesis-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);z-index:320;background:#1e293b;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;opacity:0;transition:all .2s;pointer-events:none;max-width:80vw}
        #genesis-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
        #genesis-toast.genesis-toast-error{background:#b91c1c}
        #genesis-toast.genesis-toast-ok{background:#15803d}
        .gen-busy, .gen-busy *{cursor:progress !important}
        #gen-cursor-spin{position:fixed;z-index:400;width:16px;height:16px;border:2.5px solid #4f46e5;border-top-color:transparent;border-radius:50%;animation:gen-spin .7s linear infinite;pointer-events:none;left:-100px;top:-100px}
        @keyframes gen-spin{to{transform:rotate(360deg)}}`;
        document.head.appendChild(st);
    })();

    // Mouse-attached busy indicator — the reflection call takes 10-60s with no
    // intermediate progress events, so a spinner riding beside the cursor (plus
    // cursor:progress) keeps "something is happening" visible the whole time.
    // Used by every on-ramp (chat, workflow toolbar/menu, prompt library).
    let busyEl = null, busyMove = null;
    function busy(on) {
        if (on) {
            if (busyEl) return;
            document.documentElement.classList.add('gen-busy');
            busyEl = document.createElement('div');
            busyEl.id = 'gen-cursor-spin';
            document.body.appendChild(busyEl);
            busyMove = (e) => {
                busyEl.style.left = (e.clientX + 14) + 'px';
                busyEl.style.top = (e.clientY + 14) + 'px';
            };
            document.addEventListener('mousemove', busyMove);
        } else {
            document.documentElement.classList.remove('gen-busy');
            if (busyMove) document.removeEventListener('mousemove', busyMove);
            if (busyEl) busyEl.remove();
            busyEl = null;
            busyMove = null;
        }
    }

    /** Human-readable, actionable message for a gate refusal reason. */
    function reasonMessage(d) {
        const r = (d && (d.reason || d.error)) || 'not allowed';
        const defaults = {
            mode_off: 'Skill promotion is turned off — enable it in Settings → Auto → Skill promotion',
            suggest_only: "Promotion mode is 'Suggest' (list only) — switch to Ask or Auto in Settings → Auto to build",
            over_budget: 'Daily skill-promotion budget reached — raise it in Settings → Auto or try tomorrow',
            weekly_throttle: 'Weekly new-skill limit reached — raise it in Settings → Auto',
            over_ceiling: 'Estimated cost exceeds the per-skill ceiling in Settings → Auto',
        };
        return defaults[r] ? t(`genesis.reason.${r}`, defaults[r]) : r;
    }

    // Self-contained toast — heal-panel.js does NOT expose .toast on
    // window.healSystem (only { scan, healOne, autoAfterRun }), so this
    // mirrors heal-panel's own toast idiom (markup/classes) rather than
    // delegating to a method that doesn't exist.
    let toastEl = null;
    function toast(msg, kind) {
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.id = 'genesis-toast';
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = msg;
        toastEl.className = `genesis-toast-${kind || 'info'} show`;
        clearTimeout(toastEl._t);
        toastEl._t = setTimeout(() => { toastEl.className = toastEl.className.replace(' show', ''); }, 4000);
    }

    /**
     * Workflow runner for dispatcher scripts (run.py delegates here via the
     * Pyodide js proxy). Uses the editor's runHeadless, which now runs the
     * graph BROWSER-DRIVEN (each node a chat unit, skills on the worker
     * pool) — the same engine as the canvas Run button. A bare server POST
     * /run would return empty outputs for skill-using agents, and the old
     * server run-stream + bridge path serialized skills behind 300s waits.
     */
    async function ensureWorkflowEditor() {
        if (window.workflowEditor && window.workflowEditor.loadWorkflow) return window.workflowEditor;
        if (window.agentTeamsPanel && window.agentTeamsPanel.show) window.agentTeamsPanel.show();
        for (let i = 0; i < 20; i++) {
            if (window.workflowEditor && window.workflowEditor.loadWorkflow) return window.workflowEditor;
            await new Promise(r => setTimeout(r, 100));
        }
        return null;
    }

    /**
     * Fire-and-notify: START the run and return immediately. run.py holds the
     * SERIALIZED main Pyodide queue while it executes — if it awaited the whole
     * workflow, any agent-node skill that falls back from the worker pool to
     * the main runner would deadlock behind it (and even the happy path would
     * hog the runtime for minutes). So the dispatcher exits right after start;
     * when the workflow completes, the output is posted into the conversation.
     */
    let _genRunSeq = 0;
    function genesisWorkflowStart(workflowId, prompt) {
        const runNo = ++_genRunSeq;
        (async () => {
            const label = `workflow #${workflowId} (skill run ${runNo})`;
            try {
                const ed = await ensureWorkflowEditor();
                if (!ed) {
                    toast(`Genesis run failed: workflow engine unavailable`, 'error');
                    return;
                }
                toast(`▶ Running ${label}…`, 'info');
                const run = await ed.runHeadless(Number(workflowId), String(prompt)) || {};
                const result = run.result;
                // runHeadless resolves with result:null when the stream ended on a
                // workflow_error (e.g. a bridge skill timeout) instead of
                // workflow_complete — that is a FAILURE, not an empty success.
                if (!result || result.success === false) {
                    const note = `⚠️ **Workflow #${workflowId} did not complete cleanly.** `
                        + 'It may have hit a skill timeout or node error — check the Workflows panel '
                        + 'for per-node states. Any report files already written to your outputs '
                        + 'folder are still valid.';
                    if (window.chatApp && typeof window.chatApp.addMessage === 'function') {
                        window.chatApp.addMessage('assistant', note);
                    } else {
                        toast(`${label} did not complete cleanly`, 'error');
                    }
                    return;
                }
                const output = (typeof result.output === 'string' && result.output.trim())
                    ? result.output
                    : (run.outputs ? JSON.stringify(run.outputs, null, 2) : '(no final output text — check your outputs folder for written reports)');
                const meta = [
                    result.nodes_executed ? `${result.nodes_executed} nodes` : null,
                    result.response_time_ms ? `${Math.round(result.response_time_ms / 1000)}s` : null,
                ].filter(Boolean).join(', ');
                const summary = `🧬 **Workflow #${workflowId} completed**${meta ? ` (${meta})` : ''}\n\n` + output;
                if (window.chatApp && typeof window.chatApp.addMessage === 'function') {
                    window.chatApp.addMessage('assistant', summary);
                } else {
                    toast(`${label} completed`, 'ok');
                }
            } catch (e) {
                const msg = String((e && e.message) || e);
                if (window.chatApp && typeof window.chatApp.addMessage === 'function') {
                    window.chatApp.addMessage('assistant', `⚠️ Genesis ${label} failed: ${msg}`);
                } else {
                    toast(`Genesis run failed: ${msg}`, 'error');
                }
            }
        })();
        return JSON.stringify({ started: true, run: runNo });
    }
    window.genesisWorkflowStart = genesisWorkflowStart;


    /** Workflow-backed promotion? (class 2 rows carry source_ref 'workflow:<id>') */
    function workflowIdOf(p) {
        const m = /^workflow:(\d+)$/.exec(p.source_ref || '');
        return m ? Number(m[1]) : null;
    }

    /**
     * Freeze a workflow's graph for the Pyodide-compiled snapshot. Distills
     * GET /workflows/{id} `graph` into the minimal node/edge shape the
     * embedded Python engine executes: agent nodes carry name, provider,
     * model, instructions and bound-skill dir; edges are [from, to] pairs.
     */
    async function fetchWorkflowGraphSnapshot(wfId) {
        const r = await fetch(window.apiUrl(`/workflows/${wfId}`), { headers: hdrs() });
        if (!r.ok) throw new Error(`Could not load workflow ${wfId} (HTTP ${r.status}).`);
        const wf = (await r.json()).data || {};
        let g = wf.graph || {};
        if (typeof g === 'string') { try { g = JSON.parse(g); } catch (_) { g = {}; } }
        const nodes = (g.nodes || []).map((n) => {
            const cfg = n.config || {};
            return {
                id: String(n.id),
                type: n.node_type || n.type || 'agent',
                name: cfg.agent_name || cfg.name || '',
                provider: cfg.agent_provider || cfg.provider || '',
                model: cfg.model || '',
                instructions: cfg.instructions || cfg.systemPrompt || '',
                skill: (cfg.bound_skill && cfg.bound_skill.dir_name) || '',
            };
        });
        const edges = (g.edges || g.connections || []).map((e) => [String(e.from), String(e.to)]);
        if (!nodes.length) throw new Error(`Workflow ${wfId} has no nodes to compile.`);
        return { workflow_id: wfId, name: wf.name || '', nodes, edges };
    }

    /** scripts list per bound skill (read off the local FS) — the snapshot
     * sends these as skill_metadata so /chat exposes run_skill_script. */
    async function collectSkillScripts(graph) {
        const out = {};
        if (!window.skillsFs) return out;
        for (const n of graph.nodes) {
            if (!n.skill || out[n.skill]) continue;
            try { out[n.skill] = await window.skillsFs.listSkillScripts(n.skill) || []; }
            catch (_) { out[n.skill] = []; }
        }
        return out;
    }

    function skillMd(p) {
        const params = p.parameter_schema
            ? '\n## Parameters\n' + Object.entries(p.parameter_schema).map(([k, v]) =>
                `- **${k}** (${(v && v.type) || 'string'})${v && v.default !== undefined ? ` — default: ${JSON.stringify(v.default)}` : ''}${v && v.examples ? ` — examples: ${JSON.stringify(v.examples)}` : ''}`
              ).join('\n') + '\n'
            : '';
        const wfId = workflowIdOf(p);
        const compiled = p.execution && p.execution.mode === 'compiled' ? p.execution : null;
        // L1 dispatcher contract. Interpreted: the skill executes the workflow
        // by reference through the browser engine (edits flow through).
        // Compiled: the skill runs a Python snapshot generated at promotion
        // time in the local Python runner (frozen; edits do NOT flow through).
        // Either way the model composes ONE plain-language instruction and
        // hands it to scripts/run.py via --prompt.
        let howToRun = '';
        if (wfId !== null && compiled) {
            howToRun = `\n## How to run\n\nThis skill runs a COMPILED Pyodide snapshot of workflow #${wfId} — the graph was frozen into \`scripts/run.py\` at promotion time and executes fully in the browser (agent turns via the backend, skills via the worker pool). Later edits to the workflow do NOT affect this skill; re-promote to refresh. No external runner is required.\n\nOn every invocation you MUST:\n1. Compose a single plain-language instruction for the workflow from the user's request, explicitly filling in the parameters documented above (use defaults when the user did not specify one).\n2. Call \`run_skill_script\` with script \`scripts/run.py\` and argv \`["--prompt", "<your composed instruction>"]\`.\n3. The script runs the whole workflow (a multi-agent run can take several minutes; that is normal), writes the final document to /outputs/ and announces it with a "wrote <path>" line — the platform renders that document (HTML or Markdown) for the user automatically.\n4. After it returns: give the user a SHORT 2-3 sentence summary and point to the rendered document. Do NOT re-paste the document body and do NOT invent results before the script returns.\n\nDo NOT attempt to perform the workflow's steps yourself.\n`;
        } else if (wfId !== null) {
            howToRun = `\n## How to run\n\nThis skill executes workflow #${wfId} by reference (edits in the workflow editor flow through automatically).\n\nOn every invocation you MUST:\n1. Compose a single plain-language instruction for the workflow from the user's request, explicitly filling in the parameters documented above (use defaults when the user did not specify one).\n2. Call \`run_skill_script\` with script \`scripts/run.py\` and argv \`["--prompt", "<your composed instruction>"]\`.\n3. The script starts the run and returns immediately; the full results are posted into the conversation automatically when the run completes. Tell the user the workflow is running — do NOT invent or predict results.\n\nDo NOT attempt to perform the workflow's steps yourself — the workflow engine runs them (a run may take several minutes; that is normal).\n`;
        }
        const execLine = compiled ? 'execution: compiled-pyodide\n' : (wfId !== null ? 'execution: interpreted\n' : '');
        return `---\nname: ${p.skill_name}\ndescription: ${String(p.description).replace(/\n/g, ' ')}\nfetches_urls: false\n${execLine}---\n\n# ${p.skill_name}\n\n${p.description}\n${params}${howToRun}\n## Provenance\n\nCreated by skill genesis (${wfId !== null ? (compiled ? 'L1 compiled Pyodide snapshot' : 'L1 workflow dispatcher') : 'L0'}) from ${p.source_ref || 'user material'} on ${new Date().toISOString().slice(0, 10)}.\n\n## Eval queries\n\n\`\`\`json\n${JSON.stringify(p.eval_queries || [], null, 2)}\n\`\`\`\n`;
    }

    /**
     * scripts/run.py for workflow-backed skills: submit the referenced
     * workflow with the composed prompt as its input variables and print the
     * outputs. Runs inside Pyodide — pyfetch + window proxies, same idioms as
     * skill-creator's improve_description.py (incl. asyncio.run and the
     * APP_CONFIG.API_BASE_URL base so PHP/Node backend selection is honored).
     */
    function runPyTemplate(p, wfId) {
        return `#!/usr/bin/env python3
"""Dispatcher for the '${p.skill_name}' skill.

Submits workflow #${wfId} with a caller-composed prompt and relays the
outputs. Generated by skill genesis (L1). The workflow reference is
canonical: edits made in the workflow editor apply automatically.
"""

import argparse
import asyncio
import json
import sys

from js import window

WORKFLOW_ID = ${wfId}


async def _run(prompt: str) -> int:
    # Fire-and-notify: start the run in the browser (full client-skill
    # bridge via the editor's runHeadless) and EXIT so the shared Pyodide
    # runtime is freed — the workflow's own agent skills may need it.
    # The final output is posted into the conversation when the run ends.
    starter = getattr(window, "genesisWorkflowStart", None)
    if starter is None:
        print("WORKFLOW RUN FAILED: genesis runtime not loaded (refresh the app)", file=sys.stderr)
        return 1
    info = json.loads(str(starter(WORKFLOW_ID, prompt)))
    if not info.get("started"):
        print(f"WORKFLOW RUN FAILED: {json.dumps(info)[:300]}", file=sys.stderr)
        return 1
    print(f"Workflow #{WORKFLOW_ID} STARTED in the background (run {info.get('run')}).")
    print("The full results will be posted into this conversation automatically when the "
          "run completes (a multi-agent run can take several minutes).")
    print("Tell the user the workflow is running and that results will follow — "
          "do NOT invent or predict the results.")
    return 0


def main():
    ap = argparse.ArgumentParser(description="Run the referenced workflow with a composed prompt.")
    ap.add_argument("--prompt", required=True,
                    help="Full plain-language instruction for the workflow run")
    args = ap.parse_args()
    sys.exit(asyncio.run(_run(args.prompt)))


if __name__ == "__main__":
    main()
`;
    }

    /**
     * scripts/run.py for COMPILED workflow skills: a self-contained Pyodide
     * snapshot. The workflow's graph is frozen as JSON and executed by an
     * embedded asyncio engine that runs entirely IN THE BROWSER: agent nodes
     * call the backend /chat (same-origin — no CORS, keys stay server-side),
     * parallel layers via asyncio.gather, bound-skill tool calls through the
     * worker pool (window.chatApp._runViaPool). No external runner required.
     * The final output is returned directly as this script's stdout.
     */
    function pyodideSnapshotRunPy(p, wfId, graph, skillScripts) {
        const graphLit = JSON.stringify(JSON.stringify(graph));
        const scriptsLit = JSON.stringify(JSON.stringify(skillScripts || {}));
        return `#!/usr/bin/env python3
"""Compiled Pyodide snapshot of workflow #${wfId} ('${graph.name || p.skill_name}').

Generated by skill genesis (L1 compiled/pyodide). The graph below is FROZEN
at promotion time — later edits to the workflow do not apply; re-promote to
refresh. Runs fully in the browser: /chat for agent turns, the Pyodide
worker pool for skill tool calls.
"""

import argparse
import asyncio
import json
import sys

import js
from js import window
from pyodide.ffi import to_js
from pyodide.http import pyfetch

GRAPH = json.loads(${graphLit})
SKILL_SCRIPTS = json.loads(${scriptsLit})
SKILL_NAME = ${JSON.stringify(p.skill_name)}
MAX_ROUNDS = 8
TRIM = 4000


def _api(path):
    base = "/gpt/backend/api/v1"
    try:
        cfg = getattr(window, "APP_CONFIG", None)
        if cfg is not None and getattr(cfg, "API_BASE_URL", None):
            base = str(cfg.API_BASE_URL)
    except Exception:
        pass
    return base.rstrip("/") + path


async def _post_chat(body):
    resp = await pyfetch(
        _api("/chat"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + str(window.authManager.token),
        },
        body=json.dumps(body),
    )
    return json.loads(await resp.string())


async def _run_skill(inp, node):
    """Nested run_skill_script → the worker pool (parallel-safe, off the
    main runtime this snapshot occupies)."""
    chat_app = getattr(window, "chatApp", None)
    if chat_app is None or not hasattr(chat_app, "_runViaPool"):
        return {"success": False,
                "error": "skill bridge unavailable (snapshot must run on the main thread)"}
    dir_name = (inp.get("dir_name") or node.get("skill") or "").strip()
    req = {
        "dirName": dir_name,
        "script": inp.get("script"),
        "argv": inp.get("argv") or [],
        "inputFiles": inp.get("input_files") or None,
        "readOutputs": inp.get("read_outputs") or None,
    }
    try:
        res = await chat_app._runViaPool(to_js(req, dict_converter=js.Object.fromEntries))
        py = res.to_py() if hasattr(res, "to_py") else res
        outs = {}
        for k, v in (py.get("outputs") or {}).items():
            outs[k] = v[:TRIM] if isinstance(v, str) else "[binary output]"
        return {
            "success": (py.get("exitCode") or 0) == 0,
            "output": {
                "exit_code": py.get("exitCode") or 0,
                "stdout": (py.get("stdout") or "")[:TRIM],
                "log_messages": (py.get("stderr") or "")[:TRIM],
                "outputs": outs,
            },
        }
    except Exception as e:
        return {"success": False, "error": str(e)[:500]}


async def _run_agent(node, context):
    """One agent node = one /chat conversation, looping tool rounds until
    the model returns final text (mirrors the browser engine's chat-unit)."""
    body_base = {
        "provider": node.get("provider") or "openai",
        "streaming": False,
        "verification_enabled": False,
        "compare_enabled": False,
    }
    if node.get("model"):
        body_base["model"] = node["model"]
    if node.get("skill"):
        body_base["skill_metadata"] = {
            "dir_name": node["skill"],
            "scripts": SKILL_SCRIPTS.get(node["skill"]) or ["scripts/run.py"],
        }
    instructions = (node.get("instructions") or "").strip()
    message = (instructions + "\\n\\n--- INPUT ---\\n" + context) if instructions else context
    history = []
    for _ in range(MAX_ROUNDS):
        body = dict(body_base)
        body["message"] = message
        body["conversation_history"] = history
        r = await _post_chat(body)
        if r.get("success") is False:
            return "Error: " + str(r.get("error") or "chat call failed")[:400]
        if r.get("pending_client_tool_call"):
            calls = r.get("pending_tool_calls") or []
            if message:
                history.append({"role": "user", "content": message})
            history.append({
                "role": "assistant",
                "content": r.get("text") or "",
                "tool_calls": [
                    {"id": c.get("id"), "name": c.get("name"), "input": c.get("input") or {}}
                    for c in calls
                ],
            })
            for c in calls:
                result = await _run_skill(c.get("input") or {}, node)
                history.append({
                    "role": "tool",
                    "tool_call_id": c.get("id"),
                    "name": c.get("name") or "run_skill_script",
                    "content": json.dumps(result),
                })
            message = ""
            continue
        return r.get("text") or ""
    return "(node exceeded the tool-round limit)"


async def _run_graph(prompt):
    nodes = {n["id"]: n for n in GRAPH["nodes"]}
    incoming = {nid: [e[0] for e in GRAPH["edges"] if e[1] == nid] for nid in nodes}
    outputs = {}
    done = set()
    for n in GRAPH["nodes"]:
        if n["type"] == "start":
            outputs[n["id"]] = prompt
            done.add(n["id"])
    remaining = set(nodes) - done
    while remaining:
        ready = [nid for nid in remaining if all(u in done for u in incoming[nid])]
        if not ready:
            break  # cycle or orphan
        async def _run_one(nid):
            n = nodes[nid]
            parts = []
            raws = []
            for u in incoming[nid]:
                o = outputs.get(u, "")
                if not o:
                    continue
                raws.append(o)
                parts.append(o if nodes[u]["type"] == "start"
                             else "## " + (nodes[u].get("name") or u) + "\\n" + o)
            ctx = "\\n\\n".join(parts) or prompt
            if n["type"] == "output":
                # Single feeder → pass the document through RAW (no fan-in
                # label header polluting the final HTML/Markdown).
                outputs[nid] = raws[0] if len(raws) == 1 else ctx
            else:
                outputs[nid] = await _run_agent(n, ctx)
        await asyncio.gather(*[_run_one(nid) for nid in ready])
        for nid in ready:
            done.add(nid)
            remaining.discard(nid)
    out_id = next((n["id"] for n in GRAPH["nodes"] if n["type"] == "output"), None)
    return outputs.get(out_id) or json.dumps(
        {nodes[k].get("name") or k: v for k, v in outputs.items()}, ensure_ascii=False)


def _looks_html(text):
    s = text.lstrip().lower()
    return s.startswith("<!doctype") or s.startswith("<html")


def main():
    ap = argparse.ArgumentParser(description="Run the compiled workflow snapshot.")
    ap.add_argument("--prompt", required=True,
                    help="Full plain-language instruction for the workflow run")
    args = ap.parse_args()
    final = asyncio.run(_run_graph(args.prompt))
    text = final if isinstance(final, str) else str(final)

    # Persist the workflow's OUTPUT DOCUMENT to /outputs/ and announce it
    # with a "wrote <path>" line: the platform reads announced files back
    # into the tool result and renders HTML/Markdown in the document pane —
    # the user sees the real document, not just the model's summary of it.
    import time as _time
    ext = "html" if _looks_html(text) else "md"
    out_path = "/outputs/%s_%s.%s" % (SKILL_NAME, _time.strftime("%Y-%m-%d_%H%M%S"), ext)
    try:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(text)
        print("wrote %s" % out_path)
    except Exception as e:
        print("could not write output document: %s" % e, file=sys.stderr)

    head = text[:1500]
    print(head)
    if len(text) > 1500:
        print("...[document continues — the full version is rendered for the user "
              "from %s; do NOT re-paste it]" % out_path)


if __name__ == "__main__":
    main()
`;
    }

    /** Local-FS connection check — getStatus() returns { state, handle, name },
     * NOT a `.connected` flag; 'granted' is the only usable state. */
    async function requireLocalFs() {
        if (!window.localFs) {
            throw new Error('Local skills folder is not connected (Skills panel → connect folder).');
        }
        const status = await window.localFs.getStatus();
        if (!status || status.state !== 'granted') {
            throw new Error('Local skills folder is not connected (Skills panel → connect folder).');
        }
    }

    /** Write skills/<name>/SKILL.md (+ scripts/run.py for workflow-backed skills). */
    async function writeSkillFolder(p) {
        await requireLocalFs();
        const wfId = workflowIdOf(p);
        const compiled = p.execution && p.execution.mode === 'compiled' && wfId !== null ? p.execution : null;

        // Compiled: freeze the graph FIRST — if snapshot generation fails,
        // no half-built skill folder is left behind. The snapshot IS run.py:
        // a self-contained Pyodide program (graph JSON + asyncio engine)
        // that runs in the browser — no external runner involved.
        let snapshotPy = null;
        if (compiled) {
            const graph = await fetchWorkflowGraphSnapshot(wfId);
            const skillScripts = await collectSkillScripts(graph);
            snapshotPy = pyodideSnapshotRunPy(p, wfId, graph, skillScripts);
        }

        const dir = await window.localFs.resolvePath(`skills/${p.skill_name}`, { create: true });
        if (!dir) throw new Error(`Could not create skills/${p.skill_name}.`);
        const fh = await dir.getFileHandle('SKILL.md', { create: true });
        const w = await fh.createWritable();
        await w.write(skillMd(p));
        await w.close();
        if (wfId !== null) {
            const scriptsDir = await dir.getDirectoryHandle('scripts', { create: true });
            const sfh = await scriptsDir.getFileHandle('run.py', { create: true });
            const sw = await sfh.createWritable();
            await sw.write(compiled ? snapshotPy : runPyTemplate(p, wfId));
            await sw.close();
        }
        return p.skill_name;
    }

    /**
     * Merge promotions target an EXISTING skill (skill_name === merge_target).
     * Never overwrite that skill's folder — just drop an eval-cases sidecar
     * file into it. The directory must already exist (resolvePath WITHOUT
     * {create:true}); a missing directory is a clear, surfaced failure.
     */
    async function writeMergeEvals(p) {
        await requireLocalFs();
        const dir = await window.localFs.resolvePath(`skills/${p.merge_target}`);
        if (!dir) {
            throw new Error(`Existing skill folder "skills/${p.merge_target}" was not found — cannot add eval cases.`);
        }
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
        const fh = await dir.getFileHandle(`genesis_evals_${stamp}.json`, { create: true });
        const w = await fh.createWritable();
        await w.write(JSON.stringify(p.eval_queries || [], null, 2));
        await w.close();
        return p.merge_target;
    }

    async function buildOne(p) {
        // 1. authorize (server gate is authoritative)
        let r = await fetch(window.apiUrl('/genesis/authorize'), {
            method: 'POST', headers: hdrs(),
            body: JSON.stringify({ promotion_id: p.id, estimate_usd: BUILD_ESTIMATE_USD, approved: true }),
        });
        let d = await r.json();
        if (!d.success || !d.allowed) {
            toast(`${t('genesis.buildFailed', 'Skill creation failed')}: ${reasonMessage(d)}`, 'error');
            return false;
        }
        // 2. build locally — merge promotions add a sidecar to an existing
        //    skill instead of writing/overwriting a SKILL.md folder.
        let outcome = 'failed'; let skillDir = null;
        try {
            if (p.is_merge) {
                skillDir = await writeMergeEvals(p);
                outcome = 'merged';
            } else {
                skillDir = await writeSkillFolder(p);
                outcome = 'born';
            }
        } catch (e) {
            console.error('[genesis] build failed:', e);
            toast(`${t('genesis.buildFailed', 'Skill creation failed')}: ${e.message}`, 'error');
        }
        // 3. record (spend ~0 for the local write; the reflection was already paid)
        await fetch(window.apiUrl('/genesis/record'), {
            method: 'POST', headers: hdrs(),
            body: JSON.stringify({ promotion_id: p.id, actual_usd: 0, outcome, skill_dir: skillDir }),
        }).catch(() => {});
        if (outcome === 'born' || outcome === 'merged') {
            toast(outcome === 'merged'
                ? `${t('genesis.merged', 'Eval cases added')}: ${skillDir}`
                : `${t('genesis.built', 'Skill created')}: ${skillDir}`, 'ok');
            if (window.skillsManager && typeof window.skillsManager.loadTree === 'function') {
                window.skillsManager.loadTree().catch(() => {});
            }
        }
        return outcome === 'born' || outcome === 'merged';
    }

    async function dismiss(id) {
        await fetch(window.apiUrl(`/genesis/promotions/${id}/dismiss`), { method: 'POST', headers: hdrs() })
            .catch(() => {});
    }

    function showProposal(p) {
        if (!p) { toast(t('genesis.noProcedure', 'No repeatable procedure found in this conversation.'), 'info'); return; }
        document.querySelectorAll('.gen-ov-backdrop').forEach(el => el.remove());
        const paramRows = p.parameter_schema
            ? Object.entries(p.parameter_schema).map(([k, v]) =>
                `<tr><td>${esc(k)}</td><td>${esc((v && v.type) || 'string')}</td><td>${esc(Array.isArray(v && v.examples) ? v.examples.join(', ') : (v && v.examples ? String(v.examples) : ''))}</td></tr>`).join('')
            : '';
        const approveLabel = p.is_merge
            ? t('genesis.approveMerge', 'Add eval cases to existing skill')
            : t('genesis.approveBuild', 'Create skill');
        const back = document.createElement('div');
        back.className = 'gen-ov-backdrop';
        back.innerHTML = `
        <div class="gen-ov">
            <h3>${t('genesis.proposalTitle', 'Skill proposal')}</h3>
            <p class="gen-ov-name">${esc(p.skill_name)}</p>
            <p class="gen-ov-desc">${esc(p.description)}</p>
            <div class="gen-ov-meta">
                <span>${(p.eval_queries || []).length} eval queries</span>
                ${p.rationale ? `<span>${esc(p.rationale)}</span>` : ''}
            </div>
            ${p.merge_target ? `<div class="gen-ov-merge">${t('genesis.mergeHint', 'Overlaps existing skill:')} <b>${esc(p.merge_target)}</b></div>` : ''}
            ${paramRows ? `<table><thead><tr><th>Parameter</th><th>Type</th><th>Examples</th></tr></thead><tbody>${paramRows}</tbody></table>` : ''}
            ${(workflowIdOf(p) !== null && !p.is_merge) ? `
            <div class="gen-ov-exec">
                <div class="gen-ov-exec-title">${t('genesis.execTitle', 'Execution')}</div>
                <label class="gen-exec-opt">
                    <input type="radio" name="gen-exec-mode" value="interpreted" checked>
                    <span><b>${t('genesis.execInterpreted', 'Interpreted')}</b> — ${t('genesis.execInterpretedDesc', 'runs the live workflow through the workflow engine; later edits to the workflow apply automatically')}</span>
                </label>
                <label class="gen-exec-opt">
                    <input type="radio" name="gen-exec-mode" value="compiled">
                    <span><b>${t('genesis.execCompiled', 'Compiled')}</b> — ${t('genesis.execCompiledDesc', 'Freezes the workflow into a Python snapshot; later edits to the workflow do not apply. This script will be used by SKILL.md')}</span>
                </label>
                <p class="gen-exec-hint">${t('genesis.execCompiledHint', 'The snapshot runs fully in the browser (agents via the backend, skills via the worker pool) — no external runner needed. Re-promote the workflow to refresh the snapshot.')}</p>
            </div>` : ''}
            <div class="gen-ov-actions">
                <button class="gen-btn-dismiss">${t('genesis.dismiss', 'Dismiss')}</button>
                <button class="gen-btn-approve">${approveLabel}</button>
            </div>
        </div>`;
        back.querySelector('.gen-btn-dismiss').addEventListener('click', async () => {
            await dismiss(p.id); back.remove();
        });
        back.querySelector('.gen-btn-approve').addEventListener('click', async (e) => {
            e.target.disabled = true;
            const mode = back.querySelector('input[name="gen-exec-mode"]:checked')?.value || 'interpreted';
            p.execution = { mode: mode === 'compiled' ? 'compiled' : 'interpreted' };
            const ok = await buildOne(p);
            if (ok) back.remove(); else e.target.disabled = false;
        });
        back.addEventListener('click', (e) => {
            if (e.target === back) {
                if (p.id > 0) {
                    dismiss(p.id).then(() => back.remove());
                } else {
                    back.remove();
                }
            }
        });
        document.body.appendChild(back);
    }

    window.genesisSystem = { showProposal, buildOne, dismiss, busy };
})();
