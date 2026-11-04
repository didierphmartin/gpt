/**
 * Skills Manager
 *
 * Manages the sidebar treeview for folder-backed skills and the group
 * folders they can be organized into, all under <root>/skills/.
 * Self-contained — does not depend on workflow-editor.js internals.
 */
class SkillsManager {
    constructor(apiBase, getAuthHeaders, t) {
        this.apiBase = apiBase;
        this.getAuthHeaders = getAuthHeaders;
        this.t = t; // i18n translation function
        this.skills = [];
        this.folders = [];                  // group folders under skills/
        this.edition = '';                  // 'corporate' shows Public / Private sections
        this.collapsedFolders = new Set();  // folder names currently collapsed
        this.expandedSkills = new Set();    // skill paths (dir_name) whose required skills are shown under them
        this.contextMenu = null;
        this.contextTarget = null; // { type: 'skill'|'category', id: ... }
    }

    /**
     * Initialize DOM references and event listeners
     */
    init() {
        this.treeContainer = document.getElementById('skills-tree');
        this.searchInput = document.getElementById('skills-search');
        this.newSkillBtn = document.getElementById('skills-new-btn');
        this.newFolderBtn = document.getElementById('skills-new-folder-btn');
        this.exportBtn = document.getElementById('skills-export-btn');
        this.importBtn = document.getElementById('skills-import-btn');
        this.contextMenu = document.getElementById('skills-context-menu');

        if (this.newSkillBtn) {
            this.newSkillBtn.addEventListener('click', () => window.SkillEditor.open({ skill: null, manager: this }));
        }
        if (this.newFolderBtn) {
            this.newFolderBtn.addEventListener('click', () => this.promptNewFolder());
        }
        if (this.exportBtn) {
            this.exportBtn.addEventListener('click', () => this.showExportPicker());
        }
        if (this.importBtn) {
            this.importBtn.addEventListener('click', () => this.showImportPicker());
        }
        if (this.searchInput) {
            this.searchInput.addEventListener('input', () => this.renderTree());
        }

        // Context menu actions
        if (this.contextMenu) {
            this.contextMenu.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = e.target.closest('[data-action]')?.dataset.action;
                if (!action || !this.contextTarget) return;
                this.handleContextAction(action);
                this.hideContextMenu();
            });
        }

        // Close context menu on outside click
        document.addEventListener('click', () => this.hideContextMenu());

        // Eagerly populate the skills catalog at init time.
        //
        // Background: prior to this, loadTree() was only invoked on demand —
        // when the user opened the Skills sidebar tab, Settings → Skills,
        // or the Workflow editor. That meant a user who went straight to
        // chat had `this.skills === []`, and chat.js's sendMessage would
        // build `available_skills: []` even when the user had skills
        // installed and enabled. The backend's multi-skill auto-router
        // (ChatController::buildMultiSkillTool) requires this list to
        // declare the run_skill_script tool with a populated dir_name
        // catalog — when the list is empty, the controller silently falls
        // through to the no-skill branch and the LLM never sees that any
        // skill exists. Symptoms in user testing:
        //   • Drag-dropped skill chip → works (skill_metadata bypasses this).
        //   • No chip + attached doc + "use as template" prompt → LLM
        //     generates inline because it has no awareness of the catalog.
        //
        // Fire-and-forget here is fine: rendering paths (Skills tab, picker,
        // Settings) all check `this.skills.length` and re-load on demand if
        // this background load hasn't landed yet, so there's no race-induced
        // empty state in those views. The chat path now wins from the time
        // FSA + DB scans complete (typically <1s on warm caches).
        this.loadTree().catch(err => {
            console.warn('[skillsManager] initial loadTree failed:', err);
        });
    }

    /**
     * Load skills from the filesystem (folders under <root>/skills/) and
     * render the tree. The filesystem is the single source of truth — the
     * legacy DB skills/skill_categories tables are no longer consulted.
     */
    async loadTree() {
        try {
            this.folders = window.skillsFs ? await window.skillsFs.listFolders() : [];
            this.edition = window.skillsFs?.edition ? await window.skillsFs.edition() : '';
            // Enrich each group folder with its README.md (if present at
            // skills/<group>/README.md, alongside the contained skill folders).
            // The README explains what the bundle of skills is for and may
            // include a markdown link to a workflow that orchestrates them.
            if (window.skillsFs?.getSkillFile && this.folders.length > 0) {
                await Promise.all(this.folders.map(async (f) => {
                    try {
                        const md = await window.skillsFs.getSkillFile(f.name, 'README.md');
                        if (md && md.trim()) f.readme = md;
                    } catch (e) {
                        // File missing or unreadable — leave f.readme undefined.
                    }
                }));
            }
            this.skills = await this.loadLocalSkills();
            // An empty tree is ambiguous: "no skills installed" vs "the
            // local folder isn't connected so we can't see them". When the
            // cause is connectivity, show an actionable notice (mirrors the
            // Files sidebar) instead of the misleading "no skills" state.
            if (this.skills.length === 0 && this.folders.length === 0 &&
                await this.renderFsAccessNotice()) {
                return;
            }
            this.renderTree();
        } catch (err) {
            console.error('Failed to load skills tree:', err);
        }
    }

    /**
     * When window.localFs has no granted root handle (never picked, Chrome
     * downgraded the grant to 'prompt' between sessions, denied, or FSA
     * unsupported), render a notice in the tree container with a re-grant
     * button. Returns true when the notice was rendered so loadTree can
     * skip the normal empty-state render.
     */
    async renderFsAccessNotice() {
        if (!this.treeContainer || !window.localFs?.getStatus) return false;
        // In the Docker app the list comes from the skill store, not the folder: an empty
        // store is "no skills yet", never a folder-permission problem.
        if (window.skillsFs?.mode && await window.skillsFs.mode() !== 'folder') return false;
        let status;
        try { status = await window.localFs.getStatus(); } catch (e) { return false; }
        if (!status || status.state === 'granted') return false;
        const msgKey = {
            not_picked: 'skills.fsaNotPicked',
            prompt: 'skills.fsaPrompt',
            denied: 'skills.fsaDenied',
            unsupported: 'skills.fsaUnsupported',
        }[status.state] || 'skills.fsaNotPicked';
        const canGrant = status.state !== 'unsupported';
        this.treeContainer.innerHTML = `
            <div class="skills-fsa-notice"
                 style="background:#fef3c7;border:1px solid #fcd34d;color:#92400e;
                        font-size:12px;padding:8px 10px;border-radius:6px;margin:4px 2px 8px;">
                <div data-i18n="${msgKey}" style="margin-bottom:${canGrant ? '6px' : '0'};">${this.t(msgKey)}</div>
                ${canGrant ? `<button type="button" id="skills-fsa-grant-btn" data-i18n="skills.fsaGrantBtn"
                        style="background:#fff;border:1px solid #fcd34d;color:#92400e;
                               border-radius:4px;padding:3px 10px;font-size:12px;cursor:pointer;">
                    ${this.t('skills.fsaGrantBtn')}
                </button>` : ''}
            </div>
        `;
        const btn = document.getElementById('skills-fsa-grant-btn');
        if (btn) {
            btn.addEventListener('click', async () => {
                if (!window.localFs?.requestRootAccess) return;
                const res = await window.localFs.requestRootAccess('synergyAI');
                if (res?.ok) await this.loadTree();
            });
        }
        return true;
    }

    /**
     * Re-read the skills folder and update the in-memory list without
     * re-rendering the sidebar tree. Cheap enough (~30-60ms for a handful
     * of small SKILL.md files via FSA) to run before every chat send so
     * newly created skills appear in the model's available_skills list
     * without requiring a hard refresh. Errors are non-fatal — we keep
     * the previous list and continue.
     */
    async refreshSkills() {
        try {
            this.skills = await this.loadLocalSkills();
        } catch (err) {
            console.warn('[skillsManager] refreshSkills failed; keeping previous list:', err);
        }
    }

    /**
     * Walk the user's local <root>/skills/ folder via window.skillsFs and
     * shape each entry into the same row format DB skills use, so the
     * existing renderer can show them mixed in. Local skills don't have a
     * numeric id (they're keyed by folder name) — we synthesize one to keep
     * downstream code that relies on `skill.id` from breaking.
     */
    async loadLocalSkills() {
        if (!window.skillsFs) return [];
        try {
            const list = await window.skillsFs.listSkills({ withRequires: true });
            // Eager-load each skill's SKILL.md body so the editor opens
            // instantly on click. Reads are local-disk fast; for libraries
            // larger than a few hundred skills we'd defer to first click.
            const enriched = await Promise.all(list.map(async s => {
                let skill_content = '';
                try {
                    skill_content = await window.skillsFs.getSkillContent(s.dirName);
                } catch (e) {
                    console.warn(`[skillsManager] could not read SKILL.md for ${s.dirName}:`, e);
                }
                // Inline declared reference files INTO skill_content so an authoring LLM that has no
                // file-read tool (e.g. workflow-compile, whose allowed-tools is run_skill_script only)
                // actually sees them — e.g. the live, auto-refreshed MCP catalog. Opt-in via the
                // `context-references` frontmatter key: a comma-separated list of skill-relative paths.
                // No-op for skills that don't declare it. Re-read each load so the content stays fresh.
                const ctxRefs = String(s.meta?.['context-references'] || '')
                    .split(',').map(p => p.trim()).filter(Boolean);
                for (const rel of ctxRefs) {
                    try {
                        const refBody = await window.skillsFs.getSkillFile(s.dirName, rel);
                        if (refBody && refBody.trim()) {
                            skill_content += `\n\n---\n\n# Injected reference — ${rel}\n\n${refBody.trim()}\n`;
                        }
                    } catch (e) {
                        console.warn(`[skillsManager] could not inline context-reference ${rel} for ${s.dirName}:`, e);
                    }
                }
                // Inject the user's chosen default LLM provider (a Settings value) for skills that opt in
                // via `inject-default-provider: true`. Same rationale as context-references — the authoring
                // LLM can't read settings. workflow-compile uses this so agents the user didn't assign a
                // provider default to the configured one instead of the SKILL.md template's placeholder.
                if (String(s.meta?.['inject-default-provider'] || '').toLowerCase() === 'true') {
                    let dp = '';
                    try { dp = (localStorage.getItem('workflowDefaultProvider') || '').trim(); } catch (e) { /* ignore */ }
                    if (!dp) dp = 'deepseek';
                    skill_content += `\n\n---\n\n# Default provider (user setting)\nUnless the user explicitly names a provider for an agent, set every agent's \`provider\` to \`${dp}\`. If the user names one (e.g. "use Claude", "with GPT"), honor that request instead.\n`;
                }
                let scripts = [];
                try {
                    scripts = await window.skillsFs.listSkillScripts(s.dirName);
                } catch (e) {
                    console.warn(`[skillsManager] could not list scripts for ${s.dirName}:`, e);
                }
                let references = [];
                try {
                    references = await window.skillsFs.listSkillReferences(s.dirName);
                } catch (e) {
                    console.warn(`[skillsManager] could not list references for ${s.dirName}:`, e);
                }
                if (s.spec_issues && s.spec_issues.length > 0) {
                    console.warn(`[skillsManager] SKILL.md spec issues for "${s.dirName}":`, s.spec_issues);
                }
                // Optional per-skill client-tool round budget. Frontmatter
                // values arrive as strings (see skills-fs parseFrontmatter),
                // so coerce; a bad/absent value leaves it null and the
                // dispatcher falls back to its default cap.
                const rawRounds = Number.parseInt(s.meta?.max_tool_rounds, 10);
                const maxToolRounds = Number.isFinite(rawRounds) && rawRounds > 0
                    ? rawRounds
                    : null;
                return {
                    id: `local:${s.dirName}`,         // string id; never collides with numeric DB ids
                    name: s.name,
                    description: s.description,
                    skill_content,
                    tags: [],
                    group: s.group || null,            // parent group folder, or null at top level
                    source: 'local',
                    visibility: s.visibility || 'private',
                    mine: s.mine !== false,           // false: another user's public skill (read-only here)
                    owner_id: s.ownerId ?? null,
                    owner_name: s.ownerName || '',
                    dir_name: s.dirName,               // path relative to skills/ (may include a group prefix)
                    scripts,                           // skill-relative paths to executable scripts (e.g. ['scripts/transform.py'])
                    references,                         // skill-relative paths to Markdown reference docs (e.g. ['references/second.md'])
                    max_tool_rounds: maxToolRounds,    // orchestrators may raise the client-tool round cap (see chat.js dispatchClientToolCall)
                    spec_compliant: s.spec_compliant !== false,
                    spec_issues: s.spec_issues || [],
                    requires: s.requires || [],       // dir_names of the DIRECT required skills
                };
            }));
            return enriched;
        } catch (err) {
            console.warn('[skillsManager] could not load local skills:', err);
            return [];
        }
    }

    /**
     * Render the treeview into the container
     */
    renderTree() {
        if (!this.treeContainer) return;
        const query = (this.searchInput?.value || '').toLowerCase().trim();
        const filtered = this.filterSkills(query);

        if (filtered.length === 0 && this.folders.length === 0) {
            this.treeContainer.innerHTML = `<div class="text-center text-gray-400 text-xs py-6">${this.t('skills.empty')}</div>`;
            return;
        }
        this.treeContainer.innerHTML = this.buildTreeHtml(filtered, query)
            || `<div class="text-center text-gray-400 text-xs py-6">${this.t('skills.empty')}</div>`;
        this.attachTreeListeners();
    }

    /** Filter the skill list by a lowercased search query. */
    filterSkills(query) {
        if (!query) return this.skills;
        return this.skills.filter(s =>
            (s.name || '').toLowerCase().includes(query) ||
            (s.description || '').toLowerCase().includes(query));
    }

    /**
     * Build the tree HTML: each group folder (collapsible) with the skills
     * inside it, then the top-level skills. Skills whose group folder no
     * longer exists fall back to the top level. Shared by the sidebar tree
     * and the workflow-editor skill picker.
     */
    buildTreeHtml(filteredSkills, query, opts = {}) {
        this._treeLinks = opts.expandable === false ? null : this.indexRequirements(filteredSkills);
        if (this.edition !== 'corporate') return this.buildGroupedHtml(filteredSkills, query, false);
        // Corporate: everything public, then my private skills, each with its own heading.
        const isPublic = (s) => s.visibility === 'public';
        const section = (key, list) => `
            <div class="skills-section" data-section="${key}">
                <div class="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">${this.escapeHtml(this.t('skills.section.' + key))}</div>
                ${this.buildGroupedHtml(list, query, true)}
            </div>`;
        return section('public', filteredSkills.filter(isPublic))
            + section('private', filteredSkills.filter((s) => !isPublic(s)));
    }

    /**
     * Who needs whom, over every known skill (not just the filtered ones, so children and "used by" don't
     * depend on the search): { byDir: dir_name -> skill, needs: dir_name -> [skill], usedBy: dir_name -> [skill] }.
     * Required skills that are not in the list are left out.
     */
    indexRequirements(visible) {
        const byDir = new Map();
        for (const x of [...this.skills, ...visible]) if (x.dir_name !== undefined) byDir.set(x.dir_name, x);
        const needs = new Map();
        const usedBy = new Map();
        const byName = (a, b) => String(a.name).localeCompare(String(b.name));
        for (const x of byDir.values()) {
            const req = [...new Set(x.requires || [])].map((d) => byDir.get(d)).filter((r) => r && r !== x).sort(byName);
            if (!req.length) continue;
            needs.set(x.dir_name, req);
            for (const r of req) usedBy.set(r.dir_name, [...(usedBy.get(r.dir_name) || []), x]);
        }
        return { byDir, needs, usedBy };
    }

    /** Show or hide the skills a skill requires (the ▸ arrow). */
    toggleExpanded(dir) {
        if (this.expandedSkills.has(dir)) this.expandedSkills.delete(dir);
        else this.expandedSkills.add(dir);
        this.renderTree();
    }

    /** The arrow of an expandable skill row: a chevron pointing right (closed) or down (open). */
    renderExpandArrow(dir) {
        const open = this.expandedSkills.has(dir);
        return `<button type="button" class="skills-req-toggle flex-shrink-0 inline-flex items-center justify-center w-5 h-5 -ml-1 rounded text-gray-600 hover:text-gray-900 hover:bg-gray-300" data-expand="${this.escapeHtml(dir)}"
                        aria-expanded="${open}" title="${this.escapeHtml(this.t('skills.needsTree.toggle'))}">
                    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
                         style="transition: transform .15s; transform: rotate(${open ? 90 : 0}deg);" aria-hidden="true"><path d="M7 4l6 6-6 6"/></svg>
                </button>`;
    }

    /** The required skills of `skill`, as indented link rows (nested; never a skill already open higher in the branch). */
    renderRequiredRows(skill, chain) {
        const links = this._treeLinks;
        const trail = new Set([...chain, skill.dir_name]);
        let html = '';
        for (const r of links.needs.get(skill.dir_name) || []) {
            const expandable = links.needs.has(r.dir_name) && !trail.has(r.dir_name);
            html += `
            <div class="skills-req-item flex items-center gap-1 px-2 py-1 text-xs text-gray-500 cursor-pointer hover:bg-blue-50 rounded select-none"
                 data-skill-id="${r.id}" title="${this.escapeHtml(r.description || '')}">
                ${expandable ? this.renderExpandArrow(r.dir_name) : '<span class="px-1 flex-shrink-0">&nbsp;</span>'}
                <span class="flex-1 truncate">${this.escapeHtml(r.name)}</span>
            </div>`;
            if (expandable && this.expandedSkills.has(r.dir_name)) html += this.renderRequiredRows(r, trail);
        }
        return `<div class="skills-req-children pl-4">${html}</div>`;
    }

    /** Group folders (collapsible) with their skills, then the top-level skills. */
    buildGroupedHtml(filteredSkills, query, hideEmptyFolders) {
        const byGroup = new Map();
        const rootSkills = [];
        for (const s of filteredSkills) {
            if (s.group) {
                if (!byGroup.has(s.group)) byGroup.set(s.group, []);
                byGroup.get(s.group).push(s);
            } else {
                rootSkills.push(s);
            }
        }
        let html = '';
        const folderNames = new Set();
        for (const folder of this.folders) {
            folderNames.add(folder.name);
            const inFolder = byGroup.get(folder.name) || [];
            // While searching, hide folders with no matching skill.
            if ((query || hideEmptyFolders) && inFolder.length === 0) continue;
            html += this.renderFolder(folder, inFolder);
        }
        // Orphaned skills — their group folder is gone — render at top level.
        for (const [group, skills] of byGroup) {
            if (!folderNames.has(group)) rootSkills.push(...skills);
        }
        for (const s of rootSkills) html += this.renderSkillItem(s);
        return html;
    }

    /**
     * Render the same tree as the sidebar into a different container, in
     * "picker" mode — clicking a skill row fires options.onSelect(skill)
     * instead of opening the editor / starting a drag. Used by the
     * workflow node form so users can pick a skill from the library
     * instead of typing one inline.
     *
     * Options:
     *   - onSelect(skill): called when the user picks a skill row
     *   - disableFolderBacked: bool — render folder-backed skills greyed
     *     out and unselectable (server can't read the user's local FS,
     *     so workflows can't actually use them yet)
     *   - searchInputId: id of an external <input> to drive filtering
     *
     * Returns a small handle: { refresh(), destroy() } so the caller
     * can re-render after the underlying skills/categories change.
     */
    renderPickerInto(containerEl, options = {}) {
        if (!containerEl) return null;
        const onSelect = typeof options.onSelect === 'function' ? options.onSelect : () => {};
        const disableFolderBacked = !!options.disableFolderBacked;
        const searchInput = options.searchInputId ? document.getElementById(options.searchInputId) : null;
        // Selected-skill tracking. The picker is reused across nodes
        // (each node has its own bound skill), so we keep this in
        // closure scope and let the caller drive it via the returned
        // handle's markSelected() — that way the highlight survives
        // search/refresh and follows the node form's binding.
        let selectedSkillId = options.initialSelectedSkillId != null
            ? String(options.initialSelectedSkillId)
            : null;
        // Inline styles instead of Tailwind classes: the CDN/Play
        // build of Tailwind doesn't always emit rules for classes
        // that only ever appear via runtime classList toggles, so a
        // chunk of "selected" tints would render as no-op. Inline
        // styles always apply and override the row's hover background.
        const applySelectionHighlight = () => {
            containerEl.querySelectorAll('.skills-item').forEach(el => {
                const isSel = selectedSkillId != null
                    && el.dataset.skillId === selectedSkillId;
                if (isSel) {
                    el.style.backgroundColor = '#bfdbfe'; // blue-200
                    el.style.borderLeft = '4px solid #2563eb'; // blue-600
                    el.style.color = '#1e3a8a'; // blue-900
                    el.style.fontWeight = '600';
                } else {
                    el.style.backgroundColor = '';
                    el.style.borderLeft = '';
                    el.style.color = '';
                    el.style.fontWeight = '';
                }
            });
        };

        const filterFn = () => {
            const q = (searchInput?.value || '').toLowerCase().trim();
            return q
                ? this.skills.filter(s =>
                    (s.name || '').toLowerCase().includes(q)
                    || (s.description || '').toLowerCase().includes(q))
                : this.skills;
        };

        const renderInto = () => {
            const filtered = filterFn();
            if (filtered.length === 0 && this.folders.length === 0) {
                containerEl.innerHTML = `<div class="text-center text-gray-400 text-xs py-6">${this.t('skills.empty')}</div>`;
                return;
            }
            const query = (searchInput?.value || '').toLowerCase().trim();
            containerEl.innerHTML = this.buildTreeHtml(filtered, query, { expandable: false })
                || `<div class="text-center text-gray-400 text-xs py-6">${this.t('skills.empty')}</div>`;

            // Picker-specific event binding (independent of sidebar's
            // attachTreeListeners, which targets this.treeContainer).
            containerEl.querySelectorAll('.skills-folder').forEach(el => {
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const name = el.dataset.folder;
                    if (this.collapsedFolders.has(name)) this.collapsedFolders.delete(name);
                    else this.collapsedFolders.add(name);
                    renderInto();
                });
            });
            containerEl.querySelectorAll('.skills-item').forEach(el => {
                el.draggable = false; // disable drag in picker mode
                el.removeAttribute('draggable');
                const skill = this.findSkillByDatasetId(el.dataset.skillId);
                if (!skill) return;
                const isFolderBacked = skill.source === 'local';
                if (disableFolderBacked && isFolderBacked) {
                    el.style.opacity = '0.45';
                    el.style.cursor = 'not-allowed';
                    el.setAttribute('title',
                        "Folder-backed skills aren't usable in workflows yet (the server can't read your local skills folder).");
                    return;
                }
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    selectedSkillId = String(skill.id);
                    console.log('[skillsManager picker] clicked skill id=', skill.id, 'source=', skill.source, '— applying highlight + onSelect');
                    applySelectionHighlight();
                    const after = containerEl.querySelector(`.skills-item[data-skill-id="${CSS.escape(String(skill.id))}"]`);
                    console.log('[skillsManager picker] inline style after:', after?.getAttribute('style'));
                    console.log('[skillsManager picker] computed bg:', after ? getComputedStyle(after).backgroundColor : '(no el)', 'border-left:', after ? getComputedStyle(after).borderLeftWidth : '(no el)');
                    onSelect(skill);
                });
            });
            // Re-apply highlight after the tree was rebuilt (search,
            // category collapse, refresh) so the user keeps seeing
            // which skill the node is bound to.
            applySelectionHighlight();
        };

        if (searchInput) {
            const handler = () => renderInto();
            searchInput.addEventListener('input', handler);
            // Stash so destroy() can clean up.
            containerEl._pickerSearchHandler = handler;
            containerEl._pickerSearchInput = searchInput;
        }

        // Initial render. Async-load skills/categories if the manager
        // hasn't fetched them yet (workflow editor can be opened before
        // the sidebar's first loadTree).
        if (!this.skills || this.skills.length === 0) {
            this.loadTree().then(renderInto).catch(() => renderInto());
        } else {
            renderInto();
        }

        return {
            refresh: renderInto,
            // Drive the selection highlight from the outside — used by
            // the workflow editor when loading a saved node so the
            // chip and the tree stay in sync.
            markSelected: (skillId) => {
                selectedSkillId = skillId != null ? String(skillId) : null;
                applySelectionHighlight();
            },
            destroy: () => {
                if (containerEl._pickerSearchInput && containerEl._pickerSearchHandler) {
                    containerEl._pickerSearchInput.removeEventListener('input', containerEl._pickerSearchHandler);
                    delete containerEl._pickerSearchHandler;
                    delete containerEl._pickerSearchInput;
                }
                containerEl.innerHTML = '';
            },
        };
    }

    /**
     * Open the README overlay the FIRST time a user interacts with a given
     * folder (i.e. clicks its header), so they discover the feature without
     * a recurring popup. Tracks "seen" folders in localStorage keyed by name
     * so the auto-open never replays — subsequent times, the 📖 button is
     * the only entry point.
     */
    _maybeAutoOpenReadme(folderName) {
        const folder = this.folders.find(f => f.name === folderName);
        if (!folder?.readme) return;
        let seen;
        try {
            seen = JSON.parse(localStorage.getItem('skillsReadmeSeen') || '[]');
            if (!Array.isArray(seen)) seen = [];
        } catch { seen = []; }
        if (seen.includes(folderName)) return;
        seen.push(folderName);
        try { localStorage.setItem('skillsReadmeSeen', JSON.stringify(seen)); } catch {}
        this._openReadmeOverlay(folder.name, folder.readme);
    }

    /**
     * Show a centered overlay above the main panel with the rendered README
     * markdown for a group folder. Lazy-builds the overlay DOM once and
     * reuses it. Closing via X button, click-outside, or Escape.
     */
    _openReadmeOverlay(folderName, markdown) {
        let overlay = document.getElementById('skills-readme-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'skills-readme-overlay';
            overlay.className = 'fixed inset-0 z-[10000] flex items-center justify-center hidden';
            overlay.style.background = 'rgba(0,0,0,0.55)';
            overlay.innerHTML = `
                <div class="bg-white rounded-xl shadow-2xl flex flex-col"
                     style="width: min(820px, calc(100vw - 32px)); max-height: calc(100vh - 64px);"
                     role="dialog" aria-labelledby="skills-readme-title">
                    <div class="flex items-center justify-between px-5 py-3 border-b border-gray-200">
                        <h2 id="skills-readme-title" class="text-base font-semibold text-gray-900 flex items-center gap-2">
                            <span>📖</span><span id="skills-readme-folder"></span>
                        </h2>
                        <button type="button" id="skills-readme-close"
                                class="text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded p-1 transition"
                                aria-label="Close">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>
                    <div id="skills-readme-body"
                         class="markdown-content overflow-auto px-6 py-4"
                         style="flex: 1 1 auto;"></div>
                </div>
            `;
            document.body.appendChild(overlay);

            const close = () => { overlay.classList.add('hidden'); };
            overlay.querySelector('#skills-readme-close').addEventListener('click', close);
            overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
            document.addEventListener('keydown', (ev) => {
                if (ev.key === 'Escape' && !overlay.classList.contains('hidden')) close();
            });
        }
        overlay.querySelector('#skills-readme-folder').textContent = folderName;
        const body = overlay.querySelector('#skills-readme-body');
        body.innerHTML = (typeof window.renderMarkdown === 'function')
            ? window.renderMarkdown(markdown)
            : `<pre>${this.escapeHtml(markdown)}</pre>`;
        // Links inside the README open in a new tab (don't navigate away
        // from gpt/frontend). The markdown renderer already adds
        // target=_blank rel=noopener for href links — belt-and-suspenders here.
        body.querySelectorAll('a[href]').forEach((a) => {
            if (!a.target) a.target = '_blank';
            if (!a.rel) a.rel = 'noopener noreferrer';
        });
        overlay.classList.remove('hidden');
    }

    /**
     * Render one group folder with the skills inside it.
     */
    renderFolder(folder, skills) {
        const isCollapsed = this.collapsedFolders.has(folder.name);
        let childHtml = '';
        for (const skill of skills) childHtml += this.renderSkillItem(skill);
        const safeName = this.escapeHtml(folder.name);
        // README icon appears only when skills/<group>/README.md exists.
        // Click opens an overlay with the rendered markdown — explanation of
        // the bundle and any links to workflows orchestrating these skills.
        // stopPropagation is wired in attachTreeListeners so clicking the
        // icon doesn't also toggle the folder open/close state.
        const readmeButton = folder.readme
            ? `<button type="button" class="skills-folder-readme text-base leading-none text-gray-500 hover:text-indigo-600 px-1.5 py-0.5 flex-shrink-0"
                       data-folder="${safeName}"
                       style="font-size: 22px;"
                       title="Show README for this folder">📖</button>`
            : '';
        return `
            <div class="skills-category" data-folder="${safeName}">
                <div class="skills-folder flex items-center gap-1 px-2 py-1.5 text-xs font-semibold text-gray-700 cursor-pointer hover:bg-gray-100 rounded select-none"
                     data-folder="${safeName}">
                    <span class="skills-folder-icon">${isCollapsed ? '▶' : '▼'}</span>
                    <span>📁</span>
                    <span class="flex-1 truncate">${safeName}</span>
                    ${readmeButton}
                    <span class="text-gray-400 font-normal flex-shrink-0">${skills.length}</span>
                </div>
                <div class="skills-folder-children pl-3 ${isCollapsed ? 'hidden' : ''}">
                    ${childHtml || '<div class="text-gray-400 text-[11px] px-2 py-1 italic">empty — move skills here</div>'}
                </div>
            </div>
        `;
    }

    /**
     * Render a single skill item
     */
    renderSkillItem(skill) {
        const tags = (skill.tags || []).slice(0, 2).map(t => `<span class="bg-gray-200 text-gray-600 text-[10px] px-1 rounded">${this.escapeHtml(t)}</span>`).join(' ');
        // Folder icon for filesystem-backed skills, target icon for DB ones.
        // The "DB" badge on legacy skills is intentional — it tells users
        // those entries can't be edited in their file explorer.
        const isLocal = skill.source === 'local';
        const icon = isLocal ? '📁' : '🎯';
        const badge = isLocal
            ? `<span class="bg-indigo-100 text-indigo-700 text-[10px] px-1 rounded" title="Stored as a folder under your local data directory">folder</span>`
            : `<span class="bg-gray-100 text-gray-500 text-[10px] px-1 rounded" title="Stored in the database (legacy)">DB</span>`;
        // Spec-compliance badge for folder-backed skills only — DB skills
        // don't have a SKILL.md frontmatter to validate against.
        let specBadge = '';
        if (isLocal) {
            if (skill.spec_compliant === false && (skill.spec_issues || []).length > 0) {
                const issueList = skill.spec_issues.map(i => `• ${i}`).join('\n');
                const tip = `Non-spec SKILL.md:\n${issueList}\n\n(Skill still loads, but may not be portable to other tools.)`;
                specBadge = `<span class="bg-amber-100 text-amber-700 text-[10px] px-1 rounded" title="${this.escapeHtml(tip)}">⚠ non-spec</span>`;
            } else if (skill.spec_compliant === true) {
                specBadge = `<span class="bg-emerald-100 text-emerald-700 text-[10px] px-1 rounded" title="SKILL.md frontmatter is spec-compliant (agentskills.io / Anthropic).">✓ spec</span>`;
            }
        }
        const owner = (this.edition === 'corporate' && skill.mine === false && skill.owner_name)
            ? `<span class="text-[10px] text-gray-400 flex-shrink-0">${this.escapeHtml(this.t('skills.visibility.by', { name: skill.owner_name }))}</span>`
            : '';
        // Corporate edition: the owner flips a skill between Public and Private.
        const toggle = (this.edition === 'corporate' && skill.mine !== false)
            ? `<button type="button" class="skills-item-visibility px-1 text-[10px] text-gray-500 hover:text-indigo-700 hover:bg-gray-100 rounded transition flex-shrink-0"
                       data-skill-id="${skill.id}"
                       title="${this.escapeHtml(this.t(skill.visibility === 'public' ? 'skills.visibility.makePrivate' : 'skills.visibility.makePublic'))}">${this.escapeHtml(this.t(skill.visibility === 'public' ? 'skills.visibility.public' : 'skills.visibility.private'))}</button>`
            : '';
        // Skills that need other skills: ▸ arrow + count; skills others need: "used by N" with the names on hover.
        const links = this._treeLinks;
        const needs = links?.needs.get(skill.dir_name) || [];
        const users = links?.usedBy.get(skill.dir_name) || [];
        const arrow = needs.length ? this.renderExpandArrow(skill.dir_name) : '';
        const needsBadge = needs.length
            ? `<span class="skills-req-count bg-gray-100 text-gray-600 text-[10px] px-1 rounded flex-shrink-0" title="${this.escapeHtml(this.t('skills.needsTree.needsTitle', { count: needs.length }))}">${this.escapeHtml(this.t('skills.needsTree.needs', { count: needs.length }))}</span>`
            : '';
        const usedByHint = users.length
            ? `<span class="skills-req-usedby text-[10px] text-gray-400 flex-shrink-0" title="${this.escapeHtml(this.t('skills.needsTree.usedByTitle', { names: users.map((u) => u.name).join(', ') }))}">${this.escapeHtml(this.t('skills.needsTree.usedBy', { count: users.length }))}</span>`
            : '';
        const children = needs.length && this.expandedSkills.has(skill.dir_name) ? this.renderRequiredRows(skill, []) : '';
        return `
            <div class="skills-item flex items-center gap-1 px-2 py-1.5 text-xs text-gray-700 cursor-pointer hover:bg-blue-50 rounded select-none"
                 draggable="true"
                 data-skill-id="${skill.id}" title="${this.escapeHtml(skill.description || '')}">
                ${arrow}
                <span>${icon}</span>
                <span class="flex-1 truncate">${this.escapeHtml(skill.name)}</span>
                ${needsBadge}
                ${usedByHint}
                ${owner}
                ${tags}
                ${specBadge}
                ${badge}
                ${toggle}
                <button type="button"
                        class="skills-item-menu px-1 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded transition flex-shrink-0"
                        data-skill-id="${skill.id}"
                        title="Options">⋮</button>
            </div>${children}
        `;
    }

    /**
     * Attach click and context menu listeners to rendered tree items
     */
    attachTreeListeners() {
        // README button on group folders — open overlay. Wired BEFORE the
        // folder-row click handler so stopPropagation prevents the row's
        // expand/collapse from also firing.
        this.treeContainer.querySelectorAll('.skills-folder-readme').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const name = btn.dataset.folder;
                const folder = this.folders.find(f => f.name === name);
                if (folder?.readme) this._openReadmeOverlay(folder.name, folder.readme);
            });
        });

        // Folder toggle + folder context menu
        this.treeContainer.querySelectorAll('.skills-folder').forEach(el => {
            el.addEventListener('click', (e) => {
                // Don't toggle when the click came from the README button or
                // anything else that asked us to leave it alone.
                if (e.target.closest('.skills-folder-readme')) return;
                const name = el.dataset.folder;
                if (this.collapsedFolders.has(name)) this.collapsedFolders.delete(name);
                else this.collapsedFolders.add(name);
                this.renderTree();

                // First-interaction auto-open: if this folder has a README and
                // we've never opened it for this user before, show the overlay
                // once so they discover the feature. Persisted in localStorage
                // so it never replays for the same folder.
                if (this._maybeAutoOpenReadme) this._maybeAutoOpenReadme(name);
            });

            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.contextTarget = { type: 'folder', name: el.dataset.folder };
                this.showContextMenu(e.clientX, e.clientY, 'folder');
            });
        });

        // Skill items — single click to edit, right click for context menu, drag to chat input
        // Skill ids may be numeric (DB) or strings like "local:medium-format"
        // (filesystem-backed). Compare by string to handle both.
        this.treeContainer.querySelectorAll('.skills-item').forEach(el => {
            el.addEventListener('click', (e) => {
                // Clicks on the ⋮ button shouldn't open the editor.
                if (e.target.closest('.skills-item-menu')) return;
                if (e.target.closest('.skills-req-toggle')) return;   // the arrow only expands
                const skill = this.findSkillByDatasetId(el.dataset.skillId);
                if (skill) window.SkillEditor.open({ skill, manager: this });
            });

            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.contextTarget = { type: 'skill', id: el.dataset.skillId };
                const picked = this.findSkillByDatasetId(el.dataset.skillId);
                if (picked?.dir_name) this.lastSkillDir = picked.dir_name;   // Export preselects it
                this.showContextMenu(e.clientX, e.clientY, 'skill');
            });

            el.addEventListener('dragstart', (e) => {
                const skill = this.findSkillByDatasetId(el.dataset.skillId);
                if (!skill) return;
                const payload = {
                    id: skill.id,
                    name: skill.name,
                    skill_content: skill.skill_content || '',
                    // Folder-backed skills carry their dir + script list so the
                    // chat backend can declare run_skill_script to the LLM.
                    // Server-side skills leave these unset.
                    dir_name: skill.dir_name || null,
                    scripts: Array.isArray(skill.scripts) ? skill.scripts : [],
                    source: skill.source || null,
                    mine: skill.mine !== false,
                };
                e.dataTransfer.setData('application/x-skill', JSON.stringify(payload));
                // Folder drop targets accept only this marker: others' public skills can go to the chat, not into a folder.
                if (skill.mine !== false) e.dataTransfer.setData('application/x-skill-movable', '1');
                // copy → dropping onto the chat input; move → onto a folder.
                e.dataTransfer.effectAllowed = 'copyMove';
            });
        });

        // ▸/▾ arrow: show or hide the skills a skill requires (the row itself still opens the editor).
        this.treeContainer.querySelectorAll('.skills-req-toggle').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.toggleExpanded(btn.dataset.expand);
            });
        });

        // A required skill listed under another is a link: click opens that skill's editor.
        this.treeContainer.querySelectorAll('.skills-req-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.skills-req-toggle')) return;
                const skill = this.findSkillByDatasetId(el.dataset.skillId);
                if (skill) window.SkillEditor.open({ skill, manager: this });
            });
        });

        // Folders accept dropped skills — drag a skill onto a folder block to
        // move it into that folder. Skill rows are already draggable (they
        // also drag to the chat input); this just adds the folder as a drop
        // target. Inline styles for the highlight — the CDN Tailwind build
        // doesn't reliably emit runtime-toggled utility classes.
        this.treeContainer.querySelectorAll('.skills-category').forEach(cat => {
            const folderName = cat.dataset.folder;
            const lit = (on) => {
                cat.style.outline = on ? '2px solid #3b82f6' : '';
                cat.style.borderRadius = on ? '6px' : '';
            };
            cat.addEventListener('dragover', (e) => {
                if (!e.dataTransfer.types.includes('application/x-skill-movable')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                lit(true);
            });
            cat.addEventListener('dragleave', (e) => {
                // Ignore moves between this folder's own descendants.
                if (!cat.contains(e.relatedTarget)) lit(false);
            });
            cat.addEventListener('drop', (e) => {
                e.preventDefault();
                lit(false);
                this.handleSkillDropOnFolder(e, folderName);
            });
        });

        this.treeContainer.querySelectorAll('.skills-item-visibility').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const skill = this.findSkillByDatasetId(btn.dataset.skillId);
                if (skill) this.toggleVisibility(skill);
            });
        });

        // ⋮ menu buttons — open the same context menu the right-click uses,
        // positioned just below the button so it visually anchors to the row.
        this.treeContainer.querySelectorAll('.skills-item-menu').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.contextTarget = { type: 'skill', id: btn.dataset.skillId };
                const rect = btn.getBoundingClientRect();
                this.showContextMenu(rect.right, rect.bottom + 2, 'skill');
            });
        });
    }

    /**
     * Move a skill into a folder in response to a drop on that folder's
     * block in the tree. Reads the dragged skill from the same
     * `application/x-skill` payload the chat-input drop uses. A drop onto
     * the folder the skill is already in is a silent no-op.
     */
    async handleSkillDropOnFolder(e, folderName) {
        let payload;
        try {
            payload = JSON.parse(e.dataTransfer.getData('application/x-skill') || '{}');
        } catch {
            return;
        }
        if (!payload || payload.source !== 'local' || !payload.dir_name || payload.mine === false) return;

        const slash = payload.dir_name.indexOf('/');
        const currentGroup = slash === -1 ? null : payload.dir_name.slice(0, slash);
        if (currentGroup === folderName) return;   // already in this folder

        const res = await window.skillsFs.moveSkill(payload.dir_name, folderName);
        if (!res.ok) {
            alert('Could not move the skill: ' + (res.error || 'unknown error'));
            return;
        }
        await this.loadTree();
    }

    /**
     * Look up a skill regardless of whether its id is numeric (DB) or a
     * string like "local:medium-format" (filesystem). The dataset value is
     * always a string, so we compare via String() coercion.
     */
    findSkillByDatasetId(datasetId) {
        if (!datasetId) return null;
        return this.skills.find(s => String(s.id) === String(datasetId)) || null;
    }

    /**
     * Show a small modal letting the user pick an import source: an
     * existing folder on their disk, or a .zip / .skill file. Closes
     * immediately on the user's choice; the import service then runs and
     * we refresh the tree.
     */
    showImportPicker() {
        document.getElementById('skills-import-modal')?.remove();

        const modal = document.createElement('div');
        modal.id = 'skills-import-modal';
        modal.className = 'fixed inset-0 z-[200] flex items-center justify-center';
        modal.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
        modal.innerHTML = `
            <div class="bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-md mx-4 p-5">
                <div class="flex items-center justify-between mb-4">
                    <h3 class="text-base font-semibold text-gray-800">Import Skill</h3>
                    <button id="skills-import-close" class="p-1.5 text-gray-500 hover:text-gray-700 rounded">&#10005;</button>
                </div>
                <div id="skills-import-choose">
                <p id="skills-import-intro" class="text-xs text-gray-500 mb-4">
                    Adds a new folder under your local skills directory. The skill must contain a <code class="bg-gray-100 px-1 rounded">SKILL.md</code> at its root (Anthropic-spec).
                </p>
                <div class="flex flex-col gap-2">
                    <button id="skills-import-folder-btn" class="flex items-center gap-3 px-4 py-3 border border-gray-200 rounded-lg hover:bg-blue-50 hover:border-blue-300 transition text-left">
                        <span class="text-2xl">📁</span>
                        <span>
                            <span class="block text-sm font-medium text-gray-800">From a folder</span>
                            <span class="block text-xs text-gray-500">Pick a directory on your disk; its contents are copied in.</span>
                        </span>
                    </button>
                    <button id="skills-import-zip-btn" class="flex items-center gap-3 px-4 py-3 border border-gray-200 rounded-lg hover:bg-blue-50 hover:border-blue-300 transition text-left">
                        <span class="text-2xl">🗜️</span>
                        <span>
                            <span class="block text-sm font-medium text-gray-800">From a .zip / .skill</span>
                            <span class="block text-xs text-gray-500">Upload a zipped skill — common for sharing.</span>
                        </span>
                    </button>
                    <button id="skills-import-github-btn" class="flex items-center gap-3 px-4 py-3 border border-gray-200 rounded-lg hover:bg-blue-50 hover:border-blue-300 transition text-left">
                        <span class="text-2xl">🐙</span>
                        <span>
                            <span class="block text-sm font-medium text-gray-800">From a GitHub URL</span>
                            <span class="block text-xs text-gray-500">e.g. anthropics/skills/tree/main/document-skills/pdf — installs into your skills folder.</span>
                        </span>
                    </button>
                </div>
                <div id="skills-import-github-form" class="hidden mt-3">
                    <input id="skills-import-github-url" type="text" placeholder="https://github.com/owner/repo/tree/branch/path"
                           class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-400" />
                    <div class="flex justify-end gap-2 mt-2">
                        <button id="skills-import-github-cancel" type="button" class="px-3 py-1 text-xs text-gray-600 hover:bg-gray-100 rounded">Cancel</button>
                        <button id="skills-import-github-install" type="button" class="px-3 py-1 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded">Install</button>
                    </div>
                </div>
                <details class="mt-4 text-xs text-gray-600">
                    <summary class="cursor-pointer hover:text-gray-800">Already have skills installed for Claude Code or another tool?</summary>
                    <div class="mt-2 pl-2 border-l-2 border-gray-200 space-y-1.5">
                        <p>Folder-backed skills follow the same SKILL.md spec across most tools. To reuse skills you've installed elsewhere without copying them, symlink them into your data folder:</p>
                        <pre class="bg-gray-100 px-2 py-1.5 rounded text-[11px] overflow-x-auto"><code># Claude Code skills:
ln -s ~/.claude/skills/* ~/Documents/synergyAI/skills/

# Cross-tool .agents/ convention (draft):
ln -s ~/.agents/skills/* ~/Documents/synergyAI/skills/</code></pre>
                        <p class="text-gray-500">Symlinks are read-only from this app's perspective — edits in the source folder show up here on next reload.</p>
                    </div>
                </details>
                </div>
                <div id="skills-import-status" class="hidden mt-4 text-xs"></div>
            </div>
        `;
        document.body.appendChild(modal);
        // The Docker app installs into its own skill storage, not the local folder.
        window.skillsFs?.mode?.().then((mode) => {
            const intro = modal.querySelector('#skills-import-intro');
            if (mode !== 'folder' && intro) intro.textContent = this.t('skills.import.introStore');
        }).catch(() => {});

        const status = modal.querySelector('#skills-import-status');
        const showStatus = (text, kind /* 'info' | 'error' | 'ok' */) => {
            status.classList.remove('hidden');
            status.className = 'mt-4 text-xs px-3 py-2 rounded-lg border ' + (
                kind === 'ok'    ? 'bg-green-50 border-green-200 text-green-800' :
                kind === 'error' ? 'bg-red-50 border-red-200 text-red-800'       :
                                   'bg-blue-50 border-blue-200 text-blue-800'
            );
            status.textContent = text;
        };

        const close = () => modal.remove();
        modal.querySelector('#skills-import-close').addEventListener('click', close);
        modal.addEventListener('click', e => { if (e.target === modal) close(); });

        const handleResult = (result) => {
            console.log('[skillsImport] result:', result);
            if (result.cancelled) {
                showStatus('No folder selected — try again.', 'info');
                return;
            }
            if (!result.ok) {
                showStatus(result.error || 'Import failed.', 'error');
                return;
            }
            const also = (result.requires || []).filter((r) => r.status === 'installed').map((r) => r.name || r.dir);
            showStatus(`Imported "${result.name}" (${result.fileCount} file${result.fileCount === 1 ? '' : 's'}).`
                + (also.length ? ' ' + this.t('skills.import.alsoInstalled', { list: also.join(', ') }) : ''), 'ok');
            // Refresh the tree so the new skill appears.
            this.loadTree();
            // Auto-close after a short read time.
            setTimeout(close, 1200);
        };

        modal.querySelector('#skills-import-folder-btn').addEventListener('click', async () => {
            showStatus('Opening folder picker…', 'info');
            const result = await window.skillsImport.readFromFolder();
            if (result.ok) this.showZipReview(modal, result.read, showStatus, handleResult,
                { kind: 'folder', label: result.read.dir });
            else handleResult(result);
        });
        modal.querySelector('#skills-import-zip-btn').addEventListener('click', async () => {
            showStatus('Choose a .zip / .skill file…', 'info');
            const file = await window.skillsImport.pickZipFile();
            if (!file) { showStatus(this.t('skills.zip.noFile'), 'info'); return; }
            let read;
            try {
                read = await window.skillsImport.readZipFile(file);
            } catch (e) {
                showStatus(this.t('skills.zip.failed', { message: e?.message || this.t('skills.zip.unreadable') }), 'error');
                return;
            }
            this.showZipReview(modal, read, showStatus, handleResult, { kind: 'zip', label: file.name });
        });

        // GitHub URL flow: reveal a small inline form to capture the URL,
        // then run readFromGitHub. Two-step instead of a prompt() so
        // we can keep the rest of the modal styling consistent and let
        // the user see the URL as they paste it.
        const githubForm = modal.querySelector('#skills-import-github-form');
        const githubUrlInput = modal.querySelector('#skills-import-github-url');
        modal.querySelector('#skills-import-github-btn').addEventListener('click', () => {
            githubForm.classList.remove('hidden');
            githubUrlInput.focus();
            status.classList.add('hidden');
        });
        modal.querySelector('#skills-import-github-cancel').addEventListener('click', () => {
            githubForm.classList.add('hidden');
            githubUrlInput.value = '';
        });
        const installFromGithub = async () => {
            const url = githubUrlInput.value.trim();
            if (!url) {
                showStatus('Paste a GitHub URL first.', 'error');
                return;
            }
            showStatus('Downloading from GitHub…', 'info');
            const result = await window.skillsImport.readFromGitHub(url);
            if (result.ok) {
                githubForm.classList.add('hidden');
                this.showZipReview(modal, result.read, showStatus, handleResult, { kind: 'github', label: url });
            } else handleResult(result);
        };
        modal.querySelector('#skills-import-github-install').addEventListener('click', installFromGithub);
        githubUrlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); installFromGithub(); }
        });
    }

    /**
     * What a skill folder holds, for the import review: total files and bytes, and one row per top-level
     * entry — SKILL.md first, then each folder with its file count, then the loose files as one row.
     */
    static summarizeSkillFiles(files) {
        const rels = Object.keys(files || {});
        const folders = new Map();
        let loose = 0, bytes = 0;
        for (const rel of rels) {
            bytes += (files[rel] && files[rel].length) || 0;
            const slash = rel.indexOf('/');
            if (slash > 0) folders.set(rel.slice(0, slash), (folders.get(rel.slice(0, slash)) || 0) + 1);
            else if (rel !== 'SKILL.md') loose++;
        }
        const groups = [];
        if (rels.includes('SKILL.md')) groups.push({ kind: 'skillmd', name: 'SKILL.md', count: 1 });
        for (const name of [...folders.keys()].sort()) groups.push({ kind: 'folder', name: name + '/', count: folders.get(name) });
        if (loose) groups.push({ kind: 'loose', name: '', count: loose });
        return { total: rels.length, bytes, groups };
    }

    /**
     * Review a skill before installing it. Replaces the source choices (they are done) with: where the skill
     * came from, its name and description, what the folder holds, its libraries, where it will be installed,
     * the Public/Private choice (corporate edition only, Private preselected), and Cancel / Import.
     * source = { kind: 'folder' | 'zip' | 'github', label }.
     */
    async showZipReview(modal, read, showStatus, handleResult, source = {}) {
        const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const t = this.t;
        const sizeText = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
        const md = read.files && read.files['SKILL.md'] ? new TextDecoder().decode(read.files['SKILL.md']) : '';
        const meta = (md && window.skillsFs?.parseFrontmatter) ? (window.skillsFs.parseFrontmatter(md).meta || {}) : {};
        const deps = (read.manifest && read.manifest.dependencies)
            || (md && window.SkillZip?.skillDependencies ? window.SkillZip.skillDependencies(md) : []);
        const wheels = [...Object.keys(read.pyodideWheels || {}), ...Object.keys(read.nativeWheels || {})];
        const summary = SkillsManager.summarizeSkillFiles(read.files);
        const [mode, edition] = await Promise.all([
            window.skillsFs?.mode ? window.skillsFs.mode() : 'folder',
            window.skillsFs?.edition ? window.skillsFs.edition() : '',
        ]);
        const sourceKey = { folder: 'skills.import.fromFolder', zip: 'skills.import.fromZip', github: 'skills.import.fromGithub' }[source.kind];
        const groupText = (g) => g.kind === 'loose'
            ? t('skills.import.looseFiles', { count: g.count })
            : g.kind === 'skillmd' ? 'SKILL.md' : `${g.name} — ${t('skills.zip.files', { count: g.count })}`;
        const libraries = !deps.length && !wheels.length ? t('skills.import.noLibraries')
            : wheels.length ? t('skills.import.librariesBundled', { list: deps.join(', ') || '—', count: wheels.length })
            : t('skills.import.librariesOnline', { list: deps.join(', ') });
        const destination = mode === 'folder'
            ? t('skills.import.destFolder', { dir: read.dir })
            : t('skills.import.destStore');
        // The skills it requires come with it (skill zip): each marked when it is already installed.
        let alsoInstalls = '';
        if ((read.requires || []).length) {
            let plan = [];
            try { plan = window.skillsFs?.importPlan ? await window.skillsFs.importPlan(read) : []; } catch (e) { console.warn('[skillsImport] import plan failed:', e); }
            const statusOf = (dir) => (plan.find((x) => x.dir === dir) || {}).status;
            alsoInstalls = read.requires.map((r) => {
                const st = statusOf(r.dir);
                const note = st === 'identical' ? ` (${t('skills.import.alreadyInstalled')})` : st === 'clash' ? ` (${t('skills.import.requiredClash')})` : '';
                return esc(r.name || r.dir) + esc(note);
            }).join(', ');
        }

        // The choices and any "Opening folder picker…" line belong to the step that is now over.
        modal.querySelector('#skills-import-choose')?.classList.add('hidden');
        modal.querySelector('#skills-import-status')?.classList.add('hidden');
        modal.querySelector('#skills-import-review')?.remove();

        const row = (label, value) => `
            <div class="flex gap-2"><span class="w-24 shrink-0 text-gray-500">${esc(label)}</span><span class="min-w-0 break-words">${value}</span></div>`;
        const box = document.createElement('div');
        box.id = 'skills-import-review';
        box.className = 'text-xs text-gray-700 space-y-2';
        box.innerHTML = `
            ${sourceKey ? row(t('skills.import.source'), `${esc(t(sourceKey))}: <code class="bg-gray-100 px-1 rounded">${esc(source.label || '')}</code>`) : ''}
            <div class="border border-gray-200 rounded-lg p-3 space-y-2">
                <div class="text-sm font-semibold text-gray-800">${esc(meta.name || read.name)}</div>
                ${meta.description ? `<div class="text-gray-600">${esc(meta.description)}</div>` : ''}
                ${row(t('skills.import.contents'), `${esc(t('skills.zip.files', { count: summary.total }))}, ${esc(sizeText(summary.bytes))}
                    <ul class="mt-1 space-y-0.5">${summary.groups.map((g) => `<li>${esc(groupText(g))}</li>`).join('')}</ul>`)}
                ${row(t('skills.import.libraries'), esc(libraries))}
                ${alsoInstalls ? row(t('skills.import.alsoInstalls'), alsoInstalls) : ''}
                ${read.localUnavailable ? `
                <div class="px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-900">
                    ${esc(t('skills.import.localUnavailable'))}
                    <button type="button" data-review="allow" class="ml-1 px-2 py-0.5 border border-amber-400 bg-white rounded hover:bg-amber-100">${esc(t('skills.fsaGrantBtn'))}</button>
                </div>` : ''}
                ${row(t('skills.import.destination'), esc(destination))}
                ${edition === 'corporate' ? row(t('skills.import.visibility'), `
                    <span class="flex gap-4">
                        <label class="flex items-center gap-1"><input type="radio" name="skills-zip-visibility" value="private" checked> ${esc(t('skills.zip.private'))}</label>
                        <label class="flex items-center gap-1"><input type="radio" name="skills-zip-visibility" value="public"> ${esc(t('skills.zip.public'))}</label>
                    </span>`) : ''}
            </div>
            <div class="flex justify-end gap-2 pt-1">
                <button type="button" data-review="cancel" class="px-3 py-1.5 text-gray-600 border border-gray-300 hover:bg-gray-100 rounded">${esc(t('common.cancel'))}</button>
                <button type="button" data-review="install" class="px-3 py-1.5 text-white bg-blue-600 hover:bg-blue-700 rounded">${esc(t('skills.zip.install'))}</button>
            </div>`;
        modal.querySelector('#skills-import-status').before(box);
        box.querySelector('[data-review="cancel"]').addEventListener('click', () => modal.remove());
        // No access to the local SynergyAI folder: ask for it (a click is the user gesture the browser needs),
        // then look for the required skills again and redraw this review.
        box.querySelector('[data-review="allow"]')?.addEventListener('click', async () => {
            const res = await window.localFs?.requestRootAccess?.('synergyAI');
            if (!res?.ok) return;
            read.requires = [];
            try {
                await window.skillsImport._attachRequires(read);
            } catch (e) {
                showStatus(e.message, 'error');
                return;
            }
            this.showZipReview(modal, read, showStatus, handleResult, source);
        });
        box.querySelector('[data-review="install"]').addEventListener('click', async () => {
            const visibility = box.querySelector('input[name="skills-zip-visibility"]:checked')?.value || 'private';
            box.querySelectorAll('button').forEach((b) => { b.disabled = true; });
            // Public: my own private skills it needs go public too (a public skill never needs a private one) — confirmed first.
            let confirmed = null;
            if (visibility === 'public' && window.skillsFs?.importPlan) {
                try {
                    const plan = await window.skillsFs.importPlan(read, { visibility });
                    confirmed = Object.fromEntries(plan.map((x) => [x.dir, x.madePublic || []]));
                    const extra = [...new Set(plan.flatMap((x) => x.madePublic || []))];
                    if (extra.length && window.SkillVisibilityCard?.confirmPublic
                        && !(await window.SkillVisibilityCard.confirmPublic({ name: read.name, list: extra, t }))) {
                        box.querySelectorAll('button').forEach((b) => { b.disabled = false; });
                        return;
                    }
                } catch (e) {
                    box.querySelectorAll('button').forEach((b) => { b.disabled = false; });
                    const d = e?.data?.data;
                    showStatus(d && d.reason && window.skillsFs.requiredByMessage ? window.skillsFs.requiredByMessage(d, t) : t('skills.zip.failed', { message: e?.message || e }), 'error');
                    return;
                }
            }
            const result = await window.skillsImport.installRead(read, { visibility, ...(confirmed ? { confirmed } : {}) });
            box.querySelectorAll('button').forEach((b) => { b.disabled = false; });
            if (result.ok && result.status === 'identical') {
                showStatus(t('skills.zip.identical', { name: read.name }), 'ok');
                return;
            }
            if (result.ok) box.remove();
            handleResult(result);
        });
    }

    /**
     * Show context menu at position
     */
    showContextMenu(x, y, type) {
        if (!this.contextMenu) return;

        // Show/hide items per target type. Edit + Move apply to skills only;
        // Rename and Delete apply to both skills and folders.
        const editItem = this.contextMenu.querySelector('[data-action="edit"]');
        const moveItem = this.contextMenu.querySelector('[data-action="move"]');
        const renameItem = this.contextMenu.querySelector('[data-action="rename"]');
        const optimizeItem = this.contextMenu.querySelector('[data-action="optimize"]');
        if (editItem) editItem.classList.toggle('hidden', type !== 'skill');
        if (moveItem) moveItem.classList.toggle('hidden', type !== 'skill');
        if (renameItem) renameItem.classList.toggle('hidden', false);
        if (optimizeItem) optimizeItem.classList.toggle('hidden', type !== 'skill');
        // Export: a skill (any you can see).
        this.contextMenu.querySelector('[data-action="export"]')?.classList.toggle('hidden', type !== 'skill');
        // Someone else's public skill: no rename / delete / move / optimize.
        const target = type === 'skill' ? this.findSkillByDatasetId(this.contextTarget?.id) : null;
        if (target && target.mine === false) {
            for (const a of ['move', 'rename', 'delete', 'optimize']) {
                this.contextMenu.querySelector(`[data-action="${a}"]`)?.classList.add('hidden');
            }
        } else {
            this.contextMenu.querySelector('[data-action="delete"]')?.classList.remove('hidden');
        }

        // Position then unhide so we can measure. If the menu would
        // overflow the viewport (typical when right-clicking near the
        // bottom of a long sidebar), flip it upward / clamp it inward
        // so it stays fully on-screen. 8px margin keeps it from
        // touching the edge.
        this.contextMenu.style.left = x + 'px';
        this.contextMenu.style.top = y + 'px';
        this.contextMenu.classList.remove('hidden');

        const margin = 8;
        const rect = this.contextMenu.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let adjX = x;
        let adjY = y;
        if (rect.bottom > vh - margin) {
            // Flip up: place the menu so its bottom sits at the click point
            // (or, if that still overflows the top, clamp to top + margin).
            adjY = Math.max(margin, y - rect.height);
        }
        if (rect.right > vw - margin) {
            adjX = Math.max(margin, x - rect.width);
        }
        if (adjX !== x) this.contextMenu.style.left = adjX + 'px';
        if (adjY !== y) this.contextMenu.style.top = adjY + 'px';
    }

    hideContextMenu() {
        if (this.contextMenu) {
            this.contextMenu.classList.add('hidden');
        }
    }

    /**
     * Handle context menu action
     */
    async handleContextAction(action) {
        if (!this.contextTarget) return;
        const { type, id, name } = this.contextTarget;

        if (action === 'edit' && type === 'skill') {
            const skill = this.findSkillByDatasetId(id);
            if (skill) window.SkillEditor.open({ skill, manager: this });

        } else if (action === 'export' && type === 'skill') {
            const skill = this.findSkillByDatasetId(id);
            if (skill) this.showExportPicker(skill.dir_name, { only: true });

        } else if (action === 'move' && type === 'skill') {
            const skill = this.findSkillByDatasetId(id);
            if (skill) await this.promptMoveToFolder(skill);

        } else if (action === 'rename' && type === 'skill') {
            const skill = this.findSkillByDatasetId(id);
            if (!skill) return;
            const currentLeaf = String(skill.dir_name || '').split('/').pop();
            const newName = prompt('Rename skill folder:', currentLeaf);
            if (newName && newName.trim() && newName.trim() !== currentLeaf) {
                await this.renameSkill(skill, newName.trim());
            }

        } else if (action === 'optimize' && type === 'skill') {
            const skill = this.findSkillByDatasetId(id);
            if (skill && window.skillOptPanel) {
                window.skillOptPanel.openFor(skill);
            } else if (!window.skillOptPanel) {
                alert('SkillOpt panel module not loaded.');
            }

        } else if (action === 'rename' && type === 'folder') {
            const newName = prompt('Rename folder:', name);
            if (newName && newName.trim() && newName.trim() !== name) {
                const res = await window.skillsFs.renameFolder(name, newName.trim());
                if (!res.ok) { alert(res.error || 'Could not rename the folder.'); return; }
                await this.loadTree();
            }

        } else if (action === 'delete') {
            if (type === 'skill') {
                const skill = this.findSkillByDatasetId(id);
                if (!skill) return;
                if (confirm(`Delete skill "${skill.name}"? This removes its folder and can't be undone.`)) {
                    await this.deleteSkill(skill);
                }
            } else if (type === 'folder') {
                const count = this.skills.filter(s => s.group === name).length;
                const msg = count > 0
                    ? `Delete folder "${name}" and the ${count} skill(s) inside it? This can't be undone.`
                    : `Delete the empty folder "${name}"?`;
                if (confirm(msg)) {
                    const res = await window.skillsFs.deleteFolder(name);
                    if (!res.ok) { alert(res.error || 'Could not delete the folder.'); return; }
                    await this.loadTree();
                }
            }
        }

        this.contextTarget = null;
    }

    // ===================== CRUD Operations (filesystem only) =====================
    //
    // Skills live as folders under <root>/skills/. There is no DB skill store
    // anymore — creating a skill means dropping a folder with SKILL.md and
    // optional scripts/*.py. The legacy createSkill/updateSkill DB-writers
    // were removed when the skills/skill_categories tables were retired.

    /**
     * Delete a folder-backed skill — removes its directory under
     * <root>/skills/ (handles skills nested inside a group folder).
     */
    async deleteSkill(skill) {
        if (skill.source !== 'local') {
            console.warn('[skillsManager] deleteSkill called on non-local skill; ignoring.', skill);
            return;
        }
        const res = await window.skillsFs.deleteSkill(skill.dir_name);
        if (!res.ok) {
            // A skill other skills need: the refusal says why and what to do.
            if (res.requiredBy) { this.notify(res.error); return; }
            alert('Could not delete the skill folder: ' + (res.error || 'unknown error'));
            return;
        }
        await this.loadTree();
    }

    /**
     * Rename a folder-backed skill — renames its directory within the
     * current group. The `name:` field inside SKILL.md is the on-disk source
     * of truth for the display name and is left untouched, so a renamed
     * skill may flag a spec mismatch until SKILL.md is edited too.
     */
    async renameSkill(skill, newName) {
        if (skill.source !== 'local') {
            console.warn('[skillsManager] renameSkill called on non-local skill; ignoring.', skill);
            return;
        }
        const res = await window.skillsFs.renameSkill(skill.dir_name, newName);
        if (!res.ok) {
            if (res.requiredBy) { this.notify(res.error); return; }
            alert('Could not rename the skill folder: ' + (res.error || 'unknown error'));
            return;
        }
        await this.loadTree();
    }

    // ===================== Visibility (corporate skill store) =====================

    notify(message) { alert(message); }

    /** Flip one of my skills between Public and Private; a refusal is explained, not thrown. */
    async toggleVisibility(skill) {
        const to = skill.visibility === 'public' ? 'private' : 'public';
        try {
            if (to === 'public' && window.SkillVisibilityCard?.makePublic) {
                // The skills it needs go public along (confirmed first); Cancel changes nothing.
                const r = await window.SkillVisibilityCard.makePublic(skill.dir_name, { t: this.t });
                if (!r.done) return;
            } else {
                await window.skillsFs.setVisibility(skill.dir_name, to);
            }
        } catch (e) {
            // skillsFs.api() puts the whole body on e.data: {success, data:{message, robot_workflows | clash | required_by}, error}.
            const d = e.data?.data ?? e.data ?? {};
            const robots = Array.isArray(d.robot_workflows) && d.robot_workflows.length ? d.robot_workflows : null;
            if (d.reason && Array.isArray(d.required_by) && window.skillsFs?.requiredByMessage) {
                this.notify(window.skillsFs.requiredByMessage(d, this.t));
            } else if (robots) {
                this.notify(this.t('skills.visibility.robotBlocked', { names: robots.map(r => r.name ?? r.id ?? r).join(', ') }));
            } else if (d.clash) {
                // Making it public may move a skill it needs too: the server names the one that clashes.
                const clashing = (/'([^']+)'/.exec(String(d.message || '')) || [])[1];
                this.notify(this.t('skills.visibility.clash', { name: clashing || skill.name }));
            } else {
                this.notify(this.t('skills.visibility.failed', { message: e.message }));
            }
            return;
        }
        await this.loadTree();
    }

    // ===================== One-time import of the user's own folder skills =====================

    currentUserId() {
        const u = window.authManager?.user;
        return u?.id ?? u?.uid ?? null;
    }

    migrationKey() {
        return `skills_migrate_done_${this.currentUserId()}`;
    }

    markMigrationDone() {
        if (!this.currentUserId()) return;
        try { localStorage.setItem(this.migrationKey(), '1'); } catch (e) { /* storage unavailable */ }
    }

    /** The folder skills to offer for import, or null when the offer does not apply. */
    async migrationOffer() {
        const fs = window.skillsFs;
        if (!fs || !this.currentUserId() || localStorage.getItem(this.migrationKey())) return null;
        if (await fs.mode() !== 'volume') return null;
        if ((await fs.listSkills()).some(s => s.mine)) return null;
        let list = [];
        try { list = await fs.listFolderSkills(); } catch (e) { return null; }
        return list.length ? list : null;
    }

    /** Import each folder skill privately. Returns [{ path, status: installed|exists|clash|failed, message? }]. */
    async runMigration(list) {
        const fs = window.skillsFs;
        const out = [];
        for (const s of list) {
            const path = s.path || s.dirName;
            try {
                const files = await fs.readFolderSkillFiles(path);
                const wheels = await window.SkillWheels.gather(s.dependencies || []);
                const r = await fs.importSkill(
                    { dir: path, name: path.split('/').pop(), files, pyodideWheels: wheels.pyodide, nativeWheels: wheels.native },
                    { visibility: 'private' });
                out.push({ path, status: r && r.status === 'identical' ? 'exists' : 'installed' });
            } catch (e) {
                out.push({ path, status: e.code === 'clash' ? 'clash' : 'failed', message: e.message });
            }
        }
        this.markMigrationDone();
        return out;
    }

    /** Startup task: show the offer card when it applies. Does not wait for the user. */
    async offerMigration() {
        const list = await this.migrationOffer();
        if (!list) return;
        document.getElementById('skills-migrate-card')?.remove();
        const card = document.createElement('div');
        card.id = 'skills-migrate-card';
        card.className = 'fixed bottom-4 right-4 z-[300] w-80 bg-white rounded-xl shadow-xl border border-gray-200 p-4 text-sm';
        card.innerHTML = `
            <div class="font-semibold text-gray-800 mb-1">${this.escapeHtml(this.t('skills.migrate.title'))}</div>
            <p class="text-xs text-gray-600 mb-3">${this.escapeHtml(this.t('skills.migrate.body', { count: list.length }))}</p>
            <div id="skills-migrate-result" class="text-xs text-gray-700 mb-2 max-h-40 overflow-auto"></div>
            <div class="flex gap-2 justify-end">
                <button type="button" id="skills-migrate-later" class="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50">${this.escapeHtml(this.t('skills.migrate.later'))}</button>
                <button type="button" id="skills-migrate-go" class="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">${this.escapeHtml(this.t('skills.migrate.import'))}</button>
            </div>`;
        document.body.appendChild(card);
        card.querySelector('#skills-migrate-later').addEventListener('click', () => {
            this.markMigrationDone();
            card.remove();
        });
        card.querySelector('#skills-migrate-go').addEventListener('click', async () => {
            const go = card.querySelector('#skills-migrate-go');
            const later = card.querySelector('#skills-migrate-later');
            go.disabled = true; later.disabled = true;
            card.querySelector('#skills-migrate-result').textContent = this.t('skills.migrate.running');
            const res = await this.runMigration(list);
            card.querySelector('#skills-migrate-result').innerHTML = res.map(r =>
                `<div>${this.escapeHtml(r.path)}: ${this.escapeHtml(this.t('skills.migrate.' + r.status))}${r.message && r.status === 'failed' ? ' (' + this.escapeHtml(r.message) + ')' : ''}</div>`).join('');
            go.remove();
            later.disabled = false;
            later.textContent = this.t('skills.migrate.close');
            await this.loadTree();
        });
    }

    // ===================== Folders =====================

    /** Prompt for a name and create a new (empty) group folder. */
    async promptNewFolder() {
        if (!window.skillsFs) { alert('Local skills folder is not available.'); return; }
        const name = prompt('New folder name:');
        if (!name || !name.trim()) return;
        const res = await window.skillsFs.createFolder(name.trim());
        if (!res.ok) {
            alert(res.error || 'Could not create the folder.');
            return;
        }
        await this.loadTree();
    }

    /**
     * Modal to move a skill into a group folder, or back to the top level.
     * The File System Access API has no native move, so skillsFs.moveSkill
     * implements it as a recursive copy + delete.
     */
    async promptMoveToFolder(skill) {
        document.getElementById('skills-move-modal')?.remove();
        const current = skill.group || null;

        // Destinations: top level + every folder; the skill's current
        // location is shown disabled.
        const targets = [
            { value: '', label: '⬆ Top level', disabled: current === null },
            ...this.folders.map(f => ({
                value: f.name, label: `📁 ${f.name}`, disabled: f.name === current,
            })),
        ];

        const modal = document.createElement('div');
        modal.id = 'skills-move-modal';
        modal.className = 'fixed inset-0 z-[200] flex items-center justify-center';
        modal.style.backgroundColor = 'rgba(0,0,0,0.5)';
        modal.innerHTML = `
            <div class="bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-sm mx-4">
                <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                    <h3 class="text-sm font-bold text-gray-800">Move "${this.escapeHtml(skill.name)}" to…</h3>
                    <button id="skills-move-close" class="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition">&#10005;</button>
                </div>
                <div class="p-3 flex flex-col gap-1 max-h-72 overflow-y-auto">
                    ${targets.map(t => `
                        <button class="skills-move-target text-left px-3 py-2 text-sm rounded-lg border border-gray-200 ${t.disabled ? 'opacity-40 cursor-default' : 'hover:bg-blue-50 hover:border-blue-300'}"
                                data-target="${this.escapeHtml(t.value)}" ${t.disabled ? 'disabled' : ''}>
                            ${this.escapeHtml(t.label)}${t.disabled ? ' <span class="text-gray-400 text-xs">(current)</span>' : ''}
                        </button>`).join('')}
                    ${this.folders.length === 0
                        ? '<div class="text-xs text-gray-400 px-1 py-2">No folders yet — create one with the New Folder button.</div>'
                        : ''}
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const close = () => modal.remove();
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
        modal.querySelector('#skills-move-close').addEventListener('click', close);
        modal.querySelectorAll('.skills-move-target').forEach(btn => {
            if (btn.disabled) return;
            btn.addEventListener('click', async () => {
                close();
                const res = await window.skillsFs.moveSkill(skill.dir_name, btn.dataset.target || null);
                if (!res.ok) {
                    alert('Could not move the skill: ' + (res.error || 'unknown error'));
                    return;
                }
                await this.loadTree();
            });
        });
    }

    // ===================== Export =====================

    /**
     * Export dialog: choose a skill (preselected: the one passed, else the last one opened), see what the zip will
     * hold — the skill and every skill it requires, with their libraries — choose where to save, then Export.
     * The zip is SkillZip's self-contained format (skillsImport.exportSkillZip), so an import brings it all back.
     * only: the dialog is for that one skill (a skill's right-click Export…) — shown as its name, no list to pick from.
     */
    async showExportPicker(preselect = null, { only = false } = {}) {
        document.getElementById('skills-export-modal')?.remove();
        const t = this.t;
        const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const skills = [...(this.skills || [])].sort((a, b) => String(a.dir_name).localeCompare(String(b.dir_name)));
        if (!skills.length) { alert(t('skills.export.none')); return; }
        const initial = [preselect, this.lastSkillDir].find((d) => d && skills.some((s) => s.dir_name === d)) || skills[0].dir_name;
        const single = only && preselect === initial;

        const modal = document.createElement('div');
        modal.id = 'skills-export-modal';
        modal.className = 'fixed inset-0 z-[200] flex items-center justify-center';
        modal.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
        modal.innerHTML = `
            <div class="bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-md mx-4 p-5 text-xs text-gray-700 space-y-3">
                <div class="flex items-center justify-between">
                    <h3 class="text-base font-semibold text-gray-800">${esc(t('skills.export.title'))}</h3>
                    <button data-export="close" class="p-1.5 text-gray-500 hover:text-gray-700 rounded">&#10005;</button>
                </div>
                <p class="text-gray-500">${esc(t('skills.export.intro'))}</p>
                <label class="block">
                    <span class="block text-gray-500 mb-1">${esc(t('skills.export.skill'))}</span>
                    ${single ? `
                    <input type="hidden" data-export="skill" value="${esc(initial)}">
                    <span class="block px-2 py-1.5 border border-gray-200 bg-gray-50 rounded-lg text-sm font-medium text-gray-800">${esc(initial)}</span>` : `
                    <select data-export="skill" class="w-full px-2 py-1.5 border border-gray-300 rounded-lg text-sm">
                        ${skills.map((s) => `<option value="${esc(s.dir_name)}"${s.dir_name === initial ? ' selected' : ''}>${esc(s.dir_name)}</option>`).join('')}
                    </select>`}
                </label>
                <div data-export="details" class="border border-gray-200 rounded-lg p-3 space-y-1.5"></div>
                <div data-export="status" class="hidden px-3 py-2 rounded-lg border"></div>
                <div class="flex justify-end gap-2 pt-1">
                    <button type="button" data-export="cancel" class="px-3 py-1.5 text-gray-600 border border-gray-300 hover:bg-gray-100 rounded">${esc(t('common.cancel'))}</button>
                    <button type="button" data-export="go" class="px-3 py-1.5 text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50">${esc(t('skills.export.button'))}</button>
                </div>
            </div>`;
        document.body.appendChild(modal);

        const q = (k) => modal.querySelector(`[data-export="${k}"]`);
        const close = () => modal.remove();
        q('close').addEventListener('click', close);
        q('cancel').addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
        const status = (text, kind = 'info') => {
            const el = q('status');
            el.classList.toggle('hidden', !text);
            el.className = 'px-3 py-2 rounded-lg border ' + (kind === 'error' ? 'bg-red-50 border-red-200 text-red-800'
                : kind === 'ok' ? 'bg-green-50 border-green-200 text-green-800' : 'bg-blue-50 border-blue-200 text-blue-800')
                + (text ? '' : ' hidden');
            el.textContent = text || '';
        };
        const row = (label, value) => `<div class="flex gap-2"><span class="w-24 shrink-0 text-gray-500">${esc(label)}</span><span class="min-w-0 break-words">${value}</span></div>`;

        // What the zip will hold for the chosen skill: the skills it requires (dependencies first) and libraries.
        let ready = false;
        const describe = async () => {
            const dir = q('skill').value;
            ready = false;
            q('go').disabled = true;
            status('');
            q('details').innerHTML = `<div class="text-gray-400">${esc(t('skills.export.checking'))}</div>`;
            try {
                const files = await window.skillsFs.readSkillFiles(dir);
                const md = files['SKILL.md'] ? new TextDecoder().decode(files['SKILL.md']) : '';
                const requires = await window.skillsImport.readRequires(dir, files);
                const libs = new Set(window.SkillZip?.skillDependencies ? window.SkillZip.skillDependencies(md) : []);
                for (const r of requires) {
                    const rmd = r.files && r.files['SKILL.md'] ? new TextDecoder().decode(r.files['SKILL.md']) : '';
                    for (const d of (window.SkillZip?.skillDependencies ? window.SkillZip.skillDependencies(rmd) : [])) libs.add(d);
                }
                if (q('skill').value !== dir) return;   // changed meanwhile
                q('details').innerHTML = [
                    row(t('skills.export.skillsIncluded'), esc([dir, ...requires.map((r) => r.dir)].join(', '))),
                    row(t('skills.import.libraries'), esc(libs.size ? t('skills.export.librariesBundled', { list: [...libs].join(', ') }) : t('skills.import.noLibraries'))),
                ].join('');
                ready = true;
                q('go').disabled = false;
            } catch (e) {
                if (q('skill').value !== dir) return;
                q('details').innerHTML = '';
                status(e.message || String(e), 'error');
            }
        };
        q('skill').addEventListener('change', describe);
        await describe();

        q('go').addEventListener('click', async () => {
            if (!ready) return;
            const dir = q('skill').value;
            const leaf = dir.split('/').pop();
            // Ask where to save first, while this click still counts as a user gesture.
            let handle = null;
            if (typeof window.showSaveFilePicker === 'function') {
                try {
                    handle = await window.showSaveFilePicker({ suggestedName: `${leaf}.zip`,
                        types: [{ description: 'Skill zip', accept: { 'application/zip': ['.zip'] } }] });
                } catch (e) {
                    if (e?.name === 'AbortError') return;
                    handle = null;
                }
            }
            q('go').disabled = true;
            q('skill').disabled = true;
            status(t('skills.export.exporting'));
            const result = await window.skillsImport.exportSkillZip(dir, {
                onProgress: (stage) => status(t('skills.zip.progress.' + stage)),
            });
            q('skill').disabled = false;
            if (!result?.ok) {
                q('go').disabled = false;
                status(result?.error || t('skills.export.failed'), 'error');
                return;
            }
            const blob = new Blob([result.bytes], { type: 'application/zip' });
            let savedAs = `${result.name}.zip`;
            if (handle) {
                const w = await handle.createWritable();
                await w.write(blob);
                await w.close();
                savedAs = handle.name;
            } else {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = savedAs;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            }
            status(t('skills.export.done', { file: savedAs, count: 1 + (result.requires || []).length }), 'ok');
            setTimeout(close, 1800);
        });
    }

    // ===================== Picker for Agent Modal =====================

    /**
     * Returns a flat list of skills for use in dropdowns
     */
    getSkillsForPicker() {
        return this.skills.map(s => ({
            id: s.id,
            name: s.name,
            description: s.description || '',
            category: s.group || ''   // the skill's group folder, if any
        }));
    }

    // ===================== Skill enable/disable (Phase 7) =====================
    //
    // Per-skill on/off toggles for the auto-routing catalog. Persisted in
    // localStorage as a list of DISABLED dir_names so newly-installed skills
    // default to ON without a migration. Settings → Skills exposes the UI;
    // chat/workflow read the filtered list via getEnabledLocalSkills().

    static get DISABLED_KEY() { return 'synergyai.skills.disabled'; }

    /**
     * Read the set of disabled skill dir_names from localStorage.
     * Returns an empty Set if storage is missing or unparseable.
     */
    getDisabledSkillSet() {
        try {
            const raw = localStorage.getItem(SkillsManager.DISABLED_KEY);
            if (!raw) return new Set();
            const parsed = JSON.parse(raw);
            return new Set(Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : []);
        } catch {
            return new Set();
        }
    }

    /** Is this skill currently enabled? (Default: true.) */
    isSkillEnabled(dirName) {
        if (typeof dirName !== 'string' || !dirName) return false;
        return !this.getDisabledSkillSet().has(dirName);
    }

    /** Set a skill's enabled state and persist. */
    setSkillEnabled(dirName, enabled) {
        if (typeof dirName !== 'string' || !dirName) return;
        const set = this.getDisabledSkillSet();
        if (enabled) set.delete(dirName);
        else set.add(dirName);
        try {
            localStorage.setItem(SkillsManager.DISABLED_KEY, JSON.stringify([...set]));
        } catch (e) {
            console.warn('[skillsManager] could not persist disabled skills:', e);
        }
    }

    /**
     * Local folder-backed skills eligible for the LLM's run_skill_script
     * catalog. The LLM is shown every installed skill that has at least one
     * Python script — the disabled toggle (Settings → Skills) deliberately
     * does NOT filter this list. Reason: hiding skills from the LLM produces
     * silent refusals ("the function isn't available in this session") when
     * a user-disabled skill matches the user's intent. The disabled flag
     * remains available via isSkillEnabled() for UI cosmetics (dimming rows,
     * collapsing in the sidebar, etc.) but never amputates the LLM's tool
     * awareness.
     */
    getEnabledLocalSkills() {
        return (this.skills || []).filter(s =>
            s?.source === 'local'
            && typeof s?.dir_name === 'string'
            && Array.isArray(s?.scripts)
            && s.scripts.length > 0
        );
    }

    /**
     * Fetch a single skill by ID (full data including skill_content)
     */
    async getSkill(id) {
        try {
            const res = await fetch(`${this.apiBase}/skills/${id}`, {
                headers: this.getAuthHeaders()
            });
            if (res.ok) {
                const data = await res.json();
                return data.data || data;
            }
        } catch (err) {
            console.error('Get skill error:', err);
        }
        return null;
    }

    // ===================== Utility =====================

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }
}

// Auto-initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const getHeaders = () => {
        const headers = { 'Content-Type': 'application/json' };
        if (window.authManager && window.authManager.token) {
            headers['Authorization'] = `Bearer ${window.authManager.token}`;
        }
        return headers;
    };

    const t = (key, params) => {
        if (window.i18n && typeof window.i18n.t === 'function') {
            return window.i18n.t(key, params);
        }
        return key.split('.').pop();
    };

    window.skillsManager = new SkillsManager(window.APP_CONFIG?.API_BASE_URL || '/gpt/backend/api/v1', getHeaders, t);
    window.skillsManager.init();
    // Docker app only (the offer checks the store mode itself); runs after login with the other startup tasks.
    // Getters: the splash reads them after login, once the translations are loaded.
    window.startupTasks?.register('skills-migrate', () => window.skillsManager.offerMigration(), {
        get label() { return t('skills.startup.label'); },
        icon: '🎯',
        get desc() { return t('skills.startup.desc'); }
    });
});
