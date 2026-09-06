"""Port of Controllers/ChatController.php.

Task 8 of Phase 2a brought the constructor, helpers, config appliers, quota
check, and the LLM-facing tool builders (lines 36-686 and 2711-3102 of the PHP
source). Task 9 adds the request flows — `chat` (PHP 686-942),
`_handleStreamingChat` (PHP 1499-2091) and `_handleRegularChat` (PHP
2360-2711). `agent`, `verify`, `compareOnly`, `_handleVerification` and
`_handleComparison` land in Phase 2d.
"""
from __future__ import annotations

import copy
import os
import re
import time

from app.ai_portfolio_assistant import AIPortfolioAssistant
from app.agent_team.services.memory_auto_updater import MemoryAutoUpdater
from app.agent_team.services.session_search_service import SessionSearchService
from app.agent_team.services.user_memory_repository import UserMemoryRepository
from app.exceptions import ProviderException
from app.services.combined_tools_executor import CombinedToolsExecutor
from app.services.filtered_tools_executor import FilteredToolsExecutor
from app.services.mcp_tools_loader import MCPToolsLoader
from app.services.package_resolver import PackageResolver
from app.services.llm_provider_resolver import LLMProviderResolver
from app.services.sse_hub_client import SSEHubClient
from app.services.usage_logger import UsageLogger
from app.support.crypto import aes256cbc_decrypt
from app.support.logger import error_log
from app.support.phpcompat import is_numeric, mb_substr, php_bool, php_crc32, php_empty, php_intval, php_uniqid
from app.support.phpjson import dumps

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
        # Deliberate deviation: PHP's preg_match('/^...$/') without the D modifier
        # accepts a trailing "\n" (e.g. "route_to\n"); re.fullmatch is stricter and
        # rejects it — kept as-is (stricter is safer for a name used to route tool calls).
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
            # Deliberate deviation: PHP's preg_match('/^...$/') without the D modifier
            # accepts a trailing "\n" (e.g. "route_to\n"); re.fullmatch is stricter and
            # rejects it — kept as-is (stricter is safer for a name used to route tool calls).
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
        # PHP strlen() counts BYTES, not characters — use UTF-8 byte length for all
        # seven terms so non-ASCII system prompts/messages/content match PHP's count.
        chars = (
            _blen(system_prompt) + _blen(message)
            + sum(_blen(m['content']) for m in messages)
            # PHP: plain json_encode($serverTools) / json_encode($clientTools) — no flags,
            # so BOTH slashes and unicode are escaped here (unlike the message content above).
            + _blen(_php_json_encode_default(serverTools)) + _blen(_php_json_encode_default(options.get('client_tools') or []))
            + _blen(str(options.get('memory_context') or '')) + _blen(str(options.get('skill_content') or ''))
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
                    # Deliberate deviation: PHP's preg_match('/^...$/') without the D
                    # modifier accepts a trailing "\n"; re.fullmatch is stricter and rejects
                    # it — kept as-is (stricter is safer for a name used to route tool calls).
                    or not re.fullmatch(r'webmcp_[a-zA-Z0-9_\-.]{1,120}|route_to|save_playbook_agent', name)):
                error_log(f"[ChatController] client_tools[{i}] dropped: invalid name " + repr(name))
                continue
            description = entry.get('description') if entry.get('description') is not None else ''
            if not isinstance(description, str):
                description = ''
            # PHP strlen()/substr() are BYTE-based, not character-based.
            b = description.encode('utf-8')
            if len(b) > 2048:
                # PHP substr can split a multibyte char; we drop the partial char (recorded deviation).
                description = b[:2048].decode('utf-8', errors='ignore')
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
        if php_empty(userId) or userId == 'demo-user':
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

                if not php_empty(decrypted_key):
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
        if php_empty(userId) or userId == 'demo-user':
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

            # Paid plans have no quota. PHP: ($user['plan'] ?? 'free') !== 'free' — null-
            # coalescing only substitutes on a missing/null key, not on falsy values like
            # '' (PHP treats an empty-string plan as non-null, i.e. NOT the free default).
            plan = user.get('plan')
            plan = plan if plan is not None else 'free'
            if plan != 'free':
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
    # Request flows — chat() and its two handlers.
    # `agent()`, `verify()` and `compareOnly()` land in Phase 2d.
    # ------------------------------------------------------------------

    def chat(self, request: dict) -> dict:
        input_ = request['body']

        # App-key auth is scope-gated: an `ak_` key must explicitly carry the
        # `chat` scope to use this endpoint. JWT users and per-user `uak_` keys
        # (auth_type !== 'app_key') are unrestricted and skip this check.
        if request.get('auth_type') == 'app_key':
            scopes = request.get('app_key_scopes')
            if scopes is None:
                scopes = []
            if 'chat' not in _arr_values(scopes):
                return {
                    'success': False,
                    'error': 'App key not authorized for chat (missing scope "chat")',
                    'status_code': 403,
                }

        message = input_.get('message') if input_.get('message') is not None else ''
        conversationHistory = self.stripVisualNoiseFromHistory(
            input_.get('conversation_history') if input_.get('conversation_history') is not None else []
        )
        # Streaming is opt-in. The caller decides per request whether
        # it wants progressive UI; if it doesn't ask, it doesn't get a
        # stream. Default `false` enforces the rule that streaming is a
        # UX feature owned by the call site, not a transport-layer
        # default the backend silently provides. Skill / tool-arg /
        # structured-output turns must NOT pass `streaming: true` —
        # they have nothing to render progressively.
        streaming = input_.get('streaming') if input_.get('streaming') is not None else False
        skillContent = input_['skill_content'].strip() if isinstance(input_.get('skill_content'), str) else ''

        # skill_metadata is sent by the frontend when a folder-backed skill
        # with executable Python scripts is EXPLICITLY ACTIVE (chip override).
        # Shape: { dir_name: 'html', scripts: ['scripts/create.py', ...] }.
        # When present we force tool_choice → run_skill_script so the model
        # commits to using that one skill.
        skillMetadata = self.sanitizeSkillMetadata(input_.get('skill_metadata'))

        # available_skills is sent on every turn when the user has any
        # folder-backed local skills installed. The model is shown each
        # skill's description and picks one based on intent (matching how
        # MCP tools are routed). No tool_choice forcing — the model can
        # also choose NOT to call run_skill_script if the request doesn't
        # map to a skill.
        #
        # Shape: [{dir_name, description, scripts}, ...].
        # If skill_metadata is also set (chip override), it wins and the
        # multi-skill auto-routing path is skipped for this turn.
        availableSkills = self.sanitizeAvailableSkills(input_.get('available_skills'))

        # Per-request client-side tools (e.g. webMCP tools from the active
        # browser tab). The frontend sends these so the LLM can call them.
        # The backend declares them to the LLM alongside built-in + MCP tools
        # and short-circuits dispatch via the existing client_tool_call SSE
        # event when one is picked.
        clientTools = self.sanitizeClientTools(input_.get('client_tools'))
        clientToolNames = [t['name'] for t in clientTools]
        error_log("[ChatController] client_tools count: " + str(len(clientTools))
                  + ((' [' + ','.join(clientToolNames) + ']') if clientToolNames else ''))

        # DIAGNOSTIC: log what the frontend actually sent for skill routing.
        # When the auto-routing path silently disappears (controller logs
        # "No skill_metadata or available_skills" despite skills being
        # enabled in Settings), this tells us WHICH layer is at fault:
        #   - rawAvailableSkills empty → frontend never sent it
        #   - rawAvailableSkills populated, sanitized empty → sanitizer rejecting it
        #   - both populated → bug is downstream
        rawAvail = input_.get('available_skills')
        error_log("[ChatController] skill routing input — "
                  + "skill_metadata: " + ('null' if php_empty(input_.get('skill_metadata')) else 'present')
                  + " | available_skills raw: " + (f"array({len(rawAvail)})" if isinstance(rawAvail, (dict, list)) else _php_gettype(rawAvail))
                  + " | available_skills sanitized: " + str(len(availableSkills))
                  + ((" [" + ','.join(s['dir_name'] for s in availableSkills) + "]") if len(availableSkills) > 0 else '')
                  + ((" | RAW SAMPLE: " + dumps(_idx0(rawAvail))[:200])
                     if isinstance(rawAvail, (dict, list)) and not php_empty(rawAvail) and len(availableSkills) == 0 else ''))

        # Debug: Log conversation history received from frontend (post-strip,
        # so SVG blobs don't bloat the log).
        error_log("[ChatController] Received conversation_history count: " + str(len(conversationHistory)))
        if not php_empty(conversationHistory):
            error_log("[ChatController] First history entry: " + dumps(
                conversationHistory[0] if len(conversationHistory) > 0 else 'none'))
            # PHP: end($conversationHistory) ?: 'none' — a falsy last entry becomes 'none'.
            last_entry = conversationHistory[len(conversationHistory) - 1]
            error_log("[ChatController] Last history entry: " + dumps(
                last_entry if not php_empty(last_entry) else 'none'))

        userId = str(input_.get('user_id') if input_.get('user_id') is not None
                     else (request.get('user_id') if request.get('user_id') is not None else 'demo-user'))
        provider = input_.get('provider')

        # Debug: Log the provider being requested
        error_log("[ChatController] Provider from request: " + (str(provider) if provider is not None else 'null (will use default)'))

        # Verification parameters
        verificationEnabled = input_.get('verification_enabled') if input_.get('verification_enabled') is not None else False
        verifierProvider = input_.get('verifier_provider')

        # Compare parameters
        compareEnabled = input_.get('compare_enabled') if input_.get('compare_enabled') is not None else False
        compareProvider = input_.get('compare_provider')

        # Optional custom system prompt override. API-driven frontends (e.g. the
        # AI-Dialog app, where two models converse with each other) can supply
        # their own system prompt to replace the default portfolio-assistant
        # persona. When absent, providers fall back to the default prompt — so
        # this is fully backward-compatible with the main app, which never sends it.
        systemPromptOverride = input_['system_prompt'].strip() if isinstance(input_.get('system_prompt'), str) else None
        if systemPromptOverride == '':
            systemPromptOverride = None

        # Optional 'memory' flag. Defaults to true → the user's frozen memory
        # (Hermes Layer 1) is injected into the system prompt as it is today.
        # API-driven callers (e.g. AI-Dialog) can send memory:false so the two
        # models converse without the user's personal memory leaking in. Absent
        # → true, so the main app is unaffected.
        includeMemory = php_bool(input_['memory']) if 'memory' in input_ else True

        # Tool filtering: optional array of tool names to use (null = all tools)
        toolsFilter = input_.get('tools')
        if toolsFilter is not None and not isinstance(toolsFilter, (dict, list)):
            return {
                'success': False,
                'error': 'tools must be an array of tool names',
                'status_code': 400,
            }

        # Per-node overrides from the workflow agent form. When present they WIN over
        # the provider-config defaults (system_llm_settings). Null = use provider default.
        maxTokensOverride = php_intval(input_['max_tokens']) if is_numeric(input_.get('max_tokens')) else None
        temperatureOverride = float(input_['temperature']) if is_numeric(input_.get('temperature')) else None

        # Attachment ids uploaded earlier via /chat/upload. Loaded here, text
        # is extracted (PDF via smalot/pdfparser, plain text read verbatim) and
        # prepended to the user message so every provider receives the document
        # content as part of the prompt. Native per-provider PDF/image dispatch
        # is a follow-up phase; this is the universal fallback that ships value
        # on day one.
        attachmentIds = input_.get('attachment_ids') if input_.get('attachment_ids') is not None else []
        if not isinstance(attachmentIds, (dict, list)):
            attachmentIds = []
        imageAttachments = []
        pdfAttachments = []
        if not php_empty(attachmentIds) and is_numeric(userId):
            try:
                # Phase 2a: AttachmentDispatcher lands in 2d. The import sits inside
                # the try so its ImportError is swallowed exactly like PHP swallows a
                # dispatcher failure in its own `catch (Exception $e)`.
                from app.services.attachment_dispatcher import AttachmentDispatcher
                dispatcher = AttachmentDispatcher(self.db)
                # Pass the active provider so the dispatcher can route PDFs to
                # native dispatch on Claude/Gemini and fall back to text
                # extraction elsewhere.
                #
                # skillModeActive: when a folder-backed skill is in play
                # (chip-dragged → skill_metadata; or auto-routing →
                # non-empty available_skills), the script reads the file
                # from /scratch/ directly. We tell the dispatcher to emit a
                # short reference instead of inlining the full text, saving
                # tens of thousands of input tokens per turn and giving the
                # model a clean signal to call the skill rather than to
                # respond inline against the duplicated source material.
                skillModeActive = (skillMetadata is not None) or not php_empty(availableSkills)
                built = dispatcher.buildPrefix(attachmentIds, php_intval(userId), provider, skillModeActive)
                if built['prefix'] != '':
                    message = built['prefix'] + message
                if not php_empty(built.get('image_attachments')):
                    imageAttachments = built['image_attachments']
                if not php_empty(built.get('pdf_attachments')):
                    pdfAttachments = built['pdf_attachments']
                if not php_empty(built.get('notes')):
                    error_log('[ChatController] Attachment notes: ' + ' | '.join(built['notes']))
            except Exception as e:  # noqa: BLE001
                error_log('[ChatController] Attachment dispatch failed: ' + str(e))

        # Empty message is allowed for B3 client-tool continuations: the
        # frontend re-issues /chat with `message: ''` and the tool_result
        # already at the tail of conversation_history. Anything else with
        # an empty message is a client bug and we still 400.
        isToolResultContinuation = (
            message == ''
            and not php_empty(conversationHistory)
            and _arr_get(conversationHistory[len(conversationHistory) - 1], 'role', '') == 'tool'
        )
        if php_empty(message) and not isToolResultContinuation:
            return {
                'success': False,
                'error': 'Message is required',
                'status_code': 400,
            }

        # Check free trial quota
        quotaCheck = self._checkFreeTrialQuota(userId)
        if quotaCheck is not None:
            return quotaCheck

        # For streaming responses, we handle output directly
        if streaming:
            return self._handleStreamingChat(
                request,
                message,
                conversationHistory,
                userId,
                provider,
                verificationEnabled,
                verifierProvider,
                compareEnabled,
                compareProvider,
                toolsFilter,
                imageAttachments,
                pdfAttachments,
                skillContent,
                skillMetadata,
                availableSkills,
                clientTools,
                clientToolNames,
                systemPromptOverride,
                includeMemory,
                not php_empty(input_.get('return_context')),
            )

        # Non-streaming response
        return self._handleRegularChat(
            request,
            message,
            conversationHistory,
            userId,
            provider,
            toolsFilter,
            imageAttachments,
            pdfAttachments,
            skillContent,
            skillMetadata,
            availableSkills,
            clientTools,
            clientToolNames,
            systemPromptOverride,
            includeMemory,
            maxTokensOverride,
            temperatureOverride,
            not php_empty(input_.get('return_context')),
        )

    # ------------------------------------------------------------------
    # Streaming chat (PHP handleStreamingChat, lines 1499-2091)
    # ------------------------------------------------------------------

    def _handleStreamingChat(
        self,
        request: dict,                       # deviation: PHP reads $sendEvent from globals; we take the request for its SSE stream
        message: str,
        conversationHistory: list,
        userId: str,
        provider: str | None,
        verificationEnabled: bool,
        verifierProvider: str | None,
        compareEnabled: bool,
        compareProvider: str | None,
        toolsFilter: list | None = None,
        imageAttachments: list | None = None,
        pdfAttachments: list | None = None,
        skillContent: str = '',
        skillMetadata: dict | None = None,
        availableSkills: list | None = None,
        clientTools: list | None = None,
        clientToolNames: list | None = None,
        systemPromptOverride: str | None = None,
        includeMemory: bool = True,
        returnContext: bool = False,
    ) -> dict:
        imageAttachments = imageAttachments if imageAttachments is not None else []
        pdfAttachments = pdfAttachments if pdfAttachments is not None else []
        availableSkills = availableSkills if availableSkills is not None else []
        clientTools = clientTools if clientTools is not None else []
        clientToolNames = clientToolNames if clientToolNames is not None else []

        # PHP: set_time_limit(600) — no equivalent (no per-request CPU limit here).

        # Debug: Log provider being used for streaming
        error_log("[ChatController] handleStreamingChat provider: " + (str(provider) if provider is not None else 'null'))

        # Apply database provider settings first (overrides hardcoded config)
        config = self._applyDatabaseProviderSettings(self.config)

        # Then the user's role-based package (sits below user overrides)
        config = self._applyPackageDefaults(config, userId)

        # Then apply user's custom API keys (user keys override everything)
        config = self._applyUserApiKeys(config, userId, provider)
        assistant = AIPortfolioAssistant(config)

        # Initialize usage logger
        usageLogger = None
        try:
            usageLogger = UsageLogger(self.db, True, config.get('contexts_database') if config.get('contexts_database') is not None else config.get('database'))
        except Exception as e:  # noqa: BLE001
            error_log("[ChatController] Usage logger unavailable: " + str(e))

        # Register session_search (Hermes Layer 3) on the chat's ToolsManager.
        # Scoped to the current user via a closure capture; idempotent if the
        # request handler runs multiple executor setups. Fails silently when
        # the contexts_database isn't reachable — chat continues without the tool.
        if is_numeric(userId):
            SessionSearchService.registerAsTool(
                assistant.getToolsManager(),
                php_intval(userId),
                config,
            )

        # Load MCP tools. A workflow node's selection is an exact allow-list:
        # when it names no mcp_* tool, skip the (remote-DB) MCP load entirely —
        # the definitions would be filtered out anyway.
        mcpToolsLoader = None
        snapshotExecutor = assistant.getToolsManager()  # what the Context view reports as offered tools
        wantsMcp = toolsFilter is None or [t for t in _arr_values(toolsFilter) if str(t).startswith('mcp_')] != []
        try:
            if wantsMcp:
                error_log(f"[ChatController] Loading MCP tools for user: {userId}")
                mcpToolsLoader = MCPToolsLoader(self.db)
                mcpToolsLoader.loadToolsForUser(userId)
                error_log("[ChatController] MCP hasTools: " + ('yes' if mcpToolsLoader.hasTools() else 'no'))
            else:
                error_log("[MCP] Skipped MCP load: node selected no MCP tools")

            # NB: the filter must still be applied when MCP is skipped —
            # otherwise the providers keep their default executor and every
            # basic function is offered (seen in the Context tab, 2026-09-02).
            if mcpToolsLoader and mcpToolsLoader.hasTools():
                mcpTools = mcpToolsLoader.getTools()
                error_log("[MCP] Loaded " + str(len(mcpTools)) + f" MCP tools for user: {userId}")

                # Create combined executor with base tools + MCP tools
                baseToolsManager = assistant.getToolsManager()
                combinedExecutor = CombinedToolsExecutor(baseToolsManager, mcpToolsLoader)

                # Wrap with FilteredToolsExecutor if tools filter is specified
                executor = combinedExecutor
                if toolsFilter is not None:
                    filteredExecutor = FilteredToolsExecutor(combinedExecutor)
                    filteredExecutor.setAllowedTools(toolsFilter)
                    executor = filteredExecutor
                    error_log("[ChatController] Tool filter applied: " + ', '.join(str(t) for t in _arr_values(toolsFilter)))

                # Set executor on all providers
                llmManager = assistant.getLLMManager()
                for providerName in self._getEnabledProviderKeys():
                    providerInstance = llmManager.getProvider(providerName)
                    if providerInstance and hasattr(providerInstance, 'setFunctionExecutor'):
                        providerInstance.setFunctionExecutor(executor)
            elif toolsFilter is not None:
                # No MCP tools but filter is specified - filter base tools only
                baseToolsManager = assistant.getToolsManager()
                filteredExecutor = FilteredToolsExecutor(baseToolsManager)
                filteredExecutor.setAllowedTools(toolsFilter)
                error_log("[ChatController] Tool filter applied (base tools only): " + ', '.join(str(t) for t in _arr_values(toolsFilter)))

                llmManager = assistant.getLLMManager()
                for providerName in self._getEnabledProviderKeys():
                    providerInstance = llmManager.getProvider(providerName)
                    if providerInstance and hasattr(providerInstance, 'setFunctionExecutor'):
                        providerInstance.setFunctionExecutor(filteredExecutor)
        except Exception as e:  # noqa: BLE001
            error_log("[MCP] Failed to load MCP tools: " + str(e))

        # Track request start time
        startTime = time.time()

        # SSE headers / output buffering / ignore_user_abort are handled by
        # main.py's StreamingResponse bridge (spec §3).
        sse = request['sse']
        # ContextVar set INSIDE the request thread — run_in_executor does not
        # propagate the caller's context, so SSEHubClient (used by the provider)
        # would otherwise see no stream.
        SSEHubClient.current_stream.set(sse)

        # SSE event sender - detects client disconnect and throws to abort upstream LLM call
        sendEvent = sse.send

        try:
            # Generate session ID
            sessionId = php_uniqid('chat_', True)

            # Make streaming chat request
            options = {'provider': provider} if provider else {}

            # Debug: Log final options being sent
            error_log("[ChatController] streamChat options: " + dumps(options))

            # Tool selection. The base case is "all available tools" —
            # MCP servers + run_skill_script when a skill is active. But
            # for B3 skill turns (folder-backed skill + scripts) we
            # suppress the MCP tools entirely: the user's intent is
            # self-contained ("transform this with skill X"), MCP tools
            # are noise, and 30+ tool definitions add ~6-12K input
            # tokens that the model has to read on every shot. Cutting
            # them roughly halves the per-turn latency for big-input
            # skill flows.
            if skillMetadata is not None:
                skillTool = self.buildRunSkillScriptTool(skillMetadata)
                taskTool = self.buildTaskTool()
                options['tools'] = [skillTool, taskTool]
                options['skill_metadata'] = skillMetadata

                # Force tool use when this is unambiguously a skill turn:
                # a folder-backed skill is active AND no run_skill_script
                # result has happened yet in this conversation. Some
                # models (notably DeepSeek-v4) hallucinate "tool not
                # available" and bail to manual transformation; forcing
                # tool_choice eliminates that escape hatch. Once a
                # run_skill_script result exists in history (i.e. we're
                # on the third shot, summarizing the actual file the
                # script wrote), we revert to 'auto' so the model can
                # write text.
                #
                # discover_skill rounds DO NOT count as a prior tool
                # round here. discover_skill is just SKILL.md retrieval —
                # the real work hasn't happened yet, and turn 2 (after
                # discover) is precisely when we MUST force the
                # run_skill_script call. Counting it would break
                # auto-routing's chip-equivalence by reverting to 'auto'
                # exactly when the LLM most needs to be pinned down.
                hasPriorRunSkillScript = False
                for h in conversationHistory:
                    if _arr_get(h, 'role', '') == 'tool' and _arr_get(h, 'name', '') == 'run_skill_script':
                        hasPriorRunSkillScript = True
                        break
                    if _arr_get(h, 'role', '') == 'assistant' and not php_empty(_arr_get(h, 'tool_calls', None)):
                        for tc in h['tool_calls']:
                            tcName = _arr_get(_arr_get(tc, 'function', {}) or {}, 'name', None)
                            if tcName is None:
                                tcName = _arr_get(tc, 'name', '')
                            if tcName == 'run_skill_script':
                                hasPriorRunSkillScript = True
                                break                 # PHP: break 2
                        if hasPriorRunSkillScript:
                            break

                if not hasPriorRunSkillScript:
                    # Tool_choice forcing form depends on the provider's
                    # behaviour in OpenAI-compatible API land:
                    #
                    #   - Specific-function form ({type:'function',
                    #     function:{name}}): strictest, picks THIS tool.
                    #     Honored by Claude, OpenAI, Gemini.
                    #   - Bare string 'required': forces SOME tool call
                    #     but lets the model pick. Some OpenAI-compatible
                    #     providers (Grok, DeepSeek) honor 'required'
                    #     reliably while silently ignoring the specific-
                    #     function form — empirical observation, the
                    #     model just bails to text.
                    #
                    # In single-skill mode there's exactly ONE tool
                    # declared (run_skill_script with skill-specific
                    # schema), so 'required' is functionally equivalent
                    # to the specific-function form: the model has only
                    # one tool to pick. Using 'required' for the known-
                    # problematic providers gets us through their broken
                    # forcing logic while losing nothing.
                    providerName = str(options.get('provider') if options.get('provider') is not None
                                       else (provider if provider is not None else '')).lower()
                    useRequiredForm = providerName in ('grok', 'deepseek')
                    if useRequiredForm:
                        options['tool_choice'] = 'required'
                    else:
                        options['tool_choice'] = {
                            'type': 'function',
                            'function': {'name': 'run_skill_script'},
                        }

                error_log("🔧 [ChatController] Skill turn — only run_skill_script declared (MCP suppressed). Skill: "
                          + skillMetadata['dir_name']
                          + " | tool_choice: " + dumps(options.get('tool_choice') if options.get('tool_choice') is not None else 'auto')
                          + " | hasPriorRunSkillScript: " + ('1' if hasPriorRunSkillScript else '0'))
            elif not php_empty(availableSkills):
                # Phase 6 multi-skill auto-routing: the model sees a pair
                # of skill tools (discover_skill + run_skill_script) plus
                # the catalog of frontmatter descriptions in run_skill_script's
                # description. Progressive disclosure: the model picks a
                # dir_name from the catalog, calls discover_skill to load
                # the full SKILL.md body for that skill, then calls
                # run_skill_script with the correct shape derived from the
                # body. Without discover_skill the model has only the
                # frontmatter description and has to guess the input shape
                # — which fails for skills with non-standard contracts
                # (e.g. html/create.py expects a complete HTML document
                # inline, not the JSON spec convention used by other
                # create-style scripts).
                #
                # MCP tools coexist — the user might ask "search the web
                # AND make me a doc" and the model uses both.
                skillTool = self.buildMultiSkillTool(availableSkills)
                discoverTool = self.buildDiscoverSkillTool(availableSkills)
                tools = [discoverTool, skillTool]
                if mcpToolsLoader and mcpToolsLoader.hasTools():
                    tools = tools + mcpToolsLoader.getToolDefinitions()
                options['tools'] = tools
                options['available_skills'] = availableSkills

                # Narrow tool_choice forcing for the multi-skill path:
                # ONLY force run_skill_script when (a) this turn isn't a
                # tool-result continuation, (b) the user actually attached
                # a document on this turn, and (c) the prompt contains a
                # deliverable verb. The double-gate keeps casual chat,
                # analysis-of-attachments, and MCP-tool flows untouched
                # while still closing the "Claude inlines HTML when asked
                # to fix/edit/replace something in an attached doc"
                # failure mode that motivated the heuristic.
                isContinuation = False
                if not php_empty(conversationHistory):
                    last = conversationHistory[len(conversationHistory) - 1]
                    if isinstance(last, (dict, list)) and _arr_get(last, 'role', '') == 'tool':
                        isContinuation = True
                # Attachment marker is the prefix the frontend's Phase 3
                # converter prepends to outgoingMessage before send.
                hasAttachment = '[The user attached the following document(s)' in message
                promptTail = mb_substr(message, max(0, len(message) - 600))
                deliverableSignal = bool(re.search(
                    r'\b(create|generate|make|build|produce|edit|update|replace|fix|correct|swap|change|modify|revise)\b'
                    r'|in the (document|file)\b|attached (html|document|file)',
                    promptTail, re.I,
                ))
                # Auto-routing: when conditions warrant a skill invocation,
                # force the FIRST tool call to be discover_skill rather than
                # run_skill_script. The flow is then guaranteed:
                #   1. Claude calls discover_skill(dir_name)
                #   2. Frontend returns SKILL.md body + promotes the skill
                #      to chip-equivalent in the follow-up request body
                #      (skill_content + skill_metadata)
                #   3. Backend's $skillMetadata branch fires on turn 2,
                #      forcing tool_choice to run_skill_script with the
                #      single-skill schema — identical to drag-and-drop
                #   4. Claude calls run_skill_script per the now-binding
                #      SKILL.md contract in the system prompt
                #
                # Forcing discover_skill (not run_skill_script) on turn 1
                # is what makes the auto-routing path produce the same
                # file as the chip-dragged path: it eliminates the
                # failure mode where Claude jumps straight to
                # run_skill_script with a guessed input shape.
                if not isContinuation and hasAttachment and deliverableSignal:
                    options['tool_choice'] = {
                        'type': 'function',
                        'function': {'name': 'discover_skill'},
                    }

                error_log("🔧 [ChatController] Multi-skill auto-routing — "
                          + str(len(availableSkills)) + " skill(s) declared alongside MCP tools. Skills: "
                          + ', '.join(s['dir_name'] for s in availableSkills)
                          + " | tool_choice: " + dumps(options.get('tool_choice') if options.get('tool_choice') is not None else 'auto')
                          + " | hasAttachment: " + ('1' if hasAttachment else '0')
                          + " | deliverableSignal: " + ('1' if deliverableSignal else '0')
                          + " | isContinuation: " + ('1' if isContinuation else '0'))
            else:
                if mcpToolsLoader and mcpToolsLoader.hasTools():
                    options['tools'] = mcpToolsLoader.getToolDefinitions()
                error_log("🔧 [ChatController] No skill_metadata or available_skills — not declaring run_skill_script.")

            # Append user's frozen memory (Hermes Layer 1) to the system prompt.
            # Providers read options['memory_context'] and append it after their
            # default or custom system prompt. Skipped when the caller sends
            # memory:false (e.g. AI-Dialog, so personal memory doesn't leak in).
            if includeMemory and is_numeric(userId):
                memBlock = UserMemoryRepository.buildMemoryBlock(self.db, php_intval(userId))
                if memBlock != '':
                    options['memory_context'] = memBlock

            # Active Skill from the Skills Library (dragged onto prompt input)
            if skillContent != '':
                options['skill_content'] = skillContent

            # Custom system prompt override (API-driven callers, e.g. AI-Dialog).
            # Replaces the default persona; providers read options['system_prompt'].
            if systemPromptOverride is not None:
                options['system_prompt'] = systemPromptOverride

            # Image attachments (base64 + mime). Providers embed in native shape.
            if not php_empty(imageAttachments):
                options['image_attachments'] = imageAttachments

            # PDF attachments — only populated when the active provider can
            # ingest PDFs natively (Claude, Gemini). Other providers received
            # the document as text in the message prefix already.
            if not php_empty(pdfAttachments):
                options['pdf_attachments'] = pdfAttachments

            # Client-side tools from the active browser tab (webMCP). Providers
            # (modified in Tasks 4-9) read these keys and call
            # setPerRequestClientSideToolNames() on themselves before the LLM call.
            options['client_tools'] = clientTools
            options['client_tool_names'] = clientToolNames
            # Workflow nodes: exact allow-list enforced at the assistant's tool merge.
            if toolsFilter is not None:
                options['tools_filter'] = toolsFilter

            response = assistant.streamChat(message, sessionId, userId, conversationHistory, options)

            # Calculate response time
            responseTimeMs = int((time.time() - startTime) * 1000)

            # Send main response
            responseData = {
                'success': True,
                'text': response['text'],
                'usage': response.get('usage') if response.get('usage') is not None else [],
                'provider': response.get('provider_used') if response.get('provider_used') is not None else 'claude',
            }

            # B3: when the LLM invoked a client-side tool, the provider
            # already emitted a `client_tool_call` SSE event from inside
            # its tool-use handler and short-circuited. Forward the flag
            # here so the frontend dispatcher knows to run the tool and
            # re-issue /chat with the tool_result prepended, rather than
            # closing out the assistant turn.
            if not php_empty(response.get('pending_client_tool_call')):
                responseData['pending_client_tool_call'] = True
                responseData['pending_tool_calls'] = response.get('pending_tool_calls') if response.get('pending_tool_calls') is not None else []

            # Conversations' View Context asks for what was actually sent
            # (system prompt, memory, skill, tools, messages) — same snapshot
            # the workflow node modal's Context tab uses.
            if returnContext:
                pKey = str(provider if provider is not None
                           else (responseData.get('provider') if responseData.get('provider') is not None else 'claude'))
                pCfg = _first_array(config.get(pKey), (config.get('providers') or {}).get(pKey) if isinstance(config.get('providers'), dict) else None, {})
                effectiveSystemPrompt = options.get('system_prompt') if options.get('system_prompt') is not None else str(pCfg.get('system_prompt') if pCfg.get('system_prompt') is not None else '')
                responseData['context'] = self.buildLlmContextSnapshot(
                    pKey,
                    str(pCfg['model']) if pCfg.get('model') is not None and pCfg['model'] != '' else None,
                    # PHP array union: leftmost key wins.
                    {**{'max_tokens': pCfg.get('max_tokens'), 'temperature': pCfg.get('temperature')},
                     **options, 'system_prompt': effectiveSystemPrompt},
                    options['tools'] if options.get('tools') is not None else (snapshotExecutor.getToolDefinitions() if snapshotExecutor else []),
                    conversationHistory,
                    message,
                )

            sendEvent('response', responseData)

            # B3: when the LLM short-circuited with a client-side tool call,
            # the assistant turn isn't actually finished — the frontend
            # will dispatch the tool and re-issue /chat. Verifier and
            # compare are turn-level concerns, so they run on the *real*
            # continuation, not on the empty placeholder text we just
            # emitted. Skip them and skip the 'complete' marker too —
            # the second-shot will emit its own.
            isPendingClientTool = not php_empty(response.get('pending_client_tool_call'))

            # Phase 2: Verification
            if not isPendingClientTool and verificationEnabled and verifierProvider and verifierProvider != provider:
                self._handleVerification(
                    assistant,
                    sendEvent,
                    message,
                    response['text'],
                    verifierProvider,
                    mcpToolsLoader,
                    usageLogger,
                    userId,
                    startTime,
                    responseTimeMs,
                )

            # Phase 3: Compare
            if not isPendingClientTool and compareEnabled and compareProvider and compareProvider != provider:
                self._handleComparison(
                    assistant,
                    sendEvent,
                    message,
                    conversationHistory,
                    compareProvider,
                    mcpToolsLoader,
                    usageLogger,
                    userId,
                    startTime,
                    responseTimeMs,
                    skillMetadata,
                    availableSkills,
                    skillContent,
                    imageAttachments,
                    pdfAttachments,
                )

            sendEvent('complete', {'status': 'done'})

            # PHP's fastcgi_finish_request() equivalent: close the SSE body so
            # the client is done before the usage/memory tail runs.
            sse.end()

            # Log usage
            if usageLogger and response.get('usage') is not None:
                usage = response['usage']

                # Debug: Log exactly what tool calls are being recorded
                funcCalled = response.get('functions_called') if response.get('functions_called') is not None else []
                mcpCalled = response.get('mcp_tools_called') if response.get('mcp_tools_called') is not None else []
                error_log("📋 [ChatController] About to log - functions_called: " + dumps(funcCalled) + ", mcp_tools_called: " + dumps(mcpCalled))

                usageLogger.logTransaction({
                    'user_id': php_intval(userId) if is_numeric(userId) else None,
                    'session_id': sessionId,
                    'provider': response.get('provider_used') if response.get('provider_used') is not None else 'claude',
                    'model': response.get('model') if response.get('model') is not None else 'unknown',
                    'prompt_tokens': _coalesce(_arr_get(usage, 'input_tokens'), _arr_get(usage, 'prompt_tokens'), 0),
                    'completion_tokens': _coalesce(_arr_get(usage, 'output_tokens'), _arr_get(usage, 'completion_tokens'), 0),
                    'response_time_ms': responseTimeMs,
                    'status': 'success',
                    'function_calls_count': _coalesce(_arr_get(usage, 'function_calls'), response.get('function_calls_count'), 0),
                    'functions_called': response.get('functions_called'),
                    'mcp_calls_count': response.get('mcp_calls_count') if response.get('mcp_calls_count') is not None else 0,
                    'mcp_tools_called': response.get('mcp_tools_called'),
                })

            # Post-response tail: run the memory auto-updater after the client
            # has received everything. Failures here must never affect the user.
            # Workflow nodes send memory=false: no memory injection AND no
            # post-response extraction (that extra Claude call blocked the
            # response ~3s under mod_php, where fastcgi_finish_request is absent).
            if includeMemory and is_numeric(userId) and not php_empty(response.get('text')):
                try:
                    # $config (local) is the DB-merged copy from
                    # applyDatabaseProviderSettings(). The Claude API key
                    # moved to system_llm_settings, so $this->config no
                    # longer has it — reading from $this->config here
                    # gave an empty key and silently disabled memory
                    # auto-extraction. Use the merged $config instead.
                    apiKey = _claude_api_key(config)
                    if apiKey != '':
                        updater = MemoryAutoUpdater(self.db, apiKey)
                        updater.run(php_intval(userId), sessionId, str(message), str(response['text']))
                    else:
                        error_log('[ChatController] MemoryAutoUpdater skipped: no Claude API key in merged config or ANTHROPIC_API_KEY env')
                except Exception as e:  # noqa: BLE001
                    error_log('[ChatController] MemoryAutoUpdater failed: ' + str(e))

        except Exception as e:  # noqa: BLE001
            # Client disconnected - silently cancel. No error event (client is gone anyway),
            # no error log spam. The upstream LLM connection closes automatically.
            #
            # Deviation: PHP has two catch blocks — `catch (\RuntimeException)` which
            # rethrows anything that isn't CLIENT_ABORTED, then `catch (Exception)`.
            # A rethrown RuntimeException escapes to index.php AFTER the SSE headers
            # were sent, i.e. it produces no usable output. Python's ProviderException
            # hierarchy plus the RuntimeError used for aborts makes the single block
            # the faithful-in-effect form: CLIENT_ABORTED first, everything else
            # through the generic handler.
            if isinstance(e, RuntimeError) and str(e) == 'CLIENT_ABORTED':
                error_log("[ChatController] Client aborted, upstream LLM call cancelled")
                if usageLogger and is_numeric(userId):
                    responseTimeMs = int((time.time() - startTime) * 1000)
                    usageLogger.logTransaction({
                        'user_id': php_intval(userId),
                        'provider': provider if provider is not None else 'claude',
                        'model': 'unknown',
                        'prompt_tokens': 0,
                        'completion_tokens': 0,
                        'response_time_ms': responseTimeMs,
                        'status': 'aborted',
                        'error_message': 'Cancelled by user',
                    })
                return {
                    'streaming_handled': True,
                    'status_code': 200,
                }

            responseTimeMs = int((time.time() - startTime) * 1000)

            if usageLogger and is_numeric(userId):
                usageLogger.logTransaction({
                    'user_id': php_intval(userId),
                    'provider': provider if provider is not None else 'claude',
                    'model': 'unknown',
                    'prompt_tokens': 0,
                    'completion_tokens': 0,
                    'response_time_ms': responseTimeMs,
                    'status': 'error',
                    'error_message': str(e),
                })

            try:
                sendEvent('error', {'message': self.humanizeProviderError(str(e))})
            except RuntimeError as abort:      # the client vanished mid-error
                if str(abort) != 'CLIENT_ABORTED':
                    raise

        # Return special marker indicating streaming was handled
        return {
            'streaming_handled': True,
            'status_code': 200,
        }

    def _handleVerification(self, *args, **kwargs):
        """PHP handleVerification — pending Phase 2d. Only reachable when a request
        enables verification (`verification_enabled` + a different verifier provider)."""
        raise NotImplementedError('pending 2d')

    def _handleComparison(self, *args, **kwargs):
        """PHP handleComparison — pending Phase 2d. Only reachable when a request
        enables compare (`compare_enabled` + a different compare provider)."""
        raise NotImplementedError('pending 2d')

    # ------------------------------------------------------------------
    # Regular (non-streaming) chat (PHP handleRegularChat, lines 2360-2711)
    # ------------------------------------------------------------------

    def _handleRegularChat(
        self,
        request: dict,                       # deviation: carries the `_after_response` hook (PHP: register_shutdown_function)
        message: str,
        conversationHistory: list,
        userId: str,
        provider: str | None,
        toolsFilter: list | None = None,
        imageAttachments: list | None = None,
        pdfAttachments: list | None = None,
        skillContent: str = '',
        skillMetadata: dict | None = None,
        availableSkills: list | None = None,
        clientTools: list | None = None,
        clientToolNames: list | None = None,
        systemPromptOverride: str | None = None,
        includeMemory: bool = True,
        maxTokensOverride: int | None = None,
        temperatureOverride: float | None = None,
        returnContext: bool = False,
    ) -> dict:
        imageAttachments = imageAttachments if imageAttachments is not None else []
        pdfAttachments = pdfAttachments if pdfAttachments is not None else []
        availableSkills = availableSkills if availableSkills is not None else []
        clientTools = clientTools if clientTools is not None else []
        clientToolNames = clientToolNames if clientToolNames is not None else []

        # Apply database provider settings first (overrides hardcoded config)
        config = self._applyDatabaseProviderSettings(self.config)

        # Then the user's role-based package (sits below user overrides)
        config = self._applyPackageDefaults(config, userId)

        # Then apply user's custom API keys (user keys override everything)
        config = self._applyUserApiKeys(config, userId, provider)

        # Per-node overrides from the workflow agent form win over the provider-config
        # defaults. Write into the provider's config block at its actual location — root
        # ($config[$provider]) for claude/openai, nested ($config['providers'][$provider])
        # for the rest — matching LLMProviderResolver so the provider ctor reads them.
        if (maxTokensOverride is not None or temperatureOverride is not None) and provider:
            if isinstance(config.get(provider), (dict, list)):
                if maxTokensOverride is not None:
                    config[provider]['max_tokens'] = maxTokensOverride
                if temperatureOverride is not None:
                    config[provider]['temperature'] = temperatureOverride
            elif isinstance(config.get('providers'), dict) and isinstance(config['providers'].get(provider), (dict, list)):
                if maxTokensOverride is not None:
                    config['providers'][provider]['max_tokens'] = maxTokensOverride
                if temperatureOverride is not None:
                    config['providers'][provider]['temperature'] = temperatureOverride

        assistant = AIPortfolioAssistant(config)

        # Initialize usage logger
        usageLogger = None
        try:
            usageLogger = UsageLogger(self.db, True, config.get('contexts_database') if config.get('contexts_database') is not None else config.get('database'))
        except Exception as e:  # noqa: BLE001
            error_log("[ChatController] Usage logger unavailable: " + str(e))

        # Register session_search (Hermes Layer 3) on this request's ToolsManager.
        if is_numeric(userId):
            SessionSearchService.registerAsTool(
                assistant.getToolsManager(),
                php_intval(userId),
                config,
            )

        # Load MCP tools. A workflow node's selection is an exact allow-list:
        # when it names no mcp_* tool, skip the (remote-DB) MCP load entirely.
        mcpToolsLoader = None
        snapshotExecutor = assistant.getToolsManager()  # what the Context tab reports as offered tools
        wantsMcp = toolsFilter is None or [t for t in _arr_values(toolsFilter) if str(t).startswith('mcp_')] != []
        try:
            if wantsMcp:
                mcpToolsLoader = MCPToolsLoader(self.db)
                mcpToolsLoader.loadToolsForUser(userId)
            else:
                error_log("[MCP] Skipped MCP load: node selected no MCP tools")

            # The filter must still be applied when MCP is skipped (see the
            # streaming twin above).
            if mcpToolsLoader and mcpToolsLoader.hasTools():
                baseToolsManager = assistant.getToolsManager()
                combinedExecutor = CombinedToolsExecutor(baseToolsManager, mcpToolsLoader)

                # Wrap with FilteredToolsExecutor if tools filter is specified
                executor = combinedExecutor
                if toolsFilter is not None:
                    filteredExecutor = FilteredToolsExecutor(combinedExecutor)
                    filteredExecutor.setAllowedTools(toolsFilter)
                    executor = filteredExecutor
                    error_log("[ChatController] Tool filter applied: " + ', '.join(str(t) for t in _arr_values(toolsFilter)))
                snapshotExecutor = executor

                llmManager = assistant.getLLMManager()
                for providerName in self._getEnabledProviderKeys():
                    providerInstance = llmManager.getProvider(providerName)
                    if providerInstance and hasattr(providerInstance, 'setFunctionExecutor'):
                        providerInstance.setFunctionExecutor(executor)
            elif toolsFilter is not None:
                # No MCP tools but filter is specified - filter base tools only
                baseToolsManager = assistant.getToolsManager()
                filteredExecutor = FilteredToolsExecutor(baseToolsManager)
                filteredExecutor.setAllowedTools(toolsFilter)
                snapshotExecutor = filteredExecutor

                llmManager = assistant.getLLMManager()
                for providerName in self._getEnabledProviderKeys():
                    providerInstance = llmManager.getProvider(providerName)
                    if providerInstance and hasattr(providerInstance, 'setFunctionExecutor'):
                        providerInstance.setFunctionExecutor(filteredExecutor)
        except Exception as e:  # noqa: BLE001
            error_log("[MCP] Failed to load MCP tools: " + str(e))

        startTime = time.time()

        try:
            options = {'provider': provider} if provider else {}

            # Tool selection — same policy as the streaming path. For
            # B3 skill turns we suppress MCP tools to keep the input
            # small and the model's decision space narrow, and force
            # tool_choice when no tool round has run yet.
            if skillMetadata is not None:
                skillTool = self.buildRunSkillScriptTool(skillMetadata)
                taskTool = self.buildTaskTool()
                options['tools'] = [skillTool, taskTool]
                options['skill_metadata'] = skillMetadata

                hasPriorToolRound = False
                for h in conversationHistory:
                    if _arr_get(h, 'role', '') == 'tool':
                        hasPriorToolRound = True
                        break
                    if _arr_get(h, 'role', '') == 'assistant' and not php_empty(_arr_get(h, 'tool_calls', None)):
                        hasPriorToolRound = True
                        break
                if not hasPriorToolRound:
                    options['tool_choice'] = {
                        'type': 'function',
                        'function': {'name': 'run_skill_script'},
                    }
            elif not php_empty(availableSkills):
                skillTool = self.buildMultiSkillTool(availableSkills)
                tools = [skillTool]
                if mcpToolsLoader and mcpToolsLoader.hasTools():
                    tools = tools + mcpToolsLoader.getToolDefinitions()
                options['tools'] = tools
                options['available_skills'] = availableSkills
            else:
                if mcpToolsLoader and mcpToolsLoader.hasTools():
                    options['tools'] = mcpToolsLoader.getToolDefinitions()

            # Append user's frozen memory (Hermes Layer 1) to the system prompt.
            # Skipped when the caller sends memory:false (e.g. AI-Dialog).
            if includeMemory and is_numeric(userId):
                memBlock = UserMemoryRepository.buildMemoryBlock(self.db, php_intval(userId))
                if memBlock != '':
                    options['memory_context'] = memBlock

            # Active Skill from the Skills Library (dragged onto prompt input)
            if skillContent != '':
                options['skill_content'] = skillContent

            # Custom system prompt override (API-driven callers, e.g. AI-Dialog).
            # Replaces the default persona; providers read options['system_prompt'].
            if systemPromptOverride is not None:
                options['system_prompt'] = systemPromptOverride

            # Image attachments (base64 + mime). Providers embed in native shape.
            if not php_empty(imageAttachments):
                options['image_attachments'] = imageAttachments

            # PDF attachments — only populated when the active provider can
            # ingest PDFs natively (Claude, Gemini). Other providers received
            # the document as text in the message prefix already.
            if not php_empty(pdfAttachments):
                options['pdf_attachments'] = pdfAttachments

            # Client-side tools from the active browser tab (webMCP). Providers
            # (modified in Tasks 4-9) read these keys and call
            # setPerRequestClientSideToolNames() on themselves before the LLM call.
            options['client_tools'] = clientTools
            options['client_tool_names'] = clientToolNames
            # Workflow nodes: exact allow-list enforced at the assistant's tool merge.
            if toolsFilter is not None:
                options['tools_filter'] = toolsFilter

            response = assistant.chat(message, userId, conversationHistory, options)

            responseTimeMs = int((time.time() - startTime) * 1000)

            # Log usage
            if usageLogger and response.get('usage') is not None:
                usage = response['usage']
                usageLogger.logTransaction({
                    'user_id': php_intval(userId) if is_numeric(userId) else None,
                    'provider': response.get('provider_used') if response.get('provider_used') is not None else 'claude',
                    'model': response.get('model') if response.get('model') is not None else 'unknown',
                    'prompt_tokens': _coalesce(_arr_get(usage, 'input_tokens'), _arr_get(usage, 'prompt_tokens'), 0),
                    'completion_tokens': _coalesce(_arr_get(usage, 'output_tokens'), _arr_get(usage, 'completion_tokens'), 0),
                    'response_time_ms': responseTimeMs,
                    'status': 'success',
                    'function_calls_count': _coalesce(_arr_get(usage, 'function_calls'), response.get('function_calls_count'), 0),
                    'functions_called': response.get('functions_called'),
                    'mcp_calls_count': response.get('mcp_calls_count') if response.get('mcp_calls_count') is not None else 0,
                    'mcp_tools_called': response.get('mcp_tools_called'),
                })

            # Register the memory auto-updater on shutdown so it runs after PHP
            # has written the response body. Failures must never affect the user.
            # Workflow nodes send memory=false: no memory injection AND no
            # post-response extraction (that extra Claude call blocked the
            # response ~3s under mod_php, where fastcgi_finish_request is absent).
            #
            # Deviation (recorded): there is no register_shutdown_function here.
            # The callable is handed to main.py via request['_after_response'],
            # which runs it right BEFORE the response is written — the client
            # pays the extra latency PHP avoids with fastcgi_finish_request.
            if includeMemory and is_numeric(userId) and not php_empty(response.get('text')):
                dbRef = self.db
                # Capture the DB-merged config (local $config), NOT
                # $this->config — the Claude API key now lives in
                # system_llm_settings and is only present after
                # applyDatabaseProviderSettings(). See the matching note
                # in the non-streaming path.
                configRef = config
                msgRef = str(message)
                uidRef = php_intval(userId)
                sidRef = php_uniqid('chat_', True)   # PHP: $sessionId ?? uniqid(...) — $sessionId is never set here
                textRef = str(response['text'])

                def _after_response() -> None:
                    try:
                        apiKey = _claude_api_key(configRef)
                        if apiKey != '':
                            updater = MemoryAutoUpdater(dbRef, apiKey)
                            updater.run(uidRef, sidRef, msgRef, textRef)
                        else:
                            error_log('[ChatController] MemoryAutoUpdater skipped (streaming): no Claude API key in merged config or ANTHROPIC_API_KEY env')
                    except Exception as e:  # noqa: BLE001
                        error_log('[ChatController] MemoryAutoUpdater failed: ' + str(e))

                request['_after_response'] = _after_response

            payload = {
                'success': True,
                'text': response['text'],
                'usage': response.get('usage') if response.get('usage') is not None else [],
                'provider': _coalesce(response.get('provider'), response.get('provider_used'), 'claude'),
                'status_code': 200,
            }

            # Surface client-side tool dispatch flags so the frontend
            # dispatcher can run pyodide and re-issue /chat with the
            # tool result. Same shape the streaming path emits in its
            # `response` SSE event — keeps frontend dispatch logic
            # identical regardless of streaming mode.
            if not php_empty(response.get('pending_client_tool_call')):
                payload['pending_client_tool_call'] = True
                payload['pending_tool_calls'] = response.get('pending_tool_calls') if response.get('pending_tool_calls') is not None else []
                if response.get('assistant_text') is not None and response['assistant_text'] != '':
                    payload['assistant_text'] = response['assistant_text']
                if not php_empty(response.get('assistant_reasoning')):
                    payload['assistant_reasoning'] = response['assistant_reasoning']

            # Workflow nodes ask for the context they sent (Context tab).
            if returnContext:
                pKey = str(provider if provider is not None
                           else (payload.get('provider') if payload.get('provider') is not None else 'claude'))
                pCfg = _first_array(config.get(pKey), (config.get('providers') or {}).get(pKey) if isinstance(config.get('providers'), dict) else None, {})
                # No override → the provider uses its configured persona; report that, not ''.
                effectiveSystemPrompt = options.get('system_prompt') if options.get('system_prompt') is not None else str(pCfg.get('system_prompt') if pCfg.get('system_prompt') is not None else '')
                payload['context'] = self.buildLlmContextSnapshot(
                    pKey,
                    str(pCfg['model']) if pCfg.get('model') is not None and pCfg['model'] != '' else None,
                    # PHP array union: leftmost key wins.
                    {**{'max_tokens': pCfg.get('max_tokens'), 'temperature': pCfg.get('temperature')},
                     **options, 'system_prompt': effectiveSystemPrompt},
                    options['tools'] if options.get('tools') is not None else (snapshotExecutor.getToolDefinitions() if snapshotExecutor else []),
                    conversationHistory,
                    message,
                )

            return payload

        except Exception as e:  # noqa: BLE001
            responseTimeMs = int((time.time() - startTime) * 1000)

            if usageLogger and is_numeric(userId):
                usageLogger.logTransaction({
                    'user_id': php_intval(userId),
                    'provider': provider if provider is not None else 'claude',
                    'model': 'unknown',
                    'prompt_tokens': 0,
                    'completion_tokens': 0,
                    'response_time_ms': responseTimeMs,
                    'status': 'error',
                    'error_message': str(e),
                })

            # Surface the REAL cause, not a blanket 500. ProviderException already
            # carries the true HTTP status (429 rate limit, 401 auth, 400 billing,
            # 5xx overload); use it so the client can distinguish "retry", "fix key",
            # "top up credits", etc. humanizeProviderError turns the raw provider text
            # into a categorized, user-readable message (and redacts any leaked keys).
            statusCode = e.getHttpStatusCode() if (isinstance(e, ProviderException) and e.getHttpStatusCode()) else 500
            return {
                'success': False,
                'error': self.humanizeProviderError(str(e)),
                'status_code': statusCode,
            }


def _php_gettype(v) -> str:
    """PHP gettype() for the values the skill-routing diagnostic can see."""
    if v is None:
        return 'NULL'
    if isinstance(v, bool):
        return 'boolean'
    if isinstance(v, int):
        return 'integer'
    if isinstance(v, float):
        return 'double'
    if isinstance(v, str):
        return 'string'
    if isinstance(v, (dict, list)):
        return 'array'
    return 'object'


def _arr_get(container, key: str, default=None):
    """PHP `$x['k'] ?? d` on a value that may not be an array at all."""
    if isinstance(container, dict):
        v = container.get(key)
        return v if v is not None else default
    return default


def _idx0(v):
    """PHP `$a[0] ?? null` — a JSON object decoded to a dict has no key 0."""
    if isinstance(v, list):
        return v[0] if len(v) > 0 else None
    if isinstance(v, dict):
        return v.get(0)
    return None


def _arr_values(v):
    """PHP arrays iterate values whether they are lists or maps."""
    if isinstance(v, dict):
        return list(v.values())
    if isinstance(v, list):
        return v
    return []


def _coalesce(*values):
    """PHP `$a ?? $b ?? $c` — the first non-null value."""
    for v in values:
        if v is not None:
            return v
    return None


def _first_array(*candidates):
    """PHP `$a['x'] ?? $a['y']['x'] ?? []` where each candidate is an array or missing."""
    for c in candidates:
        if c is not None:
            return c if isinstance(c, dict) else {}
    return {}


def _claude_api_key(config: dict) -> str:
    """PHP: (string) ($config['claude']['api_key'] ?? getenv('ANTHROPIC_API_KEY') ?: '')
    — `??` binds tighter than `?:`, so a falsy resolved value collapses to ''."""
    claude = config.get('claude')
    key = claude.get('api_key') if isinstance(claude, dict) else None
    if key is None:
        key = os.environ.get('ANTHROPIC_API_KEY')
    return '' if php_empty(key) else str(key)


def _blen(s: str) -> int:
    """PHP strlen() equivalent: byte length (UTF-8), not character count."""
    return len(s.encode('utf-8'))


def _php_json_encode_uu(v) -> str:
    """json_encode($v, JSON_UNESCAPED_UNICODE) — slashes are escaped, unicode is not."""
    import json as _json
    return _json.dumps(v, ensure_ascii=False, separators=(',', ':')).replace('/', '\\/')


def _php_json_encode_default(v) -> str:
    """json_encode($v) with no flags — both slashes and unicode are escaped.
    Used only for the character count in buildLlmContextSnapshot's token estimate."""
    import json as _json
    return _json.dumps(v, ensure_ascii=True, separators=(',', ':')).replace('/', '\\/')
