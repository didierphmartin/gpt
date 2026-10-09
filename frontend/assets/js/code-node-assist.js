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

    return { CALL_RE, isDocumented, splitDocumented, askBlocker, SYSTEM_PROMPT, buildUserMessage, parseAnswer, checkAnswer };
});
