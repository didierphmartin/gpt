<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;
use Quantis\AIPortfolioAssistant\Services\UsageLogger;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;
use Quantis\AIPortfolioAssistant\Services\CombinedToolsExecutor;
use Quantis\AIPortfolioAssistant\Services\FilteredToolsExecutor;
use Quantis\AIPortfolioAssistant\Services\PackageResolver;
use Quantis\AIPortfolioAssistant\Services\LLMProviderResolver;
use Quantis\AIPortfolioAssistant\Services\AttachmentDispatcher;
use Quantis\AIPortfolioAssistant\Contracts\StreamingClientInterface;
use PDO;
use Exception;
use Quantis\AIPortfolioAssistant\Exceptions\ProviderException;

/**
 * Chat Controller
 *
 * Handles chat requests with support for:
 * - Regular JSON responses
 * - SSE streaming responses
 * - Verification with another LLM
 * - Comparison with another LLM
 */
class ChatController
{
    private PDO $db;
    private array $config;
    /** Memoized enabled provider_keys from system_llm_settings (per request). */
    private ?array $enabledProviderKeysCache = null;

    public function __construct(PDO $db, array $config)
    {
        $this->db = $db;
        $this->config = $config;
    }

    /**
     * The provider keys that are ENABLED in system_llm_settings — the single source of
     * truth for which LLMs the app supports. Drives per-provider setup loops (attaching
     * the function executor, etc.) so a provider added to the table (e.g. GLM) is picked
     * up automatically instead of being silently skipped by a hardcoded list. Memoized
     * per request; falls back to the historical hardcoded set if the query fails.
     */
    private function getEnabledProviderKeys(): array
    {
        if ($this->enabledProviderKeysCache !== null) {
            return $this->enabledProviderKeysCache;
        }
        try {
            $stmt = $this->db->query(
                "SELECT provider_key FROM system_llm_settings WHERE enabled = 1 ORDER BY sort_order ASC"
            );
            $keys = $stmt->fetchAll(PDO::FETCH_COLUMN);
            if (!empty($keys)) {
                return $this->enabledProviderKeysCache = array_values(array_unique($keys));
            }
        } catch (\Throwable $e) {
            error_log('[ChatController] getEnabledProviderKeys failed: ' . $e->getMessage());
        }
        return $this->enabledProviderKeysCache = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi'];
    }

    /**
     * Convert raw provider exception messages into something the user
     * can actually act on. Provider exceptions tend to be long, include
     * the raw HTTP request body (which contains the API key in some
     * URLs), and use technical jargon. We pattern-match the common
     * cases and replace with a short actionable line. The full original
     * message still goes to error_log for debugging.
     */
    private static function humanizeProviderError(string $raw): string
    {
        // Sanitize: strip API keys / access tokens that may appear in URLs.
        $msg = preg_replace(
            '/([?&])(?:key|api[_-]?key|access_token|x-api-key)=[^&\s"]+/i',
            '$1[REDACTED]=…',
            $raw
        ) ?? $raw;

        // Model server offline: the provider's gateway is reachable but has no
        // backend to serve the model (e.g. self-hosted model host down / not
        // loaded). Distinct from transient overload — retrying right away rarely
        // helps, so we tell the user it's likely down rather than busy. Must be
        // checked BEFORE the generic 5xx branch (this is usually a 503 too).
        if (preg_match('/no (available|healthy) (server|upstream|model|worker|backend|instance)|no (server|model|backend|worker) available|model (is )?not (loaded|available|ready)|upstream connect error/i', $msg)) {
            return "🚫 This model's server is currently offline — the provider's gateway responded but has no backend available to serve the model right now. This usually isn't temporary: try again later, or switch to a different provider in the picker above.";
        }
        // Provider overloaded (5xx).
        if (preg_match('/\b(50[023]|52[39])\b|Service Unavailable|currently experiencing high demand|overloaded|temporarily unavailable/i', $msg)) {
            return "⏳ The model provider is temporarily overloaded. Please try again in a moment, or switch to a different provider in the picker above.";
        }
        // Rate limit (429).
        if (preg_match('/\b429\b|rate.?limit/i', $msg)) {
            return "⏳ Rate limit reached for this provider. Please wait a moment before trying again, or switch providers.";
        }
        // Authentication.
        if (preg_match('/\b401\b|invalid.?api.?key|authentication.?failed|unauthorized/i', $msg)) {
            return "🔑 Authentication failed for this provider. Check the API key in your settings.";
        }
        // Context window / token limit.
        if (preg_match('/context.{0,20}length|context.?window|token.{0,20}(exceed|limit)|prompt.?too.?long/i', $msg)) {
            return "📏 The input is too large for this model's context window. Try shortening the conversation, removing attachments, or switching to a model with a larger context.";
        }
        // Quota / billing.
        if (preg_match('/quota|billing|credit balance|insufficient.?credit|payment.?required/i', $msg)) {
            return "💳 The provider rejected the request for billing reasons (quota or credits). Check your provider account, then retry.";
        }
        // Network / timeout / connection.
        if (preg_match('/connection.?refused|connection.?reset|timed.?out|timeout|network.?unreachable|could not resolve/i', $msg)) {
            return "🌐 Couldn't reach the provider. Check your network and try again, or switch providers.";
        }

        // Default fallback: cap length so the chat bubble doesn't render
        // a 5 KB stack trace.
        if (mb_strlen($msg) > 400) {
            return mb_substr($msg, 0, 380) . '… (full error in server log)';
        }
        return $msg;
    }

    /**
     * Strip <svg>...</svg> blocks from each historical message's content
     * before forwarding to providers. SVG path data is pure token noise
     * to the LLM — the user-facing copies (UI render, dataset.rawContent,
     * DB record) keep the original markup, only this in-flight view is
     * trimmed. Done at the gateway so every provider, the verifier flow,
     * and the compare-pane all see the same cleaned history.
     */
    private static function stripVisualNoiseFromHistory(array $history): array
    {
        foreach ($history as &$msg) {
            if (isset($msg['content']) && is_string($msg['content'])) {
                $msg['content'] = preg_replace(
                    '#<svg\b[^>]*>.*?</svg>#is',
                    '[SVG illustration omitted]',
                    $msg['content']
                ) ?? $msg['content'];
            }
        }
        return $history;
    }

    /**
     * Validate the skill_metadata payload from the request body. Returns
     * a clean array { dir_name, scripts } or null when the payload is
     * missing, malformed, or empty (no executable scripts to expose). The
     * frontend already filters the no-scripts case but we re-check
     * server-side because the tool definition is meaningless without an
     * enum of script paths.
     */
    private static function sanitizeSkillMetadata($raw): ?array
    {
        if (!is_array($raw)) return null;
        $dirName = isset($raw['dir_name']) && is_string($raw['dir_name'])
            ? trim($raw['dir_name'])
            : '';
        if ($dirName === '') return null;
        // Same shape rules as sanitizeAvailableSkills: identifier-ish
        // segments, optionally slash-joined for group-folder skills.
        if (strlen($dirName) > 128) return null;
        if (!preg_match('/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/', $dirName)) return null;
        if (str_contains($dirName, '..')) return null;

        $scripts = [];
        if (isset($raw['scripts']) && is_array($raw['scripts'])) {
            foreach ($raw['scripts'] as $s) {
                if (!is_string($s)) continue;
                $s = trim($s);
                // Reject path-traversal and absolute paths — scripts must
                // be skill-relative. The frontend listSkillScripts only
                // emits relative paths but a forged request could try.
                if ($s === '' || str_starts_with($s, '/') || str_contains($s, '..')) continue;
                $scripts[] = $s;
            }
        }
        if (empty($scripts)) return null;

        return [
            'dir_name' => $dirName,
            'scripts'  => array_values(array_unique($scripts)),
        ];
    }

    /**
     * Validate the available_skills payload from the request body. Returns
     * an array of clean skill records [{dir_name, description, scripts}, ...]
     * or [] when missing/malformed. Used by the multi-skill auto-routing
     * path: the LLM is shown all available skills + their descriptions and
     * picks one based on the user's prompt and attachments.
     */
    private static function sanitizeAvailableSkills($raw): array
    {
        if (!is_array($raw)) return [];
        $out = [];
        $seen = [];
        foreach ($raw as $entry) {
            if (!is_array($entry)) continue;
            $dirName = isset($entry['dir_name']) && is_string($entry['dir_name'])
                ? trim($entry['dir_name'])
                : '';
            if ($dirName === '' || isset($seen[$dirName])) continue;
            // dir_name sanity: one or more identifier-ish segments separated
            // by single forward slashes. Allows group-folder skills like
            // 'GEO/geo-audit' or 'SEO/geo-technical' while still rejecting
            // path-traversal ('..'), absolute paths (leading /), and bad
            // chars. Length cap raised to 128 to accommodate group prefixes.
            if (strlen($dirName) > 128) continue;
            if (!preg_match('/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/', $dirName)) continue;
            if (str_contains($dirName, '..')) continue;

            $description = isset($entry['description']) && is_string($entry['description'])
                ? trim($entry['description'])
                : '';

            $scripts = [];
            if (isset($entry['scripts']) && is_array($entry['scripts'])) {
                foreach ($entry['scripts'] as $s) {
                    if (!is_string($s)) continue;
                    $s = trim($s);
                    if ($s === '' || str_starts_with($s, '/') || str_contains($s, '..')) continue;
                    $scripts[] = $s;
                }
            }
            $scripts = array_values(array_unique($scripts));
            if (empty($scripts)) continue;

            $seen[$dirName] = true;
            $out[] = [
                'dir_name'    => $dirName,
                'description' => $description,
                'scripts'     => $scripts,
            ];
        }
        return $out;
    }

    /**
     * Sanitize the per-request client_tools field. Frontend may attach tools
     * discovered from the active tab's webMCP registry. Each accepted entry
     * is a {name, description, input_schema} triple. Names must begin with
     * 'webmcp_' so the frontend dispatcher (chat.js) can route them.
     *
     * Filter, don't throw — one malformed tool should not kill the whole
     * chat turn. error_log dropped entries for diagnostics.
     *
     * @param mixed $raw  Untrusted input from the request body
     * @return array<array{name:string,description:string,input_schema:array}>
     */
    private static function sanitizeClientTools($raw): array
    {
        if (!is_array($raw)) return [];
        $out = [];
        foreach ($raw as $i => $entry) {
            if (!is_array($entry)) {
                error_log("[ChatController] client_tools[$i] dropped: not an object");
                continue;
            }
            $name = $entry['name'] ?? null;
            if (!is_string($name)
                || $name === ''
                || !preg_match('/^webmcp_[a-zA-Z0-9_\-\.]{1,120}$/', $name)) {
                error_log("[ChatController] client_tools[$i] dropped: invalid name " . var_export($name, true));
                continue;
            }
            $description = $entry['description'] ?? '';
            if (!is_string($description)) $description = '';
            if (strlen($description) > 2048) $description = substr($description, 0, 2048);
            $inputSchema = $entry['input_schema'] ?? null;
            if (!is_array($inputSchema)) {
                error_log("[ChatController] client_tools[$i] dropped: input_schema not an array");
                continue;
            }
            $inputSchema = self::coerceJsonSchemaObjects($inputSchema);
            $out[] = [
                'name' => $name,
                'description' => $description,
                'input_schema' => $inputSchema,
            ];
        }
        return $out;
    }

    /**
     * Walk a decoded JSON-Schema and coerce empty maps that MUST serialize
     * as JSON objects (not arrays) back into stdClass. PHP's json_decode
     * with assoc=true turns BOTH empty {} and empty [] into [], which then
     * re-encodes as [] — invalid for fields like `properties`, `patternProperties`,
     * `definitions`, `$defs`, and a few others. Anthropic's API in particular
     * rejects `properties: []` with `Input should be an object`.
     *
     * Recursive so nested schemas (e.g. items.properties or
     * properties.foo.properties) are also fixed.
     */
    private static function coerceJsonSchemaObjects(array $schema): array
    {
        static $objectFields = ['properties', 'patternProperties', 'definitions', '$defs'];
        foreach ($schema as $key => $value) {
            if (in_array($key, $objectFields, true) && is_array($value)) {
                if (empty($value)) {
                    $schema[$key] = new \stdClass();
                } else {
                    // Recurse into each sub-schema under properties.foo, definitions.foo, etc.
                    foreach ($value as $subKey => $subSchema) {
                        if (is_array($subSchema)) {
                            $value[$subKey] = self::coerceJsonSchemaObjects($subSchema);
                        }
                    }
                    $schema[$key] = $value;
                }
            } elseif (is_array($value)) {
                $schema[$key] = self::coerceJsonSchemaObjects($value);
            }
        }
        return $schema;
    }

    /**
     * Build the JSON-Schema tool definition for run_skill_script. Shape
     * matches MCPToolsLoader::getToolDefinitions() so providers consume it
     * via the same code path. The `script` field is enum-constrained to
     * the known script list — keeps the LLM from inventing paths and the
     * frontend dispatcher from having to validate after the fact.
     */
    private static function buildRunSkillScriptTool(array $metadata): array
    {
        $dirName = $metadata['dir_name'];
        $scripts = $metadata['scripts'];

        $description = "Execute one of the Python scripts bundled with the active skill \"{$dirName}\". "
            . "This tool IS available to you and you should call it whenever the user's "
            . "request maps to one of the skill's scripts — do not attempt the transformation "
            . "manually if a script can do it. Available scripts: "
            . implode(', ', $scripts) . ".\n\n"
            . "RUNTIME CONTRACT:\n"
            . "• ATTACHMENTS — any document(s) the user attached are pre-written to "
            . "/scratch/<original-filename>. Reference them by that absolute path in argv "
            . "(e.g. after -i/--input). DO NOT pass attachment contents in input_files; that "
            . "wastes output tokens.\n"
            . "• INPUT FILES YOU AUTHOR INLINE — when a script needs synthesized input you "
            . "compose yourself (a JSON spec, a complete HTML document, an ops file, etc.), "
            . "put the content in input_files under a /scratch/<name>.<ext> key, then "
            . "reference that path from argv. The exact format and extension required vary by "
            . "skill — **read the skill's body (provided as system context) to learn the "
            . "contract**. Do not assume create-style scripts always take JSON: some expect a "
            . "full HTML/MD document, some a JSON spec, some a CSV. The skill's docs are "
            . "authoritative.\n"
            . "  ‼ VALUE SHAPE — each input_files value MUST be the file body as a plain string. "
            . "Do NOT wrap it as {<path>: <content>} (that produces a JSON object as the file "
            . "content, which the script will write back out verbatim and the artifact pane "
            . "will display as broken JSON instead of HTML). For an HTML file write the literal "
            . "characters of the document starting with <!DOCTYPE html>; for a JSON spec write "
            . "the JSON object the script's contract specifies. The /scratch/ path is the OUTER "
            . "input_files key only — never repeat it inside the value.\n"
            . "• OUTPUT — files MUST be written to absolute paths under /outputs/ (passed via "
            . "-o or equivalent in argv) AND listed in read_outputs so the runner returns them.\n"
            . "• FILENAME — when transforming an attached document, keep the original basename "
            . "and extension; the output lives in /outputs/, no '-formatted' suffix needed.";

        // Build as stdClass-friendly nested arrays; ChatController already
        // hands tool schemas to providers untouched, and providers do their
        // own {} vs [] normalization downstream (see Claude/OpenAI traits).
        return [
            'name' => 'run_skill_script',
            'description' => $description,
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'script' => [
                        'type' => 'string',
                        'description' => 'Path to the script within the skill folder. Must be one of the listed scripts.',
                        'enum' => $scripts,
                    ],
                    'argv' => [
                        'type' => 'array',
                        'description' => 'Command-line arguments passed to the script (sys.argv[1:]). Output paths (e.g. -o, --output) MUST start with /outputs/ — that is where generated documents are persisted to the user filesystem.',
                        'items' => ['type' => 'string'],
                    ],
                    'input_files' => [
                        'type' => 'object',
                        'description' =>
                            'Map of absolute path → file CONTENT to stage before the script '
                            . 'runs. Use this for files YOU author inline (JSON specs, HTML '
                            . 'documents, CSVs). The user\'s attachments are already at '
                            . '/scratch/<filename>; do NOT re-pass their contents here.\n\n'
                            . 'EACH VALUE IS A PLAIN STRING — the literal file body. Start an '
                            . 'HTML value with `<!DOCTYPE html>` and emit the document character '
                            . 'by character. DO NOT wrap the body in a JSON object that repeats '
                            . 'the path — that pattern roughly DOUBLES the output tokens you '
                            . 'spend (every `"` becomes `\\"`, every newline becomes `\\n`, plus '
                            . 'the duplicated path key) AND the artifact pane will display the '
                            . 'wrap as broken JSON instead of your HTML. The lean form costs '
                            . 'you less time and produces the right output.\n\n'
                            . 'Example for a 2-byte HTML file:\n'
                            . '  CORRECT (efficient): {"/scratch/foo.html": "<!DOCTYPE html><html><body>Hi</body></html>"}\n'
                            . '  WRONG (wasteful):    {"/scratch/foo.html": "{\\"/scratch/foo.html\\": \\"<!DOCTYPE html><html><body>Hi</body></html>\\"}"}',
                        'additionalProperties' => ['type' => 'string'],
                    ],
                    'read_outputs' => [
                        'type' => 'array',
                        'description' => 'Paths whose contents should be returned to you after the script finishes. Use absolute /outputs/<filename> for files the script wrote to the outputs folder; skill-relative paths still work for files inside the skill mount. NOTE: when an output is an HTML or Markdown document, it is shown to the user in a separate artifact pane and the file content in the tool_result will be replaced with a short placeholder — do not quote, restate, or attempt to re-read the file in that case. Summarize what the script did from stdout/stderr instead.',
                        'items' => ['type' => 'string'],
                    ],
                ],
                'required' => ['script'],
            ],
        ];
    }

    /**
     * Build the JSON-Schema tool definition for the `Task` tool.
     *
     * Name and parameters intentionally mirror Claude Code's Task tool so
     * upstream skill content (e.g. `Task({ subagent_type: "grader", ... })`)
     * ports verbatim. Execution is client-side — see
     * ClientSideToolsTrait::getClientSideToolNames() and
     * chat.js::dispatchClientToolCall. The frontend reads
     * skills/<active>/agents/<subagent_type>.md and POSTs to
     * /api/v1/agent with that as the system prompt.
     */
    private static function buildTaskTool(): array
    {
        return [
            'name' => 'Task',
            'description' =>
                "Spawn an isolated single-shot subagent. The subagent runs in a fresh "
                . "context with no tools, no prior conversation history, and the agent file "
                . "`agents/<subagent_type>.md` from the active skill as its system prompt. "
                . "Returns the subagent's text response as the tool_result.\n\n"
                . "Use this for grading, comparing, analyzing, or any other task that needs "
                . "an independent LLM judgment without polluting the current conversation. "
                . "The subagent has access only to what you pass in `prompt` — load any "
                . "context the subagent needs into that string. The `subagent_type` must "
                . "match the basename (without .md) of a file in the active skill's "
                . "`agents/` folder.",
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'description' => [
                        'type' => 'string',
                        'description' => 'A short (3-5 word) description of the task, for telemetry. Not seen by the subagent.',
                    ],
                    'subagent_type' => [
                        'type' => 'string',
                        'description' => 'Basename (no .md) of an agent file in the active skill\'s agents/ folder. Example: "grader" loads agents/grader.md as the subagent\'s system prompt.',
                    ],
                    'prompt' => [
                        'type' => 'string',
                        'description' => 'The work the subagent should do. Include any context, data, or instructions the subagent needs — it has no other access.',
                    ],
                    'model' => [
                        'type' => 'string',
                        'description' => 'Optional model override for the subagent. Defaults to the active provider\'s configured model. Only meaningful when paired with a `provider` that knows the model name.',
                    ],
                    'provider' => [
                        'type' => 'string',
                        'enum' => ['claude', 'openai', 'grok', 'gemini', 'deepseek', 'kimi'],
                        'description' => 'Optional provider override for the subagent. Useful for cost-routing — e.g. spawn a deepseek subagent to do bulk grading at ~10× lower cost than claude. Defaults to the same provider as the primary chat.',
                    ],
                ],
                'required' => ['description', 'subagent_type', 'prompt'],
            ],
        ];
    }

    /**
     * Build the multi-skill version of run_skill_script for auto-routing.
     * The model is shown all available skills' descriptions, picks one via
     * the dir_name enum, then chooses a script from that skill's list. No
     * tool_choice forcing — the model decides whether to call any skill at
     * all based on intent (matching how MCP tools work).
     *
     * The script field is a free string here (not enum) because JSON Schema
     * can't easily express "if dir_name is X, script must be in [...]".
     * The frontend dispatcher validates the (dir_name, script) pair against
     * the actual skill's scripts at run time — invalid combinations fail
     * with a clear error rather than silently mis-routing.
     */
    private static function buildMultiSkillTool(array $skills): array
    {
        $dirNames = array_values(array_unique(array_map(fn($s) => $s['dir_name'], $skills)));

        $catalogLines = ["Available skills (pick the dir_name whose description best matches what the user is asking for):"];
        foreach ($skills as $s) {
            $desc = $s['description'] !== '' ? $s['description'] : '(no description)';
            $scriptsCsv = implode(', ', $s['scripts']);
            $catalogLines[] = "  • {$s['dir_name']} — {$desc} | scripts: {$scriptsCsv}";
        }
        $catalog = implode("\n", $catalogLines);

        // The description is intentionally skill-agnostic — it works for any
        // set of skills the user has installed, present or future. Routing
        // signal is the catalog above (each skill's own description); the
        // contract rules below apply to ALL folder-backed skills uniformly.
        $description = "Execute a Python script bundled with one of the available folder-backed skills. "
            . "Each skill in the catalog below produces a specific file deliverable.\n\n"
            . "PROGRESSIVE-DISCLOSURE PROTOCOL — MUST follow:\n"
            . "Before calling run_skill_script, you MUST first call `discover_skill` with the "
            . "dir_name you intend to use. discover_skill returns the full SKILL.md body for "
            . "that skill — including the input-file contract (JSON spec? complete HTML? CSV?), "
            . "the example tool-call shape, and any skill-specific rules. The catalog below "
            . "gives you only enough to pick a skill; the body tells you HOW to call it. "
            . "Skipping discover_skill leads to malformed run_skill_script calls because the "
            . "input shape varies by skill (some expect a JSON spec, some expect a complete "
            . "HTML document inline, some expect a CSV) and you cannot reliably guess.\n\n"
            . "WHEN TO CALL run_skill_script — non-negotiable rule:\n"
            . "If the user is asking you to PRODUCE, GENERATE, CREATE, MAKE, BUILD, EDIT, or "
            . "DELIVER a file in any of the formats listed in the catalog (HTML pages, Word docs, "
            . "spreadsheets, presentations, etc.), you MUST call this tool. Do NOT inline file "
            . "content in your text response — your text reply should be a short narration of "
            . "what you produced. The tool writes the file to /outputs/ where the user previews "
            . "it; an inline response gives the user nothing they can save or open.\n\n"
            . "WHEN NOT TO CALL — narrow exceptions:\n"
            . "Skip the tool only when the user is asking a question, having a discussion, "
            . "summarizing/analyzing an attached document (the converter already gave you its "
            . "text — read it directly and respond in chat), or making a request that genuinely "
            . "doesn't map to any listed skill. NOTE: \"use the attachment as a template / style "
            . "reference\" is NOT an exception — it's the core use case for create-style scripts. "
            . "Author the new file inline as the script's input and call the tool; the skill "
            . "produces the deliverable file.\n\n"
            . "URL ARGUMENTS — YOU DO NOT NEED NETWORK ACCESS:\n"
            . "If a script accepts a URL in argv (e.g. an audit/scraper skill), the runner's "
            . "bridge pre-fetches that URL server-side via the user's own backend BEFORE the "
            . "script runs. You — the LLM — never need to download anything. Pass the URL "
            . "verbatim in argv as if it were a local file path; the bridge replaces it with the "
            . "local path of the downloaded HTML and appends --source <original-url>. "
            . "Consequences: localhost, 127.0.0.1, intranet URLs, and any URL the user can reach "
            . "from their own machine all work — because the fetch runs on the user's machine, "
            . "not yours. NEVER refuse a URL-based task with phrases like 'I cannot access "
            . "localhost' or 'I don't have network access' — those refusals are wrong and "
            . "forbidden. Call the tool with the URL in argv; if the bridge can't reach the URL "
            . "(auth-walled etc.) you will get a clear [bridge] error in the tool_result, which "
            . "is the only legitimate moment to surface a failure.\n\n"
            . $catalog . "\n\n"
            . "RUNTIME CONTRACT (applies to every skill):\n"
            . "• ATTACHMENTS — any document(s) the user attached are pre-written to "
            . "/scratch/<original-filename>. Reference them by that absolute path in argv "
            . "(e.g. after -i/--input). DO NOT pass attachment contents in input_files; that "
            . "wastes output tokens.\n"
            . "• INPUT FILES YOU AUTHOR INLINE — the exact shape (JSON spec vs full HTML "
            . "document vs CSV) is determined by the skill — read the body returned by "
            . "discover_skill before guessing.\n"
            . "• OUTPUT — files MUST be written to absolute paths under /outputs/ (passed via "
            . "-o or equivalent in argv) AND listed in read_outputs so the runner returns them.\n"
            . "• FILENAME — when transforming an attached document, keep the original basename "
            . "and extension; the output lives in /outputs/, no '-formatted' suffix needed.";

        return [
            'name' => 'run_skill_script',
            'description' => $description,
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'dir_name' => [
                        'type' => 'string',
                        'description' => "Which skill to invoke. Pick based on the user's intent and the skill descriptions in the tool description.",
                        'enum' => $dirNames,
                    ],
                    'script' => [
                        'type' => 'string',
                        'description' => "Path to the script within the chosen skill (e.g. 'scripts/create.py'). Must be one of the scripts listed for the skill you picked in dir_name.",
                    ],
                    'argv' => [
                        'type' => 'array',
                        'description' => 'Command-line arguments passed to the script (sys.argv[1:]). Output paths MUST start with /outputs/.',
                        'items' => ['type' => 'string'],
                    ],
                    'input_files' => [
                        'type' => 'object',
                        'description' => "Map of absolute path → file contents (string) to stage in the script's filesystem before it runs. Use this for SMALL FILES YOU AUTHOR INLINE — typically the JSON spec for create-style scripts and the ops JSON for edit-style scripts. Common pattern: pass `/scratch/spec.json` or `/scratch/ops.json` here, then reference that path from argv (e.g. `--ops /scratch/ops.json` or `-i /scratch/spec.json`). DO NOT put user-attached document contents here — those are already pre-written to /scratch/<filename> by the runner. Leave empty when the script doesn't need any synthesized inputs.",
                        'additionalProperties' => ['type' => 'string'],
                    ],
                    'read_outputs' => [
                        'type' => 'array',
                        'description' => 'Paths whose contents should be returned after the script finishes. Use absolute /outputs/<filename>. NOTE: HTML/Markdown outputs are rendered in a separate artifact pane and the tool_result content is replaced with a placeholder — summarize what the script did from stdout/stderr in that case.',
                        'items' => ['type' => 'string'],
                    ],
                ],
                'required' => ['dir_name', 'script'],
            ],
        ];
    }

    /**
     * Build the discover_skill tool — Anthropic's progressive-disclosure
     * pattern as a client-side tool call. Claude calls discover_skill with
     * a dir_name; the frontend looks up the skill's full SKILL.md body
     * (already loaded into window.skillsManager.skills by loadLocalSkills)
     * and returns it as a tool_result. Claude then has the same context
     * the chip-dragged path provides via skill_content, and can construct
     * the run_skill_script call with the correct shape.
     *
     * Without this, auto-routing only sees the frontmatter description in
     * the catalog and has to guess the input contract — which fails when
     * skills don't follow the same convention (e.g. one create.py expects
     * a JSON spec, another expects a complete HTML document).
     */
    private static function buildDiscoverSkillTool(array $skills): array
    {
        $dirNames = array_values(array_unique(array_map(fn($s) => $s['dir_name'], $skills)));
        return [
            'name' => 'discover_skill',
            'description' => "Load the full SKILL.md body for a folder-backed skill. Call this "
                . "BEFORE run_skill_script the first time you intend to use a skill on a turn. "
                . "Returns the skill's complete contract: the input-file shape it expects "
                . "(JSON spec / complete HTML document / CSV / etc.), the canonical "
                . "tool-call example, decision rules for when to use which script, and any "
                . "skill-specific behavior. The catalog in run_skill_script's description "
                . "tells you WHICH skill to pick; this tool tells you HOW to call it. "
                . "Cheap and local — the body is already loaded in the browser, no network "
                . "round-trip. Skip this only if you have already received the body for the "
                . "same dir_name in this conversation.",
            'input_schema' => [
                'type' => 'object',
                'properties' => [
                    'dir_name' => [
                        'type' => 'string',
                        'description' => "The skill whose body to load. Must match a dir_name "
                            . "from the run_skill_script catalog.",
                        'enum' => $dirNames,
                    ],
                ],
                'required' => ['dir_name'],
            ],
        ];
    }

    /**
     * Main chat endpoint
     *
     * This method handles the streaming nature directly because SSE requires
     * control over output buffering and headers that can't be abstracted.
     */
    public function chat(array $request): array
    {
        $input = $request['body'];

        // App-key auth is scope-gated: an `ak_` key must explicitly carry the
        // `chat` scope to use this endpoint. JWT users and per-user `uak_` keys
        // (auth_type !== 'app_key') are unrestricted and skip this check.
        if (($request['auth_type'] ?? null) === 'app_key') {
            $scopes = $request['app_key_scopes'] ?? [];
            if (!in_array('chat', $scopes, true)) {
                return [
                    'success' => false,
                    'error' => 'App key not authorized for chat (missing scope "chat")',
                    'status_code' => 403,
                ];
            }
        }

        $message = $input['message'] ?? '';
        $conversationHistory = self::stripVisualNoiseFromHistory($input['conversation_history'] ?? []);
        // Streaming is opt-in. The caller decides per request whether
        // it wants progressive UI; if it doesn't ask, it doesn't get a
        // stream. Default `false` enforces the rule that streaming is a
        // UX feature owned by the call site, not a transport-layer
        // default the backend silently provides. Skill / tool-arg /
        // structured-output turns must NOT pass `streaming: true` —
        // they have nothing to render progressively.
        $streaming = $input['streaming'] ?? false;
        $skillContent = isset($input['skill_content']) && is_string($input['skill_content'])
            ? trim($input['skill_content'])
            : '';

        // skill_metadata is sent by the frontend when a folder-backed skill
        // with executable Python scripts is EXPLICITLY ACTIVE (chip override).
        // Shape: { dir_name: 'html', scripts: ['scripts/create.py', ...] }.
        // When present we force tool_choice → run_skill_script so the model
        // commits to using that one skill.
        $skillMetadata = self::sanitizeSkillMetadata($input['skill_metadata'] ?? null);

        // available_skills is sent on every turn when the user has any
        // folder-backed local skills installed. The model is shown each
        // skill's description and picks one based on intent (matching how
        // MCP tools are routed). No tool_choice forcing — the model can
        // also choose NOT to call run_skill_script if the request doesn't
        // map to a skill.
        //
        // Shape: [{dir_name, description, scripts}, ...].
        // If skill_metadata is also set (chip override), it wins and the
        // multi-skill auto-routing path is skipped for this turn.
        $availableSkills = self::sanitizeAvailableSkills($input['available_skills'] ?? null);

        // Per-request client-side tools (e.g. webMCP tools from the active
        // browser tab). The frontend sends these so the LLM can call them.
        // The backend declares them to the LLM alongside built-in + MCP tools
        // and short-circuits dispatch via the existing client_tool_call SSE
        // event when one is picked.
        $clientTools = self::sanitizeClientTools($input['client_tools'] ?? null);
        $clientToolNames = array_column($clientTools, 'name');
        error_log("[ChatController] client_tools count: " . count($clientTools)
            . ($clientToolNames ? ' [' . implode(',', $clientToolNames) . ']' : ''));

        // DIAGNOSTIC: log what the frontend actually sent for skill routing.
        // When the auto-routing path silently disappears (controller logs
        // "No skill_metadata or available_skills" despite skills being
        // enabled in Settings), this tells us WHICH layer is at fault:
        //   - rawAvailableSkills empty → frontend never sent it
        //   - rawAvailableSkills populated, sanitized empty → sanitizer rejecting it
        //   - both populated → bug is downstream
        $rawAvail = $input['available_skills'] ?? null;
        error_log("[ChatController] skill routing input — "
            . "skill_metadata: " . (empty($input['skill_metadata']) ? 'null' : 'present')
            . " | available_skills raw: " . (is_array($rawAvail) ? "array(" . count($rawAvail) . ")" : gettype($rawAvail))
            . " | available_skills sanitized: " . count($availableSkills)
            . (count($availableSkills) > 0
                ? " [" . implode(',', array_map(fn($s) => $s['dir_name'], $availableSkills)) . "]"
                : '')
            . (is_array($rawAvail) && !empty($rawAvail) && count($availableSkills) === 0
                ? " | RAW SAMPLE: " . substr(json_encode($rawAvail[0] ?? null), 0, 200)
                : ''));

        // Debug: Log conversation history received from frontend (post-strip,
        // so SVG blobs don't bloat the log).
        error_log("[ChatController] Received conversation_history count: " . count($conversationHistory));
        if (!empty($conversationHistory)) {
            error_log("[ChatController] First history entry: " . json_encode($conversationHistory[0] ?? 'none'));
            error_log("[ChatController] Last history entry: " . json_encode(end($conversationHistory) ?: 'none'));
        }
        $userId = (string)($input['user_id'] ?? $request['user_id'] ?? 'demo-user');
        $provider = $input['provider'] ?? null;

        // Debug: Log the provider being requested
        error_log("[ChatController] Provider from request: " . ($provider ?? 'null (will use default)'));

        // Verification parameters
        $verificationEnabled = $input['verification_enabled'] ?? false;
        $verifierProvider = $input['verifier_provider'] ?? null;

        // Compare parameters
        $compareEnabled = $input['compare_enabled'] ?? false;
        $compareProvider = $input['compare_provider'] ?? null;

        // Optional custom system prompt override. API-driven frontends (e.g. the
        // AI-Dialog app, where two models converse with each other) can supply
        // their own system prompt to replace the default portfolio-assistant
        // persona. When absent, providers fall back to the default prompt — so
        // this is fully backward-compatible with the main app, which never sends it.
        $systemPromptOverride = isset($input['system_prompt']) && is_string($input['system_prompt'])
            ? trim($input['system_prompt'])
            : null;
        if ($systemPromptOverride === '') {
            $systemPromptOverride = null;
        }

        // Optional 'memory' flag. Defaults to true → the user's frozen memory
        // (Hermes Layer 1) is injected into the system prompt as it is today.
        // API-driven callers (e.g. AI-Dialog) can send memory:false so the two
        // models converse without the user's personal memory leaking in. Absent
        // → true, so the main app is unaffected.
        $includeMemory = array_key_exists('memory', $input) ? (bool) $input['memory'] : true;

        // Tool filtering: optional array of tool names to use (null = all tools)
        $toolsFilter = $input['tools'] ?? null;
        if ($toolsFilter !== null && !is_array($toolsFilter)) {
            return [
                'success' => false,
                'error' => 'tools must be an array of tool names',
                'status_code' => 400
            ];
        }

        // Per-node overrides from the workflow agent form. When present they WIN over
        // the provider-config defaults (system_llm_settings). Null = use provider default.
        $maxTokensOverride = isset($input['max_tokens']) && is_numeric($input['max_tokens'])
            ? (int) $input['max_tokens'] : null;
        $temperatureOverride = isset($input['temperature']) && is_numeric($input['temperature'])
            ? (float) $input['temperature'] : null;

        // Attachment ids uploaded earlier via /chat/upload. Loaded here, text
        // is extracted (PDF via smalot/pdfparser, plain text read verbatim) and
        // prepended to the user message so every provider receives the document
        // content as part of the prompt. Native per-provider PDF/image dispatch
        // is a follow-up phase; this is the universal fallback that ships value
        // on day one.
        $attachmentIds = $input['attachment_ids'] ?? [];
        if (!is_array($attachmentIds)) $attachmentIds = [];
        $imageAttachments = [];
        $pdfAttachments = [];
        if (!empty($attachmentIds) && is_numeric($userId)) {
            try {
                $dispatcher = new AttachmentDispatcher($this->db);
                // Pass the active provider so the dispatcher can route PDFs to
                // native dispatch on Claude/Gemini and fall back to text
                // extraction elsewhere.
                //
                // skillModeActive: when a folder-backed skill is in play
                // (chip-dragged → skill_metadata; or auto-routing →
                // non-empty available_skills), the script reads the file
                // from /scratch/ directly. We tell the dispatcher to emit a
                // short reference instead of inlining the full text, saving
                // tens of thousands of input tokens per turn and giving the
                // model a clean signal to call the skill rather than to
                // respond inline against the duplicated source material.
                $skillModeActive = ($skillMetadata !== null) || !empty($availableSkills);
                $built = $dispatcher->buildPrefix($attachmentIds, (int) $userId, $provider, $skillModeActive);
                if ($built['prefix'] !== '') {
                    $message = $built['prefix'] . $message;
                }
                if (!empty($built['image_attachments'])) {
                    $imageAttachments = $built['image_attachments'];
                }
                if (!empty($built['pdf_attachments'])) {
                    $pdfAttachments = $built['pdf_attachments'];
                }
                if (!empty($built['notes'])) {
                    error_log('[ChatController] Attachment notes: ' . implode(' | ', $built['notes']));
                }
            } catch (Exception $e) {
                error_log('[ChatController] Attachment dispatch failed: ' . $e->getMessage());
            }
        }

        // Empty message is allowed for B3 client-tool continuations: the
        // frontend re-issues /chat with `message: ''` and the tool_result
        // already at the tail of conversation_history. Anything else with
        // an empty message is a client bug and we still 400.
        $isToolResultContinuation = $message === ''
            && !empty($conversationHistory)
            && (($conversationHistory[count($conversationHistory) - 1]['role'] ?? '') === 'tool');
        if (empty($message) && !$isToolResultContinuation) {
            return [
                'success' => false,
                'error' => 'Message is required',
                'status_code' => 400
            ];
        }

        // Check free trial quota
        $quotaCheck = $this->checkFreeTrialQuota($userId);
        if ($quotaCheck !== null) {
            return $quotaCheck;
        }

        // For streaming responses, we handle output directly
        if ($streaming) {
            return $this->handleStreamingChat(
                $message,
                $conversationHistory,
                $userId,
                $provider,
                $verificationEnabled,
                $verifierProvider,
                $compareEnabled,
                $compareProvider,
                $toolsFilter,
                $imageAttachments,
                $pdfAttachments,
                $skillContent,
                $skillMetadata,
                $availableSkills,
                $clientTools,
                $clientToolNames,
                $systemPromptOverride,
                $includeMemory
            );
        }

        // Non-streaming response
        return $this->handleRegularChat(
            $message,
            $conversationHistory,
            $userId,
            $provider,
            $toolsFilter,
            $imageAttachments,
            $pdfAttachments,
            $skillContent,
            $skillMetadata,
            $availableSkills,
            $clientTools,
            $clientToolNames,
            $systemPromptOverride,
            $includeMemory,
            $maxTokensOverride,
            $temperatureOverride
        );
    }

    /**
     * Single-pass LLM call: prompt in, text out. No tools, no history,
     * no streaming, no skill routing. Used by clients (e.g. the
     * skill-creator port) that just need "spawn an agent, get its
     * answer." Tools are forced off by passing `tools: []` to the
     * provider — see ClaudeProvider:174 and friends.
     */
    public function agent(array $request): array
    {
        $input = $request['body'];
        $prompt = trim((string)($input['prompt'] ?? ''));
        $provider = $input['provider'] ?? null;
        $model = isset($input['model']) ? trim((string)$input['model']) : '';
        $system = isset($input['system']) ? (string)$input['system'] : '';
        $userId = (string)($input['user_id'] ?? $request['user_id'] ?? 'demo-user');

        if ($prompt === '') {
            return ['success' => false, 'error' => 'prompt is required', 'status_code' => 400];
        }
        if (!$provider) {
            return ['success' => false, 'error' => 'provider is required', 'status_code' => 400];
        }

        $quotaCheck = $this->checkFreeTrialQuota($userId);
        if ($quotaCheck !== null) {
            return $quotaCheck;
        }

        $config = $this->applyDatabaseProviderSettings($this->config);
        $config = $this->applyPackageDefaults($config, $userId);
        $config = $this->applyUserApiKeys($config, $userId, $provider);
        $assistant = new AIPortfolioAssistant($config);

        try {
            $providerInstance = $assistant->getLLMManager()->getProvider($provider);
            if (!$providerInstance) {
                return ['success' => false, 'error' => "Provider '{$provider}' not available", 'status_code' => 400];
            }
            if ($model !== '' && method_exists($providerInstance, 'setModel')) {
                $providerInstance->setModel($model);
            }

            $options = [
                'provider' => $provider,
                'tools' => [],
                'user_id' => $userId,
            ];
            if ($system !== '') {
                $options['system_prompt'] = $system;
            }

            $result = $assistant->getLLMManager()->chat($prompt, [], $options);

            return [
                'success' => true,
                'text' => $result['text'] ?? '',
                'usage' => $result['usage'] ?? null,
                'provider' => $result['provider_used'] ?? $provider,
                'model' => $result['model'] ?? null,
            ];
        } catch (Exception $e) {
            error_log("[ChatController::agent] " . $e->getMessage());
            return [
                'success' => false,
                'error' => self::humanizeProviderError($e->getMessage()),
                'status_code' => 500,
            ];
        }
    }

    /**
     * On-demand verification of an already-completed assistant response.
     * Streams the verifier's output via SSE (verifier_chunk / verification_response / verification_complete).
     */
    public function verify(array $request): array
    {
        $input = $request['body'];
        $originalMessage = trim((string)($input['original_message'] ?? ''));
        $responseText = trim((string)($input['response_text'] ?? ''));
        $verifierProvider = $input['verifier_provider'] ?? null;
        $userId = (string)($input['user_id'] ?? $request['user_id'] ?? 'demo-user');

        if ($originalMessage === '' || $responseText === '' || !$verifierProvider) {
            return [
                'success' => false,
                'error' => 'original_message, response_text, and verifier_provider are required',
                'status_code' => 400,
            ];
        }

        $quotaCheck = $this->checkFreeTrialQuota($userId);
        if ($quotaCheck !== null) {
            return $quotaCheck;
        }

        $config = $this->applyDatabaseProviderSettings($this->config);
        $config = $this->applyPackageDefaults($config, $userId);
        $config = $this->applyUserApiKeys($config, $userId, $verifierProvider);
        $assistant = new AIPortfolioAssistant($config);

        $usageLogger = null;
        try {
            $usageLogger = new UsageLogger($this->db, true, $config['contexts_database'] ?? $config['database']);
        } catch (Exception $e) {
            error_log("[ChatController::verify] Usage logger unavailable: " . $e->getMessage());
        }

        header('Content-Type: text/event-stream');
        header('Cache-Control: no-cache');
        header('Connection: keep-alive');
        header('X-Accel-Buffering: no');
        if (function_exists('apache_setenv')) {
            @apache_setenv('no-gzip', '1');
        }
        @ini_set('zlib.output_compression', 'Off');
        while (ob_get_level()) {
            ob_end_flush();
        }
        ignore_user_abort(false);

        $sendEvent = function ($event, $data) {
            echo "event: {$event}\n";
            if (is_string($data)) {
                foreach (explode("\n", $data) as $line) {
                    echo "data: {$line}\n";
                }
            } else {
                echo "data: " . json_encode($data) . "\n";
            }
            echo "\n";
            flush();
            if (connection_aborted()) {
                throw new \RuntimeException('CLIENT_ABORTED');
            }
        };

        $startTime = microtime(true);

        try {
            $sendEvent('verification_start', ['verifier' => $verifierProvider]);

            $currentDate = date('Y-m-d');
            $currentDateTime = date('Y-m-d H:i:s T');
            $verificationPrompt = "You are a verification assistant. Your task is to analyze the following response for accuracy, completeness, and potential issues.\n\n"
                . "**Current Date:** {$currentDate} (Full timestamp: {$currentDateTime})\n\n"
                . "**Original Question:**\n{$originalMessage}\n\n"
                . "**Response to Verify:**\n{$responseText}\n\n"
                . "**Your Task:**\n"
                . "1. Check for factual accuracy (use the current date above as reference for time-sensitive information)\n"
                . "2. Identify any errors or omissions\n"
                . "3. Assess the quality of reasoning\n"
                . "4. Provide a brief verification summary\n\n"
                . "Be concise and focus on the most important points.";

            $verifierProviderInstance = $assistant->getLLMManager()->getProvider($verifierProvider);
            if (!$verifierProviderInstance) {
                throw new \RuntimeException("Verifier provider '{$verifierProvider}' not available");
            }

            // Load MCP tools and combine with base tools so the verifier can call external sources
            $mcpToolsLoader = null;
            $verifierTools = $assistant->getToolsManager()->getToolDefinitions();
            try {
                $mcpToolsLoader = new MCPToolsLoader($this->db);
                $mcpToolsLoader->loadToolsForUser($userId, $this->resolvePackageMcpAllowlist($userId));
                if ($mcpToolsLoader->hasTools()) {
                    $verifierTools = array_merge($verifierTools, $mcpToolsLoader->getToolDefinitions());
                    $combinedExecutor = new \Quantis\AIPortfolioAssistant\Services\CombinedToolsExecutor(
                        $assistant->getToolsManager(),
                        $mcpToolsLoader
                    );
                    if (method_exists($verifierProviderInstance, 'setFunctionExecutor')) {
                        $verifierProviderInstance->setFunctionExecutor($combinedExecutor);
                    }
                }
            } catch (Exception $e) {
                error_log("[ChatController::verify] MCP tools load failed: " . $e->getMessage());
            }

            $verifierSseClient = $this->createVerificationSSEClient($sendEvent);
            if (method_exists($verifierProviderInstance, 'setSSEClient')) {
                $verifierProviderInstance->setSSEClient($verifierSseClient);
            }

            $verifierResponse = $assistant->getLLMManager()->streamChat(
                $verificationPrompt,
                function ($chunk) use ($sendEvent) {
                    $sendEvent('verifier_chunk', $chunk);
                },
                [],
                [
                    'provider' => $verifierProvider,
                    'tools' => $verifierTools,
                ]
            );

            $sendEvent('verification_response', [
                'success' => true,
                'text' => $verifierResponse['text'] ?? '',
                'verifier' => $verifierProvider,
            ]);

            if ($usageLogger) {
                $u = $verifierResponse['usage'] ?? [];
                $usageLogger->logTransaction([
                    'user_id' => is_numeric($userId) ? (int) $userId : null,
                    'session_id' => uniqid('verify_', true),
                    'provider' => $verifierProvider,
                    'model' => $verifierResponse['model'] ?? 'unknown',
                    'prompt_tokens' => $u['input_tokens'] ?? $u['prompt_tokens'] ?? 0,
                    'completion_tokens' => $u['output_tokens'] ?? $u['completion_tokens'] ?? 0,
                    'response_time_ms' => (int) ((microtime(true) - $startTime) * 1000),
                    'status' => 'success',
                    'function_calls_count' => $u['function_calls'] ?? 0,
                    'functions_called' => $verifierResponse['functions_called'] ?? null,
                    'mcp_calls_count' => $verifierResponse['mcp_calls_count'] ?? 0,
                    'mcp_tools_called' => $verifierResponse['mcp_tools_called'] ?? null,
                ]);
            }

            $sendEvent('verification_complete', ['status' => 'done']);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'CLIENT_ABORTED') {
                error_log("[ChatController::verify] Client aborted");
                return ['streaming' => true];
            }
            error_log("[ChatController::verify] Error: " . $e->getMessage());
            $sendEvent('verification_error', ['message' => self::humanizeProviderError($e->getMessage())]);
            $sendEvent('verification_complete', ['status' => 'error']);
        } catch (Exception $e) {
            error_log("[ChatController::verify] Error: " . $e->getMessage());
            $sendEvent('verification_error', ['message' => self::humanizeProviderError($e->getMessage())]);
            $sendEvent('verification_complete', ['status' => 'error']);
        }

        return ['streaming' => true];
    }

    /**
     * On-demand comparison: run the last user prompt against the selected compare
     * provider without invoking the primary LLM. Streams compare_* SSE events so
     * the existing compare pane handlers render the response unchanged.
     */
    public function compareOnly(array $request): array
    {
        $input = $request['body'];
        $message = trim((string)($input['message'] ?? ''));
        $conversationHistory = is_array($input['conversation_history'] ?? null)
            ? self::stripVisualNoiseFromHistory($input['conversation_history'])
            : [];
        $compareProvider = $input['compare_provider'] ?? null;
        $userId = (string)($input['user_id'] ?? $request['user_id'] ?? 'demo-user');

        // Mirror chat()'s skill/attachment context parsing so the comparer
        // gets the SAME inputs the primary does — so it can run the same
        // skill flow and produce a comparable artifact. Without these the
        // comparer was answering a degraded version of the prompt: no
        // SKILL.md in system prompt, no run_skill_script tool, no
        // attachment reference. The whole point of compare mode is
        // apples-to-apples evaluation, which requires the apples to look
        // the same on both sides.
        $skillContent = isset($input['skill_content']) && is_string($input['skill_content'])
            ? trim($input['skill_content'])
            : '';
        $skillMetadata = self::sanitizeSkillMetadata($input['skill_metadata'] ?? null);
        $availableSkills = self::sanitizeAvailableSkills($input['available_skills'] ?? null);

        // Allow empty `message` when the request is a tool-result
        // continuation: the frontend's compare-pane dispatcher posts an
        // empty message with the tool result tucked into the tail of
        // conversation_history (assistant tool_use turn → role:'tool'
        // turn). Without this exception, every compare-pane skill turn
        // would 400 after the tool runs (which is exactly the failure
        // that broke the 4-pane test).
        $hasToolResultTail = false;
        if (!empty($conversationHistory)) {
            $tail = end($conversationHistory);
            if (is_array($tail) && (($tail['role'] ?? '') === 'tool')) {
                $hasToolResultTail = true;
            }
        }
        if ((!$hasToolResultTail && $message === '') || !$compareProvider) {
            return [
                'success' => false,
                'error' => 'message and compare_provider are required',
                'status_code' => 400,
            ];
        }

        $quotaCheck = $this->checkFreeTrialQuota($userId);
        if ($quotaCheck !== null) {
            return $quotaCheck;
        }

        // Run attachments through AttachmentDispatcher with the SAME
        // skillModeActive flag chat() uses, so the comparer's user message
        // gets the same attachment treatment: short reference for skill-
        // sensitive providers (Grok/DeepSeek), full inline elsewhere.
        $attachmentIds = $input['attachment_ids'] ?? [];
        if (!is_array($attachmentIds)) $attachmentIds = [];
        $imageAttachments = [];
        $pdfAttachments = [];
        if (!empty($attachmentIds) && is_numeric($userId)) {
            try {
                $dispatcher = new AttachmentDispatcher($this->db);
                $skillModeActive = ($skillMetadata !== null) || !empty($availableSkills);
                $built = $dispatcher->buildPrefix($attachmentIds, (int) $userId, $compareProvider, $skillModeActive);
                if ($built['prefix'] !== '') {
                    $message = $built['prefix'] . $message;
                }
                if (!empty($built['image_attachments'])) {
                    $imageAttachments = $built['image_attachments'];
                }
                if (!empty($built['pdf_attachments'])) {
                    $pdfAttachments = $built['pdf_attachments'];
                }
                if (!empty($built['notes'])) {
                    error_log('[ChatController::compareOnly] Attachment notes: ' . implode(' | ', $built['notes']));
                }
            } catch (Exception $e) {
                error_log('[ChatController::compareOnly] Attachment dispatch failed: ' . $e->getMessage());
            }
        }

        $config = $this->applyDatabaseProviderSettings($this->config);
        $config = $this->applyPackageDefaults($config, $userId);
        $config = $this->applyUserApiKeys($config, $userId, $compareProvider);
        $assistant = new AIPortfolioAssistant($config);

        $usageLogger = null;
        try {
            $usageLogger = new UsageLogger($this->db, true, $config['contexts_database'] ?? $config['database']);
        } catch (Exception $e) {
            error_log("[ChatController::compareOnly] Usage logger unavailable: " . $e->getMessage());
        }

        header('Content-Type: text/event-stream');
        header('Cache-Control: no-cache');
        header('Connection: keep-alive');
        header('X-Accel-Buffering: no');
        if (function_exists('apache_setenv')) {
            @apache_setenv('no-gzip', '1');
        }
        @ini_set('zlib.output_compression', 'Off');
        while (ob_get_level()) {
            ob_end_flush();
        }
        ignore_user_abort(false);

        $sendEvent = function ($event, $data) {
            echo "event: {$event}\n";
            if (is_string($data)) {
                foreach (explode("\n", $data) as $line) {
                    echo "data: {$line}\n";
                }
            } else {
                echo "data: " . json_encode($data) . "\n";
            }
            echo "\n";
            flush();
            if (connection_aborted()) {
                throw new \RuntimeException('CLIENT_ABORTED');
            }
        };

        $startTime = microtime(true);

        try {
            $sendEvent('compare_start', ['comparer' => $compareProvider]);

            $compareProviderInstance = $assistant->getLLMManager()->getProvider($compareProvider);
            if (!$compareProviderInstance) {
                throw new \RuntimeException("Compare provider '{$compareProvider}' not available");
            }

            // Load MCP tools — needed for the no-skill and multi-skill
            // branches. Combined executor wires MCP tool calls through to
            // the provider when MCP is in scope.
            $mcpToolsLoader = null;
            try {
                $mcpToolsLoader = new MCPToolsLoader($this->db);
                $mcpToolsLoader->loadToolsForUser($userId, $this->resolvePackageMcpAllowlist($userId));
                if ($mcpToolsLoader->hasTools()) {
                    $combinedExecutor = new CombinedToolsExecutor(
                        $assistant->getToolsManager(),
                        $mcpToolsLoader
                    );
                    if (method_exists($compareProviderInstance, 'setFunctionExecutor')) {
                        $compareProviderInstance->setFunctionExecutor($combinedExecutor);
                    }
                }
            } catch (Exception $e) {
                error_log("[ChatController::compareOnly] MCP tools load failed: " . $e->getMessage());
            }

            $compareSseClient = $this->createComparisonSSEClient($sendEvent);
            if (method_exists($compareProviderInstance, 'setSSEClient')) {
                $compareProviderInstance->setSSEClient($compareSseClient);
            }

            // Build the SAME options block chat()'s skill-routing logic
            // produces. The comparer needs to see the same tools,
            // skill_content, tool_choice forcing, and attachments as the
            // primary so the comparison is apples-to-apples.
            $options = ['provider' => $compareProvider];

            // Tool selection — single-skill / multi-skill / no-skill,
            // mirrored from handleStreamingChat.
            if ($skillMetadata !== null) {
                $skillTool = self::buildRunSkillScriptTool($skillMetadata);
                $taskTool = self::buildTaskTool();
                $options['tools'] = [$skillTool, $taskTool];
                $options['skill_metadata'] = $skillMetadata;

                $hasPriorRunSkillScript = false;
                foreach ($conversationHistory as $h) {
                    if (($h['role'] ?? '') === 'tool' && ($h['name'] ?? '') === 'run_skill_script') {
                        $hasPriorRunSkillScript = true; break;
                    }
                    if (($h['role'] ?? '') === 'assistant' && !empty($h['tool_calls'])) {
                        foreach ($h['tool_calls'] as $tc) {
                            $tcName = $tc['function']['name'] ?? $tc['name'] ?? '';
                            if ($tcName === 'run_skill_script') {
                                $hasPriorRunSkillScript = true; break 2;
                            }
                        }
                    }
                }

                if (!$hasPriorRunSkillScript) {
                    // Provider-conditional tool_choice form (same as primary
                    // path): bare 'required' for grok/deepseek (which
                    // silently ignore the specific-function form),
                    // specific-function for everyone else.
                    $compareProviderName = strtolower($compareProvider);
                    if (in_array($compareProviderName, ['grok', 'deepseek'], true)) {
                        $options['tool_choice'] = 'required';
                    } else {
                        $options['tool_choice'] = [
                            'type' => 'function',
                            'function' => ['name' => 'run_skill_script'],
                        ];
                    }
                }
            } elseif (!empty($availableSkills)) {
                $skillTool = self::buildMultiSkillTool($availableSkills);
                $discoverTool = self::buildDiscoverSkillTool($availableSkills);
                $tools = [$discoverTool, $skillTool];
                if ($mcpToolsLoader && $mcpToolsLoader->hasTools()) {
                    $tools = array_merge($tools, $mcpToolsLoader->getToolDefinitions());
                }
                $options['tools'] = $tools;
                $options['available_skills'] = $availableSkills;
            } else {
                $compareTools = $assistant->getToolsManager()->getToolDefinitions();
                if ($mcpToolsLoader && $mcpToolsLoader->hasTools()) {
                    $compareTools = array_merge($compareTools, $mcpToolsLoader->getToolDefinitions());
                }
                $options['tools'] = $compareTools;
            }

            // skill_content → appended to system prompt by the provider's
            // buildSystemPrompt (same channel that gives chip-dragged
            // turns their SKILL.md context).
            if ($skillContent !== '') {
                $options['skill_content'] = $skillContent;
            }

            // Native image / PDF attachments — providers embed these in
            // their message-construction path (Claude/Gemini have native
            // PDF support; others fell back to text in the prefix).
            if (!empty($imageAttachments)) {
                $options['image_attachments'] = $imageAttachments;
            }
            if (!empty($pdfAttachments)) {
                $options['pdf_attachments'] = $pdfAttachments;
            }

            error_log("🔧 [ChatController::compareOnly] Compare turn — provider: {$compareProvider}"
                . " | skill_metadata: " . ($skillMetadata ? $skillMetadata['dir_name'] : 'null')
                . " | available_skills: " . count($availableSkills)
                . " | tool_choice: " . json_encode($options['tool_choice'] ?? 'auto')
                . " | skill_content_len: " . mb_strlen($skillContent)
                . " | attachments: " . count($attachmentIds));

            // Honor the frontend's streaming preference. Frontend sends
            // streaming=true for compare-only-text (visible bubble, wants
            // progressive UX) and streaming=false for compare-skill
            // (hidden bubble, deliverable is a file).
            $useStreaming = $input['streaming'] ?? true;
            if ($useStreaming) {
                // Streaming path: streamChat fires the onChunk callback
                // which emits compare_chunk events the frontend bubble
                // listens to. Without this, providers whose chat() returns
                // the full response in one shot (Gemini) leave the
                // bubble stuck on a spinner because no chunks ever arrive.
                $compareResponse = $assistant->getLLMManager()->streamChat(
                    $message,
                    function ($chunk) use ($sendEvent) {
                        $sendEvent('compare_chunk', $chunk);
                    },
                    $conversationHistory,
                    $options
                );
            } else {
                // Non-streaming path: single response with reliable usage,
                // used when the bubble is hidden (compare-skill mode).
                $options['stream'] = false;
                $compareResponse = $assistant->getLLMManager()->chat(
                    $message,
                    $conversationHistory,
                    $options
                );
            }

            $sendEvent('compare_response', [
                'success' => true,
                'text' => $compareResponse['text'] ?? '',
                'comparer' => $compareProvider,
                'usage' => $compareResponse['usage'] ?? null,
            ]);

            if ($usageLogger) {
                $u = $compareResponse['usage'] ?? [];
                $usageLogger->logTransaction([
                    'user_id' => is_numeric($userId) ? (int) $userId : null,
                    'session_id' => uniqid('compare_', true),
                    'provider' => $compareProvider,
                    'model' => $compareResponse['model'] ?? 'unknown',
                    'prompt_tokens' => $u['input_tokens'] ?? $u['prompt_tokens'] ?? 0,
                    'completion_tokens' => $u['output_tokens'] ?? $u['completion_tokens'] ?? 0,
                    'response_time_ms' => (int) ((microtime(true) - $startTime) * 1000),
                    'status' => 'success',
                    'function_calls_count' => $u['function_calls'] ?? 0,
                    'functions_called' => $compareResponse['functions_called'] ?? null,
                    'mcp_calls_count' => $compareResponse['mcp_calls_count'] ?? 0,
                    'mcp_tools_called' => $compareResponse['mcp_tools_called'] ?? null,
                ]);
            }

            $sendEvent('compare_complete', ['status' => 'done']);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'CLIENT_ABORTED') {
                error_log("[ChatController::compareOnly] Client aborted");
                return ['streaming' => true];
            }
            error_log("[ChatController::compareOnly] Error: " . $e->getMessage());
            $sendEvent('compare_error', ['message' => self::humanizeProviderError($e->getMessage())]);
            $sendEvent('compare_complete', ['status' => 'error']);
        } catch (Exception $e) {
            error_log("[ChatController::compareOnly] Error: " . $e->getMessage());
            $sendEvent('compare_error', ['message' => self::humanizeProviderError($e->getMessage())]);
            $sendEvent('compare_complete', ['status' => 'error']);
        }

        return ['streaming' => true];
    }

    /**
     * Handle streaming chat with SSE
     *
     * Returns special response indicating streaming was handled
     */
    private function handleStreamingChat(
        string $message,
        array $conversationHistory,
        string $userId,
        ?string $provider,
        bool $verificationEnabled,
        ?string $verifierProvider,
        bool $compareEnabled,
        ?string $compareProvider,
        ?array $toolsFilter = null,
        array $imageAttachments = [],
        array $pdfAttachments = [],
        string $skillContent = '',
        ?array $skillMetadata = null,
        array $availableSkills = [],
        array $clientTools = [],
        array $clientToolNames = [],
        ?string $systemPromptOverride = null,
        bool $includeMemory = true
    ): array {
        // Increase execution time limit for large responses
        set_time_limit(600);

        // Debug: Log provider being used for streaming
        error_log("[ChatController] handleStreamingChat provider: " . ($provider ?? 'null'));

        // Apply database provider settings first (overrides hardcoded config)
        $config = $this->applyDatabaseProviderSettings($this->config);

        // Then the user's role-based package (sits below user overrides)
        $config = $this->applyPackageDefaults($config, $userId);

        // Then apply user's custom API keys (user keys override everything)
        $config = $this->applyUserApiKeys($config, $userId, $provider);
        $assistant = new AIPortfolioAssistant($config);

        // Initialize usage logger
        $usageLogger = null;
        try {
            $usageLogger = new UsageLogger($this->db, true, $config['contexts_database'] ?? $config['database']);
        } catch (Exception $e) {
            error_log("[ChatController] Usage logger unavailable: " . $e->getMessage());
        }

        // Register session_search (Hermes Layer 3) on the chat's ToolsManager.
        // Scoped to the current user via a closure capture; idempotent if the
        // request handler runs multiple executor setups. Fails silently when
        // the contexts_database isn't reachable — chat continues without the tool.
        if (is_numeric($userId)) {
            \AgentTeam\Services\SessionSearchService::registerAsTool(
                $assistant->getToolsManager(),
                (int) $userId,
                $config
            );
        }

        // Load MCP tools
        $mcpToolsLoader = null;
        try {
            error_log("[ChatController] Loading MCP tools for user: {$userId}");
            $mcpToolsLoader = new MCPToolsLoader($this->db);
            $mcpToolsLoader->loadToolsForUser($userId);
            error_log("[ChatController] MCP hasTools: " . ($mcpToolsLoader->hasTools() ? 'yes' : 'no'));

            if ($mcpToolsLoader->hasTools()) {
                $mcpTools = $mcpToolsLoader->getTools();
                error_log("[MCP] Loaded " . count($mcpTools) . " MCP tools for user: {$userId}");

                // Create combined executor with base tools + MCP tools
                $baseToolsManager = $assistant->getToolsManager();
                $combinedExecutor = new CombinedToolsExecutor($baseToolsManager, $mcpToolsLoader);

                // Wrap with FilteredToolsExecutor if tools filter is specified
                $executor = $combinedExecutor;
                if ($toolsFilter !== null && !empty($toolsFilter)) {
                    $filteredExecutor = new FilteredToolsExecutor($combinedExecutor);
                    $filteredExecutor->setAllowedTools($toolsFilter);
                    $executor = $filteredExecutor;
                    error_log("[ChatController] Tool filter applied: " . implode(', ', $toolsFilter));
                }

                // Set executor on all providers
                $llmManager = $assistant->getLLMManager();
                foreach ($this->getEnabledProviderKeys() as $providerName) {
                    $providerInstance = $llmManager->getProvider($providerName);
                    if ($providerInstance && method_exists($providerInstance, 'setFunctionExecutor')) {
                        $providerInstance->setFunctionExecutor($executor);
                    }
                }
            } elseif ($toolsFilter !== null && !empty($toolsFilter)) {
                // No MCP tools but filter is specified - filter base tools only
                $baseToolsManager = $assistant->getToolsManager();
                $filteredExecutor = new FilteredToolsExecutor($baseToolsManager);
                $filteredExecutor->setAllowedTools($toolsFilter);
                error_log("[ChatController] Tool filter applied (base tools only): " . implode(', ', $toolsFilter));

                $llmManager = $assistant->getLLMManager();
                foreach ($this->getEnabledProviderKeys() as $providerName) {
                    $providerInstance = $llmManager->getProvider($providerName);
                    if ($providerInstance && method_exists($providerInstance, 'setFunctionExecutor')) {
                        $providerInstance->setFunctionExecutor($filteredExecutor);
                    }
                }
            }
        } catch (Exception $e) {
            error_log("[MCP] Failed to load MCP tools: " . $e->getMessage());
        }

        // Track request start time
        $startTime = microtime(true);

        // Set SSE headers
        header('Content-Type: text/event-stream');
        header('Cache-Control: no-cache');
        header('Connection: keep-alive');
        header('X-Accel-Buffering: no');
        if (function_exists('apache_setenv')) {
            @apache_setenv('no-gzip', '1');
        }
        @ini_set('zlib.output_compression', 'Off');

        // Disable output buffering
        while (ob_get_level()) {
            ob_end_flush();
        }

        // Allow detection of client disconnect so we can abort upstream LLM calls
        // ignore_user_abort(false) = PHP will respect aborts; we check via connection_aborted()
        ignore_user_abort(false);

        // SSE event sender - detects client disconnect and throws to abort upstream LLM call
        $sendEvent = function($event, $data) {
            echo "event: {$event}\n";
            if (is_string($data)) {
                $lines = explode("\n", $data);
                foreach ($lines as $line) {
                    echo "data: {$line}\n";
                }
            } else {
                echo "data: " . json_encode($data) . "\n";
            }
            echo "\n";
            flush();

            // If the client disconnected, throw an exception that will propagate up
            // and cause the cURL streaming connection to the LLM provider to close
            if (connection_aborted()) {
                throw new \RuntimeException('CLIENT_ABORTED');
            }
        };

        try {
            // Generate session ID
            $sessionId = uniqid('chat_', true);

            // Make streaming chat request
            $options = $provider ? ['provider' => $provider] : [];

            // Debug: Log final options being sent
            error_log("[ChatController] streamChat options: " . json_encode($options));

            // Tool selection. The base case is "all available tools" —
            // MCP servers + run_skill_script when a skill is active. But
            // for B3 skill turns (folder-backed skill + scripts) we
            // suppress the MCP tools entirely: the user's intent is
            // self-contained ("transform this with skill X"), MCP tools
            // are noise, and 30+ tool definitions add ~6-12K input
            // tokens that the model has to read on every shot. Cutting
            // them roughly halves the per-turn latency for big-input
            // skill flows.
            if ($skillMetadata !== null) {
                $skillTool = self::buildRunSkillScriptTool($skillMetadata);
                $taskTool = self::buildTaskTool();
                $options['tools'] = [$skillTool, $taskTool];
                $options['skill_metadata'] = $skillMetadata;

                // Force tool use when this is unambiguously a skill turn:
                // a folder-backed skill is active AND no run_skill_script
                // result has happened yet in this conversation. Some
                // models (notably DeepSeek-v4) hallucinate "tool not
                // available" and bail to manual transformation; forcing
                // tool_choice eliminates that escape hatch. Once a
                // run_skill_script result exists in history (i.e. we're
                // on the third shot, summarizing the actual file the
                // script wrote), we revert to 'auto' so the model can
                // write text.
                //
                // discover_skill rounds DO NOT count as a prior tool
                // round here. discover_skill is just SKILL.md retrieval —
                // the real work hasn't happened yet, and turn 2 (after
                // discover) is precisely when we MUST force the
                // run_skill_script call. Counting it would break
                // auto-routing's chip-equivalence by reverting to 'auto'
                // exactly when the LLM most needs to be pinned down.
                $hasPriorRunSkillScript = false;
                foreach ($conversationHistory as $h) {
                    if (($h['role'] ?? '') === 'tool' && ($h['name'] ?? '') === 'run_skill_script') {
                        $hasPriorRunSkillScript = true; break;
                    }
                    if (($h['role'] ?? '') === 'assistant' && !empty($h['tool_calls'])) {
                        foreach ($h['tool_calls'] as $tc) {
                            $tcName = $tc['function']['name'] ?? $tc['name'] ?? '';
                            if ($tcName === 'run_skill_script') {
                                $hasPriorRunSkillScript = true; break 2;
                            }
                        }
                    }
                }

                if (!$hasPriorRunSkillScript) {
                    // Tool_choice forcing form depends on the provider's
                    // behaviour in OpenAI-compatible API land:
                    //
                    //   - Specific-function form ({type:'function',
                    //     function:{name}}): strictest, picks THIS tool.
                    //     Honored by Claude, OpenAI, Gemini.
                    //   - Bare string 'required': forces SOME tool call
                    //     but lets the model pick. Some OpenAI-compatible
                    //     providers (Grok, DeepSeek) honor 'required'
                    //     reliably while silently ignoring the specific-
                    //     function form — empirical observation, the
                    //     model just bails to text.
                    //
                    // In single-skill mode there's exactly ONE tool
                    // declared (run_skill_script with skill-specific
                    // schema), so 'required' is functionally equivalent
                    // to the specific-function form: the model has only
                    // one tool to pick. Using 'required' for the known-
                    // problematic providers gets us through their broken
                    // forcing logic while losing nothing.
                    $providerName = strtolower((string) ($options['provider'] ?? $provider ?? ''));
                    $useRequiredForm = in_array($providerName, ['grok', 'deepseek'], true);
                    if ($useRequiredForm) {
                        $options['tool_choice'] = 'required';
                    } else {
                        $options['tool_choice'] = [
                            'type' => 'function',
                            'function' => ['name' => 'run_skill_script'],
                        ];
                    }
                }

                error_log("🔧 [ChatController] Skill turn — only run_skill_script declared (MCP suppressed). Skill: "
                    . $skillMetadata['dir_name']
                    . " | tool_choice: " . json_encode($options['tool_choice'] ?? 'auto')
                    . " | hasPriorRunSkillScript: " . ($hasPriorRunSkillScript ? '1' : '0'));
            } elseif (!empty($availableSkills)) {
                // Phase 6 multi-skill auto-routing: the model sees a pair
                // of skill tools (discover_skill + run_skill_script) plus
                // the catalog of frontmatter descriptions in run_skill_script's
                // description. Progressive disclosure: the model picks a
                // dir_name from the catalog, calls discover_skill to load
                // the full SKILL.md body for that skill, then calls
                // run_skill_script with the correct shape derived from the
                // body. Without discover_skill the model has only the
                // frontmatter description and has to guess the input shape
                // — which fails for skills with non-standard contracts
                // (e.g. html/create.py expects a complete HTML document
                // inline, not the JSON spec convention used by other
                // create-style scripts).
                //
                // MCP tools coexist — the user might ask "search the web
                // AND make me a doc" and the model uses both.
                $skillTool = self::buildMultiSkillTool($availableSkills);
                $discoverTool = self::buildDiscoverSkillTool($availableSkills);
                $tools = [$discoverTool, $skillTool];
                if ($mcpToolsLoader && $mcpToolsLoader->hasTools()) {
                    $tools = array_merge($tools, $mcpToolsLoader->getToolDefinitions());
                }
                $options['tools'] = $tools;
                $options['available_skills'] = $availableSkills;

                // Narrow tool_choice forcing for the multi-skill path:
                // ONLY force run_skill_script when (a) this turn isn't a
                // tool-result continuation, (b) the user actually attached
                // a document on this turn, and (c) the prompt contains a
                // deliverable verb. The double-gate keeps casual chat,
                // analysis-of-attachments, and MCP-tool flows untouched
                // while still closing the "Claude inlines HTML when asked
                // to fix/edit/replace something in an attached doc"
                // failure mode that motivated the heuristic.
                $isContinuation = false;
                if (!empty($conversationHistory)) {
                    $last = $conversationHistory[count($conversationHistory) - 1] ?? null;
                    if (is_array($last) && ($last['role'] ?? '') === 'tool') {
                        $isContinuation = true;
                    }
                }
                // Attachment marker is the prefix the frontend's Phase 3
                // converter prepends to outgoingMessage before send.
                $hasAttachment = strpos(
                    $message,
                    '[The user attached the following document(s)'
                ) !== false;
                $promptTail = mb_substr($message, max(0, mb_strlen($message) - 600));
                $deliverableSignal = (bool) preg_match(
                    '/\b(create|generate|make|build|produce|edit|update|replace|fix|correct|swap|change|modify|revise)\b|in the (document|file)\b|attached (html|document|file)/i',
                    $promptTail
                );
                // Auto-routing: when conditions warrant a skill invocation,
                // force the FIRST tool call to be discover_skill rather than
                // run_skill_script. The flow is then guaranteed:
                //   1. Claude calls discover_skill(dir_name)
                //   2. Frontend returns SKILL.md body + promotes the skill
                //      to chip-equivalent in the follow-up request body
                //      (skill_content + skill_metadata)
                //   3. Backend's $skillMetadata branch fires on turn 2,
                //      forcing tool_choice to run_skill_script with the
                //      single-skill schema — identical to drag-and-drop
                //   4. Claude calls run_skill_script per the now-binding
                //      SKILL.md contract in the system prompt
                //
                // Forcing discover_skill (not run_skill_script) on turn 1
                // is what makes the auto-routing path produce the same
                // file as the chip-dragged path: it eliminates the
                // failure mode where Claude jumps straight to
                // run_skill_script with a guessed input shape.
                if (!$isContinuation && $hasAttachment && $deliverableSignal) {
                    $options['tool_choice'] = [
                        'type' => 'function',
                        'function' => ['name' => 'discover_skill'],
                    ];
                }

                error_log("🔧 [ChatController] Multi-skill auto-routing — "
                    . count($availableSkills) . " skill(s) declared alongside MCP tools. Skills: "
                    . implode(', ', array_map(fn($s) => $s['dir_name'], $availableSkills))
                    . " | tool_choice: " . json_encode($options['tool_choice'] ?? 'auto')
                    . " | hasAttachment: " . ($hasAttachment ? '1' : '0')
                    . " | deliverableSignal: " . ($deliverableSignal ? '1' : '0')
                    . " | isContinuation: " . ($isContinuation ? '1' : '0'));
            } else {
                if ($mcpToolsLoader && $mcpToolsLoader->hasTools()) {
                    $options['tools'] = $mcpToolsLoader->getToolDefinitions();
                }
                error_log("🔧 [ChatController] No skill_metadata or available_skills — not declaring run_skill_script.");
            }

            // Append user's frozen memory (Hermes Layer 1) to the system prompt.
            // Providers read options['memory_context'] and append it after their
            // default or custom system prompt. Skipped when the caller sends
            // memory:false (e.g. AI-Dialog, so personal memory doesn't leak in).
            if ($includeMemory && is_numeric($userId)) {
                $memBlock = \AgentTeam\Services\UserMemoryRepository::buildMemoryBlock($this->db, (int) $userId);
                if ($memBlock !== '') {
                    $options['memory_context'] = $memBlock;
                }
            }

            // Active Skill from the Skills Library (dragged onto prompt input)
            if ($skillContent !== '') {
                $options['skill_content'] = $skillContent;
            }

            // Custom system prompt override (API-driven callers, e.g. AI-Dialog).
            // Replaces the default persona; providers read options['system_prompt'].
            if ($systemPromptOverride !== null) {
                $options['system_prompt'] = $systemPromptOverride;
            }

            // Image attachments (base64 + mime). Providers embed in native shape.
            if (!empty($imageAttachments)) {
                $options['image_attachments'] = $imageAttachments;
            }

            // PDF attachments — only populated when the active provider can
            // ingest PDFs natively (Claude, Gemini). Other providers received
            // the document as text in the message prefix already.
            if (!empty($pdfAttachments)) {
                $options['pdf_attachments'] = $pdfAttachments;
            }

            // Client-side tools from the active browser tab (webMCP). Providers
            // (modified in Tasks 4-9) read these keys and call
            // setPerRequestClientSideToolNames() on themselves before the LLM call.
            $options['client_tools'] = $clientTools;
            $options['client_tool_names'] = $clientToolNames;

            $response = $assistant->streamChat($message, $sessionId, $userId, $conversationHistory, $options);

            // Calculate response time
            $responseTimeMs = (int) ((microtime(true) - $startTime) * 1000);

            // Send main response
            $responseData = [
                'success' => true,
                'text' => $response['text'],
                'usage' => $response['usage'] ?? [],
                'provider' => $response['provider_used'] ?? 'claude'
            ];

            // B3: when the LLM invoked a client-side tool, the provider
            // already emitted a `client_tool_call` SSE event from inside
            // its tool-use handler and short-circuited. Forward the flag
            // here so the frontend dispatcher knows to run the tool and
            // re-issue /chat with the tool_result prepended, rather than
            // closing out the assistant turn.
            if (!empty($response['pending_client_tool_call'])) {
                $responseData['pending_client_tool_call'] = true;
                $responseData['pending_tool_calls'] = $response['pending_tool_calls'] ?? [];
            }

            $sendEvent('response', $responseData);

            // B3: when the LLM short-circuited with a client-side tool call,
            // the assistant turn isn't actually finished — the frontend
            // will dispatch the tool and re-issue /chat. Verifier and
            // compare are turn-level concerns, so they run on the *real*
            // continuation, not on the empty placeholder text we just
            // emitted. Skip them and skip the 'complete' marker too —
            // the second-shot will emit its own.
            $isPendingClientTool = !empty($response['pending_client_tool_call']);

            // Phase 2: Verification
            if (!$isPendingClientTool && $verificationEnabled && $verifierProvider && $verifierProvider !== $provider) {
                $this->handleVerification(
                    $assistant,
                    $sendEvent,
                    $message,
                    $response['text'],
                    $verifierProvider,
                    $mcpToolsLoader,
                    $usageLogger,
                    $userId,
                    $startTime,
                    $responseTimeMs
                );
            }

            // Phase 3: Compare
            if (!$isPendingClientTool && $compareEnabled && $compareProvider && $compareProvider !== $provider) {
                $this->handleComparison(
                    $assistant,
                    $sendEvent,
                    $message,
                    $conversationHistory,
                    $compareProvider,
                    $mcpToolsLoader,
                    $usageLogger,
                    $userId,
                    $startTime,
                    $responseTimeMs,
                    $skillMetadata,
                    $availableSkills,
                    $skillContent,
                    $imageAttachments,
                    $pdfAttachments
                );
            }

            $sendEvent('complete', ['status' => 'done']);

            // Log usage
            if ($usageLogger && isset($response['usage'])) {
                $usage = $response['usage'];

                // Debug: Log exactly what tool calls are being recorded
                $funcCalled = $response['functions_called'] ?? [];
                $mcpCalled = $response['mcp_tools_called'] ?? [];
                error_log("📋 [ChatController] About to log - functions_called: " . json_encode($funcCalled) . ", mcp_tools_called: " . json_encode($mcpCalled));

                $usageLogger->logTransaction([
                    'user_id' => is_numeric($userId) ? (int) $userId : null,
                    'session_id' => $sessionId,
                    'provider' => $response['provider_used'] ?? 'claude',
                    'model' => $response['model'] ?? 'unknown',
                    'prompt_tokens' => $usage['input_tokens'] ?? $usage['prompt_tokens'] ?? 0,
                    'completion_tokens' => $usage['output_tokens'] ?? $usage['completion_tokens'] ?? 0,
                    'response_time_ms' => $responseTimeMs,
                    'status' => 'success',
                    'function_calls_count' => $usage['function_calls'] ?? $response['function_calls_count'] ?? 0,
                    'functions_called' => $response['functions_called'] ?? null,
                    'mcp_calls_count' => $response['mcp_calls_count'] ?? 0,
                    'mcp_tools_called' => $response['mcp_tools_called'] ?? null,
                ]);
            }

            // Post-response tail: run the memory auto-updater after the client
            // has received everything. Failures here must never affect the user.
            if (is_numeric($userId) && !empty($response['text'])) {
                if (function_exists('fastcgi_finish_request')) {
                    @fastcgi_finish_request();
                }
                try {
                    // $config (local) is the DB-merged copy from
                    // applyDatabaseProviderSettings(). The Claude API key
                    // moved to system_llm_settings, so $this->config no
                    // longer has it — reading from $this->config here
                    // gave an empty key and silently disabled memory
                    // auto-extraction. Use the merged $config instead.
                    $apiKey = (string) ($config['claude']['api_key'] ?? getenv('ANTHROPIC_API_KEY') ?: '');
                    if ($apiKey !== '') {
                        $updater = new \AgentTeam\Services\MemoryAutoUpdater($this->db, $apiKey);
                        $updater->run((int) $userId, $sessionId, (string) $message, (string) $response['text']);
                    } else {
                        error_log('[ChatController] MemoryAutoUpdater skipped: no Claude API key in merged config or ANTHROPIC_API_KEY env');
                    }
                } catch (\Throwable $e) {
                    error_log('[ChatController] MemoryAutoUpdater failed: ' . $e->getMessage());
                }
            }

        } catch (\RuntimeException $e) {
            // Client disconnected - silently cancel. No error event (client is gone anyway),
            // no error log spam. The upstream LLM cURL connection closes automatically.
            if ($e->getMessage() === 'CLIENT_ABORTED') {
                error_log("[ChatController] Client aborted, upstream LLM call cancelled");
                if ($usageLogger && is_numeric($userId)) {
                    $responseTimeMs = isset($startTime) ? (int) ((microtime(true) - $startTime) * 1000) : 0;
                    $usageLogger->logTransaction([
                        'user_id' => (int) $userId,
                        'provider' => $provider ?? 'claude',
                        'model' => 'unknown',
                        'prompt_tokens' => 0,
                        'completion_tokens' => 0,
                        'response_time_ms' => $responseTimeMs,
                        'status' => 'aborted',
                        'error_message' => 'Cancelled by user',
                    ]);
                }
                return [
                    'streaming_handled' => true,
                    'status_code' => 200
                ];
            }
            // Other RuntimeExceptions fall through to generic handler
            throw $e;
        } catch (Exception $e) {
            $responseTimeMs = isset($startTime) ? (int) ((microtime(true) - $startTime) * 1000) : 0;

            if ($usageLogger && is_numeric($userId)) {
                $usageLogger->logTransaction([
                    'user_id' => (int) $userId,
                    'provider' => $provider ?? 'claude',
                    'model' => 'unknown',
                    'prompt_tokens' => 0,
                    'completion_tokens' => 0,
                    'response_time_ms' => $responseTimeMs,
                    'status' => 'error',
                    'error_message' => $e->getMessage(),
                ]);
            }

            $sendEvent('error', ['message' => self::humanizeProviderError($e->getMessage())]);
        }

        // Return special marker indicating streaming was handled
        return [
            'streaming_handled' => true,
            'status_code' => 200
        ];
    }

    /**
     * Handle verification with another LLM
     */
    private function handleVerification(
        AIPortfolioAssistant $assistant,
        callable $sendEvent,
        string $originalMessage,
        string $responseText,
        string $verifierProvider,
        ?MCPToolsLoader $mcpToolsLoader,
        ?UsageLogger $usageLogger,
        string $userId,
        float $startTime,
        int $mainResponseTimeMs
    ): void {
        try {
            $sendEvent('verification_start', ['verifier' => $verifierProvider]);

            // Build verification prompt
            $currentDate = date('Y-m-d');
            $currentDateTime = date('Y-m-d H:i:s T');
            $verificationPrompt = "You are a verification assistant. Your task is to analyze the following response for accuracy, completeness, and potential issues.\n\n";
            $verificationPrompt .= "**Current Date:** {$currentDate} (Full timestamp: {$currentDateTime})\n\n";
            $verificationPrompt .= "**Original Question:**\n{$originalMessage}\n\n";
            $verificationPrompt .= "**Response to Verify:**\n{$responseText}\n\n";
            $verificationPrompt .= "**Your Task:**\n";
            $verificationPrompt .= "1. Check for factual accuracy (use the current date above as reference for time-sensitive information)\n";
            $verificationPrompt .= "2. Identify any errors or omissions\n";
            $verificationPrompt .= "3. Assess the quality of reasoning\n";
            $verificationPrompt .= "4. Provide a brief verification summary\n\n";
            $verificationPrompt .= "Be concise and focus on the most important points.";

            $verifierSessionId = uniqid('verify_', true);

            $verifierProviderInstance = $assistant->getLLMManager()->getProvider($verifierProvider);
            if ($verifierProviderInstance) {
                // Create custom SSE client for verification
                $verifierSseClient = $this->createVerificationSSEClient($sendEvent);

                if (method_exists($verifierProviderInstance, 'setSSEClient')) {
                    $verifierProviderInstance->setSSEClient($verifierSseClient);
                }

                // Get tools for verifier
                $verifierTools = $assistant->getToolsManager()->getToolDefinitions();
                if ($mcpToolsLoader && $mcpToolsLoader->hasTools()) {
                    $verifierTools = array_merge($verifierTools, $mcpToolsLoader->getToolDefinitions());
                }

                $verifierResponse = $assistant->getLLMManager()->streamChat(
                    $verificationPrompt,
                    function($chunk) use ($sendEvent) {
                        $sendEvent('verifier_chunk', $chunk);
                    },
                    [],
                    [
                        'provider' => $verifierProvider,
                        'tools' => $verifierTools
                    ]
                );

                $sendEvent('verification_response', [
                    'success' => true,
                    'text' => $verifierResponse['text'] ?? '',
                    'verifier' => $verifierProvider
                ]);

                // Log verifier usage
                if ($usageLogger) {
                    $verifierUsage = $verifierResponse['usage'] ?? [];
                    $verifierResponseTimeMs = (int) ((microtime(true) - $startTime) * 1000) - $mainResponseTimeMs;

                    $usageLogger->logTransaction([
                        'user_id' => is_numeric($userId) ? (int) $userId : null,
                        'session_id' => $verifierSessionId,
                        'provider' => $verifierProvider,
                        'model' => $verifierResponse['model'] ?? 'unknown',
                        'prompt_tokens' => $verifierUsage['input_tokens'] ?? $verifierUsage['prompt_tokens'] ?? 0,
                        'completion_tokens' => $verifierUsage['output_tokens'] ?? $verifierUsage['completion_tokens'] ?? 0,
                        'response_time_ms' => $verifierResponseTimeMs > 0 ? $verifierResponseTimeMs : 0,
                        'status' => 'success',
                        'function_calls_count' => $verifierUsage['function_calls'] ?? 0,
                        'functions_called' => $verifierResponse['functions_called'] ?? null,
                        'mcp_calls_count' => $verifierResponse['mcp_calls_count'] ?? 0,
                        'mcp_tools_called' => $verifierResponse['mcp_tools_called'] ?? null,
                    ]);
                }
            }

            $sendEvent('verification_complete', ['status' => 'done']);

        } catch (Exception $e) {
            error_log("Verification error: " . $e->getMessage());
            $sendEvent('verification_error', ['message' => self::humanizeProviderError($e->getMessage())]);
            $sendEvent('verification_complete', ['status' => 'error']);
        }
    }

    /**
     * Handle comparison with another LLM
     */
    private function handleComparison(
        AIPortfolioAssistant $assistant,
        callable $sendEvent,
        string $message,
        array $conversationHistory,
        string $compareProvider,
        ?MCPToolsLoader $mcpToolsLoader,
        ?UsageLogger $usageLogger,
        string $userId,
        float $startTime,
        int $mainResponseTimeMs,
        // The 5 skill/attachment context items the comparer needs to see
        // the same scene as the primary. Without these, the compare pane
        // was answering a degraded version of the prompt: no SKILL.md in
        // system prompt, no run_skill_script tool, no native attachments.
        // The whole point of compare mode is apples-to-apples evaluation.
        ?array $skillMetadata = null,
        array $availableSkills = [],
        string $skillContent = '',
        array $imageAttachments = [],
        array $pdfAttachments = []
    ): void {
        try {
            $sendEvent('compare_start', ['comparer' => $compareProvider]);

            $compareSessionId = uniqid('compare_', true);

            $compareProviderInstance = $assistant->getLLMManager()->getProvider($compareProvider);
            if ($compareProviderInstance) {
                // Create custom SSE client for comparison
                $compareSseClient = $this->createComparisonSSEClient($sendEvent);

                if (method_exists($compareProviderInstance, 'setSSEClient')) {
                    $compareProviderInstance->setSSEClient($compareSseClient);
                }

                // Build the SAME options block the primary's skill-routing
                // logic produces (see handleStreamingChat). The comparer
                // gets the same tools, skill_content, tool_choice forcing,
                // and attachments as the primary so it sees the same scene.
                $options = ['provider' => $compareProvider];

                if ($skillMetadata !== null) {
                    $skillTool = self::buildRunSkillScriptTool($skillMetadata);
                    $taskTool = self::buildTaskTool();
                    $options['tools'] = [$skillTool, $taskTool];
                    $options['skill_metadata'] = $skillMetadata;

                    // Mirror the primary's loop guard — only count
                    // run_skill_script tool rounds, not discover_skill.
                    $hasPriorRunSkillScript = false;
                    foreach ($conversationHistory as $h) {
                        if (($h['role'] ?? '') === 'tool' && ($h['name'] ?? '') === 'run_skill_script') {
                            $hasPriorRunSkillScript = true; break;
                        }
                        if (($h['role'] ?? '') === 'assistant' && !empty($h['tool_calls'])) {
                            foreach ($h['tool_calls'] as $tc) {
                                $tcName = $tc['function']['name'] ?? $tc['name'] ?? '';
                                if ($tcName === 'run_skill_script') {
                                    $hasPriorRunSkillScript = true; break 2;
                                }
                            }
                        }
                    }

                    if (!$hasPriorRunSkillScript) {
                        // Provider-conditional tool_choice form, mirrored
                        // from handleStreamingChat's gate (Grok/DeepSeek
                        // reliably honor 'required' but ignore the
                        // specific-function form).
                        $compareProviderName = strtolower($compareProvider);
                        if (in_array($compareProviderName, ['grok', 'deepseek'], true)) {
                            $options['tool_choice'] = 'required';
                        } else {
                            $options['tool_choice'] = [
                                'type' => 'function',
                                'function' => ['name' => 'run_skill_script'],
                            ];
                        }
                    }
                } elseif (!empty($availableSkills)) {
                    $skillTool = self::buildMultiSkillTool($availableSkills);
                    $discoverTool = self::buildDiscoverSkillTool($availableSkills);
                    $tools = [$discoverTool, $skillTool];
                    if ($mcpToolsLoader && $mcpToolsLoader->hasTools()) {
                        $tools = array_merge($tools, $mcpToolsLoader->getToolDefinitions());
                    }
                    $options['tools'] = $tools;
                    $options['available_skills'] = $availableSkills;
                } else {
                    $compareTools = $assistant->getToolsManager()->getToolDefinitions();
                    if ($mcpToolsLoader && $mcpToolsLoader->hasTools()) {
                        $compareTools = array_merge($compareTools, $mcpToolsLoader->getToolDefinitions());
                    }
                    $options['tools'] = $compareTools;
                }

                if ($skillContent !== '') {
                    $options['skill_content'] = $skillContent;
                }
                if (!empty($imageAttachments)) {
                    $options['image_attachments'] = $imageAttachments;
                }
                if (!empty($pdfAttachments)) {
                    $options['pdf_attachments'] = $pdfAttachments;
                }

                error_log("🔧 [ChatController::handleComparison] Compare turn — provider: {$compareProvider}"
                    . " | skill_metadata: " . ($skillMetadata ? $skillMetadata['dir_name'] : 'null')
                    . " | available_skills: " . count($availableSkills)
                    . " | tool_choice: " . json_encode($options['tool_choice'] ?? 'auto')
                    . " | skill_content_len: " . mb_strlen($skillContent));

                // Streaming path: this branch only runs when the primary
                // call is itself streaming (handleStreamingChat). In that
                // mode the compare bubble is visible and users benefit
                // from progressive tokens, so we stream the LLM call here
                // too. The other compare-side call (compareOnly) honors
                // the frontend's per-turn streaming flag — see there for
                // the no-skill vs skill rationale.
                $compareResponse = $assistant->getLLMManager()->streamChat(
                    $message,
                    function($chunk) use ($sendEvent) {
                        $sendEvent('compare_chunk', $chunk);
                    },
                    $conversationHistory,
                    $options
                );

                $sendEvent('compare_response', [
                    'success' => true,
                    'text' => $compareResponse['text'] ?? '',
                    'comparer' => $compareProvider,
                    'usage' => $compareResponse['usage'] ?? null,
                ]);

                // Log compare usage
                if ($usageLogger) {
                    $compareUsage = $compareResponse['usage'] ?? [];
                    $compareResponseTimeMs = (int) ((microtime(true) - $startTime) * 1000) - $mainResponseTimeMs;

                    $usageLogger->logTransaction([
                        'user_id' => is_numeric($userId) ? (int) $userId : null,
                        'session_id' => $compareSessionId,
                        'provider' => $compareProvider,
                        'model' => $compareResponse['model'] ?? 'unknown',
                        'prompt_tokens' => $compareUsage['input_tokens'] ?? $compareUsage['prompt_tokens'] ?? 0,
                        'completion_tokens' => $compareUsage['output_tokens'] ?? $compareUsage['completion_tokens'] ?? 0,
                        'response_time_ms' => $compareResponseTimeMs > 0 ? $compareResponseTimeMs : 0,
                        'status' => 'success',
                        'function_calls_count' => $compareUsage['function_calls'] ?? 0,
                        'functions_called' => $compareResponse['functions_called'] ?? null,
                        'mcp_calls_count' => $compareResponse['mcp_calls_count'] ?? 0,
                        'mcp_tools_called' => $compareResponse['mcp_tools_called'] ?? null,
                    ]);
                }
            }

            $sendEvent('compare_complete', ['status' => 'done']);

        } catch (Exception $e) {
            error_log("Compare error: " . $e->getMessage());
            $sendEvent('compare_error', ['message' => self::humanizeProviderError($e->getMessage())]);
            $sendEvent('compare_complete', ['status' => 'error']);
        }
    }

    /**
     * Handle regular (non-streaming) chat
     */
    private function handleRegularChat(
        string $message,
        array $conversationHistory,
        string $userId,
        ?string $provider,
        ?array $toolsFilter = null,
        array $imageAttachments = [],
        array $pdfAttachments = [],
        string $skillContent = '',
        ?array $skillMetadata = null,
        array $availableSkills = [],
        array $clientTools = [],
        array $clientToolNames = [],
        ?string $systemPromptOverride = null,
        bool $includeMemory = true,
        ?int $maxTokensOverride = null,
        ?float $temperatureOverride = null
    ): array {
        // Apply database provider settings first (overrides hardcoded config)
        $config = $this->applyDatabaseProviderSettings($this->config);

        // Then the user's role-based package (sits below user overrides)
        $config = $this->applyPackageDefaults($config, $userId);

        // Then apply user's custom API keys (user keys override everything)
        $config = $this->applyUserApiKeys($config, $userId, $provider);

        // Per-node overrides from the workflow agent form win over the provider-config
        // defaults. Write into the provider's config block at its actual location — root
        // ($config[$provider]) for claude/openai, nested ($config['providers'][$provider])
        // for the rest — matching LLMProviderResolver so the provider ctor reads them.
        if (($maxTokensOverride !== null || $temperatureOverride !== null) && $provider) {
            if (isset($config[$provider]) && is_array($config[$provider])) {
                if ($maxTokensOverride !== null)   $config[$provider]['max_tokens'] = $maxTokensOverride;
                if ($temperatureOverride !== null) $config[$provider]['temperature'] = $temperatureOverride;
            } elseif (isset($config['providers'][$provider]) && is_array($config['providers'][$provider])) {
                if ($maxTokensOverride !== null)   $config['providers'][$provider]['max_tokens'] = $maxTokensOverride;
                if ($temperatureOverride !== null) $config['providers'][$provider]['temperature'] = $temperatureOverride;
            }
        }

        $assistant = new AIPortfolioAssistant($config);

        // Initialize usage logger
        $usageLogger = null;
        try {
            $usageLogger = new UsageLogger($this->db, true, $config['contexts_database'] ?? $config['database']);
        } catch (Exception $e) {
            error_log("[ChatController] Usage logger unavailable: " . $e->getMessage());
        }

        // Register session_search (Hermes Layer 3) on this request's ToolsManager.
        if (is_numeric($userId)) {
            \AgentTeam\Services\SessionSearchService::registerAsTool(
                $assistant->getToolsManager(),
                (int) $userId,
                $config
            );
        }

        // Load MCP tools
        $mcpToolsLoader = null;
        try {
            $mcpToolsLoader = new MCPToolsLoader($this->db);
            $mcpToolsLoader->loadToolsForUser($userId);

            if ($mcpToolsLoader->hasTools()) {
                $baseToolsManager = $assistant->getToolsManager();
                $combinedExecutor = new CombinedToolsExecutor($baseToolsManager, $mcpToolsLoader);

                // Wrap with FilteredToolsExecutor if tools filter is specified
                $executor = $combinedExecutor;
                if ($toolsFilter !== null && !empty($toolsFilter)) {
                    $filteredExecutor = new FilteredToolsExecutor($combinedExecutor);
                    $filteredExecutor->setAllowedTools($toolsFilter);
                    $executor = $filteredExecutor;
                    error_log("[ChatController] Tool filter applied: " . implode(', ', $toolsFilter));
                }

                $llmManager = $assistant->getLLMManager();
                foreach ($this->getEnabledProviderKeys() as $providerName) {
                    $providerInstance = $llmManager->getProvider($providerName);
                    if ($providerInstance && method_exists($providerInstance, 'setFunctionExecutor')) {
                        $providerInstance->setFunctionExecutor($executor);
                    }
                }
            } elseif ($toolsFilter !== null && !empty($toolsFilter)) {
                // No MCP tools but filter is specified - filter base tools only
                $baseToolsManager = $assistant->getToolsManager();
                $filteredExecutor = new FilteredToolsExecutor($baseToolsManager);
                $filteredExecutor->setAllowedTools($toolsFilter);

                $llmManager = $assistant->getLLMManager();
                foreach ($this->getEnabledProviderKeys() as $providerName) {
                    $providerInstance = $llmManager->getProvider($providerName);
                    if ($providerInstance && method_exists($providerInstance, 'setFunctionExecutor')) {
                        $providerInstance->setFunctionExecutor($filteredExecutor);
                    }
                }
            }
        } catch (Exception $e) {
            error_log("[MCP] Failed to load MCP tools: " . $e->getMessage());
        }

        $startTime = microtime(true);

        try {
            $options = $provider ? ['provider' => $provider] : [];

            // Tool selection — same policy as the streaming path. For
            // B3 skill turns we suppress MCP tools to keep the input
            // small and the model's decision space narrow, and force
            // tool_choice when no tool round has run yet.
            if ($skillMetadata !== null) {
                $skillTool = self::buildRunSkillScriptTool($skillMetadata);
                $taskTool = self::buildTaskTool();
                $options['tools'] = [$skillTool, $taskTool];
                $options['skill_metadata'] = $skillMetadata;

                $hasPriorToolRound = false;
                foreach ($conversationHistory as $h) {
                    if (($h['role'] ?? '') === 'tool') { $hasPriorToolRound = true; break; }
                    if (($h['role'] ?? '') === 'assistant' && !empty($h['tool_calls'])) { $hasPriorToolRound = true; break; }
                }
                if (!$hasPriorToolRound) {
                    $options['tool_choice'] = [
                        'type' => 'function',
                        'function' => ['name' => 'run_skill_script'],
                    ];
                }
            } elseif (!empty($availableSkills)) {
                $skillTool = self::buildMultiSkillTool($availableSkills);
                $tools = [$skillTool];
                if ($mcpToolsLoader && $mcpToolsLoader->hasTools()) {
                    $tools = array_merge($tools, $mcpToolsLoader->getToolDefinitions());
                }
                $options['tools'] = $tools;
                $options['available_skills'] = $availableSkills;
            } else {
                if ($mcpToolsLoader && $mcpToolsLoader->hasTools()) {
                    $options['tools'] = $mcpToolsLoader->getToolDefinitions();
                }
            }

            // Append user's frozen memory (Hermes Layer 1) to the system prompt.
            // Skipped when the caller sends memory:false (e.g. AI-Dialog).
            if ($includeMemory && is_numeric($userId)) {
                $memBlock = \AgentTeam\Services\UserMemoryRepository::buildMemoryBlock($this->db, (int) $userId);
                if ($memBlock !== '') {
                    $options['memory_context'] = $memBlock;
                }
            }

            // Active Skill from the Skills Library (dragged onto prompt input)
            if ($skillContent !== '') {
                $options['skill_content'] = $skillContent;
            }

            // Custom system prompt override (API-driven callers, e.g. AI-Dialog).
            // Replaces the default persona; providers read options['system_prompt'].
            if ($systemPromptOverride !== null) {
                $options['system_prompt'] = $systemPromptOverride;
            }

            // Image attachments (base64 + mime). Providers embed in native shape.
            if (!empty($imageAttachments)) {
                $options['image_attachments'] = $imageAttachments;
            }

            // PDF attachments — only populated when the active provider can
            // ingest PDFs natively (Claude, Gemini). Other providers received
            // the document as text in the message prefix already.
            if (!empty($pdfAttachments)) {
                $options['pdf_attachments'] = $pdfAttachments;
            }

            // Client-side tools from the active browser tab (webMCP). Providers
            // (modified in Tasks 4-9) read these keys and call
            // setPerRequestClientSideToolNames() on themselves before the LLM call.
            $options['client_tools'] = $clientTools;
            $options['client_tool_names'] = $clientToolNames;

            $response = $assistant->chat($message, $userId, $conversationHistory, $options);

            $responseTimeMs = (int) ((microtime(true) - $startTime) * 1000);

            // Log usage
            if ($usageLogger && isset($response['usage'])) {
                $usage = $response['usage'];
                $usageLogger->logTransaction([
                    'user_id' => is_numeric($userId) ? (int) $userId : null,
                    'provider' => $response['provider_used'] ?? 'claude',
                    'model' => $response['model'] ?? 'unknown',
                    'prompt_tokens' => $usage['input_tokens'] ?? $usage['prompt_tokens'] ?? 0,
                    'completion_tokens' => $usage['output_tokens'] ?? $usage['completion_tokens'] ?? 0,
                    'response_time_ms' => $responseTimeMs,
                    'status' => 'success',
                    'function_calls_count' => $usage['function_calls'] ?? $response['function_calls_count'] ?? 0,
                    'functions_called' => $response['functions_called'] ?? null,
                    'mcp_calls_count' => $response['mcp_calls_count'] ?? 0,
                    'mcp_tools_called' => $response['mcp_tools_called'] ?? null,
                ]);
            }

            // Register the memory auto-updater on shutdown so it runs after PHP
            // has written the response body. Failures must never affect the user.
            if (is_numeric($userId) && !empty($response['text'])) {
                $dbRef = $this->db;
                // Capture the DB-merged config (local $config), NOT
                // $this->config — the Claude API key now lives in
                // system_llm_settings and is only present after
                // applyDatabaseProviderSettings(). See the matching note
                // in the non-streaming path.
                $configRef = $config;
                $msgRef = (string) $message;
                $uidRef = (int) $userId;
                $sidRef = $sessionId ?? uniqid('chat_', true);
                $textRef = (string) $response['text'];
                register_shutdown_function(function () use ($dbRef, $configRef, $msgRef, $uidRef, $sidRef, $textRef) {
                    if (function_exists('fastcgi_finish_request')) {
                        @fastcgi_finish_request();
                    }
                    try {
                        $apiKey = (string) ($configRef['claude']['api_key'] ?? getenv('ANTHROPIC_API_KEY') ?: '');
                        if ($apiKey !== '') {
                            $updater = new \AgentTeam\Services\MemoryAutoUpdater($dbRef, $apiKey);
                            $updater->run($uidRef, $sidRef, $msgRef, $textRef);
                        } else {
                            error_log('[ChatController] MemoryAutoUpdater skipped (streaming): no Claude API key in merged config or ANTHROPIC_API_KEY env');
                        }
                    } catch (\Throwable $e) {
                        error_log('[ChatController] MemoryAutoUpdater failed: ' . $e->getMessage());
                    }
                });
            }

            $payload = [
                'success' => true,
                'text' => $response['text'],
                'usage' => $response['usage'] ?? [],
                'provider' => $response['provider'] ?? $response['provider_used'] ?? 'claude',
                'status_code' => 200,
            ];

            // Surface client-side tool dispatch flags so the frontend
            // dispatcher can run pyodide and re-issue /chat with the
            // tool result. Same shape the streaming path emits in its
            // `response` SSE event — keeps frontend dispatch logic
            // identical regardless of streaming mode.
            if (!empty($response['pending_client_tool_call'])) {
                $payload['pending_client_tool_call'] = true;
                $payload['pending_tool_calls'] = $response['pending_tool_calls'] ?? [];
                if (isset($response['assistant_text']) && $response['assistant_text'] !== '') {
                    $payload['assistant_text'] = $response['assistant_text'];
                }
            }

            return $payload;

        } catch (Exception $e) {
            $responseTimeMs = (int) ((microtime(true) - $startTime) * 1000);

            if ($usageLogger && is_numeric($userId)) {
                $usageLogger->logTransaction([
                    'user_id' => (int) $userId,
                    'provider' => $provider ?? 'claude',
                    'model' => 'unknown',
                    'prompt_tokens' => 0,
                    'completion_tokens' => 0,
                    'response_time_ms' => $responseTimeMs,
                    'status' => 'error',
                    'error_message' => $e->getMessage(),
                ]);
            }

            // Surface the REAL cause, not a blanket 500. ProviderException already
            // carries the true HTTP status (429 rate limit, 401 auth, 400 billing,
            // 5xx overload); use it so the client can distinguish "retry", "fix key",
            // "top up credits", etc. humanizeProviderError turns the raw provider text
            // into a categorized, user-readable message (and redacts any leaked keys).
            $statusCode = ($e instanceof ProviderException && $e->getHttpStatusCode())
                ? $e->getHttpStatusCode()
                : 500;
            return [
                'success' => false,
                'error' => self::humanizeProviderError($e->getMessage()),
                'status_code' => $statusCode,
            ];
        }
    }

    /**
     * Apply user's custom API keys to configuration
     */
    /**
     * Merge the user's role-based package defaults into $config.
     *
     * Resolution order (runs in this sequence for each chat request):
     *   1. config file / hardcoded defaults
     *   2. system_llm_settings (applyDatabaseProviderSettings)
     *   3. THIS — package defaults (per-role, from `packages` table)
     *   4. user overrides (applyUserApiKeys) — user's own keys + model choices.
     *      Model overrides only apply when the user supplied their own API
     *      key for that provider (package-key users get the package's model).
     *
     * Package-level `default_api_key` and `default_model` are written onto
     * the matching `$config[provider]` or `$config['providers'][provider]`
     * entries, but only when the package has `providers[provider].enabled`.
     * Missing values leave the system defaults untouched.
     *
     * Non-numeric $userId (guest, demo-user, etc.) falls through to the guest
     * package via PackageResolver.
     */
    private function applyPackageDefaults(array $config, string $userId): array
    {
        try {
            $resolver = new PackageResolver($this->db);
            $userIdInt = is_numeric($userId) ? (int)$userId : null;
            $package = $resolver->resolveForUser($userIdInt);
            $caps = $package['capabilities'] ?? [];
            $providers = $caps['providers'] ?? [];

            if (!is_array($providers)) {
                return $config;
            }

            foreach ($providers as $providerKey => $providerCfg) {
                if (!is_array($providerCfg)) continue;
                if (empty($providerCfg['enabled'])) continue;

                $defaultKey = isset($providerCfg['default_api_key']) && is_string($providerCfg['default_api_key'])
                    ? trim($providerCfg['default_api_key']) : '';
                $defaultModel = isset($providerCfg['default_model']) && is_string($providerCfg['default_model'])
                    ? trim($providerCfg['default_model']) : '';

                if ($defaultKey === '' && $defaultModel === '') continue;

                // Apply to whichever shape the config uses — top-level
                // ($config['claude']) or nested ($config['providers']['kimi']).
                $targetRef = null;
                if (isset($config[$providerKey]) && is_array($config[$providerKey])) {
                    $targetRef = &$config[$providerKey];
                } elseif (isset($config['providers'][$providerKey]) && is_array($config['providers'][$providerKey])) {
                    $targetRef = &$config['providers'][$providerKey];
                } else {
                    continue;
                }

                if ($defaultKey !== '') {
                    $targetRef['api_key'] = $defaultKey;
                }
                if ($defaultModel !== '') {
                    $targetRef['model'] = $defaultModel;
                }
                unset($targetRef);
            }
        } catch (Exception $e) {
            error_log("[ChatController] Package defaults failed: " . $e->getMessage());
        }

        return $config;
    }

    /**
     * Resolve the MCP server allowlist for a user's role-based package.
     * Returns null when the package allows all MCP servers (default), an
     * array of server names when restricted, or an empty array for "none".
     * Callers pass the return value straight into MCPToolsLoader::loadToolsForUser.
     */
    private function resolvePackageMcpAllowlist(string $userId): ?array
    {
        try {
            $resolver = new PackageResolver($this->db);
            $userIdInt = is_numeric($userId) ? (int)$userId : null;
            return $resolver->allowedMcpServers($userIdInt);
        } catch (Exception $e) {
            error_log("[ChatController] MCP allowlist resolution failed: " . $e->getMessage());
            return null; // fail open
        }
    }

    private function applyUserApiKeys(array $config, string $userId, ?string $provider = null): array
    {
        if (!$userId || $userId === 'demo-user') {
            return $config;
        }

        try {
            // Check if user_api_keys table exists
            $stmt = $this->db->query("SHOW TABLES LIKE 'user_api_keys'");
            if ($stmt->rowCount() === 0) {
                return $config;
            }

            $numericUserId = is_numeric($userId) ? (int)$userId : abs(crc32($userId));

            $sql = "SELECT provider, api_key, system_prompt FROM user_api_keys WHERE user_id = :user_id";
            $stmt = $this->db->prepare($sql);
            $stmt->execute([':user_id' => $numericUserId]);
            $keys = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Load user model selections
            $modelRows = [];
            try {
                $modelStmt = $this->db->query("SHOW TABLES LIKE 'user_model_selections'");
                if ($modelStmt->rowCount() > 0) {
                    $modelSql = "SELECT provider, model FROM user_model_selections WHERE user_id = :user_id";
                    $mStmt = $this->db->prepare($modelSql);
                    $mStmt->execute([':user_id' => $numericUserId]);
                    $modelRows = $mStmt->fetchAll(PDO::FETCH_ASSOC);
                }
            } catch (Exception $e) {
                error_log("[ChatController] Error loading user models: " . $e->getMessage());
            }

            if (empty($keys) && empty($modelRows)) {
                return $config;
            }

            $encryptionKey = $config['auth']['jwt_secret'] ?? 'default-encryption-key-change-this';

            // Track which providers the user has supplied their own (decryptable)
            // key for. The model lock below uses this: a user on the package key
            // cannot override the package's default model — admin pays, admin
            // picks the model. Once the user pastes their own key, the lock
            // releases for that provider only.
            $userOwnedKeyProviders = [];

            // Apply custom API keys + per-user system_prompt overrides. The
            // override wins over the admin global (system_llm_settings) which
            // already won over ai_config.php in applyDatabaseProviderSettings.
            foreach ($keys as $keyRow) {
                $keyProvider = $keyRow['provider'];
                $encryptedKey = $keyRow['api_key'];
                $userSystemPrompt = $keyRow['system_prompt'] ?? null;

                $decryptedKey = $this->decryptApiKey($encryptedKey, $encryptionKey);

                if ($decryptedKey) {
                    $userOwnedKeyProviders[$keyProvider] = true;
                    if (isset($config[$keyProvider])) {
                        $config[$keyProvider]['api_key'] = $decryptedKey;
                        error_log("[ChatController] Using custom API key for provider: {$keyProvider}, user: {$numericUserId}");
                    } elseif (isset($config['providers'][$keyProvider])) {
                        $config['providers'][$keyProvider]['api_key'] = $decryptedKey;
                        error_log("[ChatController] Using custom API key for nested provider: {$keyProvider}, user: {$numericUserId}");
                    }
                }

                // System prompt override is independent of the API key — a
                // user can override the prompt without a custom key.
                if (is_string($userSystemPrompt) && trim($userSystemPrompt) !== '') {
                    if (isset($config[$keyProvider])) {
                        $config[$keyProvider]['system_prompt'] = $userSystemPrompt;
                        error_log("[ChatController] Using user system_prompt override for provider: {$keyProvider}, user: {$numericUserId}");
                    } elseif (isset($config['providers'][$keyProvider])) {
                        $config['providers'][$keyProvider]['system_prompt'] = $userSystemPrompt;
                        error_log("[ChatController] Using user system_prompt override for nested provider: {$keyProvider}, user: {$numericUserId}");
                    }
                }
            }

            // Apply user model selections, but ONLY for providers where the
            // user supplied their own API key. When on the package key the
            // package's default_model (already written by applyPackageDefaults)
            // is authoritative — the admin is footing the bill, the admin
            // picks the model.
            foreach ($modelRows as $modelRow) {
                $mProvider = $modelRow['provider'];
                $mModel = $modelRow['model'];

                if (empty($userOwnedKeyProviders[$mProvider])) {
                    error_log("[ChatController] Ignoring user model selection for {$mProvider} (user {$numericUserId} on package key); package default stands");
                    continue;
                }

                if (isset($config[$mProvider])) {
                    $config[$mProvider]['model'] = $mModel;
                    error_log("[ChatController] Using custom model for provider: {$mProvider} -> {$mModel}, user: {$numericUserId}");
                } elseif (isset($config['providers'][$mProvider])) {
                    $config['providers'][$mProvider]['model'] = $mModel;
                    error_log("[ChatController] Using custom model for nested provider: {$mProvider} -> {$mModel}, user: {$numericUserId}");
                }
            }

        } catch (Exception $e) {
            error_log("[ChatController] Error loading user API keys: " . $e->getMessage());
        }

        return $config;
    }

    /**
     * Decrypt an API key
     */
    /**
     * Check if a free trial user has exceeded their token quota
     * Returns an error response array if quota exceeded, null if OK
     */
    private function checkFreeTrialQuota(string $userId): ?array
    {
        if (!$userId || $userId === 'demo-user') {
            return null;
        }

        try {
            $numericUserId = is_numeric($userId) ? (int)$userId : abs(crc32($userId));

            // Check user's plan and role
            $stmt = $this->db->prepare("SELECT plan, role FROM users WHERE id = ?");
            $stmt->execute([$numericUserId]);
            $user = $stmt->fetch();

            if (!$user) {
                return null;
            }

            // Admins have no quota limits
            if (($user['role'] ?? '') === 'admin') {
                return null;
            }

            // Paid plans have no quota
            if (($user['plan'] ?? 'free') !== 'free') {
                return null;
            }

            // Resolve the lifetime token cap from the user's role-based package.
            // null in the package means "no cap" -> bail out without querying usage.
            try {
                $package = (new PackageResolver($this->db))->resolveForUser($numericUserId);
                $packageQuota = $package['capabilities']['quota_tokens'] ?? null;
            } catch (Exception $e) {
                error_log("[ChatController] Package quota resolution failed: " . $e->getMessage());
                $packageQuota = null;
            }
            if ($packageQuota === null) {
                return null;
            }
            $quota = (int) $packageQuota;

            // Check total tokens used across all providers
            $stmt = $this->db->query("SHOW TABLES LIKE 'llm_usage_balance'");
            if ($stmt->rowCount() === 0) {
                return null; // Table doesn't exist yet, no usage
            }

            $stmt = $this->db->prepare("SELECT COALESCE(SUM(total_tokens), 0) as total FROM llm_usage_balance WHERE user_id = ?");
            $stmt->execute([$numericUserId]);
            $row = $stmt->fetch();
            $totalTokens = (int)($row['total'] ?? 0);

            if ($totalTokens >= $quota) {
                return [
                    'success' => false,
                    'error' => 'Token quota reached. You have used ' . number_format($totalTokens) . ' of ' . number_format($quota) . ' tokens. Please upgrade your plan to continue.',
                    'code' => 'QUOTA_EXCEEDED',
                    'usage' => ['total_tokens' => $totalTokens, 'quota' => $quota],
                    'status_code' => 403
                ];
            }
        } catch (Exception $e) {
            error_log("[ChatController] Error checking free trial quota: " . $e->getMessage());
        }

        return null;
    }

    private function decryptApiKey(string $encryptedKey, string $encryptionKey): ?string
    {
        try {
            $data = base64_decode($encryptedKey);
            if ($data === false || strlen($data) < 17) {
                return null;
            }

            $key = hash('sha256', $encryptionKey, true);
            $iv = substr($data, 0, 16);
            $encrypted = substr($data, 16);

            $decrypted = openssl_decrypt($encrypted, 'AES-256-CBC', $key, OPENSSL_RAW_DATA, $iv);
            return $decrypted !== false ? $decrypted : null;
        } catch (Exception $e) {
            return null;
        }
    }

    /**
     * Delegates to LLMProviderResolver — kept as a thin wrapper because
     * `verify()`, `compareOnly()`, and the streaming/non-streaming chat
     * handlers all call this name. Logic lives in the service so all other
     * controllers that instantiate AIPortfolioAssistant can share it.
     */
    private function applyDatabaseProviderSettings(array $config): array
    {
        return LLMProviderResolver::applyDbSettings($this->db, $config);
    }

    /**
     * Create verification SSE client
     */
    private function createVerificationSSEClient(callable $sendEvent): StreamingClientInterface
    {
        return new class($sendEvent) implements StreamingClientInterface {
            private $sendEvent;
            private string $sessionId;
            private bool $connected = true;

            public function __construct(callable $sendEvent) {
                $this->sendEvent = $sendEvent;
                $this->sessionId = 'verify_' . uniqid();
            }

            public function sendProgress(string $message): void {
                ($this->sendEvent)('verification_progress', $message);
            }

            public function sendChunk(string $text): void {
                ($this->sendEvent)('verifier_chunk', $text);
            }

            public function sendResponse(array $data): void {
                ($this->sendEvent)('verification_response', $data);
            }

            public function sendError(string $message, int $code = 500): void {
                ($this->sendEvent)('verification_error', ['message' => $message, 'code' => $code]);
            }

            public function complete(): void {}

            public function sendCustomEvent(string $eventName, array $data): void {
                ($this->sendEvent)($eventName, $data);
            }

            public function getSessionId(): string {
                return $this->sessionId;
            }

            public function isConnected(): bool {
                return $this->connected;
            }

            public function markHeadersInitialized(): void {}
        };
    }

    /**
     * Create comparison SSE client
     */
    private function createComparisonSSEClient(callable $sendEvent): StreamingClientInterface
    {
        return new class($sendEvent) implements StreamingClientInterface {
            private $sendEvent;
            private string $sessionId;
            private bool $connected = true;

            public function __construct(callable $sendEvent) {
                $this->sendEvent = $sendEvent;
                $this->sessionId = 'compare_' . uniqid();
            }

            public function sendProgress(string $message): void {
                ($this->sendEvent)('compare_progress', $message);
            }

            public function sendChunk(string $text): void {
                ($this->sendEvent)('compare_chunk', $text);
            }

            public function sendResponse(array $data): void {
                ($this->sendEvent)('compare_response', $data);
            }

            public function sendError(string $message, int $code = 500): void {
                ($this->sendEvent)('compare_error', ['message' => $message, 'code' => $code]);
            }

            public function complete(): void {}

            public function sendCustomEvent(string $eventName, array $data): void {
                // Namespace per-pane events so the comparer's tool-call
                // emissions don't collide with the primary's. Without
                // this rename, both panes' run_skill_script tool calls
                // arrive on the same channel and the frontend can't
                // tell which pane to feed the result back into.
                if ($eventName === 'client_tool_call') {
                    ($this->sendEvent)('compare_client_tool_call', $data);
                    return;
                }
                ($this->sendEvent)($eventName, $data);
            }

            public function getSessionId(): string {
                return $this->sessionId;
            }

            public function isConnected(): bool {
                return $this->connected;
            }

            public function markHeadersInitialized(): void {}
        };
    }
}
