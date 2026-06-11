/**
 * Documentation panel.
 *
 * Two-pane modal triggered by #documentation-btn. Left: a list of services.
 * Right: the rendered markdown for the selected service.
 *
 * Each service has its own .md file under assets/docs/{lang}/{slug}.md so we
 * can grow them independently (add screenshots, walkthroughs, etc.) without
 * touching the others.
 *
 * Sidebar labels are pulled from i18n (docs.<key>); page content is loaded
 * lazily and cached per (lang, slug).
 */
(function () {
    'use strict';

    const DOCS_BASE = 'assets/docs';
    const SUPPORTED = ['en', 'fr', 'es'];

    // The order of this list drives the sidebar order. Slug = filename (no
    // extension). i18nKey is the entry in docs.* for the sidebar label.
    const PAGES = [
        { slug: 'overview',       i18nKey: 'docs.overview' },
        { slug: 'conversations',  i18nKey: 'docs.conversations' },
        { slug: 'verify',         i18nKey: 'docs.verify' },
        { slug: 'compare',        i18nKey: 'docs.compare' },
        { slug: 'prompt-library', i18nKey: 'docs.promptLibrary' },
        { slug: 'skills',         i18nKey: 'docs.skills' },
        { slug: 'workflows',      i18nKey: 'docs.workflows' },
        { slug: 'file-storage',   i18nKey: 'docs.fileStorage' },
        { slug: 'info-bar',       i18nKey: 'docs.infoBar' },
        { slug: 'top-bar',        i18nKey: 'docs.topBar' },
        { slug: 'settings',       i18nKey: 'docs.settings' },
        { slug: 'tips',           i18nKey: 'docs.tips' },
    ];
    const DEFAULT_SLUG = 'overview';

    let overlayEl = null;
    let sidebarEl = null;
    let contentEl = null;
    let titleEl   = null;
    let currentSlug = DEFAULT_SLUG;
    // Cache rendered HTML per `${lang}::${slug}` so repeat clicks are instant.
    const cache = new Map();

    function currentLang() {
        const lang = window.i18n?.currentLanguage;
        return SUPPORTED.includes(lang) ? lang : 'en';
    }

    function tt(key, fallback) {
        try {
            const v = window.i18n?.t?.(key);
            if (v && v !== key) return v;
        } catch (_) { /* ignore */ }
        return fallback;
    }

    /**
     * Slugify a heading: lowercase, strip diacritics, non-alphanumerics → '-'.
     * Used for in-page TOC anchors generated from <h2>/<h3> text.
     */
    function slugify(text) {
        return String(text)
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    function ensureShell() {
        if (overlayEl) return;

        overlayEl = document.createElement('div');
        overlayEl.id = 'documentation-overlay';
        overlayEl.className = 'fixed inset-0 z-[1000] hidden bg-black/50 backdrop-blur-sm flex items-center justify-center p-4';
        overlayEl.innerHTML = `
            <div class="bg-white rounded-2xl shadow-2xl w-full flex flex-col"
                 style="max-width: 64rem; max-height: 90vh;">
                <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200">
                    <h2 id="documentation-title" class="text-lg font-semibold text-gray-900">Documentation</h2>
                    <button id="documentation-close"
                            class="text-gray-400 hover:text-gray-600 transition"
                            aria-label="Close">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                        </svg>
                    </button>
                </div>
                <div class="flex-1 flex min-h-0">
                    <nav id="documentation-sidebar"
                         class="w-56 flex-shrink-0 border-r border-gray-200 bg-gray-50 overflow-y-auto py-3"></nav>
                    <div id="documentation-content"
                         class="flex-1 overflow-y-auto px-6 py-5 documentation-prose"></div>
                </div>
            </div>
        `;
        document.body.appendChild(overlayEl);

        sidebarEl = overlayEl.querySelector('#documentation-sidebar');
        contentEl = overlayEl.querySelector('#documentation-content');
        titleEl   = overlayEl.querySelector('#documentation-title');

        overlayEl.querySelector('#documentation-close').addEventListener('click', hide);
        overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) hide(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !overlayEl.classList.contains('hidden')) hide();
        });

        sidebarEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-doc-slug]');
            if (!btn) return;
            const slug = btn.dataset.docSlug;
            if (slug) loadPage(slug);
        });
    }

    function renderSidebar() {
        sidebarEl.innerHTML = PAGES.map((p) => {
            const label = tt(p.i18nKey, p.slug);
            const active = p.slug === currentSlug;
            const cls = active
                ? 'bg-blue-100 text-blue-900 font-medium'
                : 'text-gray-700 hover:bg-gray-100';
            return `
                <button type="button"
                        data-doc-slug="${p.slug}"
                        class="w-full text-left px-4 py-2 text-sm transition ${cls}">
                    ${label}
                </button>
            `;
        }).join('');
    }

    async function fetchPage(lang, slug) {
        const key = `${lang}::${slug}`;
        if (cache.has(key)) return cache.get(key);

        const res = await fetch(`${DOCS_BASE}/${lang}/${slug}.md`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status} (${lang}/${slug}.md)`);
        const md = await res.text();

        if (typeof window.marked?.parse !== 'function') {
            throw new Error('marked.js not loaded');
        }
        const html = window.marked.parse(md);
        cache.set(key, html);
        return html;
    }

    function addHeadingIds(root) {
        root.querySelectorAll('h1, h2, h3, h4').forEach((h) => {
            if (!h.id) h.id = slugify(h.textContent);
        });
    }

    function wireInPageAnchors(root) {
        root.addEventListener('click', (e) => {
            const link = e.target.closest('a[href^="#"]');
            if (!link) return;
            const id = link.getAttribute('href').slice(1);
            const target = root.querySelector(`#${CSS.escape(id)}`);
            if (target) {
                e.preventDefault();
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    }

    async function loadPage(slug) {
        currentSlug = slug;
        renderSidebar();
        contentEl.innerHTML = '<p class="text-gray-500 text-sm">…</p>';
        try {
            const html = await fetchPage(currentLang(), slug);
            contentEl.innerHTML = html;
            addHeadingIds(contentEl);
            // Render any ```mermaid blocks in the doc (e.g. architecture diagrams).
            if (typeof window.renderMermaidIn === 'function') {
                window.renderMermaidIn(contentEl);
            }
            contentEl.scrollTop = 0;
        } catch (err) {
            console.error('[documentation] load failed:', err);
            contentEl.innerHTML = `<p class="text-red-600 text-sm">Failed to load: ${err.message}</p>`;
        }
    }

    async function show() {
        ensureShell();
        titleEl.textContent = tt('header.documentation', 'Documentation');

        // Re-render sidebar each open in case the language has changed.
        renderSidebar();
        await loadPage(currentSlug);

        // Wire anchors only once per shell.
        if (!contentEl.dataset.anchorsWired) {
            wireInPageAnchors(contentEl);
            contentEl.dataset.anchorsWired = '1';
        }

        overlayEl.classList.remove('hidden');
    }

    function hide() {
        if (overlayEl) overlayEl.classList.add('hidden');
    }

    // Live language switch: if the panel is open and the user changes
    // language, redraw sidebar labels and reload the current page in the new
    // language. (i18n.js dispatches 'languageChanged' on switch.)
    window.addEventListener('languageChanged', () => {
        if (overlayEl && !overlayEl.classList.contains('hidden')) {
            titleEl.textContent = tt('header.documentation', 'Documentation');
            renderSidebar();
            loadPage(currentSlug);
        }
    });

    window.openDocumentation  = show;
    window.closeDocumentation = hide;

    function bindButton() {
        const btn = document.getElementById('documentation-btn');
        if (btn) btn.addEventListener('click', show);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindButton, { once: true });
    } else {
        bindButton();
    }
})();
