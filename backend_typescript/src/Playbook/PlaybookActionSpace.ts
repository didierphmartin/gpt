import { GateManager } from './GateManager';
import { PlaybookNativeTools } from './PlaybookNativeTools';
import { PlaybookRunState } from './PlaybookRunState';
import { AnalyzedAction } from './PlaybookAnalyzer';
import { mbLen, mbSub, phpBool, phpEmpty, phpJson } from './php';

/** The MCP side of a playbook run. Mirrors backend/src/Playbook/McpExecutorInterface.php. */
export interface McpExecutor {
  call(server: string, tool: string, args: Record<string, any>): Promise<Record<string, any>>;
  /** Keyed "server.tool". */
  availableTools(): Record<string, { description: string; input_schema: any }>;
}

type Entry = { kind: 'native' | 'mcp' | 'unbound'; action_name: string; server?: string; tool?: string; target?: string | null };

// Fail-closed write classification: a tool is a WRITE unless its name starts with a read verb, or with
// one namespace token followed by a read verb (aws's iam_list_*).
const READ_VERB_PATTERN = /^(?:[a-z0-9]+_)?(get|list|search|read|find|describe|verify|check|lookup)(_|$)/i;
const UNBOUND_DESCRIPTION = 'NOT AVAILABLE — calling this applies the on_unbound policy';
const GATE_TOOL_NAMES = ['trigger_form', 'request_approval', 'prompt_handoff', 'await_message'];

/**
 * Whitelisted tool surface the LLM sees for one playbook run: native tools plus a definition per
 * bound/unbound analyzer action, with dispatch, a replay guard for MCP writes, and a write-policy
 * gate. Mirrors backend/src/Playbook/PlaybookActionSpace.php.
 */
export class PlaybookActionSpace {
  private map = new Map<string, Entry>();
  private mcpEntries = new Map<string, Entry>();
  private unboundEntries = new Map<string, { action_name: string; note: string }>();

  constructor(
    analyzedActions: AnalyzedAction[] | Record<string, any>[],
    private readonly native: PlaybookNativeTools,
    private readonly mcp: McpExecutor,
    private readonly state: PlaybookRunState,
    private readonly policy: Record<string, any>,
    private readonly gates: GateManager | null = null,
  ) {
    for (const action of analyzedActions as Record<string, any>[]) {
      const name = String(action.name ?? '');
      const kind = String(action.kind ?? '');
      const target: string | null = action.target ?? null;

      if (kind === 'native' && target !== null) {
        this.map.set(target, { kind: 'native', action_name: name, target });
        continue;
      }
      if (kind === 'bound' && target !== null && target.startsWith('agent.')) {
        // Bound agent.* targets have no invocation path yet: treated like unbound (on_unbound applies).
        const llmName = 'unbound__' + this.slug(name);
        this.unboundEntries.set(llmName, {
          action_name: name,
          note: 'NOT AVAILABLE — agent invocation arrives in a later slice; the on_unbound policy applies for now',
        });
        this.map.set(llmName, { kind: 'unbound', action_name: name, target });
        continue;
      }
      if (kind === 'bound' && target !== null) {
        const [server, tool] = this.splitTarget(target);
        const llmName = this.sanitizeTarget(target);
        const entry: Entry = { kind: 'mcp', action_name: name, server, tool, target };
        this.map.set(llmName, entry);
        this.mcpEntries.set(llmName, entry);
        continue;
      }
      const llmName = 'unbound__' + this.slug(name);
      this.unboundEntries.set(llmName, { action_name: name, note: UNBOUND_DESCRIPTION });
      this.map.set(llmName, { kind: 'unbound', action_name: name, target });
    }

    // Native verbs are built-in and executable unconditionally — no binding required.
    for (const def of this.native.definitions()) {
      const toolName = def.function?.name ?? null;
      if (toolName === null || this.map.has(toolName)) continue;
      this.map.set(toolName, { kind: 'native', action_name: toolName, target: toolName });
    }
  }

  toolDefinitions(): any[] {
    let defs: any[] = this.native.definitions();
    const available = this.mcp.availableTools();
    for (const [llmName, entry] of this.mcpEntries) {
      const info = available[entry.target as string] ?? null;
      const mcpDescription = info?.description ?? '';
      const parameters = info?.input_schema ?? { type: 'object', properties: [] };
      const description = (entry.action_name + (mcpDescription !== '' ? ' — ' + mcpDescription : '')).trim();
      defs.push({ type: 'function', function: { name: llmName, description, parameters } });
    }
    for (const [llmName, entry] of this.unboundEntries) {
      defs.push({
        type: 'function',
        function: { name: llmName, description: (entry.action_name + ': ' + entry.note).trim(), parameters: { type: 'object', properties: [] } },
      });
    }
    if (this.gates !== null) defs = defs.concat(this.gates.definitions());
    return defs;
  }

  async execute(runId: number, leg: number, llmToolName: string, args: Record<string, any>): Promise<Record<string, any>> {
    if (this.gates !== null && GATE_TOOL_NAMES.includes(llmToolName)) {
      return this.executeGate(runId, leg, llmToolName, args);
    }
    const entry = this.map.get(llmToolName);
    if (entry === undefined) {
      await this.state.ledgerAppend(runId, leg, llmToolName, llmToolName, args, 'skipped', null);
      return { ok: false, error: 'tool not allowed' };
    }
    switch (entry.kind) {
      case 'native':
        return this.executeNative(runId, leg, llmToolName, entry, args);
      case 'mcp':
        return this.executeMcp(runId, leg, entry, args);
      default:
        return this.executeUnbound(runId, leg, llmToolName, entry, args);
    }
  }

  private async executeGate(runId: number, leg: number, llmToolName: string, args: Record<string, any>): Promise<Record<string, any>> {
    const result = await (this.gates as GateManager).execute(runId, leg, llmToolName, args);
    if (!Object.prototype.hasOwnProperty.call(result, 'decision')) {
      // Unanswered (timeout/error): ledger the failure with the full result.
      await this.state.ledgerAppend(runId, leg, llmToolName, llmToolName, args, 'failed', this.summarize(result));
      return { ...result, gate: result.gate ?? true };
    }
    const decision = result.decision !== null && typeof result.decision === 'object' ? result.decision : {};
    const redacted = GateManager.redactSensitiveFields(args, decision);
    await this.state.ledgerAppend(runId, leg, llmToolName, llmToolName, args, 'ok', this.summarize(redacted));
    return { ...result, gate: result.gate ?? true };
  }

  private async executeNative(runId: number, leg: number, llmToolName: string, entry: Entry, args: Record<string, any>): Promise<Record<string, any>> {
    const result = await this.native.execute(runId, leg, llmToolName, args);
    const outcome = (result.ok ?? false) === false ? 'failed' : 'ok';
    const sensitive = !phpEmpty(args.sensitive);
    await this.state.ledgerAppend(runId, leg, entry.action_name, llmToolName, args, outcome, this.summarize(result), sensitive);
    return result;
  }

  private async executeMcp(runId: number, leg: number, entry: Entry, args: Record<string, any>): Promise<Record<string, any>> {
    const target = entry.target as string;
    const isWrite = this.isWriteTool(entry.tool as string);

    // Replay guard: write-classified tools only (a repeated read re-executes for fresh data).
    if (isWrite) {
      const replay = await this.state.ledgerFindOk(runId, target, args);
      if (replay !== null) {
        await this.state.ledgerAppend(runId, leg, entry.action_name, target, args, 'replayed', replay.result_summary ?? null);
        return { ok: true, outcome: 'replayed', result: replay.result_summary ?? null };
      }
    }

    // Write policy: MCP tools only; native verbs act on the run record and are never blocked.
    const writesEnabled = phpBool(this.policy.writes_enabled ?? false);
    if (!writesEnabled && isWrite) {
      await this.state.ledgerAppend(runId, leg, entry.action_name, target, args, 'skipped', null);
      return { ok: false, error: 'writes disabled by policy' };
    }

    const result = await this.mcp.call(entry.server as string, entry.tool as string, args);
    const outcome = (result.ok ?? false) === false ? 'failed' : 'ok';
    await this.state.ledgerAppend(runId, leg, entry.action_name, target, args, outcome, this.summarize(result));
    return result;
  }

  /** Fail-closed classifier: anything not recognizably read-only counts as a write. */
  private isWriteTool(tool: string): boolean {
    return !READ_VERB_PATTERN.test(tool);
  }

  private async executeUnbound(runId: number, leg: number, llmToolName: string, entry: Entry, args: Record<string, any>): Promise<Record<string, any>> {
    await this.state.ledgerAppend(runId, leg, entry.action_name, llmToolName, args, 'skipped', null);
    const policy = this.policy.on_unbound ?? null;
    if (policy === 'skip') {
      return {
        ok: false, unbound: true, skipped: true,
        guidance: 'This action is unavailable and the policy says skip it: note it in the internal record and continue with the rest of the playbook.',
      };
    }
    if (policy === 'fail') {
      return {
        ok: false, unbound: true, fatal: true,
        guidance: 'This action is unavailable and the policy says fail: leave an internal note and resolve the request as not completed.',
      };
    }
    return {
      ok: false, unbound: true, policy,
      guidance: 'This action has no connected implementation. Follow the policy: hand off to a human with prompt_handoff and note what could not be done.',
    };
  }

  private splitTarget(target: string): [string, string] {
    const dot = target.indexOf('.');
    return dot === -1 ? [target, ''] : [target.slice(0, dot), target.slice(dot + 1)];
  }

  private sanitizeTarget(target: string): string {
    return target.split('.').join('__').replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
  }

  private slug(name: string): string {
    return name.replace(/[^a-z0-9]+/gi, '_').toLowerCase().replace(/^_+|_+$/g, '');
  }

  private summarize(result: Record<string, any>): string | null {
    const json = phpJson(result);
    // Multibyte-safe truncation.
    return mbLen(json) > 500 ? mbSub(json, 0, 500) : json;
  }
}
