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
        #genesis-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);z-index:320;background:#1e293b;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;opacity:0;transition:all .2s;pointer-events:none;max-width:80vw}
        #genesis-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
        #genesis-toast.genesis-toast-error{background:#b91c1c}
        #genesis-toast.genesis-toast-ok{background:#15803d}`;
        document.head.appendChild(st);
    })();

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

    /** Compose SKILL.md content from a promotion row. */
    function skillMd(p) {
        const params = p.parameter_schema
            ? '\n## Parameters\n' + Object.entries(p.parameter_schema).map(([k, v]) =>
                `- **${k}** (${(v && v.type) || 'string'})${v && v.default !== undefined ? ` — default: ${JSON.stringify(v.default)}` : ''}${v && v.examples ? ` — examples: ${JSON.stringify(v.examples)}` : ''}`
              ).join('\n') + '\n'
            : '';
        return `---\nname: ${p.skill_name}\ndescription: ${String(p.description).replace(/\n/g, ' ')}\n---\n\n# ${p.skill_name}\n\n${p.description}\n${params}\n## Provenance\n\nCreated by skill genesis (L0) from ${p.source_ref || 'user material'} on ${new Date().toISOString().slice(0, 10)}.\n\n## Eval queries\n\n\`\`\`json\n${JSON.stringify(p.eval_queries || [], null, 2)}\n\`\`\`\n`;
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

    /** Write skills/<name>/SKILL.md through the local-FS handle. */
    async function writeSkillFolder(p) {
        await requireLocalFs();
        const dir = await window.localFs.resolvePath(`skills/${p.skill_name}`, { create: true });
        if (!dir) throw new Error(`Could not create skills/${p.skill_name}.`);
        const fh = await dir.getFileHandle('SKILL.md', { create: true });
        const w = await fh.createWritable();
        await w.write(skillMd(p));
        await w.close();
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
            toast(`${t('genesis.buildFailed', 'Skill creation failed')}: ${d.reason || d.error || 'not allowed'}`, 'error');
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

    window.genesisSystem = { showProposal, buildOne, dismiss };
})();
