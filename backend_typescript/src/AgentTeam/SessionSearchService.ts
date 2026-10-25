import { sql } from 'kysely';
import { db } from '../db/pools';
import { ToolsManager } from '../Services/ToolsManager';
import { mbLen, mbSub } from '../Playbook/php';

/**
 * Port of src/AgentTeam/Services/SessionSearchService.php: the run archive (archiveRun) and the
 * lexical `session_search` tool (search + registerAsTool, Hermes Layer 3) the chat path offers.
 * The notes below predate the search port; the connection reasoning applies to both.
 *
 * PHP's SessionSearchService is two things bolted together: (1) a `connectFromConfig(config)`
 * factory that opens a dedicated PDO connection to the `contexts_database` (CTX_DB_* env) —
 * a database SEPARATE from whatever `$this->db` the calling request happened to be using —
 * and (2) a lexical FULLTEXT `search()` + `registerAsTool()` surface for the `session_search`
 * tool (Hermes Layer 3).
 *
 * Only the piece GraphWorkflowRunner.archiveRunToConversationContexts() needs is ported here:
 * the ability to write a finished workflow run into `conversation_contexts`.
 *
 * PORTING DECISION (recon, 2026-07-08) — why there's no new pool/connection here:
 * PHP's connectFromConfig() exists because a PHP request's `$this->db` can be pointed at
 * config['database'] in some call paths. In THIS Node backend, `db` (backend_typescript/
 * src/db/pools.ts) is already built from `config.contextsDatabase` (CTX_DB_*) — see that
 * file's comment: "the connection PHP controllers operate on". This is not a guess: PHP's own
 * app-wide bootstrap resolves the SAME fallback GraphWorkflowRunner.php uses internally
 * (`$config['contexts_database'] ?? $config['database']`) to `contexts_database` for every
 * request (backend/index.php:50, backend/scheduler/run-scheduled-workflows.php:75), and that
 * is the exact PDO handed into `new GraphWorkflowRunner($pdo, ...)` — i.e. `$this->db` IS
 * already the contexts DB connection in every real deployment. `conversation_contexts` lives
 * in that same database (backend/schema/chatbot.sql), which is why `ContextController.ts`
 * (the existing conversation_contexts CRUD port) already just reuses the shared `db` export
 * with no second connection. Opening a fresh mysql2 pool here would be a second, redundant
 * connection to the identical host/credentials — so `archiveRun()` below reuses `db` directly
 * instead of re-implementing `connectFromConfig()`.
 */
export class SessionSearchService {
  /**
   * Insert one archived run row into `conversation_contexts`.
   * Mirrors the INSERT in GraphWorkflowRunner.php::archiveRunToConversationContexts()
   * (columns: user_id, title, context_data, provider, message_count).
   * Returns the new row's id (PDO::lastInsertId() equivalent).
   */
  static async archiveRun(row: {
    userId: number;
    title: string;
    contextData: string;
    provider: string;
    messageCount: number;
  }): Promise<number> {
    const res = await db
      .insertInto('conversation_contexts')
      .values({
        user_id: row.userId,
        title: row.title,
        context_data: row.contextData,
        provider: row.provider,
        message_count: row.messageCount,
      } as any)
      .executeTakeFirst();
    return Number(res.insertId ?? 0);
  }

  private static readonly DEFAULT_LIMIT = 5;
  private static readonly MAX_LIMIT = 15;
  private static readonly SNIPPET_CHARS = 600;

  /**
   * Register `session_search` on the given ToolsManager, scoped to `userId` (the handler captures
   * it, so the LLM cannot search another user). False for a non-positive id. PHP also returns false
   * when the contexts_database connection fails; here that connection is the shared `db`.
   */
  static registerAsTool(tools: ToolsManager, userId: number): boolean {
    if (userId <= 0) return false;
    tools.registerFunction(
      'session_search',
      async (params: any) => {
        const query = String(params?.query ?? '').trim();
        const limit = params?.limit !== undefined && params?.limit !== null ? Math.trunc(Number(params.limit)) || 0 : 5;
        if (query === '') return { error: 'query is required' };
        const hits = await SessionSearchService.search(userId, query, limit);
        return { query, hit_count: hits.length, hits };
      },
      {
        description:
          "Search the current user's past chat conversations (lexical / BM25-ranked full-text search) and return the most relevant sessions with short snippets. Use this when you need to recall what the user said or decided in prior discussions. The search is keyword-based, so pick words likely to appear literally in a past transcript.",
        input_schema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Keywords to match in past conversations (e.g. "GLP-1 heart failure", "auth microservice Redis").',
            },
            limit: {
              type: 'integer',
              description: 'Max number of sessions to return (default 5, max 15).',
              minimum: 1,
              maximum: 15,
            },
          },
          required: ['query'],
        },
      },
    );
    return true;
  }

  /** FULLTEXT search over the user's conversations: [{id, title, created_at, updated_at, provider, message_count, score, snippet}]. */
  static async search(userId: number, query: string, limit: number = SessionSearchService.DEFAULT_LIMIT): Promise<any[]> {
    query = query.trim();
    if (query === '') return [];
    limit = Math.max(1, Math.min(limit, SessionSearchService.MAX_LIMIT));

    let rows: any[];
    try {
      rows = (
        await sql<any>`
            SELECT id, title, created_at, updated_at, provider, message_count,
                   MATCH(context_data) AGAINST(${query} IN NATURAL LANGUAGE MODE) AS score,
                   context_data
            FROM conversation_contexts
            WHERE user_id = ${userId}
              AND MATCH(context_data) AGAINST(${query} IN NATURAL LANGUAGE MODE)
            ORDER BY score DESC
            LIMIT ${sql.raw(String(limit))}
        `.execute(db)
      ).rows;
    } catch (e: any) {
      console.error('[SessionSearchService] search failed: ' + (e?.message ?? e));
      return [];
    }

    const terms = SessionSearchService.queryTerms(query);
    return rows.map((row) => ({
      id: Number(row.id),
      title: String(row.title ?? ''),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      provider: String(row.provider ?? ''),
      message_count: Number(row.message_count ?? 0) || 0,
      score: Number(row.score),
      snippet: SessionSearchService.buildSnippet(SessionSearchService.extractPlainText(String(row.context_data)), terms, SessionSearchService.SNIPPET_CHARS),
    }));
  }

  /** Every `content` in a context_data blob (a message list, or one under "messages"), one per line. */
  static extractPlainText(json: string): string {
    let decoded: any;
    try {
      decoded = JSON.parse(json);
    } catch {
      return json;
    }
    if (decoded === null || typeof decoded !== 'object') return json;
    const messages = decoded.messages ?? decoded;
    if (messages === null || typeof messages !== 'object') return json;

    const parts: string[] = [];
    for (const m of Object.values(messages) as any[]) {
      if (m === null || typeof m !== 'object') continue;
      const content = m.content ?? null;
      if (typeof content === 'string' && content !== '') {
        parts.push((m.role !== undefined && m.role !== null ? m.role + ': ' : '') + content);
      } else if (content !== null && typeof content === 'object') {
        // Claude-style content blocks: [{type: "text", text: "..."}]
        for (const block of Object.values(content) as any[]) {
          if (block && typeof block === 'object' && typeof block.text === 'string') {
            parts.push((m.role ?? '') + ': ' + block.text);
          }
        }
      }
    }
    return parts.join('\n');
  }

  private static queryTerms(q: string): string[] {
    return q.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => mbLen(t) >= 3);
  }

  /** A window of text around the first matching term, else the head of the transcript. */
  static buildSnippet(text: string, terms: string[], maxChars: number): string {
    const len = mbLen(text);
    if (len <= maxChars) return text;

    const lower = Array.from(text.toLowerCase());
    const lowerStr = lower.join('');
    let hitPos: number | null = null;
    for (const t of terms) {
      const at = lowerStr.indexOf(t);
      if (at !== -1) {
        hitPos = Array.from(lowerStr.slice(0, at)).length;
        break;
      }
    }
    if (hitPos === null) return mbSub(text, 0, maxChars) + '…';

    const half = Math.floor(maxChars / 2);
    const start = Math.max(0, hitPos - half);
    return (start > 0 ? '…' : '') + mbSub(text, start, maxChars) + (start + maxChars < len ? '…' : '');
  }
}
