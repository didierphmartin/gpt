/**
 * MCP Tool Tester
 *
 * Port of MCPeek's tool cards (htdocs/mcPeek/index.html: getToolInputs,
 * displayTools, callToolWithInputs, renderMCPContent) for the AI Assistant.
 *
 * Read-only with respect to the tool: the user fills argument inputs and
 * presses "Call Tool"; nothing is persisted. Calls go through
 * window.mcpClient.callTool() (backend proxy: CORS-free, headers applied
 * server-side). MCP App tools render through window.mcpAppHost.
 */
class MCPToolTester {
    /**
     * @param {{container: HTMLElement, server: object, t?: (k:string)=>string}} opts
     */
    constructor({ container, server, t }) {
        this.container = container;
        this.server = server;
        this.t = typeof t === 'function' ? t : (k) => k;
        this.tools = [];
    }

    // ─── pure helpers (unit-tested) ────────────────────────────────────────
    static escape(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    /**
     * MCPeek getToolInputs(): one text input per top-level property.
     * Ids are `${prefix}-${index}` so odd tool/property names never break
     * querySelector. Property order == Object.entries order.
     */
    static buildInputsHtml(tool, prefix) {
        const props = tool?.inputSchema?.properties;
        if (!props || typeof props !== 'object') return '';
        const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];
        const esc = MCPToolTester.escape;
        let html = '';
        Object.entries(props).forEach(([propName, propDef], index) => {
            const isReq = required.includes(propName);
            const def = propDef && typeof propDef === 'object' ? propDef : {};
            const placeholder = def.description || def.type || propName;
            html += `
                <div class="mcp-tool-input">
                    <label for="${prefix}-${index}">${esc(propName)}${isReq ? '<span class="mcp-tool-required">*</span>' : ''}${def.type ? `<span class="mcp-tool-type">${esc(def.type)}</span>` : ''}</label>
                    <input type="text" id="${prefix}-${index}" data-prop="${esc(propName)}"
                           placeholder="${esc(placeholder)}" ${isReq ? 'required' : ''}>
                </div>`;
        });
        return html;
    }

    /**
     * MCPeek callToolWithInputs() coercion. `values` maps propName -> raw
     * string. Empty strings are skipped entirely.
     */
    static coerceArgs(tool, values) {
        const args = {};
        const props = tool?.inputSchema?.properties;
        if (!props || typeof props !== 'object') return args;
        for (const propName of Object.keys(props)) {
            const raw = values?.[propName];
            if (raw === undefined || raw === null) continue;
            const value = String(raw).trim();
            if (!value) continue;
            const type = props[propName]?.type;
            if (type === 'number' || type === 'integer') {
                args[propName] = Number(value);
            } else if (type === 'boolean') {
                args[propName] = value.toLowerCase() === 'true' || value === '1';
            } else if (type === 'array') {
                try { args[propName] = JSON.parse(value); }
                catch { args[propName] = value.split(',').map(s => s.trim()); }
            } else if (type === 'object') {
                try { args[propName] = JSON.parse(value); }
                catch { args[propName] = value; }
            } else {
                args[propName] = value;
            }
        }
        return args;
    }

    // ─── rendering ─────────────────────────────────────────────────────────
    render(tools) {
        this.tools = Array.isArray(tools) ? tools : [];
        if (!this.container) return;
        if (this.tools.length === 0) {
            this.container.innerHTML = `<div class="mcp-tool-empty">${MCPToolTester.escape(this.t('mcpLibrary.noTools'))}</div>`;
            return;
        }
        const esc = MCPToolTester.escape;
        this.container.innerHTML = this.tools.map((tool, idx) => {
            const prefix = `mcp-arg-${this.server.id}-${idx}`;
            const uiBadge = tool.hasUi ? `<span class="mcp-badge mcp-badge-type mcp-badge-app">MCP App</span>` : '';
            return `
                <div class="mcp-tool-card" data-tool-index="${idx}">
                    <div class="mcp-tool-name">${esc(tool.name)}${uiBadge}</div>
                    <div class="mcp-tool-desc">${esc(tool.description || this.t('mcpLibrary.noDescription'))}</div>
                    ${tool.hasUi && tool.uiResourceUri ? `<div class="mcp-tool-ui-uri">🖼️ <code>${esc(tool.uiResourceUri)}</code></div>` : ''}
                    <div class="mcp-tool-inputs">${MCPToolTester.buildInputsHtml(tool, prefix)}</div>
                    <button type="button" class="mcp-btn mcp-btn-primary mcp-tool-call" data-tool-index="${idx}">
                        ▶ ${esc(this.t('mcpLibrary.callTool'))}
                    </button>
                    <div class="mcp-tool-result" id="mcp-result-${this.server.id}-${idx}"></div>
                </div>`;
        }).join('');

        this.container.querySelectorAll('.mcp-tool-call').forEach(btn => {
            btn.addEventListener('click', () => this.callTool(parseInt(btn.dataset.toolIndex, 10)));
        });
    }

    collectValues(idx) {
        const values = {};
        const card = this.container.querySelector(`.mcp-tool-card[data-tool-index="${idx}"]`);
        card?.querySelectorAll('input[data-prop]').forEach(input => { values[input.dataset.prop] = input.value; });
        return values;
    }

    async callTool(idx) {
        const tool = this.tools[idx];
        const resultEl = this.container.querySelector(`#mcp-result-${this.server.id}-${idx}`);
        const btn = this.container.querySelector(`.mcp-tool-call[data-tool-index="${idx}"]`);
        if (!tool || !resultEl) return;

        const args = MCPToolTester.coerceArgs(tool, this.collectValues(idx));
        const requestPayload = {
            jsonrpc: '2.0', method: 'tools/call',
            params: { name: tool.name, arguments: args }
        };

        resultEl.innerHTML = `<div class="mcp-tool-loading">⏳ ${MCPToolTester.escape(this.t('mcpLibrary.calling'))}</div>`;
        if (btn) btn.disabled = true;
        try {
            // Make sure mcpClient knows this tool (server may be disabled or
            // loadAllTools may not have run yet).
            if (!window.mcpClient.getTool(tool.name)) {
                window.mcpClient.registerTools(this.server, [tool]);
            }
            const res = await window.mcpClient.callTool(tool.name, args);
            if (!res.success) {
                resultEl.innerHTML = this.renderError(res.error || 'Tool execution failed', requestPayload, res);
                return;
            }
            resultEl.innerHTML = this.renderResult(res.result, requestPayload);
            if (tool.hasUi && window.mcpAppHost) {
                const appContainer = resultEl.querySelector('.mcp-tool-app');
                if (appContainer) {
                    try {
                        await window.mcpAppHost.createAppFrame(tool.name, appContainer);
                    } catch (err) {
                        appContainer.innerHTML = `<div class="mcp-tool-error">${MCPToolTester.escape(err.message)}</div>`;
                    }
                }
            }
        } catch (err) {
            resultEl.innerHTML = this.renderError(err.message, requestPayload, null);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    renderError(message, requestPayload, raw) {
        const esc = MCPToolTester.escape;
        return `
            <div class="mcp-tool-error">❌ ${esc(message)}</div>
            ${this.renderRaw(requestPayload, raw)}`;
    }

    renderResult(result, requestPayload) {
        const esc = MCPToolTester.escape;
        const contents = Array.isArray(result?.content) ? result.content : null;
        let body;
        if (contents) {
            body = contents.map((c, i) => this.renderContent(c, i)).join('') ||
                   `<div class="mcp-tool-content">${esc(this.t('mcpLibrary.emptyResult'))}</div>`;
        } else {
            body = `<pre class="mcp-tool-pre">${esc(JSON.stringify(result, null, 2))}</pre>`;
        }
        return `
            <div class="mcp-tool-success">
                <details open>
                    <summary>✅ ${esc(this.t('mcpLibrary.resultTitle'))}${contents ? ` (${contents.length})` : ''}${result?.isError ? ' ⚠️ isError' : ''}</summary>
                    ${body}
                    <div class="mcp-tool-app"></div>
                </details>
                ${this.renderRaw(requestPayload, result)}
            </div>`;
    }

    renderContent(content, index) {
        const esc = MCPToolTester.escape;
        const type = content?.type || 'unknown';
        const n = index > 0 ? ` #${index + 1}` : '';
        if (type === 'text' || (content?.mimeType || '').startsWith('text/')) {
            return `<div class="mcp-tool-content mcp-tool-content-text"><div class="mcp-tool-content-title">📝 Text${n}</div><pre class="mcp-tool-pre">${esc(content.text || '')}</pre></div>`;
        }
        if (type === 'image' || (content?.mimeType || '').startsWith('image/')) {
            const mime = content.mimeType || 'image/png';
            const src = content.data ? `data:${mime};base64,${content.data}` : (content.uri || content.url || '');
            return `<div class="mcp-tool-content mcp-tool-content-image"><div class="mcp-tool-content-title">🖼️ Image${n} (${esc(mime)})</div><img src="${esc(src)}" alt="MCP image content"></div>`;
        }
        if (type === 'resource') {
            const r = content.resource || {};
            const uri = r.uri || content.uri || 'unknown';
            return `<div class="mcp-tool-content mcp-tool-content-resource"><div class="mcp-tool-content-title">📁 Resource${n}</div><code>${esc(uri)}</code>${r.text ? `<pre class="mcp-tool-pre">${esc(r.text)}</pre>` : ''}</div>`;
        }
        return `<div class="mcp-tool-content"><div class="mcp-tool-content-title">📦 ${esc(type)}${n}</div><pre class="mcp-tool-pre">${esc(JSON.stringify(content, null, 2))}</pre></div>`;
    }

    renderRaw(requestPayload, response) {
        const esc = MCPToolTester.escape;
        return `
            <details class="mcp-tool-raw">
                <summary>🔧 ${esc(this.t('mcpLibrary.technicalDetails'))}</summary>
                <div class="mcp-tool-raw-panel"><div class="mcp-tool-raw-title">📤 Request</div><pre class="mcp-tool-pre">${esc(JSON.stringify(requestPayload, null, 2))}</pre></div>
                <div class="mcp-tool-raw-panel"><div class="mcp-tool-raw-title">📥 Response</div><pre class="mcp-tool-pre">${esc(JSON.stringify(response, null, 2))}</pre></div>
            </details>`;
    }
}

if (typeof window !== 'undefined') window.MCPToolTester = MCPToolTester;
else globalThis.MCPToolTester = MCPToolTester;
