/**
 * Code node assistant -- an LLM writes a code node's code and exits from the ticked MCP servers' own
 * tool documentation, or answers "cannot". Pure logic first (no DOM), then mountAssistBox, the box
 * itself, with every editor service injected. General for every MCP server: all a tool is, here, is
 * its tools/list entry.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./code-node.js'));
    else root.CodeNodeAssist = factory(root.CodeNode);
})(typeof self !== 'undefined' ? self : this, function (CN) {
    /** call_tool("<server>", "<tool>" -- literal names only; group 2 the server, group 4 the tool. */
    const CALL_RE = /call_tool\(\s*(["'])([^"']+)\1\s*,\s*(["'])([^"']+)\3/g;

    const isDocumented = (tool) => typeof tool?.description === 'string' && tool.description.trim() !== '';

    /** Server listings -> the documented tools per server, and "slug.tool" for each undocumented one. */
    function splitDocumented(listed) {
        const usable = [], skipped = [];
        for (const s of listed || []) {
            if (s.error) continue;
            for (const t of s.tools || []) if (!isDocumented(t)) skipped.push(`${s.slug}.${t?.name}`);
            usable.push({ name: s.name, slug: s.slug, tools: (s.tools || []).filter(isDocumented) });
        }
        return { usable, skipped };
    }

    /** Why an Ask must not reach the LLM, or null. Servers ticked but no documented tool: refuse. */
    function askBlocker(tickedCount, usable) {
        if (!tickedCount) return null;
        return (usable || []).some((s) => s.tools.length) ? null : 'noTools';
    }

    const SYSTEM_PROMPT = [
        'You write the Python code of one workflow "code node". Answer with ONE JSON object and nothing else:',
        '  {"code": "<the full Python source>", "exits": ["<exit>", ...], "explanation": "<one or two sentences>"}',
        'or',
        '  {"cannot": "<why the documentation is not enough: name the tool and what is missing>"}',
        '',
        'The code node contract:',
        '- Define def run(input, call_tool). Import only the Python standard library; no network, process or file access:',
        '  everything external goes through call_tool.',
        '- input is what the parent node produced: its text, or the decoded value when it is JSON; with several parents,',
        '  a dict {parent name: value}. With no parent, input is the workflow\'s prompt (text). The Start node\'s text is',
        '  passed as text, never JSON-decoded.',
        '- call_tool(server, tool, args) calls a tool of a server listed by the user. server is the quoted slug shown after',
        '  `server` in the tool list (e.g. server "abc"), not the display name in parentheses.',
        '  It returns the tool\'s result: its structured content, else its text decoded from JSON when possible, else the text.',
        '  It RAISES an exception when the tool reports an error, the server answers a protocol error, or it cannot be reached.',
        '- Return {"route": "<exit>", "output": <value>} to choose the exit the run continues on, or just the output when',
        '  there is one exit. An exception run() does not catch goes to the exit named "error" when the node has one.',
        '- Exit names: lowercase letters, digits and _, starting with a letter; 1 to 8 exits.',
        '',
        'Rules:',
        '1. Use only the tools listed, exactly as documented: their names, their arguments (inputSchema), and only the',
        '   result fields their description or outputSchema names. Never guess a field, an argument or a result shape.',
        '2. Every tool call has up to three outcomes:',
        '   - something: the call returned a result -> a data exit, with the result (or its documented part) as output;',
        '   - error: call_tool raised -> the "error" exit. Include "error" in the exits; letting the exception propagate is enough;',
        '   - nothing: the call succeeded but found nothing -> a quiet exit (e.g. "no_items") with a short text as output.',
        '     A "nothing" exit is required when the tool\'s documentation describes an empty / no-result outcome, or when the',
        '     request is about fetching or polling items. If the documentation does not say how "nothing" looks for such a',
        '     fetch or poll, answer cannot. A tool whose documentation describes no empty outcome (one that sends, creates or',
        '     updates, say) has no "nothing" branch: never invent one.',
        '3. Answer {"cannot": ...} when the request needs result contents (fields) the documentation does not give, or is a',
        '   fetch or poll whose empty case is undocumented. Do not write code that guesses. There is no fallback, not even',
        '   when asked to pass the whole result on.',
        '4. Keep the current code\'s names and style unless the request changes them; keep existing exit names that fit.',
        '5. Each exit leads to the nodes named for it; let that decide what each exit\'s output should be.',
    ].join('\n');

    function buildUserMessage({ usable, exits, wiring, sample, code, request }) {
        const parts = [];
        const servers = (usable || []).filter((s) => s.tools.length);
        if (!servers.length) parts.push('## MCP servers\nNo server is checked: write plain Python, no call_tool.');
        else {
            parts.push('## MCP servers and their documented tools');
            for (const s of servers) {
                parts.push(`### server "${s.slug}" (${s.name})`);
                for (const t of s.tools) {
                    const doc = { name: t.name, description: t.description, inputSchema: t.inputSchema || {} };
                    if (t.outputSchema) doc.outputSchema = t.outputSchema;
                    parts.push(JSON.stringify(doc, null, 2));
                }
            }
        }
        parts.push('## Current exits and where they lead\n' + (exits || []).map((e) => {
            const to = (wiring || {})[e] || [];
            return `${e} -> ${to.length ? to.join(', ') : '(not connected)'}`;
        }).join('\n'));
        if (sample && String(sample).trim()) parts.push('## Sample input\n' + sample);
        parts.push('## Current code\n```python\n' + (code || '') + '\n```');
        parts.push('## Request\n' + request);
        return parts.join('\n\n');
    }

    /** The LLM's reply -> one of the two answer shapes, tolerating a ``` fence or prose around the object. */
    function parseAnswer(text) {
        const s = String(text || '').trim();
        const shape = (j) => {
            if (j && typeof j.cannot === 'string' && j.cannot.trim()) return { kind: 'cannot', reason: j.cannot.trim() };
            if (j && typeof j.code === 'string' && Array.isArray(j.exits) && j.exits.every((e) => typeof e === 'string')) {
                return { kind: 'code', code: j.code, exits: j.exits, explanation: typeof j.explanation === 'string' ? j.explanation : '' };
            }
            return null;
        };
        const tryParse = (body) => { try { return shape(JSON.parse(body)); } catch (_) { return null; } };
        let bad = false;
        for (const m of s.matchAll(/```[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g)) {
            const r = tryParse(m[1]);
            if (r) return r;
            bad = true;
        }
        const r = tryParse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
        if (r) return r;
        if (!bad) { try { JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); bad = true; } catch (_) { /* not JSON */ } }
        if (!bad) return { kind: 'invalid', error: 'The answer is not a JSON object.' };
        return { kind: 'invalid', error: 'Expected {"code", "exits", "explanation"} or {"cannot"}.' };
    }

    /** What is wrong with a code answer, beyond Python itself (checked by the harness): exits, run, tools used. */
    function checkAnswer(answer, usable) {
        const errs = CN.validateConfig({ code: answer.code, exits: answer.exits, mcp_servers: [], timeout_s: 1 });
        const offered = new Map((usable || []).map((s) => [s.slug, new Set(s.tools.map((t) => t.name))]));
        for (const m of String(answer.code || '').matchAll(CALL_RE)) {
            const server = m[2], tool = m[4];
            if (!offered.has(server)) {
                errs.push(`call_tool("${server}", ...): no checked server is called "${server}"; use one of: ${[...offered.keys()].join(', ') || 'none'}.`);
            } else if (!offered.get(server).has(tool)) {
                errs.push(`call_tool("${server}", "${tool}"): "${tool}" is not one of the documented tools of ${server}.`);
            }
        }
        if (/call_tool\(/.test(String(answer.code || '')) && !(answer.exits || []).includes('error')) {
            errs.push('Code that calls tools needs an "error" exit.');
        }
        return errs;
    }

    /** The node's exits after Accept: the proposal's, plus every current exit that is wired and not proposed. */
    function mergeExits(proposed, current, wired) {
        const cur = current || [];
        const kept = cur.filter((e) => wired.has(e) && !proposed.includes(e));
        const exits = [...proposed, ...kept];
        const added = proposed.filter((e) => !cur.includes(e));
        const errors = CN.validateConfig({ code: 'def run(', exits, mcp_servers: [], timeout_s: 1 });
        return { exits, added, kept, errors };
    }

    /** Line diff (longest common subsequence): ' ' same, '-' only in the old text, '+' only in the new. */
    function lineDiff(oldText, newText) {
        const x = String(oldText ?? '').split('\n'), y = String(newText ?? '').split('\n');
        const n = x.length, k = y.length;
        const L = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(0));
        for (let i = n - 1; i >= 0; i--) for (let j = k - 1; j >= 0; j--) {
            L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
        }
        const out = [];
        let i = 0, j = 0;
        while (i < n && j < k) {
            if (x[i] === y[j]) { out.push({ op: ' ', line: x[i] }); i++; j++; }
            else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', line: x[i++] });
            else out.push({ op: '+', line: y[j++] });
        }
        while (i < n) out.push({ op: '-', line: x[i++] });
        while (j < k) out.push({ op: '+', line: y[j++] });
        return out;
    }

    /** Literal tool calls in the code whose server marks the tool as changing things (MCP annotations). */
    function changingCalls(code, listed) {
        const byKey = new Map();
        for (const s of listed || []) for (const t of s.tools || []) byKey.set(`${s.slug}.${t.name}`, { server: s.name, tool: t.name, a: t.annotations || {} });
        const seen = new Set(), out = [];
        for (const m of String(code || '').matchAll(CALL_RE)) {
            const key = `${m[2]}.${m[4]}`, hit = byKey.get(key);
            if (!hit || seen.has(key)) continue;
            if (hit.a.readOnlyHint === false || hit.a.destructiveHint === true) { seen.add(key); out.push({ server: hit.server, tool: hit.tool }); }
        }
        return out;
    }

    /** The assistant box under the Code tab. All editor services come in through deps (see the plan). */
    function mountAssistBox(el, deps) {
        const t = deps.t;
        const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
        el.innerHTML = `
            <label>${esc(t('workflow.codeAssist.title'))}</label>
            <textarea data-a="request" rows="3" style="width:100%;" placeholder="${esc(t('workflow.codeAssist.placeholder'))}"></textarea>
            <div style="display:flex;gap:8px;align-items:center;margin-top:6px;">
                <label style="margin:0;">${esc(t('workflow.codeAssist.model'))}</label>
                <select data-a="model" style="flex:1;"></select>
                <button type="button" class="storage-config-btn" data-a="ask">${esc(t('workflow.codeAssist.ask'))}</button>
            </div>
            <div data-a="status" class="text-xs text-gray-500" style="margin-top:6px;"></div>
            <div data-a="proposal" style="margin-top:8px;"></div>`;
        const q = (k) => el.querySelector(`[data-a="${k}"]`);
        const STORE = 'codeAssist.model';
        let options = [], listed = null, controller = null;

        const status = (html) => { q('status').innerHTML = html; };
        const remembered = () => { try { return localStorage.getItem(STORE) || ''; } catch (_) { return ''; } };

        (async () => {
            options = await deps.models();
            q('model').innerHTML = options.map((o, i) => `<option value="${i}">${esc(o.label)}</option>`).join('');
            const i = options.findIndex((o) => `${o.provider}|${o.model}` === remembered());
            if (i >= 0) q('model').value = String(i);
            q('model').addEventListener('change', () => {
                const o = options[Number(q('model').value)];
                try { localStorage.setItem(STORE, `${o.provider}|${o.model}`); } catch (_) {}
            });
        })();

        /** The ticked servers' listings, the "not usable" line and any listing failures. */
        async function refresh() {
            listed = await deps.listServers();
            const { skipped } = splitDocumented(listed);
            const lines = listed.filter((s) => s.error).map((s) => esc(t('workflow.codeAssist.listFailed', { server: s.name, message: s.error })));
            if (skipped.length) lines.push(esc(t('workflow.codeAssist.undocumented', { list: skipped.join(', ') })));
            status(lines.join('<br>'));
            return listed;
        }

        function showProposal(ans) {
            const { exits, added, kept, errors } = mergeExits(ans.exits, deps.getExits(), deps.wiredExits());
            const wiring = deps.wiring();
            const chip = (e) => {
                const note = added.includes(e) ? ` (${esc(t('workflow.codeAssist.exitNew'))})`
                    : kept.includes(e) ? ` — ${esc(t('workflow.codeAssist.exitKept', { nodes: (wiring[e] || []).join(', ') }))}` : '';
                return `<div><code>${esc(e)}</code>${note}</div>`;
            };
            const diff = lineDiff(deps.getCode(), ans.code).map((d) => {
                const bg = d.op === '+' ? 'background:rgba(34,197,94,0.15);' : d.op === '-' ? 'background:rgba(239,68,68,0.15);' : '';
                return `<div style="${bg}white-space:pre;">${esc(d.op + ' ' + d.line)}</div>`;
            }).join('');
            q('proposal').innerHTML = `
                <p style="margin:0 0 6px;">${esc(ans.explanation)}</p>
                <label>${esc(t('workflow.codeAssist.exits'))}</label>${exits.map(chip).join('')}
                ${errors.length ? `<div style="color:#b91c1c;">${esc(errors.join(' '))}</div>` : ''}
                <div style="font-family:ui-monospace,Menlo,monospace;font-size:12px;max-height:260px;overflow:auto;border:1px solid #e5e7eb;margin-top:6px;">${diff}</div>
                <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px;">
                    <button type="button" class="storage-config-btn cancel" data-a="discard">${esc(t('workflow.codeAssist.discard'))}</button>
                    <button type="button" class="storage-config-btn save" data-a="accept" ${errors.length ? 'disabled' : ''}>${esc(t('workflow.codeAssist.accept'))}</button>
                </div>`;
            q('discard').addEventListener('click', () => { q('proposal').innerHTML = ''; });
            q('accept').addEventListener('click', () => { deps.apply({ code: ans.code, exits }); q('proposal').innerHTML = ''; });
        }

        async function ask() {
            if (controller) { controller.abort(); return; }          // the button reads "Stop" while asking
            const request = q('request').value.trim();
            if (!request) { status(esc(t('workflow.codeAssist.emptyRequest'))); return; }
            q('proposal').innerHTML = '';
            const { usable } = splitDocumented(await refresh());
            if (askBlocker(deps.tickedCount(), usable)) { status(esc(t('workflow.codeAssist.noTools'))); return; }
            const opt = options[Number(q('model').value)] || options[0] || { provider: '', model: '' };
            const message = buildUserMessage({ usable, exits: deps.getExits(), wiring: deps.wiring(),
                sample: deps.getSample(), code: deps.getCode(), request });
            controller = new AbortController();
            q('ask').textContent = t('workflow.codeAssist.stop');
            const before = q('status').innerHTML;
            status(before + (before ? '<br>' : '') + esc(t('workflow.codeAssist.thinking')));
            try {
                let msg = message, ans = null, errs = [];
                for (let attempt = 0; attempt < 2; attempt++) {
                    ans = parseAnswer(await deps.ask({ provider: opt.provider, model: opt.model, system: SYSTEM_PROMPT, message: msg, signal: controller.signal }));
                    if (ans.kind === 'cannot') break;
                    errs = ans.kind === 'invalid' ? [ans.error] : checkAnswer(ans, usable);
                    if (!errs.length) { const py = await deps.checkPython(ans.code); if (py) errs = [py]; }
                    if (!errs.length) break;
                    msg = `${message}\n\n## Your previous answer was rejected\n${errs.join('\n')}\nAnswer again, fixing this.`;
                }
                status(before);
                if (ans.kind === 'cannot') status(esc(t('workflow.codeAssist.cannot', { reason: ans.reason })));
                else if (errs.length) status(esc(t('workflow.codeAssist.unusable', { reason: errs.join(' ') })));
                else showProposal(ans);
            } catch (e) {
                status(e?.name === 'AbortError' ? before : esc(t('workflow.codeAssist.failed', { message: e?.message || e })));
            } finally {
                controller = null;
                q('ask').textContent = t('workflow.codeAssist.ask');
            }
        }

        q('ask').addEventListener('click', ask);
        return { refresh };
    }

    return { mergeExits, lineDiff, changingCalls, CALL_RE, isDocumented, splitDocumented, askBlocker, SYSTEM_PROMPT, buildUserMessage, parseAnswer, checkAnswer, mountAssistBox };
});
