/**
 * StartupTasksRunner — registry + executor for one-shot work that runs
 * right after the user is authenticated.
 *
 * Why a registry instead of inlining calls in auth.js: future install /
 * wizard tasks (skill scaffolding, default agent seeding, etc.) all need
 * the same "run once after login, with progress feedback" semantics. The
 * registry keeps them discoverable in one place and lets each feature
 * module register its own task at load time without touching auth.js.
 *
 * Drives the existing #splash-screen overlay: rows are generated from
 * the registered tasks (no more hard-coded service list in index.html),
 * each row's state reflects real progress (active → completed / failed),
 * and the splash fades out only when runAll() resolves.
 *
 * Resumed sessions (no fresh-login splash flag) still run all tasks
 * silently — catalogs and similar need to stay fresh on every page load,
 * not just fresh logins.
 */
class StartupTasksRunner {
    constructor() {
        this.tasks = new Map();
        this.minDisplayMs = 1500;   // avoid flicker on very fast task runs
        this.failsafeMs = 30000;    // hard cap if a task hangs

        // Built-in startup tasks live as methods on this class. Add new
        // tasks here: write the method, register it below.
        this.register(
            'refresh-workflow-compile-catalog',
            this._refreshWorkflowCompileCatalog.bind(this),
            {
                label: 'Workflow Compile Skill',
                icon: '🔀',
                desc: 'Refreshing MCP & skills catalog'
            }
        );
    }

    /**
     * Register a task. `opts.once` (a string key) makes the task run
     * exactly once per browser (persisted in localStorage) — used for
     * wizard / first-time-setup steps. Without it, the task runs on
     * every startup.
     */
    register(name, fn, opts = {}) {
        if (typeof fn !== 'function') {
            console.warn(`[StartupTasks] register("${name}") ignored — fn is not a function`);
            return;
        }
        this.tasks.set(name, { fn, opts });
    }

    async runAll(ctx = {}) {
        const splash = document.getElementById('splash-screen');
        const showSplash = sessionStorage.getItem('showSplash') === 'true';
        sessionStorage.removeItem('showSplash');

        // Resumed session, or no tasks registered: don't show the splash.
        // Still run the tasks (silently) so things like catalog refresh
        // stay current across reloads.
        if (!showSplash || this.tasks.size === 0) {
            splash?.classList.add('hidden');
            return this._runSilent(ctx);
        }

        const startedAt = Date.now();
        this._renderRows(splash);
        const failsafe = setTimeout(() => this._hide(splash), this.failsafeMs);

        let done = 0;
        for (const [name, { fn, opts }] of this.tasks) {
            if (opts.once && localStorage.getItem(`startup:${opts.once}`)) {
                this._markRow(name, 'completed');
            } else {
                this._markRow(name, 'active');
                try {
                    await fn(ctx);
                    if (opts.once) localStorage.setItem(`startup:${opts.once}`, '1');
                    this._markRow(name, 'completed');
                } catch (e) {
                    console.warn(`[StartupTasks] "${name}" failed:`, e);
                    this._markRow(name, 'failed');
                }
            }
            this._updateProgress(++done, this.tasks.size);
        }

        clearTimeout(failsafe);
        const remaining = Math.max(0, this.minDisplayMs - (Date.now() - startedAt));
        setTimeout(() => this._hide(splash), remaining);
    }

    async _runSilent(ctx) {
        for (const [name, { fn, opts }] of this.tasks) {
            if (opts.once && localStorage.getItem(`startup:${opts.once}`)) continue;
            try {
                await fn(ctx);
                if (opts.once) localStorage.setItem(`startup:${opts.once}`, '1');
            } catch (e) {
                console.warn(`[StartupTasks] "${name}" failed (silent):`, e);
            }
        }
    }

    _renderRows(splash) {
        const container = splash?.querySelector('.splash-services');
        if (!container) return;
        container.innerHTML = '';
        for (const [name, { opts }] of this.tasks) {
            const row = document.createElement('div');
            row.className = 'splash-service';
            row.dataset.task = name;
            row.innerHTML = `
                <div class="splash-service-icon">${opts.icon || '⚙️'}</div>
                <div class="splash-service-info">
                    <div class="splash-service-name">${this._escape(opts.label || name)}</div>
                    <div class="splash-service-desc">${this._escape(opts.desc || '')}</div>
                </div>
                <div class="splash-service-status"><div class="splash-spinner"></div></div>
            `;
            container.appendChild(row);
        }
    }

    _markRow(name, state) {
        const row = document.querySelector(`.splash-service[data-task="${CSS.escape(name)}"]`);
        if (!row) return;
        row.classList.add(state);
        const status = row.querySelector('.splash-service-status');
        if (!status) return;
        if (state === 'completed') {
            status.innerHTML = '<span class="splash-checkmark">✓</span>';
        } else if (state === 'failed') {
            status.innerHTML = '<span class="splash-checkmark" style="color:#ef4444">✕</span>';
        }
    }

    _updateProgress(done, total) {
        const bar = document.getElementById('splash-progress');
        if (bar) bar.style.width = `${(done / total) * 100}%`;
    }

    _hide(splash) {
        if (!splash || splash.classList.contains('hidden')) return;
        splash.classList.add('fade-out');
        setTimeout(() => splash.classList.add('hidden'), 500);
    }

    _escape(s) {
        const div = document.createElement('div');
        div.textContent = s ?? '';
        return div.innerHTML;
    }

    // ─── built-in tasks ───────────────────────────────────────────────

    /**
     * Refresh the workflow-compile skill's reference catalogs. Writes
     * `mcp-catalog.md` and `skills-catalog.md` into
     * `<storage-root>/skills/workflow-compile/references/`, so the
     * skill's SKILL.md can point the LLM at a current list of MCP
     * servers and installed skills when authoring a workflow.
     *
     * Why this lives client-side: the storage root is a user-granted
     * FileSystemDirectoryHandle that only the browser can write into.
     * The backend just supplies the data.
     *
     * Skips cleanly (no error) when FSA isn't supported, the root
     * handle hasn't been picked yet, or the workflow-compile skill
     * folder doesn't exist.
     */
    async _refreshWorkflowCompileCatalog(ctx) {
        if (!window.localFs?.isSupported?.()) {
            console.log('[StartupTasks] localFs not supported — skipping catalog refresh');
            return;
        }
        const root = await window.localFs.getRootHandle();
        if (!root) {
            console.log('[StartupTasks] no FSA root handle yet — skipping catalog refresh');
            return;
        }

        let workflowCompileHandle;
        try {
            const skillsHandle = await root.getDirectoryHandle('skills', { create: false });
            workflowCompileHandle = await skillsHandle.getDirectoryHandle('workflow-compile', { create: false });
        } catch {
            console.log('[StartupTasks] workflow-compile skill not installed — skipping catalog refresh');
            return;
        }
        const referencesHandle = await workflowCompileHandle.getDirectoryHandle('references', { create: true });

        const headers = { 'Authorization': `Bearer ${ctx.token || ''}` };
        const userId = ctx.user?.id ?? '';
        const q = userId !== '' ? `?user_id=${encodeURIComponent(userId)}` : '';

        const [serversRes, toolsRes] = await Promise.all([
            fetch(`${ctx.apiBase}/mcp/servers${q}`, { headers }).then(r => r.json()).catch(() => ({})),
            fetch(`${ctx.apiBase}/mcp/servers/all-tools${q}`, { headers }).then(r => r.json()).catch(() => ({})),
        ]);

        const servers = Array.isArray(serversRes?.servers) ? serversRes.servers : [];
        const tools   = Array.isArray(toolsRes?.tools)     ? toolsRes.tools     : [];

        const toolsByServer = new Map();
        for (const t of tools) {
            const name = t.server_name || '';
            if (!toolsByServer.has(name)) toolsByServer.set(name, []);
            toolsByServer.get(name).push(t);
        }

        const mcpMd = this._formatMcpCatalog(servers, toolsByServer);
        await this._writeIfChanged(referencesHandle, 'mcp-catalog.md', mcpMd);

        // Skills catalog now comes straight from the filesystem (single
        // source of truth). skillsManager.loadTree() has already populated
        // window.skillsManager.skills by the time startup tasks run.
        const fsSkills = Array.isArray(window.skillsManager?.skills)
            ? window.skillsManager.skills.filter(s => s?.source === 'local')
            : [];
        const skillsMd = this._formatSkillsCatalog(fsSkills);
        await this._writeIfChanged(referencesHandle, 'skills-catalog.md', skillsMd);
    }

    _formatMcpCatalog(servers, toolsByServer) {
        const lines = [
            '# Available MCP Functions',
            '',
            '> Auto-generated by the app at startup. Do not edit manually.',
            '> This is the canonical list of MCP functions available to agents in a workflow.',
            '> Every function name is shown exactly as it must appear in an agent\'s `tools`',
            '> array — the `mcp_` prefix is mandatory (it is what the runtime sees).',
            '> Servers are headings only; agents reference *functions*, not servers.',
            ''
        ];
        if (servers.length === 0) {
            lines.push('_No MCP servers configured for this user._');
            return lines.join('\n') + '\n';
        }
        for (const s of servers) {
            lines.push(`## ${s.name}`);
            if (s.description) lines.push('', s.description);
            const t = toolsByServer.get(s.name) || [];
            if (t.length > 0) {
                lines.push('', '### Functions');
                for (const tool of t) {
                    const desc = tool.description || tool.tool_description || '';
                    // MCPToolsLoader.php:98 prefixes every MCP tool with `mcp_`
                    // before declaring it to the LLM. Mirror that here so the
                    // catalog shows the verbatim identifier an agent's `tools`
                    // array must contain — anything else hallucinates.
                    const prefixed = `mcp_${tool.tool_name}`;
                    lines.push(`- \`${prefixed}\`${desc ? ' — ' + desc : ''}`);
                }
            }
            lines.push('');
        }
        return lines.join('\n');
    }

    _formatSkillsCatalog(skills) {
        const lines = [
            '# Installed Skills',
            '',
            '> Auto-generated by the app at startup. Do not edit manually.',
            '> This is the canonical list of skills available to the LLM when',
            '> authoring a workflow.',
            ''
        ];
        if (skills.length === 0) {
            lines.push('_No skills installed._');
            return lines.join('\n') + '\n';
        }
        for (const s of skills) {
            lines.push(`## ${s.name}`);
            if (s.description) lines.push('', s.description);
            lines.push('');
        }
        return lines.join('\n');
    }

    /**
     * Write `content` to `filename` under `dirHandle` only if the file's
     * current text differs. Avoids touching mtime on every reload (the
     * data is mostly static) and won't dirty the user's git tree if the
     * skill is version-controlled.
     */
    async _writeIfChanged(dirHandle, filename, content) {
        try {
            const existing = await dirHandle.getFileHandle(filename, { create: false });
            const file = await existing.getFile();
            const existingText = await file.text();
            if (existingText === content) return;
        } catch { /* file doesn't exist yet — fall through to create */ }

        const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
    }
}

window.startupTasks = new StartupTasksRunner();
