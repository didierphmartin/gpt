/**
 * Mermaid post-render hook.
 *
 * Used after the markdown renderer has produced HTML and the caller has
 * mounted it into the DOM. We do NOT render mid-stream — the calling code
 * (chat.js::updateMessage, documentation-panel.js, chat.js::loadContext)
 * only invokes this on the final, non-streaming pass.
 *
 * Public API:
 *   window.renderMermaidIn(rootEl)  →  Promise<void>
 *     Finds every <pre><code class="language-mermaid"> block under rootEl,
 *     replaces it with a <div class="mermaid"> holding the source, and asks
 *     mermaid.run() to render the SVG IN PLACE. Letting mermaid own its
 *     own DOM target (vs grabbing an SVG string from mermaid.render() and
 *     stuffing it into a div we made) gives correct sizing and avoids the
 *     scratch-node leakage we had with the lower-level API.
 *
 * Errors fall back to the original code in a <pre> with a small notice so
 * one bad diagram never breaks the whole message.
 */
(function () {
    'use strict';

    if (typeof window.mermaid === 'undefined') {
        console.warn('[mermaid-renderer] mermaid.js not loaded; renderMermaidIn will be a no-op.');
        window.renderMermaidIn = async () => {};
        return;
    }

    // One-time init. startOnLoad:false because we control timing.
    //
    // securityLevel:
    //   'antiscript' allows <br>, <b>, <i> in node labels (LLMs generate
    //   these constantly) but strips <script> for XSS safety.
    // flowchart.htmlLabels:true tells the flowchart parser to interpret
    // HTML tags as HTML rather than literal text.
    window.mermaid.initialize({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'antiscript',
        fontFamily: 'inherit',
        flowchart: { htmlLabels: true },
    });

    let _seq = 0;
    function nextId() { return `mermaid-${Date.now().toString(36)}-${++_seq}`; }

    function escapeHtml(s) {
        return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    }

    /**
     * Self-heal a mangled source: if the model glued a closing ``` into the
     * body of the block, truncate at the first stray triple-backtick.
     * Returns null when no recovery applies.
     */
    function recoverSource(source) {
        const tickIdx = source.indexOf('```');
        if (tickIdx <= 0) return null;
        const candidate = source.slice(0, tickIdx).trim();
        return candidate.length > 0 ? candidate : null;
    }

    /**
     * Mermaid v11 bug: short edge labels (`A -->|x| B`) sometimes trigger
     *   "Could not find a suitable point for the given distance"
     * inside calcLabelPosition. Strip the |label| segments and the graph
     * topology renders, just without the per-edge labels.
     */
    function stripEdgeLabels(source) {
        const cleaned = source.replace(/(-->|---|==>|-\.->|\.->|<-->|<--)\|[^|]*\|/g, '$1');
        return cleaned !== source ? cleaned : null;
    }

    function isEdgeLabelError(err) {
        const msg = (err && err.message) || '';
        // Known mermaid v11 internal bugs that the edge-label-strip
        // recovery has fixed in practice:
        //   - calcLabelPosition: "Could not find a suitable point for the given distance"
        //   - d3 selection getter on a null edge node: "Cannot read properties of null (reading 'getAttribute')"
        // Both are typically triggered by edge labels — stripping them lets
        // the topology render, just without per-edge labels.
        return msg.includes('Could not find a suitable point')
            || msg.includes("Cannot read properties of null (reading 'getAttribute')");
    }

    /**
     * Try to render one source string into the given target div via
     * mermaid.run(). mermaid marks the div with data-processed='true' on
     * success; we clear that flag (and reset the textContent) before each
     * retry attempt so the same node can be re-rendered with corrected
     * source.
     */
    async function attemptRun(target, source) {
        target.removeAttribute('data-processed');
        target.textContent = source;
        await window.mermaid.run({ nodes: [target], suppressErrors: false });
    }

    /**
     * Render the diagram at `pre`, with two layers of self-healing
     * recovery, then a source-fallback if all else fails.
     */
    async function renderOne(pre, source) {
        // Create the target div mermaid will render into, in place of the
        // <pre>. The .mermaid class is what mermaid.run() looks for;
        // .mermaid-render-container is our own visual wrapper styling.
        const target = document.createElement('div');
        target.className = 'mermaid mermaid-render-container';
        target.id = nextId();
        pre.replaceWith(target);

        try {
            await attemptRun(target, source);
            return;
        } catch (err) {
            // Recovery 1: source has a stray ``` that closed the block early.
            const recovered = recoverSource(source);
            if (recovered) {
                try {
                    await attemptRun(target, recovered);
                    console.info('[mermaid-renderer] rendered after recovering source from a malformed block.');
                    return;
                } catch (err2) {
                    console.warn('[mermaid-renderer] recovery render also failed:', err2);
                }
            }

            // Recovery 2: mermaid v11 calcLabelPosition bug on edge labels.
            if (isEdgeLabelError(err)) {
                const stripped = stripEdgeLabels(source);
                if (stripped) {
                    try {
                        await attemptRun(target, stripped);
                        console.info('[mermaid-renderer] rendered after stripping edge labels (mermaid v11 calcLabelPosition bug).');
                        return;
                    } catch (err3) {
                        console.warn('[mermaid-renderer] edge-label-strip recovery also failed:', err3);
                    }
                }
            }

            console.warn('[mermaid-renderer] render failed:', err);

            // Final fallback: replace the target with the original source
            // in a <pre> block plus a short error notice.
            const fallback = document.createElement('div');
            fallback.innerHTML =
                '<div class="mermaid-error-notice">Diagram could not be rendered (syntax error). Showing source below.</div>'
                + '<pre><code class="language-mermaid">' + escapeHtml(source) + '</code></pre>';
            target.replaceWith(fallback);
        }
    }

    /**
     * Process every mermaid block under `root`. Sequential to keep error
     * isolation simple (a failure on one diagram never affects the next).
     */
    async function renderMermaidIn(root) {
        if (!root) return;
        const blocks = root.querySelectorAll('pre > code.language-mermaid');
        if (!blocks.length) return;

        const items = [];
        for (const code of blocks) {
            const pre = code.parentElement;
            if (!pre || pre.dataset.mermaidProcessed) continue;
            pre.dataset.mermaidProcessed = '1';
            const source = (code.textContent || '').trim();
            if (!source) continue;
            items.push({ pre, source });
        }

        for (const { pre, source } of items) {
            await renderOne(pre, source);
        }
    }

    window.renderMermaidIn = renderMermaidIn;
})();
