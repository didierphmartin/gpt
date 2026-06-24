/**
 * SkillOpt Panel — per-skill optimization UI.
 *
 * Opened from the 3-dot context menu on a skill ("🧠 Optimize…"). Builds a
 * single shared modal lazily and parametrizes it for the skill in question.
 *
 * Three tabs:
 *   Configure & Launch — form for run_loop / run_body_loop arguments
 *   Monitor            — live progress while a run is in flight (poll-based)
 *   Results            — list past runs from the skill's body-opt-results/,
 *                        diff of accepted edits, Revert button (uses .preopt.bak)
 *
 * Inspired by Microsoft's SkillOpt Gradio webui (~/Documents/SkillOpt/
 * skillopt_webui/app.py) — borrows layout ideas but no Python/Gradio runtime;
 * native HTML/JS calling our existing scripts via window.pyodideRunner.
 *
 * Public API:
 *   window.skillOptPanel.openFor(skill)
 *     where `skill` is the skills-manager skill object (has dir_name).
 */
(function () {
    'use strict';

    // ─── Constants ─────────────────────────────────────────────────────────
    const SKILL_CREATOR_DIR = 'skill-creator';
    const SCRIPT_BODY_LOOP  = 'scripts/run_body_loop.py';
    const SCRIPT_DESC_LOOP  = 'scripts/run_loop.py';
    const POLL_INTERVAL_MS  = 3000;
    const PREFS_KEY         = 'skillopt.prefs.v1';

    // Supported models per provider — sourced from backend Providers/*.php
    // SUPPORTED_MODELS constants (as of 2026-05-30). Grok / DeepSeek / Kimi
    // expose their list via config, so we ship sensible defaults and let the
    // "Custom…" option cover anything else the deployment has configured.
    const MODELS_BY_PROVIDER = {
        claude: [
            'claude-sonnet-4-5-20250929',
            'claude-3-5-sonnet-20241022',
            'claude-3-opus-20240229',
            'claude-3-sonnet-20240229',
            'claude-3-haiku-20240307',
        ],
        openai: [
            'gpt-4o',
            'gpt-4o-mini',
            'gpt-4-turbo',
            'gpt-4-turbo-preview',
            'gpt-4',
            'gpt-3.5-turbo',
        ],
        gemini: [
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemini-2.5-pro',
            'gemini-2.0-flash',
            'gemini-2.0-flash-lite',
            'gemini-3-flash-preview',
            'gemini-3-flash-lite-preview',
            'gemini-3-pro-preview',
            'gemini-1.5-flash',
            'gemini-1.5-pro',
        ],
        grok:     ['grok-4-1-fast-reasoning'],
        deepseek: ['deepseek-v4-pro'],
        kimi:     ['kimi-k2.6'],
    };
    const PROVIDERS = Object.keys(MODELS_BY_PROVIDER);
    function defaultModelFor(provider) {
        const list = MODELS_BY_PROVIDER[provider] || [];
        return list[0] || '';
    }

    // Default form values used when no per-skill prefs are cached yet.
    // modelByProvider lets the user keep a preferred model per provider —
    // switching providers doesn't wipe the previously-chosen Claude model.
    const DEFAULTS = {
        loopType: 'body',                          // 'body' | 'description'
        provider: 'claude',
        modelByProvider: {
            claude:   'claude-sonnet-4-5-20250929',
            openai:   'gpt-4o',
            gemini:   'gemini-2.5-flash',
            grok:     'grok-4-1-fast-reasoning',
            deepseek: 'deepseek-v4-pro',
            kimi:     'kimi-k2.6',
        },
        maxIterations: 3,
        lrBudget:      2,
        runsPerQuery:  3,
        softThreshold: 4,
        strictGate:    true,
    };

    // ─── Prefs (cached per-skill in localStorage) ──────────────────────────
    function loadPrefs(dirName) {
        try {
            const all = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
            const raw = all[dirName] || {};
            // Deep-merge modelByProvider so user's per-provider picks survive.
            const merged = {
                ...DEFAULTS,
                ...raw,
                modelByProvider: { ...DEFAULTS.modelByProvider, ...(raw.modelByProvider || {}) },
            };
            // Migration: legacy `model` string (pre-multi-provider prefs) was
            // a single field; pin it to whichever provider was selected.
            if (raw.model && typeof raw.model === 'string' && raw.provider) {
                merged.modelByProvider[raw.provider] = raw.model;
            }
            return merged;
        } catch { return { ...DEFAULTS, modelByProvider: { ...DEFAULTS.modelByProvider } }; }
    }
    function savePrefs(dirName, prefs) {
        try {
            const all = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
            // Don't keep the legacy `model` field around once migrated.
            const { model, ...clean } = prefs;
            all[dirName] = clean;
            localStorage.setItem(PREFS_KEY, JSON.stringify(all));
        } catch {}
    }

    // ─── State ─────────────────────────────────────────────────────────────
    const state = {
        skill: null,            // current skill object (dir_name etc.)
        running: false,         // a runSkillScript is in flight
        resultsDir: null,       // pyodide-vfs path passed via --results-dir
        runStartedAt: 0,
        pollTimer: null,
        runPromise: null,
        lastSnapshot: null,     // last results snapshot (for "no change" suppress)
    };

    // ─── DOM builders ──────────────────────────────────────────────────────
    function buildModal() {
        const overlay = document.createElement('div');
        overlay.id = 'skillopt-overlay';
        overlay.className = 'fixed inset-0 z-[10000] flex items-center justify-center hidden';
        overlay.style.background = 'rgba(0,0,0,0.55)';
        overlay.innerHTML = `
            <div class="bg-white rounded-xl shadow-2xl flex flex-col"
                 style="width: min(960px, calc(100vw - 32px)); max-height: calc(100vh - 64px);"
                 role="dialog" aria-labelledby="skillopt-title">
                <div class="px-5 py-3 border-b border-gray-200">
                    <div class="flex items-center justify-between">
                        <h2 id="skillopt-title" class="text-base font-semibold text-gray-900 flex items-center gap-2">
                            <span>🧠</span>
                            <span>SkillOpt &middot; <span id="skillopt-skill-name" class="font-mono text-indigo-700"></span></span>
                        </h2>
                        <button type="button" id="skillopt-close"
                                class="text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded p-1 transition"
                                aria-label="Close">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>
                    <div class="flex gap-1 mt-3" id="skillopt-tabs">
                        <button data-tab="configure" class="skillopt-tab px-3 py-1.5 text-xs font-medium rounded-md transition bg-indigo-100 text-indigo-700">⚙️ Configure &amp; Launch</button>
                        <button data-tab="monitor"   class="skillopt-tab px-3 py-1.5 text-xs font-medium rounded-md transition text-gray-600 hover:bg-gray-100">📊 Monitor</button>
                        <button data-tab="results"   class="skillopt-tab px-3 py-1.5 text-xs font-medium rounded-md transition text-gray-600 hover:bg-gray-100">📈 Results</button>
                    </div>
                </div>

                <div class="overflow-auto px-6 py-4" style="flex: 1 1 auto;">
                    <div id="skillopt-pane-configure"></div>
                    <div id="skillopt-pane-monitor" class="hidden"></div>
                    <div id="skillopt-pane-results" class="hidden"></div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        // Close handlers (X, backdrop click, Escape)
        const close = () => hideModal();
        overlay.querySelector('#skillopt-close').addEventListener('click', close);
        overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && !overlay.classList.contains('hidden')) close();
        });

        // Tab switching
        overlay.querySelectorAll('.skillopt-tab').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });

        return overlay;
    }

    function switchTab(name) {
        const overlay = document.getElementById('skillopt-overlay');
        if (!overlay) return;
        overlay.querySelectorAll('.skillopt-tab').forEach(b => {
            const on = b.dataset.tab === name;
            b.classList.toggle('bg-indigo-100', on);
            b.classList.toggle('text-indigo-700', on);
            b.classList.toggle('text-gray-600', !on);
            b.classList.toggle('hover:bg-gray-100', !on);
        });
        ['configure', 'monitor', 'results'].forEach(n => {
            const p = overlay.querySelector('#skillopt-pane-' + n);
            if (p) p.classList.toggle('hidden', n !== name);
        });
        if (name === 'results') refreshResultsList();
    }

    // ─── Configure pane ────────────────────────────────────────────────────
    function renderConfigurePane(skill) {
        const prefs = loadPrefs(skill.dir_name);
        const html = `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div class="space-y-4">
                    <div>
                        <label class="block text-xs font-medium text-gray-700 mb-1">Loop type</label>
                        <div class="flex gap-2">
                            <label class="flex-1 border rounded-md px-3 py-2 cursor-pointer text-xs">
                                <input type="radio" name="loopType" value="body" ${prefs.loopType==='body'?'checked':''} class="mr-2"/>
                                <span class="font-medium">Body</span> &middot; tunes <em>what</em> the LLM does once triggered
                            </label>
                            <label class="flex-1 border rounded-md px-3 py-2 cursor-pointer text-xs">
                                <input type="radio" name="loopType" value="description" ${prefs.loopType==='description'?'checked':''} class="mr-2"/>
                                <span class="font-medium">Description</span> &middot; tunes <em>when</em> the LLM triggers
                            </label>
                        </div>
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-700 mb-1">Provider</label>
                        <select id="so-provider" class="block w-full text-sm border-gray-300 rounded-md">
                            ${PROVIDERS.map(p =>
                                `<option value="${p}" ${prefs.provider===p?'selected':''}>${p}</option>`).join('')}
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-700 mb-1">Model</label>
                        <select id="so-model-select" class="block w-full text-sm border-gray-300 rounded-md font-mono"></select>
                        <input id="so-model-custom" type="text" value=""
                               placeholder="Enter custom model identifier"
                               class="block w-full text-sm border-gray-300 rounded-md font-mono mt-1 hidden"/>
                        <p class="text-[10px] text-gray-500 mt-1">Pick from your provider's supported list, or choose <em>Custom…</em> for any other model the backend knows about.</p>
                    </div>
                    <div>
                        <label class="flex items-center gap-2 text-xs font-medium text-gray-700">
                            <input type="checkbox" id="so-strict" ${prefs.strictGate?'checked':''}/>
                            Strict gate &middot; <span class="font-normal text-gray-600">reject any per-case regression</span>
                        </label>
                    </div>
                </div>
                <div class="space-y-4">
                    ${sliderRow('so-maxiter', 'Max iterations', 1, 5, prefs.maxIterations, 'how many propose→eval rounds')}
                    ${sliderRow('so-lr',      'lr-budget', 1, 5, prefs.lrBudget, 'max edits per iteration')}
                    ${sliderRow('so-runs',    'Runs per query', 1, 5, prefs.runsPerQuery, 'denoise — N runs per case, majority vote')}
                    ${sliderRow('so-soft',    'Soft threshold', 1, 5, prefs.softThreshold, 'min judge score (1-5) to count a case as passing')}
                </div>
            </div>
            <div class="flex items-center gap-3 mt-6 pt-4 border-t border-gray-200">
                <button id="so-launch" class="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed">🚀 Launch</button>
                <button id="so-selfheal" class="px-4 py-2 bg-emerald-600 text-white text-sm font-semibold rounded-md hover:bg-emerald-700" title="Diagnose this skill from its traces and heal it through the cost gate (auto-picks description vs body; respects your Auto mode + budget)">🩺 Self-heal</button>
                <button id="so-stop"   class="px-4 py-2 bg-gray-200 text-gray-800 text-sm font-semibold rounded-md hover:bg-gray-300 hidden">🛑 Stop (will finish current step)</button>
                <span id="so-status" class="text-xs text-gray-600"></span>
            </div>
            <div class="text-[11px] text-gray-500 mt-3 leading-relaxed">
                Skill: <code class="bg-gray-100 px-1.5 rounded">synergyAI/skills/${escapeHtml(skill.dir_name)}/</code>.
                The script writes a pre-optimization backup of SKILL.md to <code class="bg-gray-100 px-1.5 rounded">SKILL.md.preopt.bak</code> in that folder.
            </div>
        `;
        const pane = document.getElementById('skillopt-pane-configure');
        pane.innerHTML = html;
        // Wire form
        pane.querySelectorAll('input[type=range]').forEach(r => {
            const out = pane.querySelector(`output[for="${r.id}"]`);
            if (out) r.addEventListener('input', () => out.textContent = r.value);
        });

        // Provider → repopulate the model dropdown with that provider's list.
        // Keep the user's last-picked model PER PROVIDER (prefs.modelByProvider)
        // so switching back to a provider you've used before restores its model.
        const providerEl = pane.querySelector('#so-provider');
        const modelEl    = pane.querySelector('#so-model-select');
        const customEl   = pane.querySelector('#so-model-custom');
        function populateModels(provider) {
            const list = MODELS_BY_PROVIDER[provider] || [];
            const remembered = (prefs.modelByProvider || {})[provider] || list[0] || '';
            const knownPick = list.includes(remembered) ? remembered : null;
            const opts = list.map(m =>
                `<option value="${escapeHtml(m)}" ${m===knownPick?'selected':''}>${escapeHtml(m)}</option>`
            ).join('') + `<option value="__custom__" ${!knownPick && remembered ? 'selected' : ''}>Custom…</option>`;
            modelEl.innerHTML = opts;
            // If the remembered model isn't in the supported list (e.g. user
            // typed a custom one), reveal the custom-text input pre-filled.
            if (!knownPick && remembered) {
                customEl.value = remembered;
                customEl.classList.remove('hidden');
            } else {
                customEl.classList.add('hidden');
                customEl.value = '';
            }
        }
        populateModels(providerEl.value);
        providerEl.addEventListener('change', () => populateModels(providerEl.value));
        modelEl.addEventListener('change', () => {
            const show = modelEl.value === '__custom__';
            customEl.classList.toggle('hidden', !show);
            if (show && !customEl.value) customEl.focus();
        });

        pane.querySelector('#so-launch').addEventListener('click', () => launchRun(skill));
        // Diagnosis-driven, cost-gated heal for THIS skill (heal-panel.js).
        pane.querySelector('#so-selfheal')?.addEventListener('click', () => {
            if (window.healSystem && window.healSystem.healOne) {
                window.healSystem.healOne(skill.dir_name);
            } else {
                updateStatus('Self-heal module not loaded.', 'error');
            }
        });
        pane.querySelector('#so-stop').addEventListener('click', () => {
            // We can't kill a runSkillScript in flight; just mark intent.
            updateStatus('Stop requested — the current step will finish, then the loop exits.');
        });
    }

    function sliderRow(id, label, min, max, val, hint) {
        return `
            <div>
                <div class="flex items-baseline justify-between mb-1">
                    <label for="${id}" class="text-xs font-medium text-gray-700">${label}</label>
                    <output for="${id}" class="text-xs font-mono text-indigo-700">${val}</output>
                </div>
                <input id="${id}" type="range" min="${min}" max="${max}" step="1" value="${val}" class="w-full"/>
                <p class="text-[10px] text-gray-500 mt-0.5">${hint}</p>
            </div>
        `;
    }

    function collectForm() {
        const pane = document.getElementById('skillopt-pane-configure');
        if (!pane) return null;
        const provider = pane.querySelector('#so-provider').value;
        const selVal = pane.querySelector('#so-model-select').value;
        const model = selVal === '__custom__'
            ? pane.querySelector('#so-model-custom').value.trim()
            : selVal;
        // Persist this provider→model pairing so a future open of this skill
        // restores the correct model when the same provider is reselected.
        const modelByProvider = { ...(loadPrefs(state.skill?.dir_name).modelByProvider || {}) };
        if (model) modelByProvider[provider] = model;
        return {
            loopType: pane.querySelector('input[name="loopType"]:checked')?.value || 'body',
            provider,
            model,
            modelByProvider,
            maxIterations: parseInt(pane.querySelector('#so-maxiter').value, 10),
            lrBudget:      parseInt(pane.querySelector('#so-lr').value, 10),
            runsPerQuery:  parseInt(pane.querySelector('#so-runs').value, 10),
            softThreshold: parseInt(pane.querySelector('#so-soft').value, 10),
            strictGate:    pane.querySelector('#so-strict').checked,
        };
    }

    function updateStatus(msg, kind) {
        const el = document.querySelector('#so-status');
        if (!el) return;
        el.textContent = msg || '';
        el.className = 'text-xs ' + (
            kind === 'error' ? 'text-red-700 font-medium' :
            kind === 'ok'    ? 'text-emerald-700 font-medium' :
            'text-gray-600'
        );
    }

    // ─── Run lifecycle ─────────────────────────────────────────────────────
    async function launchRun(skill) {
        if (state.running) { updateStatus('A run is already in progress.', 'error'); return; }
        const form = collectForm();
        if (!form) return;
        if (!form.model) { updateStatus('Pick a model first.', 'error'); return; }
        savePrefs(skill.dir_name, form);

        const isBody = form.loopType === 'body';
        const script = isBody ? SCRIPT_BODY_LOOP : SCRIPT_DESC_LOOP;
        // The eval set is expected to live next to SKILL.md.
        const skillRel  = `synergyAI/skills/${skill.dir_name}/`;
        const evalSet   = `${skillRel}eval_set.json`;
        // Persistent results dir inside the skill (FSA-mounted, survives session).
        const resultsDir = `/skill/${skill.dir_name}/${isBody ? 'body-opt-results' : 'desc-opt-results'}`;
        state.resultsDir = resultsDir;

        const argv = [
            '--eval-set',   evalSet,
            '--skill-path', skillRel,
            '--model',      form.model,
            '--provider',   form.provider,
            '--max-iterations', String(form.maxIterations),
            '--lr-budget',  String(form.lrBudget),
            '--verbose',
            '--results-dir', resultsDir,
        ];
        if (isBody) {
            argv.push('--runs-per-query', String(form.runsPerQuery));
            argv.push('--soft-threshold', String(form.softThreshold));
        }
        if (!form.strictGate) argv.push('--lenient-gate');

        // UI state — switch to Monitor, lock the form
        state.running = true;
        state.runStartedAt = Date.now();
        state.lastSnapshot = null;
        document.querySelector('#so-launch').disabled = true;
        document.querySelector('#so-stop').classList.remove('hidden');
        updateStatus('Launching…');
        renderMonitorEmpty(form, skill);
        switchTab('monitor');
        startPolling();

        try {
            const runPromise = window.pyodideRunner.runSkillScript({
                dirName: SKILL_CREATOR_DIR,
                script,
                argv,
            });
            state.runPromise = runPromise;
            const result = await runPromise;
            await finalizeRun(skill, /*ok=*/true, result);
        } catch (e) {
            console.error('[skillopt] runSkillScript failed:', e);
            await finalizeRun(skill, /*ok=*/false, { error: String(e?.message || e) });
        }
    }

    async function finalizeRun(skill, ok, result) {
        state.running = false;
        stopPolling();
        document.querySelector('#so-launch').disabled = false;
        document.querySelector('#so-stop').classList.add('hidden');
        const elapsed = ((Date.now() - state.runStartedAt) / 1000).toFixed(0);
        if (ok) {
            updateStatus(`Done in ${elapsed}s — see Results tab.`, 'ok');
        } else {
            updateStatus(`Run failed after ${elapsed}s: ${result?.error || 'unknown error'}`, 'error');
        }
        // One last snapshot read so Monitor reflects the final state.
        await readSnapshot();
        renderMonitorFromSnapshot(state.lastSnapshot);
        // Refresh Results list in the background.
        refreshResultsList();
    }

    // ─── Polling (read incremental log files via FSA) ──────────────────────
    function startPolling() {
        stopPolling();
        state.pollTimer = setInterval(async () => {
            try {
                await readSnapshot();
                renderMonitorFromSnapshot(state.lastSnapshot);
            } catch (e) {
                // Non-fatal — likely the results dir doesn't exist yet.
            }
        }, POLL_INTERVAL_MS);
    }
    function stopPolling() {
        if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    }

    /**
     * Locate the latest run directory under the configured results dir and
     * read whatever incremental log files are present. Returns a snapshot:
     *   { runDir, baseline?, iterations: [{n, phase, score?, accepted?, regressions?}], crashed? }
     */
    async function readSnapshot() {
        if (!state.resultsDir || !state.skill) return;
        // Resolve the host path through FSA so we read the live disk view.
        // /skill/<dir>/body-opt-results/ — the parent of timestamped run dirs.
        const parts = state.resultsDir.split('/').filter(Boolean);  // ["skill","<dir>","body-opt-results"]
        if (parts[0] !== 'skill') return;
        const subPath = parts.slice(2).join('/');                    // "body-opt-results"
        const hostPath = `skills/${state.skill.dir_name}/${subPath}`;
        const dirHandle = await window.localFs.resolvePath(hostPath);
        if (!dirHandle) return;
        // Find newest sub-folder (body-loop_*_<timestamp>)
        let newest = null, newestName = '';
        for await (const entry of dirHandle.values()) {
            if (entry.kind !== 'directory') continue;
            if (entry.name > newestName) { newest = entry; newestName = entry.name; }
        }
        if (!newest) { state.lastSnapshot = { phase: 'starting' }; return; }
        // Read logs/*.json + (if present) results.json
        const snap = { runDir: newestName, iterations: [] };
        let logsDir = null;
        try { logsDir = await newest.getDirectoryHandle('logs'); } catch { logsDir = null; }
        if (logsDir) {
            for await (const f of logsDir.values()) {
                if (f.kind !== 'file' || !f.name.endsWith('.json')) continue;
                try {
                    const text = await (await f.getFile()).text();
                    const json = JSON.parse(text);
                    if (f.name === '00-baseline.json') {
                        snap.baseline = json.summary?.overall_passed != null
                            ? `${json.summary.overall_passed}/${json.summary.total_body_cases}`
                            : null;
                        snap.baselineRaw = json.summary || null;
                    } else if (/^\d{2}-eval\.json$/.test(f.name)) {
                        const n = parseInt(f.name.slice(0, 2), 10);
                        snap.iterations.push({ n, kind: 'eval', summary: json.summary });
                    } else if (/^\d{2}-patch\.json$/.test(f.name)) {
                        const n = parseInt(f.name.slice(0, 2), 10);
                        snap.iterations.push({ n, kind: 'patch',
                            reasoning: json.reasoning || '',
                            applied: json.applied, skipped: (json.skipped || []).length,
                        });
                    }
                } catch {}
            }
        }
        // Did the parent dir get a results.json (== run finished cleanly)?
        try {
            const rj = await newest.getFileHandle('results.json');
            const txt = await (await rj.getFile()).text();
            snap.results = JSON.parse(txt);
        } catch {}
        state.lastSnapshot = snap;
    }

    // ─── Monitor pane ──────────────────────────────────────────────────────
    function renderMonitorEmpty(form, skill) {
        const pane = document.getElementById('skillopt-pane-monitor');
        const elapsed = ((Date.now() - state.runStartedAt) / 1000).toFixed(0);
        pane.innerHTML = `
            <div class="text-xs text-gray-700 space-y-3">
                <div class="flex items-center gap-2">
                    <span class="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
                    <span class="font-medium">Running</span>
                    <span class="text-gray-500">${form.loopType} loop · ${escapeHtml(form.model)} · ${elapsed}s</span>
                </div>
                <div class="text-gray-500">Polling results every ${(POLL_INTERVAL_MS/1000)|0}s. Log files appear here as iterations complete.</div>
            </div>
        `;
    }

    function renderMonitorFromSnapshot(snap) {
        const pane = document.getElementById('skillopt-pane-monitor');
        if (!pane) return;
        if (!snap) { pane.innerHTML = `<div class="text-xs text-gray-500">No run started yet.</div>`; return; }
        const elapsed = state.running ? `${((Date.now()-state.runStartedAt)/1000)|0}s` : '';
        const dot = state.running
            ? `<span class="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>`
            : `<span class="inline-block w-2 h-2 rounded-full bg-emerald-500"></span>`;
        let html = `
            <div class="flex items-center gap-2 mb-3 text-xs">
                ${dot}
                <span class="font-medium">${state.running ? 'Running' : 'Done'}</span>
                <span class="text-gray-500">${escapeHtml(snap.runDir || '')} ${elapsed}</span>
            </div>
        `;
        if (snap.baseline) {
            html += `<div class="mb-2 text-xs"><span class="font-medium">Baseline:</span> <span class="font-mono">${escapeHtml(snap.baseline)}</span>`;
            if (snap.baselineRaw) {
                html += ` <span class="text-gray-500">(hard ${snap.baselineRaw.hard_passed}/${snap.baselineRaw.total_body_cases}, avg soft ${snap.baselineRaw.avg_soft_score}/5)</span>`;
            }
            html += `</div>`;
        }
        // Group iterations by n, fold patch + eval together
        const byN = {};
        (snap.iterations || []).forEach(it => { (byN[it.n] = byN[it.n] || { n: it.n }); byN[it.n][it.kind] = it; });
        const ns = Object.keys(byN).map(Number).sort((a,b)=>a-b);
        if (ns.length) {
            html += `<div class="border border-gray-200 rounded-md divide-y divide-gray-100">`;
            ns.forEach(n => {
                const row = byN[n];
                const evalS = row.eval?.summary;
                const score = evalS ? `${evalS.overall_passed}/${evalS.total_body_cases}` : '—';
                html += `
                    <div class="px-3 py-2">
                        <div class="flex items-center justify-between text-xs">
                            <div class="font-medium">Iteration ${n}</div>
                            <div class="font-mono text-indigo-700">${escapeHtml(score)}</div>
                        </div>
                        ${row.patch ? `<div class="text-[11px] text-gray-600 mt-1"><span class="font-medium">Analyst:</span> ${escapeHtml((row.patch.reasoning||'').slice(0,220))}${row.patch.reasoning?.length > 220 ? '…' : ''}</div>
                            <div class="text-[11px] text-gray-500 mt-0.5">${row.patch.applied||0} applied · ${row.patch.skipped||0} skipped</div>` : ''}
                    </div>
                `;
            });
            html += `</div>`;
        } else if (snap.results == null) {
            html += `<div class="text-xs text-gray-500 mt-2">Waiting for first iteration…</div>`;
        }
        // Final summary if results.json present
        if (snap.results) {
            const r = snap.results;
            const accepted = r.history?.filter(h => h.phase === 'iteration' && h.accepted).length || 0;
            html += `
                <div class="mt-4 p-3 bg-gray-50 rounded-md text-xs space-y-1">
                    <div><span class="font-medium">Exit:</span> ${escapeHtml(r.exit_reason||'')}</div>
                    <div><span class="font-medium">Score:</span> ${escapeHtml(r.baseline_score||'')} → <span class="font-mono text-indigo-700">${escapeHtml(r.best_score||'')}</span> (net ${r.net_improvement>=0?'+':''}${r.net_improvement})</div>
                    <div><span class="font-medium">Iterations:</span> ${accepted} accepted / ${r.iterations_rejected} rejected of ${r.iterations_run||0}</div>
                    <div><span class="font-medium">Body changed:</span> ${r.body_changed ? 'YES (see Results tab to diff/revert)' : 'no'}</div>
                </div>
            `;
        }
        pane.innerHTML = html;
    }

    // ─── Results pane ──────────────────────────────────────────────────────
    async function refreshResultsList() {
        if (!state.skill) return;
        const pane = document.getElementById('skillopt-pane-results');
        if (!pane) return;
        pane.innerHTML = `<div class="text-xs text-gray-500">Loading…</div>`;

        // List both desc-opt-results/ and body-opt-results/ if present.
        const runs = [];
        for (const sub of ['body-opt-results', 'desc-opt-results']) {
            const hostPath = `skills/${state.skill.dir_name}/${sub}`;
            const dirHandle = await window.localFs.resolvePath(hostPath).catch(() => null);
            if (!dirHandle) continue;
            for await (const entry of dirHandle.values()) {
                if (entry.kind !== 'directory') continue;
                runs.push({ sub, name: entry.name, handle: entry });
            }
        }
        runs.sort((a, b) => b.name.localeCompare(a.name));

        // Header + revert button
        const backup = await window.localFs.resolvePath(`skills/${state.skill.dir_name}/SKILL.md.preopt.bak`,
            { kind: 'file' }).catch(() => null);
        let html = `
            <div class="flex items-center justify-between mb-3">
                <div class="text-xs text-gray-700">
                    ${runs.length} run${runs.length===1?'':'s'} on disk
                    <span class="text-gray-400">·</span>
                    <code class="bg-gray-100 px-1.5 rounded">skills/${escapeHtml(state.skill.dir_name)}/{body,desc}-opt-results/</code>
                </div>
                <button id="so-revert-btn" class="text-xs px-2.5 py-1 rounded border ${backup ? 'border-rose-300 text-rose-700 hover:bg-rose-50' : 'border-gray-200 text-gray-400 cursor-not-allowed'}" ${backup?'':'disabled'}>
                    ⤺ Revert SKILL.md from .preopt.bak
                </button>
            </div>
        `;
        if (!runs.length) {
            html += `<div class="text-xs text-gray-500">No previous runs. Launch one from the Configure tab.</div>`;
        } else {
            html += `<div class="border border-gray-200 rounded-md divide-y divide-gray-100" id="so-runs-list">`;
            for (const run of runs) {
                html += `
                    <button class="so-run-row w-full text-left px-3 py-2 hover:bg-gray-50 transition text-xs"
                            data-sub="${run.sub}" data-name="${escapeHtml(run.name)}">
                        <div class="flex items-center justify-between">
                            <span class="font-mono">${escapeHtml(run.name)}</span>
                            <span class="text-gray-500">${run.sub === 'body-opt-results' ? 'body' : 'description'}</span>
                        </div>
                    </button>
                `;
            }
            html += `</div>`;
            html += `<div id="so-run-detail" class="mt-3"></div>`;
        }
        pane.innerHTML = html;

        // Wire row clicks + revert
        pane.querySelectorAll('.so-run-row').forEach(row => {
            row.addEventListener('click', () => showRunDetail(row.dataset.sub, row.dataset.name));
        });
        const rev = pane.querySelector('#so-revert-btn');
        if (rev && !rev.disabled) rev.addEventListener('click', () => doRevert());
    }

    async function showRunDetail(sub, name) {
        const detail = document.querySelector('#so-run-detail');
        if (!detail) return;
        detail.innerHTML = `<div class="text-xs text-gray-500">Loading ${escapeHtml(name)}…</div>`;
        const runHandle = await window.localFs.resolvePath(`skills/${state.skill.dir_name}/${sub}/${name}`).catch(() => null);
        if (!runHandle) { detail.innerHTML = `<div class="text-xs text-red-600">Run dir not found.</div>`; return; }
        let results = null;
        try {
            const fh = await runHandle.getFileHandle('results.json');
            results = JSON.parse(await (await fh.getFile()).text());
        } catch {}
        if (!results) {
            detail.innerHTML = `<div class="text-xs text-amber-700">No results.json — run may have been interrupted. The logs/ dir may still have partial data.</div>`;
            return;
        }
        const accepted = results.history?.filter(h => h.phase === 'iteration' && h.accepted).length || 0;
        let html = `
            <div class="p-3 bg-gray-50 rounded-md text-xs space-y-1">
                <div><span class="font-medium">Exit:</span> ${escapeHtml(results.exit_reason||'')}</div>
                <div><span class="font-medium">Score:</span> ${escapeHtml(results.baseline_score||'')} → <span class="font-mono text-indigo-700">${escapeHtml(results.best_score||'')}</span> (net ${results.net_improvement>=0?'+':''}${results.net_improvement})</div>
                <div><span class="font-medium">Iterations:</span> ${accepted} accepted / ${results.iterations_rejected} rejected of ${results.iterations_run||0}</div>
                <div><span class="font-medium">Body changed:</span> ${results.body_changed ? 'YES' : 'no'}</div>
            </div>
        `;
        // Rejected edits summary
        if ((results.rejected_body_edits || []).length) {
            html += `<div class="mt-3 text-xs"><div class="font-medium mb-1">Rejected iterations:</div>`;
            results.rejected_body_edits.slice(-5).forEach(r => {
                html += `
                    <div class="mt-1 p-2 bg-rose-50 border border-rose-100 rounded">
                        <div>iter ${r.iteration} · delta ${r.score_delta} · ${(r.regressions||[]).length} regression(s)</div>
                        ${r.regressions && r.regressions[0] ? `<div class="text-gray-600 mt-0.5">first regressed: <code class="bg-white px-1 rounded">${escapeHtml((r.regressions[0]||'').slice(0,80))}</code></div>` : ''}
                    </div>
                `;
            });
            html += `</div>`;
        }
        detail.innerHTML = html;
    }

    async function doRevert() {
        if (!state.skill) return;
        if (!confirm('Restore SKILL.md from .preopt.bak? This overwrites the current SKILL.md.')) return;
        try {
            const skillDir = await window.localFs.resolvePath(`skills/${state.skill.dir_name}`);
            const bakHandle = await skillDir.getFileHandle('SKILL.md.preopt.bak');
            const bakText = await (await bakHandle.getFile()).text();
            const skillHandle = await skillDir.getFileHandle('SKILL.md');
            const writable = await skillHandle.createWritable();
            await writable.write(bakText);
            await writable.close();
            alert('SKILL.md restored from .preopt.bak.');
        } catch (e) {
            alert('Revert failed: ' + (e?.message || e));
        }
    }

    // ─── Helpers ───────────────────────────────────────────────────────────
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ─── Public API ────────────────────────────────────────────────────────
    function openFor(skill) {
        if (!skill || !skill.dir_name) {
            console.warn('[skillopt] openFor called without a skill.dir_name');
            return;
        }
        if (!window.pyodideRunner || typeof window.pyodideRunner.runSkillScript !== 'function') {
            alert('Pyodide runner is not available yet. Wait a moment and try again.');
            return;
        }
        state.skill = skill;
        let overlay = document.getElementById('skillopt-overlay');
        if (!overlay) overlay = buildModal();
        overlay.querySelector('#skillopt-skill-name').textContent = skill.dir_name;
        renderConfigurePane(skill);
        renderMonitorFromSnapshot(null);   // empty until a run starts
        switchTab('configure');
        overlay.classList.remove('hidden');
    }

    function hideModal() {
        const overlay = document.getElementById('skillopt-overlay');
        if (overlay) overlay.classList.add('hidden');
        // Note: do NOT stop polling if a run is in flight — the modal can
        // reopen and pick up the live snapshot.
    }

    window.skillOptPanel = { openFor };
})();
