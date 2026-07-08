import { randomBytes } from 'crypto';

/**
 * Rendezvous between a workflow run-stream (SSE) and the browser-side Pyodide
 * dispatcher's tool-result POST.
 *
 * When the runner detects a `run_skill_script` tool call, it emits an SSE
 * `client_tool_call` event with a generated tool_call_id and then blocks on
 * awaitResult(). The browser runs the script, POSTs the result to
 * /api/v1/workflows/tool-result, the controller calls writeResult(), the
 * runner picks it up and continues.
 *
 * PHP (src/AgentTeam/Services/SkillToolBridge.php) uses /tmp file polling
 * because each PHP request is a separate process, so the SSE run and the
 * tool-result POST cannot share memory. The TS backend is a SINGLE Node
 * process — the run-stream handler and the tool-result POST run in the same
 * process and heap — so an in-memory Map of pending resolvers is equivalent
 * and cleaner (no filesystem, no polling latency).
 *
 * Tool-call ids are 32-char random hex (~128 bits) so a forged POST to the
 * result endpoint can't collide with a real pending call.
 */

const DEFAULT_TIMEOUT_MS = 300_000; // 5 min — matches PHP DEFAULT_TIMEOUT_MS

/** Pending resolvers keyed by tool_call_id. Latest-write-wins on the value. */
const pending = new Map<string, (result: any) => void>();

export class SkillToolBridge {
  static generateToolCallId(): string {
    return randomBytes(16).toString('hex');
  }

  /**
   * Block until the browser writes a result for `toolCallId`, or the timeout
   * expires. Resolves with the decoded result on success, `null` on timeout.
   * The map entry and timer are cleaned up on either path.
   */
  static awaitResult(toolCallId: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<any | null> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (value: any | null): void => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        // Only clear the map entry if it still points at THIS resolver, so a
        // late awaitResult for a reused id (there shouldn't be one — ids are
        // unique) can't be clobbered by a previous timeout.
        if (pending.get(toolCallId) === resolver) {
          pending.delete(toolCallId);
        }
        resolve(value);
      };

      const resolver = (result: any): void => finish(result);

      pending.set(toolCallId, resolver);
      timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  /**
   * Write the browser's result for `toolCallId`. Latest-write-wins: if a
   * resolver is registered, invoke it with `result`. If none is registered
   * (a late or duplicate POST for an already-settled call), this is a no-op.
   */
  static writeResult(toolCallId: string, result: any): void {
    const resolver = pending.get(toolCallId);
    if (resolver) {
      resolver(result);
    }
  }
}
