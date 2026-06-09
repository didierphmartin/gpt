<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;
use PDOException;

/**
 * Session Search Service
 *
 * Implements Hermes Layer 3: lexical (FULLTEXT) search over the user's
 * past chat conversations stored in the `conversation_contexts` table
 * (separate `contexts_database` connection), followed by LLM summarization
 * of the hits before returning to the calling agent.
 *
 * Deliberately not touched by LangGraphGenerator — this is runtime-only.
 */
class SessionSearchService
{
    private const DEFAULT_LIMIT = 5;
    private const MAX_LIMIT = 15;
    private const SNIPPET_CHARS = 600;
    private const SUMMARY_MAX_TOKENS = 400;

    private PDO $contextsDb;
    private array $config;

    public function __construct(PDO $contextsDb, array $config = [])
    {
        $this->contextsDb = $contextsDb;
        $this->config = $config;
    }

    /**
     * Build a PDO connection to the contexts_database from config.
     */
    public static function connectFromConfig(array $config): PDO
    {
        $cfg = $config['contexts_database'] ?? null;
        if (!is_array($cfg) || empty($cfg['host']) || empty($cfg['database'])) {
            throw new \RuntimeException('contexts_database config missing');
        }
        $dsn = sprintf(
            'mysql:host=%s;dbname=%s;charset=%s',
            $cfg['host'],
            $cfg['database'],
            $cfg['charset'] ?? 'utf8mb4'
        );
        return new PDO($dsn, $cfg['username'] ?? '', $cfg['password'] ?? '', [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    }

    /**
     * Register `session_search` as a regular tool on the given ToolsManager.
     * The handler closure captures $userId so the search is always scoped
     * to the current request's user (can't be spoofed by the LLM).
     *
     * Returns true on success, false if the contexts_database connection
     * fails. Safe to call multiple times — duplicate registration just
     * overwrites the closure binding.
     */
    public static function registerAsTool(
        \Quantis\AIPortfolioAssistant\Services\ToolsManager $tools,
        int $userId,
        array $config
    ): bool {
        if ($userId <= 0) {
            return false;
        }
        try {
            $pdo = self::connectFromConfig($config);
            $service = new self($pdo, $config);
        } catch (\Throwable $e) {
            error_log('[SessionSearchService] registerAsTool: contexts_database unavailable — ' . $e->getMessage());
            return false;
        }

        $tools->registerFunction(
            'session_search',
            function (array $params, $ctx = null) use ($service, $userId): array {
                $query = trim((string) ($params['query'] ?? ''));
                $limit = isset($params['limit']) ? (int) $params['limit'] : 5;
                if ($query === '') {
                    return ['error' => 'query is required'];
                }
                $hits = $service->search($userId, $query, $limit);
                return [
                    'query' => $query,
                    'hit_count' => count($hits),
                    'hits' => $hits,
                ];
            },
            [
                'description' => 'Search the current user\'s past chat conversations (lexical / BM25-ranked full-text search) and return the most relevant sessions with short snippets. Use this when you need to recall what the user said or decided in prior discussions. The search is keyword-based, so pick words likely to appear literally in a past transcript.',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => [
                        'query' => [
                            'type' => 'string',
                            'description' => 'Keywords to match in past conversations (e.g. "GLP-1 heart failure", "auth microservice Redis").',
                        ],
                        'limit' => [
                            'type' => 'integer',
                            'description' => 'Max number of sessions to return (default 5, max 15).',
                            'minimum' => 1,
                            'maximum' => 15,
                        ],
                    ],
                    'required' => ['query'],
                ],
            ]
        );
        return true;
    }

    /**
     * Run a FULLTEXT search over the user's conversations.
     *
     * Returns rows of shape:
     *   [{id, title, created_at, updated_at, provider, message_count,
     *     score, snippet}]
     */
    public function search(int $userId, string $query, int $limit = self::DEFAULT_LIMIT): array
    {
        $query = trim($query);
        if ($query === '') {
            return [];
        }
        $limit = max(1, min($limit, self::MAX_LIMIT));

        $sql = "
            SELECT id, title, created_at, updated_at, provider, message_count,
                   MATCH(context_data) AGAINST(:q IN NATURAL LANGUAGE MODE) AS score,
                   context_data
            FROM conversation_contexts
            WHERE user_id = :uid
              AND MATCH(context_data) AGAINST(:q IN NATURAL LANGUAGE MODE)
            ORDER BY score DESC
            LIMIT {$limit}
        ";

        try {
            $stmt = $this->contextsDb->prepare($sql);
            $stmt->execute([':uid' => $userId, ':q' => $query]);
            $rows = $stmt->fetchAll();
        } catch (PDOException $e) {
            error_log('[SessionSearchService] search failed: ' . $e->getMessage());
            return [];
        }

        // Build plain-text snippets around the query terms; drop raw
        // context_data from the returned payload to keep it small.
        $terms = self::queryTerms($query);
        $results = [];
        foreach ($rows as $row) {
            $plain = self::extractPlainText((string) $row['context_data']);
            $results[] = [
                'id' => (int) $row['id'],
                'title' => (string) ($row['title'] ?? ''),
                'created_at' => (string) $row['created_at'],
                'updated_at' => (string) $row['updated_at'],
                'provider' => (string) ($row['provider'] ?? ''),
                'message_count' => (int) ($row['message_count'] ?? 0),
                'score' => (float) $row['score'],
                'snippet' => self::buildSnippet($plain, $terms, self::SNIPPET_CHARS),
            ];
        }
        return $results;
    }

    /**
     * Return the best-effort plain-text version of a context_data JSON blob.
     * Concatenates every `content` field it can find, in order.
     */
    private static function extractPlainText(string $json): string
    {
        $decoded = json_decode($json, true);
        if (!is_array($decoded)) {
            return $json;
        }

        // conversation_contexts stores messages either as the root array
        // or under a "messages" key — handle both shapes.
        $messages = $decoded['messages'] ?? $decoded;
        if (!is_array($messages)) {
            return $json;
        }

        $parts = [];
        foreach ($messages as $m) {
            if (!is_array($m)) {
                continue;
            }
            $content = $m['content'] ?? null;
            if (is_string($content) && $content !== '') {
                $role = isset($m['role']) ? $m['role'] . ': ' : '';
                $parts[] = $role . $content;
            } elseif (is_array($content)) {
                // Claude-style content blocks: [{type: "text", text: "..."}]
                foreach ($content as $block) {
                    if (is_array($block) && isset($block['text']) && is_string($block['text'])) {
                        $parts[] = ($m['role'] ?? '') . ': ' . $block['text'];
                    }
                }
            }
        }
        return implode("\n", $parts);
    }

    private static function queryTerms(string $q): array
    {
        $q = mb_strtolower($q);
        $tokens = preg_split('/\W+/u', $q) ?: [];
        return array_values(array_filter($tokens, fn($t) => mb_strlen($t) >= 3));
    }

    /**
     * Build a window of text around the first matching term, falling back
     * to the head of the transcript if no term matches.
     */
    private static function buildSnippet(string $text, array $terms, int $maxChars): string
    {
        $len = mb_strlen($text);
        if ($len <= $maxChars) {
            return $text;
        }

        $lower = mb_strtolower($text);
        $hitPos = null;
        foreach ($terms as $t) {
            $pos = mb_strpos($lower, $t);
            if ($pos !== false) {
                $hitPos = $pos;
                break;
            }
        }

        if ($hitPos === null) {
            return mb_substr($text, 0, $maxChars) . '…';
        }

        $half = intdiv($maxChars, 2);
        $start = max(0, $hitPos - $half);
        $snippet = mb_substr($text, $start, $maxChars);
        return ($start > 0 ? '…' : '') . $snippet . ($start + $maxChars < $len ? '…' : '');
    }
}
