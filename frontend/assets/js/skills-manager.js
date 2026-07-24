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
        this.collapsedFolders = new Set();  // folder names currently collapsed
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
        this.importBtn = document.getElementById('skills-import-btn');
        this.contextMenu = document.getElementById('skills-context-menu');

        if (this.newSkillBtn) {
            this.newSkillBtn.addEventListener('click', () => this.showSkillEditor());
        }
        if (this.newFolderBtn) {
            this.newFolderBtn.addEventListener('click', () => this.promptNewFolder());
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
            this.renderTree();
        } catch (err) {
            console.error('Failed to load skills tree:', err);
        }
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
            const list = await window.skillsFs.listSkills();
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
                    dir_name: s.dirName,               // path relative to skills/ (may include a group prefix)
                    scripts,                           // skill-relative paths to executable scripts (e.g. ['scripts/transform.py'])
                    references,                         // skill-relative paths to Markdown reference docs (e.g. ['references/second.md'])
                    max_tool_rounds: maxToolRounds,    // orchestrators may raise the client-tool round cap (see chat.js dispatchClientToolCall)
                    spec_compliant: s.spec_compliant !== false,
                    spec_issues: s.spec_issues || [],
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
    buildTreeHtml(filteredSkills, query) {
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
            if (query && inFolder.length === 0) continue;
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
            containerEl.innerHTML = this.buildTreeHtml(filtered, query)
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
        return `
            <div class="skills-item flex items-center gap-1 px-2 py-1.5 text-xs text-gray-700 cursor-pointer hover:bg-blue-50 rounded select-none"
                 draggable="true"
                 data-skill-id="${skill.id}" title="${this.escapeHtml(skill.description || '')}">
                <span>${icon}</span>
                <span class="flex-1 truncate">${this.escapeHtml(skill.name)}</span>
                ${tags}
                ${specBadge}
                ${badge}
                <button type="button"
                        class="skills-item-menu px-1 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded transition flex-shrink-0"
                        data-skill-id="${skill.id}"
                        title="Options">⋮</button>
            </div>
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
                const skill = this.findSkillByDatasetId(el.dataset.skillId);
                if (skill) this.showSkillEditor(skill);
            });

            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.contextTarget = { type: 'skill', id: el.dataset.skillId };
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
                };
                e.dataTransfer.setData('application/x-skill', JSON.stringify(payload));
                // copy → dropping onto the chat input; move → onto a folder.
                e.dataTransfer.effectAllowed = 'copyMove';
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
                if (!e.dataTransfer.types.includes('application/x-skill')) return;
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
        if (!payload || payload.source !== 'local' || !payload.dir_name) return;

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
                <p class="text-xs text-gray-500 mb-4">
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
                <div id="skills-import-status" class="hidden mt-4 text-xs"></div>
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
        `;
        document.body.appendChild(modal);

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
            showStatus(`Imported "${result.name}" (${result.fileCount} file${result.fileCount === 1 ? '' : 's'}).`, 'ok');
            // Refresh the tree so the new skill appears.
            this.loadTree();
            // Auto-close after a short read time.
            setTimeout(close, 1200);
        };

        modal.querySelector('#skills-import-folder-btn').addEventListener('click', async () => {
            showStatus('Opening folder picker…', 'info');
            const result = await window.skillsImport.importFromFolder();
            handleResult(result);
        });
        modal.querySelector('#skills-import-zip-btn').addEventListener('click', async () => {
            showStatus('Choose a .zip / .skill file…', 'info');
            const result = await window.skillsImport.importFromZipPicker();
            handleResult(result);
        });

        // GitHub URL flow: reveal a small inline form to capture the URL,
        // then run importFromGitHub. Two-step instead of a prompt() so
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
            const result = await window.skillsImport.importFromGitHub(url);
            handleResult(result);
        };
        modal.querySelector('#skills-import-github-install').addEventListener('click', installFromGithub);
        githubUrlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); installFromGithub(); }
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
            if (skill) this.showSkillEditor(skill);

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
            alert('Could not rename the skill folder: ' + (res.error || 'unknown error'));
            return;
        }
        await this.loadTree();
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

    // ===================== Skill Editor Modal =====================

    /**
     * Show a modal to create or edit a skill.
     * @param {Object|null} skill - existing skill to edit, or null for new
     */
    async showSkillEditor(skill = null) {
        // Remove any existing editor modal
        document.getElementById('skill-editor-modal')?.remove();

        const isEdit = !!skill;
        const t = this.t.bind ? this.t : (k) => this.t(k);

        // Python scripts shipped under the skill's scripts/ folder (see
        // listSkillScripts). When present, the right pane gains a "Script" tab
        // alongside the SKILL.md preview so the source is viewable in-app.
        const pyScripts = (skill?.scripts || []).filter(p => /\.py$/i.test(p));
        const hasScripts = pyScripts.length > 0;

        // Markdown docs under the skill's references/ folder. Each gets its own
        // right-pane tab labelled with the folder over the filename.
        const refDocs = (skill?.references || []).filter(p => /\.md$/i.test(p));

        const modal = document.createElement('div');
        modal.id = 'skill-editor-modal';
        modal.className = 'fixed inset-0 z-[200] flex items-center justify-center';
        modal.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
        modal.innerHTML = `
            <div class="bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-6xl mx-4 h-[90vh] overflow-hidden flex flex-col">
                <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                    <h3 class="text-sm font-bold text-gray-800">${isEdit ? 'Edit Skill' : t('skills.newSkill')}</h3>
                    <button id="skill-editor-close" class="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition">&#10005;</button>
                </div>
                <div class="flex-1 flex overflow-hidden min-h-0">
                    <!-- Left: technical metadata + system prompt editor -->
                    <div class="w-1/2 flex flex-col gap-3 p-4 border-r border-gray-200 min-h-0 overflow-y-auto">
                        <div class="grid grid-cols-2 gap-3 flex-shrink-0">
                            <div>
                                <label class="block text-xs font-medium text-gray-700 mb-1">License</label>
                                <input type="text" id="skill-ed-license" class="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg"
                                       value="${this.escapeHtml(skill?.license || '')}" placeholder="MIT">
                            </div>
                            <div>
                                <label class="block text-xs font-medium text-gray-700 mb-1">Origin</label>
                                <input type="text" id="skill-ed-origin" class="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg"
                                       value="${this.escapeHtml(skill?.origin || skill?.metadata?.origin || '')}" placeholder="synergyAI custom">
                            </div>
                        </div>
                        <div class="flex-shrink-0">
                            <label class="block text-xs font-medium text-gray-700 mb-1">Dependencies</label>
                            <input type="text" id="skill-ed-deps" class="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg"
                                   value="${this.escapeHtml(Array.isArray(skill?.dependencies) ? skill.dependencies.join(', ') : (skill?.dependencies || ''))}" placeholder="beautifulsoup4, python-docx">
                        </div>
                        <div class="flex-shrink-0">
                            <label class="block text-xs font-medium text-gray-700 mb-1">Allowed tools</label>
                            <input type="text" id="skill-ed-allowed-tools" class="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg"
                                   value="${this.escapeHtml((skill?.default_tools || skill?.allowed_tools || []).join(', '))}" placeholder="run_skill_script">
                        </div>
                        <div class="flex-1 flex flex-col min-h-0">
                            <label class="block text-xs font-medium text-gray-700 mb-1 flex-shrink-0">${t('skills.systemPrompt')}</label>
                            <textarea id="skill-ed-prompt" class="flex-1 w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg font-mono resize-none min-h-[200px]">${this.escapeHtml(skill?.skill_content || '')}</textarea>
                        </div>
                    </div>
                    <!-- Right: identity fields + live rendered preview -->
                    <div class="w-1/2 flex flex-col min-h-0">
                        <div class="flex flex-col gap-3 p-4 bg-white flex-shrink-0">
                            <div class="grid grid-cols-2 gap-3">
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">${t('skills.name')}</label>
                                    <input type="text" id="skill-ed-name" class="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                           value="${this.escapeHtml(skill?.name || '')}">
                                </div>
                                <div>
                                    <label class="block text-xs font-medium text-gray-700 mb-1">Version</label>
                                    <input type="text" id="skill-ed-version" class="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg"
                                           value="${this.escapeHtml(skill?.version || skill?.metadata?.version || '1.0.0')}" placeholder="1.0.0">
                                </div>
                            </div>
                            <div>
                                <label class="block text-xs font-medium text-gray-700 mb-1">${t('skills.description')}</label>
                                <input type="text" id="skill-ed-desc" class="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg cursor-pointer"
                                       value="${this.escapeHtml(skill?.description || '')}"
                                       title="Click to expand" readonly>
                            </div>
                        </div>
                        <div class="px-4 py-1.5 border-y border-gray-200 bg-gray-100 flex-shrink-0 flex items-center gap-1 overflow-x-auto" id="skill-ed-tabs">
                            <button type="button" data-pane="preview" class="skill-ed-tab px-3 py-1 text-xs font-medium rounded-md transition bg-white text-indigo-700 shadow-sm">SKILL.md</button>
                        </div>
                        <div id="skill-ed-preview" class="flex-1 overflow-y-auto p-4 markdown-content prose prose-sm max-w-none bg-gray-50"></div>
                    </div>
                </div>
                <div class="flex justify-end gap-2 px-4 py-3 border-t border-gray-200">
                    <button id="skill-editor-cancel" class="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-lg hover:bg-gray-50 transition">Cancel</button>
                    <button id="skill-editor-save" class="px-3 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition">${t('skills.saveSkill')}</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Editing folder-backed skills means writing back to the user's
        // disk — not in this slice yet. Lock the form to read-only and
        // make Save unavailable. The preview pane stays fully functional.
        if (skill?.source === 'local') {
            modal.querySelectorAll('input, textarea').forEach(el => { el.readOnly = true; });
            const titleEl = modal.querySelector('h3');
            if (titleEl) titleEl.textContent = `View Skill — ${skill.dir_name || skill.name}`;
            const saveBtn = modal.querySelector('#skill-editor-save');
            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.textContent = 'Saved on disk';
                saveBtn.title = 'This skill is read directly from your local data folder. Editing on disk is supported in your file explorer; in-app editing is coming in a later step.';
                saveBtn.className = saveBtn.className.replace('bg-blue-600 hover:bg-blue-700', 'bg-gray-300 cursor-not-allowed');
            }
        }

        // Event listeners
        modal.querySelector('#skill-editor-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#skill-editor-cancel').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });

        // Description expand-on-click: the inline input shows only one line,
        // so clicking it pops an overlay with a roomy textarea. Backdrop click
        // or Escape closes and syncs the edited value back to the input.
        const descEl = modal.querySelector('#skill-ed-desc');
        const descReadOnly = skill?.source === 'local';
        const openDescOverlay = () => {
            const overlay = document.createElement('div');
            overlay.className = 'fixed inset-0 z-[210] flex items-center justify-center';
            overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.4)';
            overlay.innerHTML = `
                <div class="bg-white rounded-xl shadow-xl border border-gray-200 w-[min(640px,90vw)] max-h-[80vh] flex flex-col" data-desc-panel>
                    <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                        <h4 class="text-sm font-semibold text-gray-800">${t('skills.description')}</h4>
                        <button type="button" data-desc-close class="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition" aria-label="Close">&#10005;</button>
                    </div>
                    <div class="p-4 flex-1 overflow-y-auto">
                        <textarea class="w-full h-64 px-3 py-2 text-sm border border-gray-300 rounded-lg resize-none focus:ring-2 focus:ring-blue-500"
                                  ${descReadOnly ? 'readonly' : ''}></textarea>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            const ta = overlay.querySelector('textarea');
            ta.value = descEl.value;
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);

            const closeOverlay = () => {
                if (!descReadOnly) descEl.value = ta.value;
                overlay.remove();
                document.removeEventListener('keydown', onKey);
            };
            const onKey = (e) => { if (e.key === 'Escape') closeOverlay(); };
            overlay.addEventListener('click', (e) => {
                if (!overlay.querySelector('[data-desc-panel]').contains(e.target)) closeOverlay();
            });
            overlay.querySelector('[data-desc-close]').addEventListener('click', closeOverlay);
            document.addEventListener('keydown', onKey);
        };
        descEl.addEventListener('click', openDescOverlay);
        descEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openDescOverlay();
            }
        });

        // Live Markdown preview of skill content — renders YAML frontmatter
        // (between leading --- delimiters) as a GitHub-style name/value table
        const promptEl = modal.querySelector('#skill-ed-prompt');
        const previewEl = modal.querySelector('#skill-ed-preview');
        const renderPreview = () => {
            const src = promptEl.value || '';
            try {
                const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
                let html = '';
                let body = src;
                if (fm) {
                    body = fm[2];
                    const pairs = [];
                    let curKey = null;
                    let curVal = '';
                    for (const line of fm[1].split(/\r?\n/)) {
                        const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
                        if (m) {
                            if (curKey !== null) pairs.push([curKey, curVal.trim()]);
                            curKey = m[1];
                            curVal = m[2];
                        } else if (curKey !== null) {
                            curVal += ' ' + line.trim();
                        }
                    }
                    if (curKey !== null) pairs.push([curKey, curVal.trim()]);
                    if (pairs.length) {
                        html += '<table class="border border-gray-300 rounded mb-4 text-sm w-full">'
                             + '<tbody>'
                             + pairs.map(([k, v]) =>
                                 `<tr class="border-b border-gray-200 last:border-b-0">`
                                 + `<td class="bg-gray-50 px-3 py-1.5 font-semibold text-gray-700 align-top whitespace-nowrap">${this.escapeHtml(k)}</td>`
                                 + `<td class="px-3 py-1.5 text-gray-800 break-words">${this.escapeHtml(v)}</td>`
                                 + `</tr>`
                               ).join('')
                             + '</tbody></table>';
                    }
                }
                html += window.renderMarkdown(body);
                previewEl.innerHTML = html;
            } catch (e) {
                previewEl.textContent = src;
            }
        };
        promptEl.addEventListener('input', renderPreview);
        renderPreview();

        // Right-pane tabs: SKILL.md preview (always), an optional Script tab
        // when the skill ships Python under scripts/, and one tab per Markdown
        // doc under references/. Every non-preview pane reads its file(s) from
        // disk lazily on first activation so opening the editor stays instant.
        if (hasScripts || refDocs.length) {
            const tabsEl = modal.querySelector('#skill-ed-tabs');
            const panes = [{ id: 'preview', el: previewEl, load: null }];

            // Append a tab button. `folder` (when set) is shown as a small
            // label over the file/label line — e.g. "references" / "second.md".
            const addTab = (id, folder, label) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.dataset.pane = id;
                btn.className = 'skill-ed-tab px-3 py-1 text-xs font-medium rounded-md transition text-gray-600 hover:bg-gray-200 flex flex-col items-center leading-tight whitespace-nowrap';
                btn.innerHTML = folder
                    ? `<span class="text-[10px] uppercase tracking-wide opacity-70">${this.escapeHtml(folder)}</span><span>${this.escapeHtml(label)}</span>`
                    : `<span>${this.escapeHtml(label)}</span>`;
                tabsEl.appendChild(btn);
            };

            // Append a content pane as a sibling of the preview pane so the
            // flex-1 sizing matches. Returns the empty div for lazy fill.
            const addPane = (extraClasses) => {
                const div = document.createElement('div');
                div.className = `hidden flex-1 overflow-y-auto bg-gray-50 ${extraClasses}`.trim();
                previewEl.parentElement.appendChild(div);
                return div;
            };

            if (hasScripts) {
                const pane = addPane('');
                addTab('script', null, 'Script');
                panes.push({ id: 'script', el: pane, load: async () => {
                    const blocks = await Promise.all(pyScripts.map(async (rel) => {
                        let code = '';
                        try {
                            code = await window.skillsFs.getSkillFile(skill.dir_name, rel);
                        } catch (e) {
                            code = `# could not read ${rel}: ${e?.message || e}`;
                        }
                        return `<div class="px-4 py-2 text-xs font-mono text-gray-500 bg-gray-100 border-b border-gray-200">${this.escapeHtml(rel)}</div>`
                             + `<pre class="px-4 py-3 text-xs font-mono text-gray-800 whitespace-pre overflow-x-auto"><code>${this.escapeHtml(code || '')}</code></pre>`;
                    }));
                    pane.innerHTML = blocks.join('');
                }});
            }

            refDocs.forEach((rel, i) => {
                const id = `ref-${i}`;
                const file = rel.split('/').pop();
                const pane = addPane('p-4 markdown-content prose prose-sm max-w-none');
                addTab(id, 'references', file);
                panes.push({ id, el: pane, load: async () => {
                    let md = '';
                    try {
                        md = await window.skillsFs.getSkillFile(skill.dir_name, rel);
                    } catch (e) {
                        md = `_Could not read ${rel}: ${e?.message || e}_`;
                    }
                    pane.innerHTML = window.renderMarkdown(md || '');
                }});
            });

            const loaded = new Set();
            const switchPane = (id) => {
                panes.forEach(p => p.el.classList.toggle('hidden', p.id !== id));
                tabsEl.querySelectorAll('.skill-ed-tab').forEach(b => {
                    const on = b.dataset.pane === id;
                    b.classList.toggle('bg-white', on);
                    b.classList.toggle('text-indigo-700', on);
                    b.classList.toggle('shadow-sm', on);
                    b.classList.toggle('text-gray-600', !on);
                    b.classList.toggle('hover:bg-gray-200', !on);
                });
                const target = panes.find(p => p.id === id);
                if (target?.load && !loaded.has(id)) {
                    loaded.add(id);
                    target.load();
                }
            };
            tabsEl.querySelectorAll('.skill-ed-tab').forEach(b => {
                b.addEventListener('click', () => switchPane(b.dataset.pane));
            });
        }

        // Helper: parse a comma-separated input into a clean array.
        const parseCsv = (id) => {
            const raw = document.getElementById(id)?.value || '';
            return raw.split(',').map(s => s.trim()).filter(Boolean);
        };

        modal.querySelector('#skill-editor-save').addEventListener('click', async () => {
            const name = document.getElementById('skill-ed-name').value.trim();
            if (!name) {
                alert('Name is required');
                return;
            }

            // SKILL.md frontmatter fields. License / dependencies / origin
            // aren't backed by DB columns yet — they ride along on the payload
            // so the API can persist them once the schema catches up.
            // allowed-tools maps to default_tools (the existing DB column).
            const data = {
                name,
                description: document.getElementById('skill-ed-desc').value.trim(),
                skill_content: document.getElementById('skill-ed-prompt').value,
                version: document.getElementById('skill-ed-version').value.trim() || '1.0.0',
                license: document.getElementById('skill-ed-license').value.trim(),
                dependencies: parseCsv('skill-ed-deps'),
                origin: document.getElementById('skill-ed-origin').value.trim(),
                default_tools: parseCsv('skill-ed-allowed-tools'),
            };

            if (isEdit) {
                await this.updateSkill(skill.id, data);
            } else {
                await this.createSkill(data);
            }

            modal.remove();
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
});
