/**
 * Self-Healing orchestrator — Phase 1, Layers 2+3.
 *
 * window.healSystem.scan() :
 *   1. GET /traces/diagnosis  → skills with a fixable verdict + cost estimate
 *   2. GET /settings/heal     → mode + loop params (eval provider, iterations, runs)
 *   3. per skill: POST /heal/authorize (server enforces mode/budget/ceiling)
 *        - mode off            → read-only list, never spends
 *        - requires_approval   → approval overlay (problem + estimate)
 *        - allowed (auto)      → proceed
 *   4. run SkillOpt's loop (run_loop.py | run_body_loop.py) in Pyodide — the
 *      SAME mechanism skillopt-panel.js uses — then POST /heal/record.
 *
 * The server gate (HealController) is authoritative; this is orchestration only.
 */
(function () {
    'use strict';

    // Inject overlay + toast styles once.
    (function injectStyles() {
        if (document.getElementById('heal-panel-styles')) return;
        const css = `
        .heal-ov-backdrop{position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}
        .heal-ov{background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.3);width:min(440px,92vw);padding:20px}
        .heal-ov h3{font-size:16px;font-weight:700;color:#1e293b;margin:0 0 6px}
        .heal-ov-skill{font-family:ui-monospace,monospace;font-size:13px;color:#4f46e5;margin:0 0 8px}
        .heal-ov-problem{font-size:13px;color:#475569;margin:0 0 12px}
        .heal-ov-meta{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:#64748b;margin:0 0 12px}
        .heal-ov-warn{font-size:12px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px;margin:0 0 12px}
        .heal-ov-list{list-style:none;margin:0 0 12px;padding:0;max-height:240px;overflow:auto}
        .heal-ov-list li{font-size:13px;color:#334155;padding:8px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px}
        .heal-ov-actions{display:flex;justify-content:flex-end;gap:8px}
        .heal-ov-actions button{padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none}
        .heal-btn-decline{background:#fff;border:1px solid #cbd5e1!important;color:#475569}
        .heal-btn-approve{background:#16a34a;color:#fff}
        #heal-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);z-index:320;background:#1e293b;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;opacity:0;transition:all .2s;pointer-events:none;max-width:80vw}
        #heal-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
        #heal-toast.heal-toast-error{background:#b91c1c}
        #heal-toast.heal-toast-ok{background:#15803d}`;
        const st = document.createElement('style');
        st.id = 'heal-panel-styles';
        st.textContent = css;
        document.head.appendChild(st);
    })();

    const API = '/gpt/backend/api/v1';
    const SKILL_CREATOR_DIR = 'skill-creator';
    const t = (k, d) => (window.i18n && window.i18n.t && window.i18n.t(k)) || d;
    const tok = () => (localStorage.getItem('token') || (window.authManager && window.authManager.token) || '');
    const hdrs = () => ({ 'Authorization': `Bearer ${tok()}`, 'Content-Type': 'application/json' });
    // Default model per provider (mirrors skillopt-panel's first choices).
    const MODEL = {
        claude: 'claude-sonnet-4-5-20250929', openai: 'gpt-4o', gemini: 'gemini-2.5-flash',
        grok: 'grok-4-fast', deepseek: 'deepseek-chat', kimi: 'kimi-k2',
    };
    // Post-run auto-trigger guards.
    const AUTO_MIN_BAD = 2;                     // need >=2 bad runs before auto-healing
    const AUTO_DEBOUNCE_MS = 5 * 60 * 1000;     // at most one auto pass per 5 min
    let lastAuto = 0;
    const normDir = (d) => String(d || '').replace(/\/+$/, '');

    async function getJSON(url) {
        const r = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { headers: hdrs(), cache: 'no-store' });
        return r.json();
    }
    async function postJSON(url, body) {
        const r = await fetch(url, { method: 'POST', headers: hdrs(), body: JSON.stringify(body) });
        return r.json();
    }

    async function scan() {
        if (!window.pyodideRunner || typeof window.pyodideRunner.runSkillScript !== 'function') {
            toast(t('heal.noPyodide', 'Skill runtime not ready — open a skill once, then retry.'), 'error');
            return;
        }
        toast(t('heal.scanning', 'Scanning traces…'));
        let diag, settings;
        try {
            [diag, settings] = await Promise.all([getJSON(`${API}/traces/diagnosis`), getJSON(`${API}/settings/heal`)]);
        } catch (e) {
            toast(t('heal.scanFailed', 'Could not load diagnosis.'), 'error');
            return;
        }
        const cfg = (settings && settings.settings) || {};
        const mode = cfg.heal_mode || 'off';
        const fixable = ((diag && diag.diagnosis && diag.diagnosis.skills) || [])
            .filter(s => s.verdict === 'skill_description' || s.verdict === 'skill_body');

        if (!fixable.length) {
            toast(t('heal.none', 'No fixable skills — everything looks healthy.'), 'ok');
            return;
        }

        if (mode === 'off') {
            const total = fixable.reduce((a, s) => a + ((s.estimate && s.estimate.usd) || 0), 0);
            showInfoOverlay(fixable, total);
            return;
        }

        let healed = 0, skipped = 0;
        for (const s of fixable) {
            const r = await healSkill(s, cfg);
            if (r.healed) healed++; else skipped++;
        }
        toast(t('heal.done', 'Self-heal complete') + ` — ${healed} healed, ${skipped} skipped.`, 'ok');
    }

    /**
     * Heal one diagnosed skill, the gated way: used by both the global scan
     * and the per-skill SkillOpt-panel button (window.healSystem.healOne).
     */
    async function healOne(skillDir) {
        if (!window.pyodideRunner || typeof window.pyodideRunner.runSkillScript !== 'function') {
            toast(t('heal.noPyodide', 'Skill runtime not ready — open a skill once, then retry.'), 'error');
            return;
        }
        toast(t('heal.scanning', 'Scanning traces…'));
        let diag, settings;
        try {
            [diag, settings] = await Promise.all([getJSON(`${API}/traces/diagnosis`), getJSON(`${API}/settings/heal`)]);
        } catch (e) {
            toast(t('heal.scanFailed', 'Could not load diagnosis.'), 'error');
            return;
        }
        const cfg = (settings && settings.settings) || {};
        const skills = (diag && diag.diagnosis && diag.diagnosis.skills) || [];
        const norm = (d) => String(d || '').replace(/\/+$/, '');
        const target = norm(skillDir);
        const s = skills.find(x => (x.verdict === 'skill_description' || x.verdict === 'skill_body')
            && (norm(x.skill_dir) === target
                || norm(x.skill_dir).endsWith('/' + target)
                || target.endsWith('/' + norm(x.skill_dir))));
        if (!s) {
            toast(t('heal.noneForSkill', 'No recent issues detected for this skill — nothing to heal.'), 'ok');
            return;
        }
        if ((cfg.heal_mode || 'off') === 'off') {
            showInfoOverlay([s], (s.estimate && s.estimate.usd) || 0);
            return;
        }
        const r = await healSkill(s, cfg);
        if (r.healed) toast(t('heal.done', 'Self-heal complete'), 'ok');
    }

    /** Gate → (overlay|auto) → run → record for one diagnosed skill. */
    async function healSkill(s, cfg) {
        const est = (s.estimate && s.estimate.usd) || 0;
        const auth = await postJSON(`${API}/heal/authorize`, { skill_dir: s.skill_dir, estimate_usd: est });
        if (!auth.allowed && !auth.requires_approval) {
            toast(`${s.skill_dir}: ${reasonText(auth.reason)}`);
            return { healed: false, reason: auth.reason };
        }
        let proceed = !auth.requires_approval;
        if (auth.requires_approval) proceed = await approveOverlay(s, auth);
        if (!proceed) return { healed: false, reason: 'declined' };
        const ok = await runHeal(s, cfg);
        if (ok) {
            // Record the estimate as the spend (conservative; the loop does not
            // return exact token cost — refine later from traces).
            await postJSON(`${API}/heal/record`, { actual_usd: est });
            return { healed: true };
        }
        return { healed: false, reason: 'run_failed' };
    }

    async function runHeal(s, cfg) {
        const isBody = s.verdict === 'skill_body';
        const script = isBody ? 'scripts/run_body_loop.py' : 'scripts/run_loop.py';
        const skillRel = `synergyAI/skills/${s.skill_dir}/`;
        const evalSet = `${skillRel}eval_set.json`;
        const m = (p) => MODEL[p] || 'kimi-k2';
        // Three roles, three models:
        //  EVALUATOR = the provider that's actually FAILING for this skill (so
        //  the bug reproduces); falls back to the eval setting if unknown.
        const evalProvider = Object.keys(s.providers || {})
            .sort((a, b) => ((s.providers[b] || 0) - (s.providers[a] || 0)))[0]
            || cfg.heal_eval_provider || 'kimi';
        const proposerProvider = cfg.heal_proposer_provider || 'claude';   // strong rewriter
        const judgeProvider = cfg.heal_judge_provider || 'kimi';           // cheap scorer

        const argv = [
            '--eval-set', evalSet,
            '--skill-path', skillRel,
            '--max-iterations', String(cfg.heal_max_iterations || 3),
            '--lr-budget', '2',
            '--verbose',
        ];
        if (isBody) {
            // run_body_loop.py understands the 3-way split.
            argv.push('--model', m(evalProvider), '--provider', evalProvider,
                '--proposer-model', m(proposerProvider), '--proposer-provider', proposerProvider,
                '--judge-model', m(judgeProvider), '--judge-provider', judgeProvider,
                '--runs-per-query', String(cfg.heal_runs_per_query || 3),
                '--soft-threshold', '4');
        } else {
            // run_loop.py (description) — single model for now; use the proposer.
            argv.push('--model', m(proposerProvider), '--provider', proposerProvider);
        }
        toast(`${t('heal.healing', 'Healing')} ${s.skill_dir} (${isBody ? 'body' : 'description'})…`);
        try {
            const result = await window.pyodideRunner.runSkillScript({ dirName: SKILL_CREATOR_DIR, script, argv });
            const out = (result && (result.stdout || '')) || '';
            if (/no eval set|eval_set|No SKILL\.md|FileNotFound/i.test(out + (result && result.stderr || ''))) {
                toast(`${s.skill_dir}: ${t('heal.noEvalSet', 'no eval_set.json — cannot heal yet')}`, 'error');
                return false;
            }
            return (result && (result.exitCode ?? 0)) === 0;
        } catch (e) {
            console.error('[heal] runSkillScript failed:', e);
            toast(`${s.skill_dir}: ${t('heal.runFailed', 'heal run failed')}`, 'error');
            return false;
        }
    }

    function reasonText(reason) {
        return ({
            over_budget: t('heal.overBudget', 'daily budget reached'),
            over_ceiling: t('heal.overCeiling', 'over per-fix ceiling'),
            mode_off: t('heal.modeOff', 'healing is off'),
        })[reason] || reason;
    }

    // ─── overlays ───────────────────────────────────────────────────────────

    function approveOverlay(s, auth) {
        return new Promise((resolve) => {
            const est = (s.estimate && s.estimate.usd) || 0;
            const rec = s.recommended || {};
            const ov = el(`
                <div class="heal-ov-backdrop">
                  <div class="heal-ov">
                    <h3>${esc(t('heal.title', 'Self-heal this skill?'))}</h3>
                    <p class="heal-ov-skill">${esc(s.skill_dir)}</p>
                    <p class="heal-ov-problem">${esc(rec.action || '')}</p>
                    <div class="heal-ov-meta">
                      <span>${esc(t('heal.estCost', 'Est. cost'))}: <b>~$${est.toFixed(4)}</b></span>
                      <span>${esc(t('heal.remaining', 'Budget left'))}: $${(auth.remaining_usd ?? 0).toFixed(2)}</span>
                      <span>${esc(t('heal.loop', 'Loop'))}: ${esc(rec.loop || '')}</span>
                    </div>
                    ${auth.reason === 'over_ceiling' ? `<p class="heal-ov-warn">${esc(t('heal.overCeilingNote', 'Above your per-fix ceiling — approving runs it anyway, once.'))}</p>` : ''}
                    <div class="heal-ov-actions">
                      <button class="heal-btn-decline">${esc(t('heal.decline', 'Skip'))}</button>
                      <button class="heal-btn-approve">${esc(t('heal.approve', 'Approve'))}</button>
                    </div>
                  </div>
                </div>`);
            const done = (v) => { ov.remove(); resolve(v); };
            ov.querySelector('.heal-btn-approve').onclick = () => done(true);
            ov.querySelector('.heal-btn-decline').onclick = () => done(false);
            ov.querySelector('.heal-ov-backdrop, .heal-ov')?.addEventListener('click', (e) => { if (e.target === ov.firstChild) done(false); });
            document.body.appendChild(ov);
        });
    }

    function showInfoOverlay(fixable, total) {
        const rows = fixable.map(s =>
            `<li><b>${esc(s.skill_dir)}</b> — ${esc((s.recommended && s.recommended.action) || '')} <span>~$${((s.estimate && s.estimate.usd) || 0).toFixed(4)}</span></li>`
        ).join('');
        const ov = el(`
            <div class="heal-ov-backdrop">
              <div class="heal-ov">
                <h3>${esc(t('heal.offTitle', 'Healing is Off'))}</h3>
                <p class="heal-ov-problem">${esc(t('heal.offBody', 'These skills could be improved. Turn healing to Ask or Auto in Settings → Auto to fix them.'))}</p>
                <ul class="heal-ov-list">${rows}</ul>
                <p class="heal-ov-meta"><span>${esc(t('heal.estTotal', 'Estimated total'))}: <b>~$${total.toFixed(4)}</b></span></p>
                <div class="heal-ov-actions"><button class="heal-btn-approve">${esc(t('common.close', 'Close'))}</button></div>
              </div>
            </div>`);
        ov.querySelector('.heal-btn-approve').onclick = () => ov.remove();
        document.body.appendChild(ov);
    }

    let toastEl = null;
    function toast(msg, kind) {
        if (!toastEl) {
            toastEl = el('<div id="heal-toast"></div>').firstChild;
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = msg;
        toastEl.className = `heal-toast-${kind || 'info'} show`;
        clearTimeout(toastEl._t);
        toastEl._t = setTimeout(() => { toastEl.className = toastEl.className.replace(' show', ''); }, 4000);
    }

    function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d; }
    function esc(s) { const d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }

    /**
     * Post-run hook: AUTO mode only. After a workflow/chat run, silently heal
     * skills that crossed the bad-run threshold — debounced, never popping a
     * modal (skips anything that would need approval). This is what makes Auto
     * "fix itself as you work". Off/Ask do nothing here (use the buttons).
     * @param {string[]} [usedSkillDirs] restrict to skills this run used
     */
    async function autoAfterRun(usedSkillDirs) {
        if (Date.now() - lastAuto < AUTO_DEBOUNCE_MS) return;           // cheap guard, no fetch
        if (!window.pyodideRunner || typeof window.pyodideRunner.runSkillScript !== 'function') return;
        let settings;
        try { settings = await getJSON(`${API}/settings/heal`); } catch (e) { return; }
        const cfg = (settings && settings.settings) || {};
        if ((cfg.heal_mode || 'off') !== 'auto') return;               // ONLY auto self-triggers
        let diag;
        try { diag = await getJSON(`${API}/traces/diagnosis`); } catch (e) { return; }
        let skills = ((diag && diag.diagnosis && diag.diagnosis.skills) || []).filter(s =>
            (s.verdict === 'skill_description' || s.verdict === 'skill_body') && (s.bad || 0) >= AUTO_MIN_BAD);
        if (Array.isArray(usedSkillDirs) && usedSkillDirs.length) {
            const used = usedSkillDirs.map(normDir);
            skills = skills.filter(s => used.some(u => normDir(s.skill_dir) === u
                || normDir(s.skill_dir).endsWith('/' + u) || u.endsWith('/' + normDir(s.skill_dir))));
        }
        if (!skills.length) return;
        lastAuto = Date.now();
        let healed = 0;
        for (const s of skills) {
            const est = (s.estimate && s.estimate.usd) || 0;
            const auth = await postJSON(`${API}/heal/authorize`, { skill_dir: s.skill_dir, estimate_usd: est });
            if (!auth.allowed || auth.requires_approval) continue;     // silent: never modal here
            const ok = await runHeal(s, cfg);
            if (ok) { await postJSON(`${API}/heal/record`, { actual_usd: est }); healed++; }
        }
        if (healed) toast(`${t('heal.autoHealed', 'Auto-healed')} ${healed} ${t('heal.skillsWord', 'skill(s)')}`, 'ok');
    }

    window.healSystem = { scan, healOne, autoAfterRun };
})();
