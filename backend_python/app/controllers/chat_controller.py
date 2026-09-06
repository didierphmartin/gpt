"""Port of Controllers/ChatController.php.

This module (Task 8 of Phase 2a) carries the constructor, helpers, config
appliers, quota check, and the LLM-facing tool builders (lines 36-686 and
2711-3102 of the PHP source). The public flow methods (`chat`, `agent`,
`verify`, `compareOnly`, `handleStreamingChat`, `handleVerification`,
`handleComparison`, `handleRegularChat`) are added by Task 9 — see the
section marker near the bottom of this file.
"""
from __future__ import annotations

import copy
import re

from app.services.package_resolver import PackageResolver
from app.services.llm_provider_resolver import LLMProviderResolver
from app.support.crypto import aes256cbc_decrypt
from app.support.logger import error_log
from app.support.phpcompat import is_numeric, php_crc32, php_empty, php_intval

import base64
import hashlib


class ChatController:
    def __init__(self, db, config: dict):
        self.db = db
        self.config = config
        # Memoized enabled provider_keys from system_llm_settings (per request).
        self.enabledProviderKeysCache: list[str] | None = None

    # ------------------------------------------------------------------
    # Enabled provider keys
    # ------------------------------------------------------------------

    def _getEnabledProviderKeys(self) -> list[str]:
        """The provider keys that are ENABLED in system_llm_settings — the single source
        of truth for which LLMs the app supports. Drives per-provider setup loops
        (attaching the function executor, etc.) so a provider added to the table
        (e.g. GLM) is picked up automatically instead of being silently skipped by
        a hardcoded list. Memoized per request; falls back to the historical
        hardcoded set if the query fails."""
        if self.enabledProviderKeysCache is not None:
            return self.enabledProviderKeysCache
        try:
            keys = self.db.fetch_column(
                "SELECT provider_key FROM system_llm_settings WHERE enabled = 1 ORDER BY sort_order ASC"
            )
            if not php_empty(keys):
                self.enabledProviderKeysCache = list(dict.fromkeys(keys))
                return self.enabledProviderKeysCache
        except Exception as e:  # noqa: BLE001
            error_log('[ChatController] getEnabledProviderKeys failed: ' + str(e))
        self.enabledProviderKeysCache = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi']
        return self.enabledProviderKeysCache

    # ------------------------------------------------------------------
    # Error humanization
    # ------------------------------------------------------------------

    @staticmethod
    def humanizeProviderError(raw: str) -> str:
        """Convert raw provider exception messages into something the user
        can actually act on. Provider exceptions tend to be long, include
        the raw HTTP request body (which contains the API key in some
        URLs), and use technical jargon. We pattern-match the common
        cases and replace with a short actionable line. The full original
        message still goes to error_log for debugging."""
        # Sanitize: strip API keys / access tokens that may appear in URLs.
        msg = re.sub(
            r'([?&])(?:key|api[_-]?key|access_token|x-api-key)=[^&\s"]+',
            r'\1[REDACTED]=…',
            raw,
            flags=re.I,
        )

        # Model server offline: the provider's gateway is reachable but has no
        # backend to serve the model (e.g. self-hosted model host down / not
        # loaded). Distinct from transient overload — retrying right away rarely
        # helps, so we tell the user it's likely down rather than busy. Must be
        # checked BEFORE the generic 5xx branch (this is usually a 503 too).
        if re.search(
            r'no (available|healthy) (server|upstream|model|worker|backend|instance)|'
            r'no (server|model|backend|worker) available|model (is )?not (loaded|available|ready)|'
            r'upstream connect error',
            msg, re.I,
        ):
            return ("🚫 This model's server is currently offline — the provider's gateway responded "
                    "but has no backend available to serve the model right now. This usually isn't "
                    "temporary: try again later, or switch to a different provider in the picker above.")
        # Provider overloaded (5xx).
        if re.search(r'\b(50[023]|52[39])\b|Service Unavailable|currently experiencing high demand|overloaded|temporarily unavailable', msg, re.I):
            return "⏳ The model provider is temporarily overloaded. Please try again in a moment, or switch to a different provider in the picker above."
        # Rate limit (429).
        if re.search(r'\b429\b|rate.?limit', msg, re.I):
            return "⏳ Rate limit reached for this provider. Please wait a moment before trying again, or switch providers."
        # Authentication.
        if re.search(r'\b401\b|invalid.?api.?key|authentication.?failed|unauthorized', msg, re.I):
            return "🔑 Authentication failed for this provider. Check the API key in your settings."
        # Context window / token limit.
        if re.search(r'context.{0,20}length|context.?window|token.{0,20}(exceed|limit)|prompt.?too.?long', msg, re.I):
            return "📏 The input is too large for this model's context window. Try shortening the conversation, removing attachments, or switching to a model with a larger context."
        # Quota / billing.
        if re.search(r'quota|billing|credit balance|insufficient.?credit|payment.?required', msg, re.I):
            return "💳 The provider rejected the request for billing reasons (quota or credits). Check your provider account, then retry."
        # Network / timeout / connection.
        if re.search(r'connection.?refused|connection.?reset|timed.?out|timeout|network.?unreachable|could not resolve', msg, re.I):
            return "🌐 Couldn't reach the provider. Check your network and try again, or switch providers."

        # Default fallback: cap length so the chat bubble doesn't render
        # a 5 KB stack trace.
        if len(msg) > 400:
            return msg[:380] + '… (full error in server log)'
        return msg

    # ------------------------------------------------------------------
    # History / skill / client-tool sanitizers
    # ------------------------------------------------------------------

    @staticmethod
    def stripVisualNoiseFromHistory(history: list) -> list:
        """Strip <svg>...</svg> blocks from each historical message's content
        before forwarding to providers. SVG path data is pure token noise
        to the LLM — the user-facing copies (UI render, dataset.rawContent,
        DB record) keep the original markup, only this in-flight view is
        trimmed. Done at the gateway so every provider, the verifier flow,
        and the compare-pane all see the same cleaned history."""
        out = []
        for msg in history:
            if isinstance(msg, dict) and isinstance(msg.get('content'), str):
                msg = dict(msg)
                msg['content'] = re.sub(r'<svg\b[^>]*>.*?</svg>', '[SVG illustration omitted]', msg['content'], flags=re.I | re.S)
                out.append(msg)
            else:
                out.append(msg)
        return out

    @staticmethod
    def sanitizeSkillMetadata(raw) -> dict | None:
        """Validate the skill_metadata payload from the request body. Returns
        a clean dict { dir_name, scripts } or None when the payload is
        missing, malformed, or empty (no executable scripts to expose). The
        frontend already filters the no-scripts case but we re-check
        server-side because the tool definition is meaningless without an
        enum of script paths."""
        if not isinstance(raw, dict):
            return None
        dir_name = raw.get('dir_name').strip() if isinstance(raw.get('dir_name'), str) else ''
        if dir_name == '':
            return None
        # Same shape rules as sanitizeAvailableSkills: identifier-ish
        # segments, optionally slash-joined for group-folder skills.
        if len(dir_name) > 128:
            return None
        if not re.fullmatch(r'[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*', dir_name):
            return None
        if '..' in dir_name:
            return None

        scripts = []
        raw_scripts = raw.get('scripts')
        if isinstance(raw_scripts, list):
            for s in raw_scripts:
                if not isinstance(s, str):
                    continue
                s = s.strip()
                # Reject path-traversal and absolute paths — scripts must
                # be skill-relative. The frontend listSkillScripts only
                # emits relative paths but a forged request could try.
                if s == '' or s.startswith('/') or '..' in s:
                    continue
                scripts.append(s)
        if php_empty(scripts):
            return None

        return {
            'dir_name': dir_name,
            'scripts': list(dict.fromkeys(scripts)),
        }

    @staticmethod
    def sanitizeAvailableSkills(raw) -> list:
        """Validate the available_skills payload from the request body. Returns
        a list of clean skill records [{dir_name, description, scripts}, ...]
        or [] when missing/malformed. Used by the multi-skill auto-routing
        path: the LLM is shown all available skills + their descriptions and
        picks one based on the user's prompt and attachments."""
        if not isinstance(raw, list):
            return []
        out = []
        seen: set[str] = set()
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            dir_name = entry.get('dir_name').strip() if isinstance(entry.get('dir_name'), str) else ''
            if dir_name == '' or dir_name in seen:
                continue
            # dir_name sanity: one or more identifier-ish segments separated
            # by single forward slashes. Allows group-folder skills like
            # 'GEO/geo-audit' or 'SEO/geo-technical' while still rejecting
            # path-traversal ('..'), absolute paths (leading /), and bad
            # chars. Length cap raised to 128 to accommodate group prefixes.
            if len(dir_name) > 128:
                continue
            if not re.fullmatch(r'[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*', dir_name):
                continue
            if '..' in dir_name:
                continue

            description = entry.get('description').strip() if isinstance(entry.get('description'), str) else ''

            scripts = []
            raw_scripts = entry.get('scripts')
            if isinstance(raw_scripts, list):
                for s in raw_scripts:
                    if not isinstance(s, str):
                        continue
                    s = s.strip()
                    if s == '' or s.startswith('/') or '..' in s:
                        continue
                    scripts.append(s)
            scripts = list(dict.fromkeys(scripts))
            if php_empty(scripts):
                continue

            seen.add(dir_name)
            out.append({
                'dir_name': dir_name,
                'description': description,
                'scripts': scripts,
            })
        return out

    @staticmethod
    def buildLlmContextSnapshot(provider: str, model: str | None, options: dict, serverTools: list, history: list, message: str) -> dict:
        """Snapshot of what a request sends to the LLM, for the workflow node
        modal's "Context" tab: provider/model, the final system prompt, the
        messages (history + current turn), the tool definitions actually
        offered (server executor + per-request client tools), the memory /
        skill inclusion flags and a rough token estimate (chars / 4).
        Provider-agnostic on purpose: it reflects the inputs handed to the
        provider, not one provider's wire format."""
        tools = []
        for t in serverTools:
            tools.append({'name': str(t.get('name') or ''), 'description': str(t.get('description') or ''), 'source': 'server'})
        for t in (options.get('client_tools') or []):
            tools.append({'name': str(t.get('name') or ''), 'description': str(t.get('description') or ''), 'source': 'client'})

        messages = []
        for h in history:
            if not isinstance(h, dict):
                continue
            c = h.get('content') if h.get('content') is not None else ''
            # PHP: json_encode($c, JSON_UNESCAPED_UNICODE) — slashes ARE escaped, unicode is not.
            content = c if isinstance(c, str) else _php_json_encode_uu(c)
            messages.append({'role': str(h.get('role') or ''), 'content': content})
        messages.append({'role': 'user', 'content': message})

        system_prompt = str(options.get('system_prompt') or '')
        chars = (
            len(system_prompt) + len(message)
            + sum(len(m['content']) for m in messages)
            # PHP: plain json_encode($serverTools) / json_encode($clientTools) — no flags,
            # so BOTH slashes and unicode are escaped here (unlike the message content above).
            + len(_php_json_encode_default(serverTools)) + len(_php_json_encode_default(options.get('client_tools') or []))
            + len(str(options.get('memory_context') or '')) + len(str(options.get('skill_content') or ''))
        )
        import math
        return {
            'provider': provider,
            'model': model,
            'max_tokens': options.get('max_tokens') if options.get('max_tokens') is not None else None,
            'temperature': options.get('temperature') if options.get('temperature') is not None else None,
            'system_prompt': system_prompt,
            'memory_included': not php_empty(options.get('memory_context')),
            'memory_context': str(options.get('memory_context') or ''),
            'skill_included': not php_empty(options.get('skill_content')),
            'skill_content': str(options.get('skill_content') or ''),
            'messages': messages,
            'tools': tools,
            'estimated_tokens': int(math.ceil(chars / 4)),
        }

    @staticmethod
    def sanitizeClientTools(raw) -> list:
        """Sanitize the per-request client_tools field. Frontend may attach tools
        discovered from the active tab's webMCP registry. Each accepted entry
        is a {name, description, input_schema} triple. Names must begin with
        'webmcp_' so the frontend dispatcher (chat.js) can route them.

        Filter, don't throw — one malformed tool should not kill the whole
        chat turn. error_log dropped entries for diagnostics."""
        if not isinstance(raw, list):
            return []
        out = []
        for i, entry in enumerate(raw):
            if not isinstance(entry, dict):
                error_log(f"[ChatController] client_tools[{i}] dropped: not an object")
                continue
            name = entry.get('name')
            if (not isinstance(name, str) or name == ''
                    # route_to: the workflow dispatcher's branch choice (browser run path);
                    # resolved client-side, so it rides the same per-request channel.
                    or not re.fullmatch(r'webmcp_[a-zA-Z0-9_\-.]{1,120}|route_to|save_playbook_agent', name)):
                error_log(f"[ChatController] client_tools[{i}] dropped: invalid name " + repr(name))
                continue
            description = entry.get('description') if entry.get('description') is not None else ''
            if not isinstance(description, str):
                description = ''
            if len(description) > 2048:
                description = description[:2048]
            input_schema = entry.get('input_schema')
            if not isinstance(input_schema, (dict, list)):
                error_log(f"[ChatController] client_tools[{i}] dropped: input_schema not an array")
                continue
            input_schema = ChatController.coerceJsonSchemaObjects(input_schema)
            out.append({
                'name': name,
                'description': description,
                'input_schema': input_schema,
            })
        return out

    @staticmethod
    def coerceJsonSchemaObjects(schema):
        """Walk a decoded JSON-Schema and coerce empty maps that MUST serialize
        as JSON objects (not arrays) back into stdClass. PHP's json_decode
        with assoc=true turns BOTH empty {} and empty [] into [], which then
        re-encodes as [] — invalid for fields like `properties`, `patternProperties`,
        `definitions`, `$defs`, and a few others. Anthropic's API in particular
        rejects `properties: []` with `Input should be an object`.

        Recursive so nested schemas (e.g. items.properties or
        properties.foo.properties) are also fixed."""
        object_fields = ('properties', 'patternProperties', 'definitions', '$defs')
        if isinstance(schema, dict):
            out = {}
            for key, value in schema.items():
                if key in object_fields and isinstance(value, (dict, list)):
                    if php_empty(value):
                        out[key] = {}
                    else:
                        # Recurse into each sub-schema under properties.foo, definitions.foo, etc.
                        if isinstance(value, dict):
                            new_value = {}
                            for sub_key, sub_schema in value.items():
                                new_value[sub_key] = ChatController.coerceJsonSchemaObjects(sub_schema) if isinstance(sub_schema, (dict, list)) else sub_schema
                            out[key] = new_value
                        else:
                            new_value = []
                            for sub_schema in value:
                                new_value.append(ChatController.coerceJsonSchemaObjects(sub_schema) if isinstance(sub_schema, (dict, list)) else sub_schema)
                            out[key] = new_value
                elif isinstance(value, (dict, list)):
                    out[key] = ChatController.coerceJsonSchemaObjects(value)
                else:
                    out[key] = value
            return out
        if isinstance(schema, list):
            return [ChatController.coerceJsonSchemaObjects(v) if isinstance(v, (dict, list)) else v for v in schema]
        return schema

    # ------------------------------------------------------------------
    # LLM-facing tool builders — descriptions/schemas copied VERBATIM from
    # ChatController.php (byte-identical, they reach the LLM directly).
    # ------------------------------------------------------------------

    @staticmethod
    def buildRunSkillScriptTool(metadata: dict) -> dict:
        """Build the JSON-Schema tool definition for run_skill_script. Shape
        matches MCPToolsLoader::getToolDefinitions() so providers consume it
        via the same code path. The `script` field is enum-constrained to
        the known script list — keeps the LLM from inventing paths and the
        frontend dispatcher from having to validate after the fact."""
        dir_name = metadata['dir_name']
        scripts = metadata['scripts']

        description = (
            f'Execute one of the Python scripts bundled with the active skill "{dir_name}". '
            "This tool IS available to you and you should call it whenever the user's "
            "request maps to one of the skill's scripts — do not attempt the transformation "
            "manually if a script can do it. Available scripts: "
            + ', '.join(scripts) +
            ".\n\n"
            "RUNTIME CONTRACT:\n"
            "• ATTACHMENTS — any document(s) the user attached are pre-written to "
            "/scratch/<original-filename>. Reference them by that absolute path in argv "
            "(e.g. after -i/--input). DO NOT pass attachment contents in input_files; that "
            "wastes output tokens.\n"
            "• INPUT FILES YOU AUTHOR INLINE — when a script needs synthesized input you "
            "compose yourself (a JSON spec, a complete HTML document, an ops file, etc.), "
            "put the content in input_files under a /scratch/<name>.<ext> key, then "
            "reference that path from argv. The exact format and extension required vary by "
            "skill — **read the skill's body (provided as system context) to learn the "
            "contract**. Do not assume create-style scripts always take JSON: some expect a "
            "full HTML/MD document, some a JSON spec, some a CSV. The skill's docs are "
            "authoritative.\n"
            "  ‼ VALUE SHAPE — each input_files value MUST be the file body as a plain string. "
            "Do NOT wrap it as {<path>: <content>} (that produces a JSON object as the file "
            "content, which the script will write back out verbatim and the artifact pane "
            "will display as broken JSON instead of HTML). For an HTML file write the literal "
            "characters of the document starting with <!DOCTYPE html>; for a JSON spec write "
            "the JSON object the script's contract specifies. The /scratch/ path is the OUTER "
            "input_files key only — never repeat it inside the value.\n"
            "• OUTPUT — files MUST be written to absolute paths under /outputs/ (passed via "
            "-o or equivalent in argv) AND listed in read_outputs so the runner returns them.\n"
            "• FILENAME — when transforming an attached document, keep the original basename "
            "and extension; the output lives in /outputs/, no '-formatted' suffix needed."
        )

        return {
            'name': 'run_skill_script',
            'description': description,
            'input_schema': {
                'type': 'object',
                'properties': {
                    'script': {
                        'type': 'string',
                        'description': 'Path to the script within the skill folder. Must be one of the listed scripts.',
                        'enum': scripts,
                    },
                    'argv': {
                        'type': 'array',
                        'description': 'Command-line arguments passed to the script (sys.argv[1:]). Output paths (e.g. -o, --output) MUST start with /outputs/ — that is where generated documents are persisted to the user filesystem.',
                        'items': {'type': 'string'},
                    },
                    'input_files': {
                        'type': 'object',
                        'description':
                            'Map of absolute path → file CONTENT to stage before the script '
                            'runs. Use this for files YOU author inline (JSON specs, HTML '
                            'documents, CSVs). The user\'s attachments are already at '
                            '/scratch/<filename>; do NOT re-pass their contents here.\\n\\n'
                            'EACH VALUE IS A PLAIN STRING — the literal file body. Start an '
                            'HTML value with `<!DOCTYPE html>` and emit the document character '
                            'by character. DO NOT wrap the body in a JSON object that repeats '
                            'the path — that pattern roughly DOUBLES the output tokens you '
                            'spend (every `"` becomes `\\"`, every newline becomes `\\n`, plus '
                            'the duplicated path key) AND the artifact pane will display the '
                            'wrap as broken JSON instead of your HTML. The lean form costs '
                            'you less time and produces the right output.\\n\\n'
                            'Example for a 2-byte HTML file:\\n'
                            '  CORRECT (efficient): {"/scratch/foo.html": "<!DOCTYPE html><html><body>Hi</body></html>"}\\n'
                            '  WRONG (wasteful):    {"/scratch/foo.html": "{\\"/scratch/foo.html\\": \\"<!DOCTYPE html><html><body>Hi</body></html>\\"}"}',
                        'additionalProperties': {'type': 'string'},
                    },
                    'read_outputs': {
                        'type': 'array',
                        'description': 'Paths whose contents should be returned to you after the script finishes. Use absolute /outputs/<filename> for files the script wrote to the outputs folder; skill-relative paths still work for files inside the skill mount. NOTE: when an output is an HTML or Markdown document, it is shown to the user in a separate artifact pane and the file content in the tool_result will be replaced with a short placeholder — do not quote, restate, or attempt to re-read the file in that case. Summarize what the script did from stdout/stderr instead.',
                        'items': {'type': 'string'},
                    },
                },
                'required': ['script'],
            },
        }

    @staticmethod
    def buildTaskTool() -> dict:
        """Build the JSON-Schema tool definition for the `Task` tool.

        Name and parameters intentionally mirror Claude Code's Task tool so
        upstream skill content (e.g. `Task({ subagent_type: "grader", ... })`)
        ports verbatim. Execution is client-side — see
        ClientSideToolsTrait::getClientSideToolNames() and
        chat.js::dispatchClientToolCall. The frontend reads
        skills/<active>/agents/<subagent_type>.md and POSTs to
        /api/v1/agent with that as the system prompt."""
        return {
            'name': 'Task',
            'description':
                "Spawn an isolated single-shot subagent. The subagent runs in a fresh "
                "context with no tools, no prior conversation history, and the agent file "
                "`agents/<subagent_type>.md` from the active skill as its system prompt. "
                "Returns the subagent's text response as the tool_result.\n\n"
                "Use this for grading, comparing, analyzing, or any other task that needs "
                "an independent LLM judgment without polluting the current conversation. "
                "The subagent has access only to what you pass in `prompt` — load any "
                "context the subagent needs into that string. The `subagent_type` must "
                "match the basename (without .md) of a file in the active skill's "
                "`agents/` folder.",
            'input_schema': {
                'type': 'object',
                'properties': {
                    'description': {
                        'type': 'string',
                        'description': 'A short (3-5 word) description of the task, for telemetry. Not seen by the subagent.',
                    },
                    'subagent_type': {
                        'type': 'string',
                        'description': "Basename (no .md) of an agent file in the active skill's agents/ folder. Example: \"grader\" loads agents/grader.md as the subagent's system prompt.",
                    },
                    'prompt': {
                        'type': 'string',
                        'description': 'The work the subagent should do. Include any context, data, or instructions the subagent needs — it has no other access.',
                    },
                    'model': {
                        'type': 'string',
                        'description': "Optional model override for the subagent. Defaults to the active provider's configured model. Only meaningful when paired with a `provider` that knows the model name.",
                    },
                    'provider': {
                        'type': 'string',
                        'enum': ['claude', 'openai', 'grok', 'gemini', 'deepseek', 'kimi'],
                        'description': 'Optional provider override for the subagent. Useful for cost-routing — e.g. spawn a deepseek subagent to do bulk grading at ~10× lower cost than claude. Defaults to the same provider as the primary chat.',
                    },
                },
                'required': ['description', 'subagent_type', 'prompt'],
            },
        }

    @staticmethod
    def buildMultiSkillTool(skills: list) -> dict:
        """Build the multi-skill version of run_skill_script for auto-routing.
        The model is shown all available skills' descriptions, picks one via
        the dir_name enum, then chooses a script from that skill's list. No
        tool_choice forcing — the model decides whether to call any skill at
        all based on intent (matching how MCP tools work).

        The script field is a free string here (not enum) because JSON Schema
        can't easily express "if dir_name is X, script must be in [...]".
        The frontend dispatcher validates the (dir_name, script) pair against
        the actual skill's scripts at run time — invalid combinations fail
        with a clear error rather than silently mis-routing."""
        dir_names = list(dict.fromkeys(s['dir_name'] for s in skills))

        catalog_lines = ["Available skills (pick the dir_name whose description best matches what the user is asking for):"]
        for s in skills:
            desc = s['description'] if s['description'] != '' else '(no description)'
            scripts_csv = ', '.join(s['scripts'])
            catalog_lines.append(f"  • {s['dir_name']} — {desc} | scripts: {scripts_csv}")
        catalog = "\n".join(catalog_lines)

        # The description is intentionally skill-agnostic — it works for any
        # set of skills the user has installed, present or future. Routing
        # signal is the catalog above (each skill's own description); the
        # contract rules below apply to ALL folder-backed skills uniformly.
        description = (
            "Execute a Python script bundled with one of the available folder-backed skills. "
            "Each skill in the catalog below produces a specific file deliverable.\n\n"
            "PROGRESSIVE-DISCLOSURE PROTOCOL — MUST follow:\n"
            "Before calling run_skill_script, you MUST first call `discover_skill` with the "
            "dir_name you intend to use. discover_skill returns the full SKILL.md body for "
            "that skill — including the input-file contract (JSON spec? complete HTML? CSV?), "
            "the example tool-call shape, and any skill-specific rules. The catalog below "
            "gives you only enough to pick a skill; the body tells you HOW to call it. "
            "Skipping discover_skill leads to malformed run_skill_script calls because the "
            "input shape varies by skill (some expect a JSON spec, some expect a complete "
            "HTML document inline, some expect a CSV) and you cannot reliably guess.\n\n"
            "WHEN TO CALL run_skill_script — non-negotiable rule:\n"
            "If the user is asking you to PRODUCE, GENERATE, CREATE, MAKE, BUILD, EDIT, or "
            "DELIVER a file in any of the formats listed in the catalog (HTML pages, Word docs, "
            "spreadsheets, presentations, etc.), you MUST call this tool. Do NOT inline file "
            "content in your text response — your text reply should be a short narration of "
            "what you produced. The tool writes the file to /outputs/ where the user previews "
            "it; an inline response gives the user nothing they can save or open.\n\n"
            "WHEN NOT TO CALL — narrow exceptions:\n"
            "Skip the tool only when the user is asking a question, having a discussion, "
            "summarizing/analyzing an attached document (the converter already gave you its "
            "text — read it directly and respond in chat), or making a request that genuinely "
            "doesn't map to any listed skill. NOTE: \"use the attachment as a template / style "
            "reference\" is NOT an exception — it's the core use case for create-style scripts. "
            "Author the new file inline as the script's input and call the tool; the skill "
            "produces the deliverable file.\n\n"
            "URL ARGUMENTS — YOU DO NOT NEED NETWORK ACCESS:\n"
            "If a script accepts a URL in argv (e.g. an audit/scraper skill), the runner's "
            "bridge pre-fetches that URL server-side via the user's own backend BEFORE the "
            "script runs. You — the LLM — never need to download anything. Pass the URL "
            "verbatim in argv as if it were a local file path; the bridge replaces it with the "
            "local path of the downloaded HTML and appends --source <original-url>. "
            "Consequences: localhost, 127.0.0.1, intranet URLs, and any URL the user can reach "
            "from their own machine all work — because the fetch runs on the user's machine, "
            "not yours. NEVER refuse a URL-based task with phrases like 'I cannot access "
            "localhost' or 'I don't have network access' — those refusals are wrong and "
            "forbidden. Call the tool with the URL in argv; if the bridge can't reach the URL "
            "(auth-walled etc.) you will get a clear [bridge] error in the tool_result, which "
            "is the only legitimate moment to surface a failure.\n\n"
            + catalog + "\n\n"
            "RUNTIME CONTRACT (applies to every skill):\n"
            "• ATTACHMENTS — any document(s) the user attached are pre-written to "
            "/scratch/<original-filename>. Reference them by that absolute path in argv "
            "(e.g. after -i/--input). DO NOT pass attachment contents in input_files; that "
            "wastes output tokens.\n"
            "• INPUT FILES YOU AUTHOR INLINE — the exact shape (JSON spec vs full HTML "
            "document vs CSV) is determined by the skill — read the body returned by "
            "discover_skill before guessing.\n"
            "• OUTPUT — files MUST be written to absolute paths under /outputs/ (passed via "
            "-o or equivalent in argv) AND listed in read_outputs so the runner returns them.\n"
            "• FILENAME — when transforming an attached document, keep the original basename "
            "and extension; the output lives in /outputs/, no '-formatted' suffix needed."
        )

        return {
            'name': 'run_skill_script',
            'description': description,
            'input_schema': {
                'type': 'object',
                'properties': {
                    'dir_name': {
                        'type': 'string',
                        'description': "Which skill to invoke. Pick based on the user's intent and the skill descriptions in the tool description.",
                        'enum': dir_names,
                    },
                    'script': {
                        'type': 'string',
                        'description': "Path to the script within the chosen skill (e.g. 'scripts/create.py'). Must be one of the scripts listed for the skill you picked in dir_name.",
                    },
                    'argv': {
                        'type': 'array',
                        'description': 'Command-line arguments passed to the script (sys.argv[1:]). Output paths MUST start with /outputs/.',
                        'items': {'type': 'string'},
                    },
                    'input_files': {
                        'type': 'object',
                        'description': "Map of absolute path → file contents (string) to stage in the script's filesystem before it runs. Use this for SMALL FILES YOU AUTHOR INLINE — typically the JSON spec for create-style scripts and the ops JSON for edit-style scripts. Common pattern: pass `/scratch/spec.json` or `/scratch/ops.json` here, then reference that path from argv (e.g. `--ops /scratch/ops.json` or `-i /scratch/spec.json`). DO NOT put user-attached document contents here — those are already pre-written to /scratch/<filename> by the runner. Leave empty when the script doesn't need any synthesized inputs.",
                        'additionalProperties': {'type': 'string'},
                    },
                    'read_outputs': {
                        'type': 'array',
                        'description': 'Paths whose contents should be returned after the script finishes. Use absolute /outputs/<filename>. NOTE: HTML/Markdown outputs are rendered in a separate artifact pane and the tool_result content is replaced with a placeholder — summarize what the script did from stdout/stderr in that case.',
                        'items': {'type': 'string'},
                    },
                },
                'required': ['dir_name', 'script'],
            },
        }

    @staticmethod
    def buildDiscoverSkillTool(skills: list) -> dict:
        """Build the discover_skill tool — Anthropic's progressive-disclosure
        pattern as a client-side tool call. Claude calls discover_skill with
        a dir_name; the frontend looks up the skill's full SKILL.md body
        (already loaded into window.skillsManager.skills by loadLocalSkills)
        and returns it as a tool_result. Claude then has the same context
        the chip-dragged path provides via skill_content, and can construct
        the run_skill_script call with the correct shape.

        Without this, auto-routing only sees the frontmatter description in
        the catalog and has to guess the input contract — which fails when
        skills don't follow the same convention (e.g. one create.py expects
        a JSON spec, another expects a complete HTML document)."""
        dir_names = list(dict.fromkeys(s['dir_name'] for s in skills))
        return {
            'name': 'discover_skill',
            'description': "Load the full SKILL.md body for a folder-backed skill. Call this "
                "BEFORE run_skill_script the first time you intend to use a skill on a turn. "
                "Returns the skill's complete contract: the input-file shape it expects "
                "(JSON spec / complete HTML document / CSV / etc.), the canonical "
                "tool-call example, decision rules for when to use which script, and any "
                "skill-specific behavior. The catalog in run_skill_script's description "
                "tells you WHICH skill to pick; this tool tells you HOW to call it. "
                "Cheap and local — the body is already loaded in the browser, no network "
                "round-trip. Skip this only if you have already received the body for the "
                "same dir_name in this conversation.",
            'input_schema': {
                'type': 'object',
                'properties': {
                    'dir_name': {
                        'type': 'string',
                        'description': "The skill whose body to load. Must match a dir_name "
                            "from the run_skill_script catalog.",
                        'enum': dir_names,
                    },
                },
                'required': ['dir_name'],
            },
        }

    # ------------------------------------------------------------------
    # Config appliers (package defaults, user API keys, DB provider
    # settings, quota) — private instance methods
    # ------------------------------------------------------------------

    def _applyPackageDefaults(self, config: dict, userId: str) -> dict:
        config = copy.deepcopy(config)
        try:
            resolver = PackageResolver(self.db)
            user_id_int = php_intval(userId) if is_numeric(userId) else None
            package = resolver.resolveForUser(user_id_int)
            caps = package.get('capabilities') or {}
            providers = caps.get('providers') if isinstance(caps, dict) else None
            if providers is None:
                providers = []

            if not isinstance(providers, (dict, list)):
                return config

            items = providers.items() if isinstance(providers, dict) else enumerate(providers)
            for provider_key, provider_cfg in items:
                if not isinstance(provider_cfg, dict):
                    continue
                if php_empty(provider_cfg.get('enabled')):
                    continue

                default_key = provider_cfg.get('default_api_key').strip() if isinstance(provider_cfg.get('default_api_key'), str) else ''
                default_model = provider_cfg.get('default_model').strip() if isinstance(provider_cfg.get('default_model'), str) else ''

                if default_key == '' and default_model == '':
                    continue

                # Apply to whichever shape the config uses — top-level
                # (config['claude']) or nested (config['providers']['kimi']).
                if isinstance(config.get(provider_key), dict):
                    target = config[provider_key]
                elif isinstance(config.get('providers'), dict) and isinstance(config['providers'].get(provider_key), dict):
                    target = config['providers'][provider_key]
                else:
                    continue

                if default_key != '':
                    target['api_key'] = default_key
                if default_model != '':
                    target['model'] = default_model
        except Exception as e:  # noqa: BLE001
            error_log("[ChatController] Package defaults failed: " + str(e))

        return config

    def _resolvePackageMcpAllowlist(self, userId: str) -> list[str] | None:
        """Resolve the MCP server allowlist for a user's role-based package.
        Returns None when the package allows all MCP servers (default), a
        list of server names when restricted, or an empty list for "none".
        Callers pass the return value straight into MCPToolsLoader.loadToolsForUser."""
        try:
            resolver = PackageResolver(self.db)
            user_id_int = php_intval(userId) if is_numeric(userId) else None
            return resolver.allowedMcpServers(user_id_int)
        except Exception as e:  # noqa: BLE001
            error_log("[ChatController] MCP allowlist resolution failed: " + str(e))
            return None  # fail open

    def _applyUserApiKeys(self, config: dict, userId: str, provider: str | None = None) -> dict:
        if not userId or userId == 'demo-user':
            return config

        config = copy.deepcopy(config)
        try:
            # Check if user_api_keys table exists
            tables = self.db.fetch_all("SHOW TABLES LIKE 'user_api_keys'")
            if len(tables) == 0:
                return config

            numeric_user_id = php_intval(userId) if is_numeric(userId) else php_crc32(userId)

            keys = self.db.fetch_all(
                "SELECT provider, api_key, system_prompt FROM user_api_keys WHERE user_id = :user_id",
                {':user_id': numeric_user_id},
            )

            # Load user model selections
            model_rows = []
            try:
                model_tables = self.db.fetch_all("SHOW TABLES LIKE 'user_model_selections'")
                if len(model_tables) > 0:
                    model_rows = self.db.fetch_all(
                        "SELECT provider, model FROM user_model_selections WHERE user_id = :user_id",
                        {':user_id': numeric_user_id},
                    )
            except Exception as e:  # noqa: BLE001
                error_log("[ChatController] Error loading user models: " + str(e))

            if php_empty(keys) and php_empty(model_rows):
                return config

            encryption_key = config.get('auth', {}).get('jwt_secret') if isinstance(config.get('auth'), dict) else None
            if encryption_key is None:
                encryption_key = 'default-encryption-key-change-this'

            # Track which providers the user has supplied their own (decryptable)
            # key for. The model lock below uses this: a user on the package key
            # cannot override the package's default model — admin pays, admin
            # picks the model. Once the user pastes their own key, the lock
            # releases for that provider only.
            user_owned_key_providers: dict[str, bool] = {}

            # Apply custom API keys + per-user system_prompt overrides. The
            # override wins over the admin global (system_llm_settings) which
            # already won over ai_config.php in applyDatabaseProviderSettings.
            for key_row in keys:
                key_provider = key_row['provider']
                encrypted_key = key_row['api_key']
                user_system_prompt = key_row.get('system_prompt')

                decrypted_key = self._decryptApiKey(encrypted_key, encryption_key)

                if decrypted_key:
                    user_owned_key_providers[key_provider] = True
                    if isinstance(config.get(key_provider), dict):
                        config[key_provider]['api_key'] = decrypted_key
                        error_log(f"[ChatController] Using custom API key for provider: {key_provider}, user: {numeric_user_id}")
                    elif isinstance(config.get('providers'), dict) and isinstance(config['providers'].get(key_provider), dict):
                        config['providers'][key_provider]['api_key'] = decrypted_key
                        error_log(f"[ChatController] Using custom API key for nested provider: {key_provider}, user: {numeric_user_id}")

                # System prompt override is independent of the API key — a
                # user can override the prompt without a custom key.
                if isinstance(user_system_prompt, str) and user_system_prompt.strip() != '':
                    if isinstance(config.get(key_provider), dict):
                        config[key_provider]['system_prompt'] = user_system_prompt
                        error_log(f"[ChatController] Using user system_prompt override for provider: {key_provider}, user: {numeric_user_id}")
                    elif isinstance(config.get('providers'), dict) and isinstance(config['providers'].get(key_provider), dict):
                        config['providers'][key_provider]['system_prompt'] = user_system_prompt
                        error_log(f"[ChatController] Using user system_prompt override for nested provider: {key_provider}, user: {numeric_user_id}")

            # Apply user model selections, but ONLY for providers where the
            # user supplied their own API key. When on the package key the
            # package's default_model (already written by applyPackageDefaults)
            # is authoritative — the admin is footing the bill, the admin
            # picks the model.
            for model_row in model_rows:
                m_provider = model_row['provider']
                m_model = model_row['model']

                if php_empty(user_owned_key_providers.get(m_provider)):
                    error_log(f"[ChatController] Ignoring user model selection for {m_provider} (user {numeric_user_id} on package key); package default stands")
                    continue

                if isinstance(config.get(m_provider), dict):
                    config[m_provider]['model'] = m_model
                    error_log(f"[ChatController] Using custom model for provider: {m_provider} -> {m_model}, user: {numeric_user_id}")
                elif isinstance(config.get('providers'), dict) and isinstance(config['providers'].get(m_provider), dict):
                    config['providers'][m_provider]['model'] = m_model
                    error_log(f"[ChatController] Using custom model for nested provider: {m_provider} -> {m_model}, user: {numeric_user_id}")

        except Exception as e:  # noqa: BLE001
            error_log("[ChatController] Error loading user API keys: " + str(e))

        return config

    def _checkFreeTrialQuota(self, userId: str) -> dict | None:
        """Check if a free trial user has exceeded their token quota.
        Returns an error response dict if quota exceeded, None if OK."""
        if not userId or userId == 'demo-user':
            return None

        try:
            numeric_user_id = php_intval(userId) if is_numeric(userId) else php_crc32(userId)

            # Check user's plan and role
            user = self.db.fetch_one("SELECT plan, role FROM users WHERE id = ?", [numeric_user_id])

            if not user:
                return None

            # Admins have no quota limits
            if (user.get('role') or '') == 'admin':
                return None

            # Paid plans have no quota
            if (user.get('plan') or 'free') != 'free':
                return None

            # Resolve the lifetime token cap from the user's role-based package.
            # None in the package means "no cap" -> bail out without querying usage.
            try:
                package = PackageResolver(self.db).resolveForUser(numeric_user_id)
                caps = package.get('capabilities') or {}
                package_quota = caps.get('quota_tokens') if isinstance(caps, dict) else None
            except Exception as e:  # noqa: BLE001
                error_log("[ChatController] Package quota resolution failed: " + str(e))
                package_quota = None
            if package_quota is None:
                return None
            quota = php_intval(package_quota)

            # Check total tokens used across all providers
            tables = self.db.fetch_all("SHOW TABLES LIKE 'llm_usage_balance'")
            if len(tables) == 0:
                return None  # Table doesn't exist yet, no usage

            row = self.db.fetch_one(
                "SELECT COALESCE(SUM(total_tokens), 0) as total FROM llm_usage_balance WHERE user_id = ?",
                [numeric_user_id],
            )
            total_tokens = php_intval(row.get('total')) if row else 0

            if total_tokens >= quota:
                return {
                    'success': False,
                    'error': f'Token quota reached. You have used {total_tokens:,} of {quota:,} tokens. Please upgrade your plan to continue.',
                    'code': 'QUOTA_EXCEEDED',
                    'usage': {'total_tokens': total_tokens, 'quota': quota},
                    'status_code': 403,
                }
        except Exception as e:  # noqa: BLE001
            error_log("[ChatController] Error checking free trial quota: " + str(e))

        return None

    def _decryptApiKey(self, encryptedKey: str, encryptionKey: str) -> str | None:
        try:
            try:
                data = base64.b64decode(encryptedKey, validate=False)
            except Exception:  # noqa: BLE001
                return None
            if data is False or len(data) < 17:
                return None

            key = hashlib.sha256(encryptionKey.encode()).digest()
            iv = data[:16]
            encrypted = data[16:]

            decrypted = aes256cbc_decrypt(encrypted, key, iv)
            if decrypted is None:
                return None
            try:
                return decrypted.decode('utf-8')
            except Exception:  # noqa: BLE001
                return None
        except Exception:  # noqa: BLE001
            return None

    def _applyDatabaseProviderSettings(self, config: dict) -> dict:
        """Delegates to LLMProviderResolver — kept as a thin wrapper because
        `verify()`, `compareOnly()`, and the streaming/non-streaming chat
        handlers all call this name. Logic lives in the service so all other
        controllers that instantiate AIPortfolioAssistant can share it."""
        return LLMProviderResolver.applyDbSettings(self.db, config)

    # ------------------------------------------------------------------
    # Section marker: public flow methods (chat, agent, verify,
    # compareOnly, handleStreamingChat, handleVerification,
    # handleComparison, handleRegularChat) land in Task 9.
    # ------------------------------------------------------------------


def _php_json_encode_uu(v) -> str:
    """json_encode($v, JSON_UNESCAPED_UNICODE) — slashes are escaped, unicode is not."""
    import json as _json
    return _json.dumps(v, ensure_ascii=False, separators=(',', ':')).replace('/', '\\/')


def _php_json_encode_default(v) -> str:
    """json_encode($v) with no flags — both slashes and unicode are escaped.
    Used only for the character count in buildLlmContextSnapshot's token estimate."""
    import json as _json
    return _json.dumps(v, ensure_ascii=True, separators=(',', ':')).replace('/', '\\/')
