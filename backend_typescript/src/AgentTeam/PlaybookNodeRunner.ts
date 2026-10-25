import { sql } from 'kysely';
import { db } from '../db/pools';
import { MCPToolsLoader } from '../Services/MCPToolsLoader';
import { LoaderMcpExecutor } from '../Playbook/Adapters/LoaderMcpExecutor';
import { SkillBridgeGateBridge } from '../Playbook/Adapters/SkillBridgeGateBridge';
import { WorkflowLlmClient } from '../Playbook/Adapters/WorkflowLlmClient';
import { GateBridge, GateManager } from '../Playbook/GateManager';
import { McpExecutor, PlaybookActionSpace } from '../Playbook/PlaybookActionSpace';
import { PlaybookAnalyzer } from '../Playbook/PlaybookAnalyzer';
import { PlaybookDocument } from '../Playbook/PlaybookDocument';
import { PlaybookInterpreter, PlaybookLlm } from '../Playbook/PlaybookInterpreter';
import { PlaybookNativeTools } from '../Playbook/PlaybookNativeTools';
import { PlaybookRunState } from '../Playbook/PlaybookRunState';
import { PlaybookTranscript } from '../Playbook/PlaybookTranscript';
import { phpEmpty, phpStr } from '../Playbook/php';
import { WorkflowRunLog } from './WorkflowRunLog';

export type Emit = (event: Record<string, any>) => void;
export type PlaybookNodeResult = { output: string; run_id: number; status: string; gate: string | null };

export interface PlaybookNodeRunnerFactories {
  /** nodeConfig -> the LLM round function */
  llm?: (nodeConfig: Record<string, any>) => PlaybookLlm;
  /** userId -> the MCP executor */
  mcp?: (userId: number) => Promise<McpExecutor> | McpExecutor;
  /** emit -> the gate bridge */
  bridge?: (emit: Emit) => GateBridge;
}

/** json_encode($v, JSON_UNESCAPED_UNICODE): slashes escaped. */
function jsonUnicode(v: any): string {
  return JSON.stringify(v).replace(/\//g, '\\/');
}

/**
 * Server-side entry point for one playbook node: parse the node's playbook, wire the playbook library
 * (analyzer -> run state -> native tools -> gates -> action space -> interpreter) and run one leg to
 * completion. Every real collaborator (MCP executor, LLM, gate bridge) comes from an overridable
 * factory so tests run against fakes. Mirrors backend/src/AgentTeam/Services/PlaybookNodeRunner.php.
 */
export class PlaybookNodeRunner {
  constructor(
    private readonly config: Record<string, any> = {},
    private readonly factories: PlaybookNodeRunnerFactories = {},
  ) {}

  /** unattended: no human present, any gate ends the run as handed_off. */
  async run(userId: number, nodeConfig: Record<string, any>, requestText: string, emit: Emit, unattended = false): Promise<PlaybookNodeResult> {
    let doc = PlaybookNodeRunner.parseDocument(nodeConfig.playbook ?? null);

    // Node-level write authorization: markdown playbooks cannot set policy.writes_enabled, so the node
    // config carries an explicit toggle. JSON documents keep their own policy unless it is set.
    if (!phpEmpty(nodeConfig.writes_enabled)) {
      const arr = doc.toArray();
      arr.policy = { ...(arr.policy ?? {}), writes_enabled: true };
      doc = PlaybookDocument.fromArray(arr);
    }

    const mcp = this.factories.mcp ? await this.factories.mcp(userId) : await PlaybookNodeRunner.defaultMcp(userId);

    // Bound agent.* targets have no invocation path yet, so no agent names are resolved here.
    const analysis = new PlaybookAnalyzer().analyze(doc, Object.keys(mcp.availableTools()), []);
    if (analysis.errors.length) {
      throw new Error('Playbook has unresolved bindings: ' + analysis.errors.join('; '));
    }

    // Capture every event so the node's OUTPUT can mirror the run overlay.
    const events: Record<string, any>[] = [];
    let unattendedGate: string | null = null;
    const emitAll: Emit = (ev) => {
      events.push(ev);
      // The first unattended gate wins (the run ends there).
      if (unattendedGate === null && ev.type === 'tool_result' && !phpEmpty(ev.result?.unattended)) {
        unattendedGate = phpStr(ev.result?.kind ?? '');
      }
      emit(ev);
    };

    const transcript = new PlaybookTranscript(WorkflowRunLog.defaultDir(this.config));
    const state = new PlaybookRunState(transcript);

    const requester = await PlaybookNodeRunner.buildRequester(userId);
    const runId = await state.createRun(userId, doc, requester, []);

    const native = new PlaybookNativeTools(state);
    const bridge = this.factories.bridge ? this.factories.bridge(emitAll) : new SkillBridgeGateBridge(emitAll);
    const gates = new GateManager(state, bridge, 900000, unattended);
    const space = new PlaybookActionSpace(analysis.actions, native, mcp, state, doc.policy, gates);

    let llm: PlaybookLlm;
    if (this.factories.llm) {
      llm = this.factories.llm(nodeConfig);
    } else {
      const client = new WorkflowLlmClient(nodeConfig);
      llm = (messages, toolDefs) => client.invoke(messages, toolDefs);
    }

    const interpreter = new PlaybookInterpreter(space, state, transcript, llm, 40, emitAll);
    const result = await interpreter.runLeg(runId, 0, doc, [], requester, requestText);

    let status = String(result.status);
    if (unattendedGate !== null && status !== 'handed_off') {
      // Defence in depth: an unattended gate hands the run off, whatever happened after it.
      status = 'handed_off';
      await state.setStatus(runId, 'handed_off');
    }

    const output = PlaybookNodeRunner.renderTranscript(doc.title, events, String(result.output ?? ''), runId, status);
    return { output, run_id: runId, status, gate: unattendedGate };
  }

  /**
   * The node's output text: a Markdown transcript mirroring the run overlay — tool calls with ✓/✗, the
   * playbook's messages (sensitive ones redacted), human gates with their decision, then the final
   * result and status. Twin of workflow-editor.js _pbTranscriptText.
   */
  static renderTranscript(title: string, events: Record<string, any>[], finalOutput: string, runId: number | null, status: string): string {
    const gateTitles: Record<string, string> = {
      approval: 'Approval requested', form: 'Form request', handoff: 'Handed off to a human',
      await_message: 'Waiting for the requester', wait: 'Waiting',
    };
    const gateTools = ['request_approval', 'trigger_form', 'prompt_handoff', 'await_message', 'wait_until'];
    const lines: string[] = [];
    const pendingTools: Record<string, number> = {};
    const str = (v: any): string => (v === null || v === undefined || typeof v !== 'object' ? phpStr(v).trim() : jsonUnicode(v));
    const isArr = (v: any) => v !== null && typeof v === 'object';
    for (const ev of events) {
      const type = phpStr(ev.type ?? '');
      if (type === 'tool_call') {
        const name = phpStr(ev.name ?? 'tool');
        if (gateTools.includes(name)) continue; // rendered via gate_request + decision
        lines.push(`- 🔧 ${name} …`);
        pendingTools[name] = lines.length - 1;
      } else if (type === 'tool_result') {
        const name = phpStr(ev.name ?? 'tool');
        let res: Record<string, any> = isArr(ev.result) ? ev.result : {};
        if (gateTools.includes(name)) {
          // GateManager stores the whole answer under 'decision'; unwrap it.
          let d: any = res.decision ?? (res.status ?? '');
          if (isArr(d)) {
            res = { ...res, ...d };
            d = d.decision ?? (d.status ?? (d.outcome ?? 'answered'));
          }
          const decision = str(d);
          const comment = str(res.comment ?? '');
          if (decision !== '') lines.push(`  → ${decision}` + (comment !== '' ? ` (${comment})` : ''));
          continue;
        }
        const ok = (res.ok ?? true) !== false;
        const mark = ok ? '✓' : '✗';
        if (pendingTools[name] !== undefined) {
          lines[pendingTools[name]] = `- 🔧 ${name} ${mark}` + (!ok && !phpEmpty(res.error) ? ' — ' + str(res.error) : '');
          delete pendingTools[name];
        } else {
          lines.push(`- 🔧 ${name} ${mark}`);
        }
      } else if (type === 'message') {
        const text = !phpEmpty(ev.sensitive) ? '(message redacted)' : phpStr(ev.text ?? '').trim();
        if (text !== '') lines.push('- 💬 Playbook:\n' + text.replace(/^/gm, '  '));
      } else if (type === 'gate_request') {
        const kind = phpStr(ev.kind ?? 'gate');
        const p: Record<string, any> = isArr(ev.payload) ? ev.payload : {};
        const what = str(p.question ?? p.prompt ?? (str(p.team_or_person ?? '') + (p.reason !== undefined && p.reason !== null ? ' — ' + str(p.reason) : '')));
        lines.push('- ✋ ' + (gateTitles[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1)) + (what !== '' ? `: ${what}` : ''));
      }
    }
    const head = `# Playbook: ${title}` + (runId !== null ? ` (run ${runId} — ${status})` : ` (${status})`);
    let out = head + '\n\n## Timeline\n' + (lines.length ? lines.join('\n') : '- (no steps recorded)');
    const final = finalOutput.trim();
    if (final !== '') out += '\n\n## Result\n' + final;
    return out + `\n\n[playbook run ${runId ?? ''}: ${status}]`;
  }

  /** The requester the interpreter sees, with email/name from users when available (id only otherwise). */
  private static async buildRequester(userId: number): Promise<Record<string, any>> {
    const requester: Record<string, any> = { id: String(userId) };
    try {
      const row = (await sql<any>`SELECT email, first_name, last_name FROM users WHERE id = ${userId} LIMIT 1`.execute(db)).rows[0];
      if (row) {
        if (!phpEmpty(row.email)) requester.email = row.email;
        const name = (phpStr(row.first_name ?? '') + ' ' + phpStr(row.last_name ?? '')).trim();
        if (name !== '') requester.name = name;
      }
    } catch {
      // users table unavailable — id only.
    }
    return requester;
  }

  static parseDocument(playbook: any): PlaybookDocument {
    if (typeof playbook === 'string') return PlaybookDocument.fromConsoleText(playbook);
    if (playbook !== null && typeof playbook === 'object') return PlaybookDocument.fromArray(playbook);
    throw new Error('nodeConfig.playbook (object or string) is required.');
  }

  private static async defaultMcp(userId: number): Promise<McpExecutor> {
    const loader = new MCPToolsLoader();
    await loader.loadToolsForUser(String(userId));
    return new LoaderMcpExecutor(loader);
  }
}
