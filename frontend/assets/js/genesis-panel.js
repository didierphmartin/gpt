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
        .gen-exec-target{margin:6px 0 0 24px;font-size:12.5px;padding:4px 8px;border:1px solid #d1d5db;border-radius:6px;background:#fff}
        .gen-exec-target[disabled]{opacity:.5}
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

    /**
     * Fire-and-notify runner for COMPILED workflow skills: POST the frozen
     * snapshot (already in synergyAI/python/scripts/) to the local Python
     * runner's /api/run-file with the prompt as argv, stream its output, and
     * post the result into the conversation. Mirrors genesisWorkflowStart's
     * contract: returns a JSON string {started, run} synchronously.
     */
    function genesisCompiledStart(filename, prompt, workflowId) {
        const runNo = ++_genRunSeq;
        (async () => {
            const label = `compiled workflow #${workflowId} (${filename}, skill run ${runNo})`;
            const say = (text) => {
                if (window.chatApp && typeof window.chatApp.addMessage === 'function') {
                    window.chatApp.addMessage('assistant', text);
                } else {
                    toast(text.slice(0, 140), 'info');
                }
            };
            try {
                // Liveness probe: fail with a setup hint, not a silent hang.
                try {
                    const ping = await fetch('http://127.0.0.1:8765/health');
                    if (!ping.ok) throw new Error(`HTTP ${ping.status}`);
                } catch (_) {
                    say(`⚠️ **Compiled workflow #${workflowId} could not start** — the local Python runner is not running. `
                        + 'Start it with `cd synergyAI/python && python main.py` (port 8765), then run the skill again. '
                        + 'Or re-promote the workflow choosing Interpreted execution.');
                    return;
                }
                toast(`▶ Running ${label}…`, 'info');
                const resp = await fetch('http://127.0.0.1:8765/api/run-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename, args: [String(prompt)] }),
                });
                if (!resp.ok) {
                    say(`⚠️ **Compiled workflow #${workflowId} failed to start** — runner returned HTTP ${resp.status}: `
                        + (await resp.text()).slice(0, 300));
                    return;
                }
                // Stream the SSE body to completion, keeping the raw text.
                const reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let out = '';
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    out += decoder.decode(value, { stream: true });
                }
                // Strip SSE framing ("event: …" / "data: …" prefixes) to plain text.
                const text = out.split('\n')
                    .filter(l => !/^event: /.test(l))
                    .map(l => l.replace(/^data: /, ''))
                    .join('\n').trim();
                const MAX = 6000;
                const shown = text.length > MAX ? text.slice(-MAX) : text;
                const failed = /Traceback \(most recent call last\)|\[runner returned HTTP/.test(text);
                say((failed
                        ? `⚠️ **Compiled workflow #${workflowId} finished with errors** (${filename})`
                        : `🧬 **Compiled workflow #${workflowId} completed** (${filename})`)
                    + '\n\n```\n' + shown + '\n```');
            } catch (e) {
                say(`⚠️ Compiled ${label} failed: ${String((e && e.message) || e)}`);
            }
        })();
        return JSON.stringify({ started: true, run: runNo });
    }
    window.genesisCompiledStart = genesisCompiledStart;

    /** Workflow-backed promotion? (class 2 rows carry source_ref 'workflow:<id>') */
    function workflowIdOf(p) {
        const m = /^workflow:(\d+)$/.exec(p.source_ref || '');
        return m ? Number(m[1]) : null;
    }

    /**
     * Compiled-execution targets. Each maps to the backend generator endpoint
     * whose Content-Disposition names the .py the local Python runner
     * (langchain_runner, port 8765) executes from synergyAI/python/scripts/.
     */
    const COMPILE_TARGETS = {
        langgraph: { endpoint: 'generate-python', label: 'LangGraph — Python' },
        adk:       { endpoint: 'generate-adk',    label: 'Google ADK — Python' },
        maf:       { endpoint: 'generate-maf',    label: 'Microsoft Agent Framework — Python' },
    };
    const RUNNER_BASE = 'http://127.0.0.1:8765'; // langchain_runner/main.py

    /**
     * Fetch the compiled Python for a workflow from the backend generator and
     * return { filename, code }. The filename comes from Content-Disposition —
     * the same name the editor's Generate action uses, so the runner's
     * /api/run-file resolves it.
     */
    async function fetchCompiledCode(wfId, target) {
        const tgt = COMPILE_TARGETS[target];
        if (!tgt) throw new Error(`Unknown compile target "${target}"`);
        const r = await fetch(window.apiUrl(`/workflows/${wfId}/${tgt.endpoint}?download=1`), { headers: hdrs() });
        if (!r.ok) throw new Error(`Code generation failed (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`);
        const dispo = r.headers.get('Content-Disposition') || '';
        const m = /filename="([^"]+)"/.exec(dispo);
        const filename = m ? m[1] : `workflow_${wfId}_${target}.py`;
        return { filename, code: await r.text() };
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
            howToRun = `\n## How to run\n\nThis skill runs a COMPILED snapshot of workflow #${wfId} (${COMPILE_TARGETS[compiled.target]?.label || compiled.target}) in the local Python runner. The code was generated at promotion time — later edits to the workflow do NOT affect this skill (re-promote to refresh).\n\nRequirements: the local Python runner must be running (synergyAI/python → \`python main.py\`, port 8765).\n\nOn every invocation you MUST:\n1. Compose a single plain-language instruction for the workflow from the user's request, explicitly filling in the parameters documented above (use defaults when the user did not specify one).\n2. Call \`run_skill_script\` with script \`scripts/run.py\` and argv \`["--prompt", "<your composed instruction>"]\`.\n3. The script starts the compiled run and returns immediately; the results are posted into the conversation automatically when it completes. Tell the user the workflow is running — do NOT invent or predict results.\n\nDo NOT attempt to perform the workflow's steps yourself.\n`;
        } else if (wfId !== null) {
            howToRun = `\n## How to run\n\nThis skill executes workflow #${wfId} by reference (edits in the workflow editor flow through automatically).\n\nOn every invocation you MUST:\n1. Compose a single plain-language instruction for the workflow from the user's request, explicitly filling in the parameters documented above (use defaults when the user did not specify one).\n2. Call \`run_skill_script\` with script \`scripts/run.py\` and argv \`["--prompt", "<your composed instruction>"]\`.\n3. The script starts the run and returns immediately; the full results are posted into the conversation automatically when the run completes. Tell the user the workflow is running — do NOT invent or predict results.\n\nDo NOT attempt to perform the workflow's steps yourself — the workflow engine runs them (a run may take several minutes; that is normal).\n`;
        }
        const execLine = compiled ? `execution: compiled-${compiled.target}\n` : (wfId !== null ? 'execution: interpreted\n' : '');
        return `---\nname: ${p.skill_name}\ndescription: ${String(p.description).replace(/\n/g, ' ')}\nfetches_urls: false\n${execLine}---\n\n# ${p.skill_name}\n\n${p.description}\n${params}${howToRun}\n## Provenance\n\nCreated by skill genesis (${wfId !== null ? (compiled ? `L1 compiled dispatcher (${compiled.target})` : 'L1 workflow dispatcher') : 'L0'}) from ${p.source_ref || 'user material'} on ${new Date().toISOString().slice(0, 10)}.\n\n## Eval queries\n\n\`\`\`json\n${JSON.stringify(p.eval_queries || [], null, 2)}\n\`\`\`\n`;
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
     * scripts/run.py for COMPILED workflow skills: fire-and-notify into the
     * local Python runner via window.genesisCompiledStart. The compiled .py
     * (snapshot from promotion time) lives in synergyAI/python/scripts/ where
     * langchain_runner's /api/run-file resolves it; the prompt travels as
     * argv (all three generators accept " ".join(sys.argv[1:])).
     */
    function compiledRunPyTemplate(p, wfId, filename, target) {
        return `#!/usr/bin/env python3
"""Compiled dispatcher for the '${p.skill_name}' skill.

Runs the ${target} snapshot of workflow #${wfId} (${filename}) in the local
Python runner. Generated by skill genesis (L1 compiled). The snapshot is
frozen at promotion time — re-promote the workflow to refresh it.
"""

import argparse
import asyncio
import json
import sys

from js import window

WORKFLOW_ID = ${wfId}
SCRIPT_FILENAME = ${JSON.stringify(filename)}


async def _run(prompt: str) -> int:
    starter = getattr(window, "genesisCompiledStart", None)
    if starter is None:
        print("COMPILED RUN FAILED: genesis runtime not loaded (refresh the app)", file=sys.stderr)
        return 1
    info = json.loads(str(starter(SCRIPT_FILENAME, prompt, WORKFLOW_ID)))
    if not info.get("started"):
        print(f"COMPILED RUN FAILED: {json.dumps(info)[:300]}", file=sys.stderr)
        return 1
    print(f"Compiled workflow #{WORKFLOW_ID} ({SCRIPT_FILENAME}) STARTED in the local Python runner.")
    print("The results will be posted into this conversation automatically when the run completes.")
    print("Tell the user the workflow is running and that results will follow — "
          "do NOT invent or predict the results.")
    return 0


def main():
    ap = argparse.ArgumentParser(description="Run the compiled workflow snapshot with a composed prompt.")
    ap.add_argument("--prompt", required=True,
                    help="Full plain-language instruction for the workflow run")
    args = ap.parse_args()
    sys.exit(asyncio.run(_run(args.prompt)))


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

        // Compiled: generate the snapshot FIRST — if generation fails, no
        // half-built skill folder is left behind.
        let artifact = null;
        if (compiled) {
            // Runner-installed sentinel (same probe as the editor's Generate).
            const runnerEntry = await window.localFs.resolvePath('python/main.py', { create: false, kind: 'file' });
            if (!runnerEntry) {
                throw new Error('Local Python runner not installed (synergyAI/python). Install it or choose Interpreted.');
            }
            artifact = await fetchCompiledCode(wfId, compiled.target);
            // Write where the runner's /api/run-file resolves scripts.
            const pyScripts = await window.localFs.resolvePath('python/scripts', { create: true });
            if (!pyScripts) throw new Error('Could not resolve synergyAI/python/scripts.');
            const pfh = await pyScripts.getFileHandle(artifact.filename, { create: true });
            const pw = await pfh.createWritable();
            await pw.write(artifact.code);
            await pw.close();
            // Provider keys → python/.env so the compiled script can auth.
            try { await window.workflowEditor?._syncRunnerEnv?.(); } catch (_) {}
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
            await sw.write(compiled
                ? compiledRunPyTemplate(p, wfId, artifact.filename, compiled.target)
                : runPyTemplate(p, wfId));
            await sw.close();
            if (compiled) {
                // Provenance copy of the frozen snapshot inside the skill —
                // lets the user re-install into python/scripts/ if wiped.
                const cfh = await scriptsDir.getFileHandle(artifact.filename, { create: true });
                const cw = await cfh.createWritable();
                await cw.write(artifact.code);
                await cw.close();
            }
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
                    <span><b>${t('genesis.execCompiled', 'Compiled')}</b> — ${t('genesis.execCompiledDesc', 'generates Python code now and runs it in the local Python runner; frozen snapshot, later edits do not apply')}</span>
                </label>
                <select class="gen-exec-target" disabled>
                    ${Object.entries(COMPILE_TARGETS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}
                </select>
                <p class="gen-exec-hint">${t('genesis.execCompiledHint', 'Compiled runs need the local Python runner (synergyAI/python, port 8765). Agent nodes bound to browser skills cannot execute those skills in the runner.')}</p>
            </div>` : ''}
            <div class="gen-ov-actions">
                <button class="gen-btn-dismiss">${t('genesis.dismiss', 'Dismiss')}</button>
                <button class="gen-btn-approve">${approveLabel}</button>
            </div>
        </div>`;
        back.querySelector('.gen-btn-dismiss').addEventListener('click', async () => {
            await dismiss(p.id); back.remove();
        });
        // Compiled-target select follows the radio choice.
        const targetSel = back.querySelector('.gen-exec-target');
        back.querySelectorAll('input[name="gen-exec-mode"]').forEach(rb => {
            rb.addEventListener('change', () => {
                if (targetSel) targetSel.disabled = back.querySelector('input[name="gen-exec-mode"]:checked')?.value !== 'compiled';
            });
        });
        back.querySelector('.gen-btn-approve').addEventListener('click', async (e) => {
            e.target.disabled = true;
            const mode = back.querySelector('input[name="gen-exec-mode"]:checked')?.value || 'interpreted';
            p.execution = mode === 'compiled'
                ? { mode: 'compiled', target: targetSel?.value || 'langgraph' }
                : { mode: 'interpreted' };
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
