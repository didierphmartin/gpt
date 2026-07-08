import fs from 'fs';
import path from 'path';

/**
 * Faithful port of src/AgentTeam/Services/WorkflowRunLog.php.
 *
 * Per-run append-only event log. One JSONL file per workflow run, written as events are emitted, so
 * a run is debuggable after it ends, dies, loops, or its SSE stream drops. Read back by the node form
 * via the events endpoint (GET /api/v1/workflows/runs/{runId}/events).
 *
 * PHP uses file_put_contents(..., FILE_APPEND | LOCK_EX) — a synchronous, advisory-locked append.
 * Node's single-threaded event loop has no equivalent multi-process race for a single instance, so a
 * plain synchronous append (fs.appendFileSync) reproduces the same on-disk semantics (one JSON object
 * per line, appended atomically enough for our single-process server) without needing a lock.
 */
export class WorkflowRunLog {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir.replace(/\/+$/, '');
  }

  /**
   * PHP: dirname(__DIR__, 3) from backend/src/AgentTeam/Services = backend, so the default dir is
   * backend/storage/workflow-runs. This file lives at backend_typescript/src/AgentTeam/ (one
   * directory shallower — no Services/ nesting), so two levels up from __dirname reaches
   * backend_typescript/, giving the analogous backend_typescript/storage/workflow-runs.
   */
  static defaultDir(config: Record<string, any> = {}): string {
    return config.workflow_runs_dir ?? path.resolve(__dirname, '../../storage/workflow-runs');
  }

  pathFor(runId: string): string {
    return this.baseDir + '/' + runId + '.jsonl';
  }

  private isValidRunId(runId: string): boolean {
    return /^[a-f0-9]{32}$/.test(runId);
  }

  append(runId: string, event: Record<string, any>): void {
    if (!this.isValidRunId(runId)) {
      console.error('[WorkflowRunLog] refusing append for invalid runId');
      return;
    }
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o775 });
      }
      let line: string;
      try {
        line = JSON.stringify(event);
      } catch {
        console.error(`[WorkflowRunLog] json_encode failed for runId=${runId}`);
        return;
      }
      // PHP's JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE: JSON.stringify already leaves '/' and
      // non-ASCII characters unescaped, so no post-processing is needed to match.
      fs.appendFileSync(this.pathFor(runId), line + '\n');
    } catch (e: any) {
      console.error(`[WorkflowRunLog] append failed for runId=${runId}: ${e?.message ?? e}`);
    }
  }

  read(runId: string): Record<string, any>[] | null {
    if (!this.isValidRunId(runId)) {
      return null;
    }
    const filePath = this.pathFor(runId);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return null;
    }
    const events: Record<string, any>[] = [];
    const contents = fs.readFileSync(filePath, 'utf8');
    for (const line of contents.split('\n')) {
      if (line === '') continue; // FILE_SKIP_EMPTY_LINES
      let decoded: any;
      try {
        decoded = JSON.parse(line);
      } catch {
        continue; // json_decode failure — skip, matching PHP's is_array() guard
      }
      if (decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)) {
        events.push(decoded);
      } else if (Array.isArray(decoded)) {
        // PHP json_decode(..., true) turns BOTH JSON objects and arrays into PHP arrays, and
        // is_array() accepts either — so a JSON array line would also be kept there.
        events.push(decoded as any);
      }
    }
    return events;
  }
}
