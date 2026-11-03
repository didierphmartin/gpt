/**
 * Private-skill warning card. The backend refuses a robot workflow that uses private skills
 * (code 'private_skills', skills [{path, owner_id, owner_name, missing?}]); this overlay lists them,
 * offers Make public on the user's own ones, and calls onResolved() (the caller retries its action)
 * once every listed skill is public. Same overlay/modal classes as the other dialogs.
 * makePublic() is the one way to make a skill public (Skills page too): the private skills it requires go along,
 * after confirmPublic().
 */
(function () {
    'use strict';

    const tr = (t, k, p) => (typeof t === 'function' ? t(k, p) : k);

    /** The skills list of a refusal: an HTTP body ({data:{skills}}) or an SSE event ({skills}); null otherwise. */
    function fromRefusal(body) {
        if (!body || body.code !== 'private_skills') return null;
        const list = body.data?.skills ?? body.skills;
        return Array.isArray(list) ? list : null;
    }

    function make(tag, props = {}, kids = []) {
        const e = document.createElement(tag);
        Object.assign(e, props.prop || {});
        if (props.cls) e.className = props.cls;
        if (props.text != null) e.textContent = props.text;
        if (props.style) e.style.cssText = props.style;
        Object.assign(e.dataset, props.data || {});
        e.append(...kids);
        return e;
    }

    /** err from skillsFs.setVisibility -> a line for the row. */
    function errorText(err, t) {
        const d = err?.data?.data ?? err?.data ?? {};
        if (d.clash) return tr(t, 'skills.visibilityCard.clash');
        if (d.reason && window.skillsFs?.requiredByMessage) return window.skillsFs.requiredByMessage(d, t);
        if (Array.isArray(d.robot_workflows) && d.robot_workflows.length) {
            return tr(t, 'skills.visibilityCard.robotUse', { workflows: d.robot_workflows.map((w) => w.name ?? w.id ?? w).join(', ') });
        }
        return err?.message || String(err);
    }

    /**
     * The in-app confirmation before a skill goes public with the skills it needs:
     * "Making "{name}" public will also make public the skills it needs: {list}." [Cancel] [Make public].
     * Resolves true on Make public, false on Cancel / close.
     */
    function confirmPublic({ name, list, t }) {
        const cancelBtn = make('button', { cls: 'storage-config-btn cancel', text: tr(t, 'common.cancel'), data: { act: 'cancel' } });
        const okBtn = make('button', { cls: 'storage-config-btn save', text: tr(t, 'skills.visibilityCard.makePublic'), data: { act: 'confirm' } });
        const closeBtn = make('button', { cls: 'storage-config-close', text: '×', data: { act: 'cancel' } });
        const overlay = make('div', { cls: 'storage-config-overlay', data: { role: 'confirm-public' } });
        overlay.append(make('div', { cls: 'storage-config-modal', style: 'width:min(480px,95vw);' }, [
            make('div', { cls: 'storage-config-header' }, [make('h3', { text: tr(t, 'skills.visibility.confirmTitle') }), closeBtn]),
            make('div', { cls: 'storage-config-body' }, [
                make('p', { text: tr(t, 'skills.visibility.confirmAlso', { name, list: list.join(', ') }), style: 'margin:0;font-size:14px;' })]),
            make('div', { cls: 'storage-config-footer' }, [cancelBtn, okBtn]),
        ]));
        document.body.appendChild(overlay);
        return new Promise((resolve) => {
            const done = (v) => { overlay.remove(); resolve(v); };
            cancelBtn.addEventListener('click', () => done(false));
            closeBtn.addEventListener('click', () => done(false));
            okBtn.addEventListener('click', () => done(true));
        });
    }

    /**
     * Make one of my skills public the one way: ask the server which of my private skills it needs go along
     * (dry run), confirm when there are any, then do it. setVisibility(path, visibility, { dryRun }).
     * Returns { done: false } when cancelled, else { done: true, madePublic: [path] }. Errors are thrown.
     */
    async function makePublic(path, { setVisibility, t } = {}) {
        const set = setVisibility || ((p, v, o) => window.skillsFs.setVisibility(p, v, o));
        const plan = (await set(path, 'public', { dryRun: true })) || {};
        const along = plan.made_public || [];
        if (along.length && !(await confirmPublic({ name: String(path).split('/').pop(), list: along, t }))) return { done: false };
        const r = (await set(path, 'public', { expectPublic: along })) || {};   // the server refuses if that changed
        return { done: true, madePublic: r.made_public || along };
    }

    /**
     * @param {{skills:Array, currentUserId:*, onResolved:Function, t?:Function, setVisibility?:Function}} o
     * @returns {Promise<void>} resolves when the card closes (resolved or cancelled)
     */
    function show(o) {
        const t = o.t || window.i18n?.t?.bind(window.i18n) || window.t;
        const setVisibility = o.setVisibility || ((p, v, opts) => window.skillsFs.setVisibility(p, v, opts));
        const me = o.currentUserId;
        const skills = o.skills || [];
        const pub = new Set();

        const list = make('div', { style: 'display:flex;flex-direction:column;gap:6px;' });
        const overlay = make('div', { cls: 'storage-config-overlay' });
        const closeBtn = make('button', { cls: 'storage-config-close', text: '×', data: { act: 'close' } });
        const cancelBtn = make('button', { cls: 'storage-config-btn cancel', text: tr(t, 'common.cancel'), data: { act: 'close' } });
        overlay.append(make('div', { cls: 'storage-config-modal', style: 'width:min(560px,95vw);' }, [
            make('div', { cls: 'storage-config-header' }, [make('h3', { text: '⚠ ' + tr(t, 'skills.visibilityCard.title') }), closeBtn]),
            make('div', { cls: 'storage-config-body' }, [
                make('p', { text: tr(t, 'skills.visibilityCard.intro'), style: 'margin:0 0 8px;font-size:14px;' }), list]),
            make('div', { cls: 'storage-config-footer' }, [cancelBtn]),
        ]));
        document.body.appendChild(overlay);

        return new Promise((resolve) => {
            let finished = false;
            const finish = (resolved) => {
                if (finished) return;
                finished = true;
                overlay.remove();
                if (resolved) o.onResolved?.();
                resolve();
            };
            closeBtn.addEventListener('click', () => finish(false));
            cancelBtn.addEventListener('click', () => finish(false));

            const render = () => {
                list.textContent = '';
                for (const s of skills) {
                    const row = make('div', { data: { role: 'row' }, style: 'border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;font-size:14px;' });
                    const head = make('div', { style: 'display:flex;align-items:center;gap:8px;justify-content:space-between;' });
                    head.append(make('strong', { text: s.path }));
                    let status;
                    if (pub.has(s.path)) status = make('span', { text: tr(t, 'skills.visibilityCard.nowPublic') });
                    else if (s.missing) status = make('span', { text: tr(t, 'skills.visibilityCard.notFound') });
                    else if (s.owner_id !== undefined && s.owner_id !== null && String(s.owner_id) === String(me)) {
                        status = make('button', { cls: 'storage-config-btn save', text: tr(t, 'skills.visibilityCard.makePublic'), data: { act: 'public' } });
                        status.addEventListener('click', () => onMakePublic(s, row, status));
                    } else status = make('span', { text: tr(t, 'skills.visibilityCard.ownedBy', { owner: s.owner_name || '?' }) });
                    head.append(status);
                    row.append(head);
                    if (s.error) row.append(make('div', { text: s.error, style: 'color:#b91c1c;font-size:13px;margin-top:4px;' }));
                    list.append(row);
                }
            };

            const onMakePublic = async (s, row, btn) => {
                btn.disabled = true;
                s.error = '';
                try {
                    // The same path as the Skills page: the skills it needs go public along, after a confirmation.
                    const r = await makePublic(s.path, { setVisibility, t });
                    if (r.done) {
                        pub.add(s.path);
                        for (const p of r.madePublic || []) pub.add(p);
                    }
                } catch (err) {
                    s.error = errorText(err, t);
                }
                render();
                if (skills.length && skills.every((x) => pub.has(x.path))) finish(true);
            };
            render();
        });
    }

    window.SkillVisibilityCard = { show, fromRefusal, confirmPublic, makePublic };
})();
