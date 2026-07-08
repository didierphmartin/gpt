import { db } from '../db/pools';

/**
 * Partial port of src/AgentTeam/Services/SessionSearchService.php.
 *
 * PHP's SessionSearchService is two things bolted together: (1) a `connectFromConfig(config)`
 * factory that opens a dedicated PDO connection to the `contexts_database` (CTX_DB_* env) —
 * a database SEPARATE from whatever `$this->db` the calling request happened to be using —
 * and (2) a lexical FULLTEXT `search()` + `registerAsTool()` surface for the `session_search`
 * tool (Hermes Layer 3).
 *
 * Only the piece GraphWorkflowRunner.archiveRunToConversationContexts() needs is ported here:
 * the ability to write a finished workflow run into `conversation_contexts`. The `search()` /
 * `registerAsTool()` lexical-search API is intentionally NOT ported (out of scope for the
 * archival gap; PHP itself notes this service is "runtime-only", not touched by the graph
 * generator, and duplicating a whole FULLTEXT search + snippet-builder is unrelated work).
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
}
