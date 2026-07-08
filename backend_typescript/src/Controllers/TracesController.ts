import { Ctx, ControllerResult } from '../Support/Http';
import { ExecutionTraceStore } from '../AgentTeam/ExecutionTraceStore';

/**
 * TracesController — faithful TS mirror of src/Controllers/TracesController.php.
 * Records chat-path execution traces (Phase 0 self-healing). The server owns
 * classification + outcome labelling (ExecutionTraceStore).
 *
 *   POST /api/v1/traces            -> create
 *   GET  /api/v1/traces/diagnosis  -> diagnose
 */

// PHP (int) cast semantics (truncating; bool→1/0; leading-numeric, else 0).
function phpIntVal(v: any): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Math.trunc(v);
  const n = parseInt(String(v), 10);
  return isNaN(n) ? 0 : n;
}

// PHP empty(): true for null/undefined, false, 0, 0.0, '', '0', [].
function phpEmpty(v: any): boolean {
  if (v === undefined || v === null) return true;
  if (v === false) return true;
  if (v === '' || v === '0') return true;
  if (typeof v === 'number') return v === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

// PHP date('Y-m-d H:i:s') (server-local time).
function phpDateYmdHis(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

export class TracesController {
  async create(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id ?? 0;
    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }

    const b = ctx.body ?? {};
    if (!b || typeof b !== 'object' || phpEmpty(b.skill_dir)) {
      return { success: false, error: 'Missing skill_dir', status_code: 400 };
    }

    // Only the two chat-origin modes are accepted here; default to discovery.
    const mode = ['auto_discovery', 'forced'].includes(b.invocation_mode ?? '')
      ? b.invocation_mode : 'auto_discovery';

    const store = new ExecutionTraceStore();
    const id = await store.insert({
      run_id: b.run_id !== undefined ? String(b.run_id) : '',
      ts: phpDateYmdHis(new Date()),
      env: 'chat',
      invocation_mode: mode,
      workflow_id: null,
      node_id: null,
      provider: b.provider ?? null,
      model: b.model ?? null,
      skill_dir: String(b.skill_dir),
      script: b.script ?? null,
      argv: b.argv ?? [],
      input_snapshot: b.input ?? null,
      skill_exit_code: b.exit_code !== undefined && b.exit_code !== null ? phpIntVal(b.exit_code) : null,
      skill_stdout: b.stdout ?? null,
      skill_log_messages: b.log_messages ?? null,
      output_files: Array.isArray(b.output_files) ? b.output_files : [],
      final_text: b.final_text ?? null,
      success: !phpEmpty(b.success),
      loop_detected: !phpEmpty(b.loop_detected),
      tokens_in: phpIntVal(b.tokens_in ?? 0),
      tokens_out: phpIntVal(b.tokens_out ?? 0),
    });

    return { success: id !== null, id };
  }

  /**
   * GET /api/v1/traces/diagnosis?days=30
   * Read-only diagnosis of recent traces.
   */
  async diagnose(ctx: Ctx): Promise<ControllerResult> {
    const userId = ctx.user_id ?? 0;
    if (!userId) {
      return { success: false, error: 'Authentication required', status_code: 401 };
    }
    let days = phpIntVal((ctx.query as any)?.days ?? 30);
    days = Math.max(1, Math.min(365, days));

    const store = new ExecutionTraceStore();
    return { success: true, diagnosis: await store.diagnose(days) };
  }
}
