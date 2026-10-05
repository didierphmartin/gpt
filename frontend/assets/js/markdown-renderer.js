/**
 * Shared Markdown renderer — the single source of truth for rendering
 * markdown to HTML across the app. Any component that displays markdown
 * should call window.renderMarkdown(text).
 *
 * Configures `marked` once at load time, pre-processes the source
 * (```markdown fence unwrap, GFM table fixup), then post-processes the
 * generated HTML (links open in new tab, SVG extraction + sanitization,
 * responsive table wrapping).
 */
(function () {
    if (typeof marked === 'undefined') {
        console.warn('[markdown-renderer] marked is not loaded; renderMarkdown will fall back to plain text.');
    } else {
        marked.setOptions({
            gfm: true,
            breaks: true,
            tables: true,
            headerIds: false,
            pedantic: false,
            sanitize: false
        });
    }

    function sanitizeSVG(svgString) {
        let sanitized = svgString
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
            .replace(/javascript:/gi, '');

        sanitized = sanitized.replace(/<svg([^>]*)>/i, (match, attrs) => {
            let newAttrs = attrs.replace(/\s*height\s*=\s*["'][^"']*["']/gi, '');
            newAttrs = newAttrs.replace(/\s*width\s*=\s*["'][^"']*["']/gi, '');
            newAttrs += ' width="100%" height="auto" class="needs-viewbox-fix" style="max-width:100%;height:auto;"';
            return `<svg${newAttrs}>`;
        });

        return sanitized;
    }

    /** JSON text indented (2 spaces) when it parses as an object or array, else null. */
    function indentJson(text) {
        try {
            const v = JSON.parse(text);
            return v !== null && typeof v === 'object' ? JSON.stringify(v, null, 2) : null;
        } catch (_) {
            return null;
        }
    }

    /**
     * Pretty-print JSON in markdown source: a text that IS a JSON object or array becomes an
     * indented ```json block, and every ```json block is re-indented. Anything that is not valid
     * JSON is left exactly as written.
     */
    function prettyJsonMarkdown(text) {
        if (!text) return text;
        const whole = indentJson(text.trim());
        if (whole !== null) return '```json\n' + whole + '\n```';
        return text.replace(/```json[ \t]*\n([\s\S]*?)\n?```/gi, (m, body) => {
            const pretty = indentJson(body.trim());
            return pretty === null ? m : '```json\n' + pretty + '\n```';
        });
    }

    function renderMarkdown(text) {
        if (!text) return '';
        text = prettyJsonMarkdown(text);
        if (typeof marked === 'undefined') {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // Unwrap ```markdown / ```md fences (treat inner content as renderable)
        text = text.replace(/```(?:markdown|md)\s*\n([\s\S]*?)```/gi, (m, content) => content.trim());

        // Fix GFM table formatting — marked requires no blank lines between rows
        const lines = text.split('\n');
        const newLines = [];
        let inTable = false;
        let tableRows = [];
        for (const line of lines) {
            const trimmed = line.trim();
            const isTableLine = trimmed.startsWith('|') && trimmed.endsWith('|');
            const isEmpty = trimmed === '';
            if (isTableLine) {
                if (!inTable) {
                    if (newLines.length > 0 && newLines[newLines.length - 1].trim() !== '') {
                        newLines.push('');
                    }
                    inTable = true;
                }
                tableRows.push(line);
            } else if (inTable && isEmpty) {
                continue;
            } else {
                if (inTable) {
                    newLines.push(...tableRows);
                    newLines.push('');
                    tableRows = [];
                    inTable = false;
                }
                newLines.push(line);
            }
        }
        if (tableRows.length > 0) newLines.push(...tableRows);
        const processedText = newLines.join('\n');

        let html;
        try {
            html = marked.parse(processedText);
        } catch (error) {
            console.error('[markdown-renderer] parse failed:', error);
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;

        tempDiv.querySelectorAll('a').forEach(link => {
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noopener noreferrer');
        });

        tempDiv.querySelectorAll('pre code').forEach(codeBlock => {
            const codeText = codeBlock.textContent.trim();
            const svgRegex = /<svg[\s\S]*?<\/svg>/i;
            if (svgRegex.test(codeText)) {
                const svgMatch = codeText.match(svgRegex);
                if (svgMatch) {
                    const sanitizedSVG = sanitizeSVG(svgMatch[0]);
                    const svgContainer = document.createElement('div');
                    svgContainer.className = 'svg-render-container';
                    const svgDisplay = document.createElement('div');
                    svgDisplay.className = 'svg-display';
                    svgDisplay.innerHTML = sanitizedSVG;
                    svgContainer.appendChild(svgDisplay);
                    codeBlock.parentElement.replaceWith(svgContainer);
                }
            }
        });

        tempDiv.querySelectorAll('svg').forEach(svgElement => {
            if (!svgElement.closest('.svg-render-container')) {
                const svgContainer = document.createElement('div');
                svgContainer.className = 'svg-render-container';
                const svgDisplay = document.createElement('div');
                svgDisplay.className = 'svg-display';
                svgDisplay.appendChild(svgElement.cloneNode(true));
                svgContainer.appendChild(svgDisplay);
                svgElement.replaceWith(svgContainer);
            }
        });

        tempDiv.querySelectorAll('table').forEach(table => {
            if (!table.closest('.table-container')) {
                const tableContainer = document.createElement('div');
                tableContainer.className = 'table-container';
                const tableClone = table.cloneNode(true);
                tableContainer.appendChild(tableClone);
                table.replaceWith(tableContainer);
            }
        });

        return tempDiv.innerHTML;
    }

    window.renderMarkdown = renderMarkdown;
    window.prettyJsonMarkdown = prettyJsonMarkdown;
    window.sanitizeSVG = sanitizeSVG;
})();
