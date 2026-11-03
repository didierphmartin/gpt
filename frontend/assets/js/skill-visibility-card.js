/**
 * Private-skill warning card. The backend refuses a robot workflow that uses private skills
 * (code 'private_skills', skills [{path, owner_id, owner_name, missing?}]); this overlay lists them,
 * offers Make public on the user's own ones, and calls onResolved() (the caller retries its action)
 * once every listed skill is public. Same overlay/modal classes as the other dialogs.
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
        if (Array.isArray(d.robot_workflows) && d.robot_workflows.length) {
            return tr(t, 'skills.visibilityCard.robotUse', { workflows: d.robot_workflows.map((w) => w.name ?? w.id ?? w).join(', ') });
        }
        return err?.message || String(err);
    }

    /**
     * @param {{skills:Array, currentUserId:*, onResolved:Function, t?:Function, setVisibility?:Function}} o
     * @returns {Promise<void>} resolves when the card closes (resolved or cancelled)
     */
    function show(o) {
        const t = o.t || window.i18n?.t?.bind(window.i18n) || window.t;
        const setVisibility = o.setVisibility || ((p, v) => window.skillsFs.setVisibility(p, v));
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
                        status.addEventListener('click', () => makePublic(s, row, status));
                    } else status = make('span', { text: tr(t, 'skills.visibilityCard.ownedBy', { owner: s.owner_name || '?' }) });
                    head.append(status);
                    row.append(head);
                    if (s.error) row.append(make('div', { text: s.error, style: 'color:#b91c1c;font-size:13px;margin-top:4px;' }));
                    list.append(row);
                }
            };

            const makePublic = async (s, row, btn) => {
                btn.disabled = true;
                s.error = '';
                try {
                    await setVisibility(s.path, 'public');
                    pub.add(s.path);
                } catch (err) {
                    s.error = errorText(err, t);
                }
                render();
                if (skills.length && skills.every((x) => pub.has(x.path))) finish(true);
            };
            render();
        });
    }

    window.SkillVisibilityCard = { show, fromRefusal };
})();
