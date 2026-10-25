import { PlaybookActionSpace } from './PlaybookActionSpace';
import { PlaybookDocument } from './PlaybookDocument';
import { PlaybookRunState } from './PlaybookRunState';
import { PlaybookTranscript } from './PlaybookTranscript';
import { phpArray, phpBool, phpJson, phpStr, phpTrim, uniqid } from './php';

export type LlmToolCall = { id?: string; name: string; arguments?: Record<string, any> };
export type LlmResponse = { text?: string | null; tool_calls?: LlmToolCall[] };
/** One LLM round: the running messages and the tool definitions in, text and/or tool calls out. */
export type PlaybookLlm = (messages: any[], toolDefs: any[]) => Promise<LlmResponse> | LlmResponse;
export type PlaybookEventSink = (event: Record<string, any>) => void;

const SYSTEM_PROMPT_TEMPLATE = `You are a playbook interpreter for {domain}. Execute the PLAYBOOK below
for the current REQUEST, step by step, using ONLY the tools provided.
Rules:
- Never invent tool results, user input, or tools. If information from the requester
  is missing, you must obtain it through the provided tools; if an action has no
  working tool (an "unbound" tool tells you so), follow its guidance instead of guessing.
- Take parameters for later steps from earlier tool results.
- When the playbook says Stop or the work is complete, call resolve_request.
- Record what you did with leave_internal_note before resolving, as the playbook asks.
PLAYBOOK:
{instructions}
POLICY: {policy_json}
REQUESTER: {requester_json}
APPROVERS: {approvers_json}`;

const MESSAGE_TOOL_NAMES = ['send_direct_message', 'send_channel_message', 'send_email'];

/**
 * The interpreter loop: the LLM re-decides each round from the running transcript of tool calls and
 * results. Each round calls the LLM with the messages and tool defs, executes the tool calls through
 * the action space, appends the results, and repeats until the LLM stops calling tools, a result is
 * terminal (resolve_request) or ends the leg at a gate, or the round budget runs out.
 * Mirrors backend/src/Playbook/PlaybookInterpreter.php.
 */
export class PlaybookInterpreter {
  constructor(
    private readonly space: PlaybookActionSpace,
    private readonly state: PlaybookRunState,
    private readonly transcript: PlaybookTranscript,
    private readonly llm: PlaybookLlm,
    private readonly maxRounds: number = 40,
    private readonly onEvent: PlaybookEventSink | null = null,
  ) {}

  async runLeg(runId: number, leg: number, doc: PlaybookDocument, variables: any, requester: any, requestText: string): Promise<{ status: string; output: string }> {
    const toolDefs = this.space.toolDefinitions();
    const messages: any[] = [
      { role: 'system', content: this.buildSystemPrompt(doc, requester) },
      { role: 'user', content: this.buildUserMessage(requestText, variables) },
    ];

    this.transcript.append(runId, { type: 'leg_started', leg });
    this.transcript.append(runId, { type: 'prompt', leg, text: requestText });

    for (let round = 1; round <= this.maxRounds; round++) {
      this.emit({ type: 'round', leg, round });

      const response = await this.llm(messages, toolDefs);
      const text = response.text ?? null;
      const toolCalls: LlmToolCall[] = (response.tool_calls ?? []).map((c) => ({ ...c }));

      if (toolCalls.length === 0) {
        return this.endLeg(runId, leg, await this.currentStatus(runId), text ?? '');
      }

      // Normalize once so the assistant message and its tool-result messages agree on the id.
      for (const tc of toolCalls) {
        if (tc.id === undefined || tc.id === null) tc.id = uniqid('tc_');
      }

      messages.push(this.buildAssistantMessage(text, toolCalls));

      let terminal = false;
      let handedOff = false; // an unattended gate handed the run off: nothing else runs
      let summary = ''; // resolve_request's summary: the run's answer, not the turn's narration
      for (const toolCall of toolCalls) {
        const name = phpStr(toolCall.name);
        const args: Record<string, any> = phpArray(toolCall.arguments ?? []);

        if (handedOff) {
          // The remaining calls of this turn are never executed, but each still gets a tool message so
          // the history stays well-formed.
          const skipped = { ok: false, error: 'the run was handed off at a gate' };
          this.transcript.append(runId, { type: 'tool_skipped', leg, round, name, result: skipped });
          messages.push({ role: 'tool', tool_call_id: toolCall.id ?? uniqid('tc_'), name, content: phpJson(skipped) });
          continue;
        }

        this.transcript.append(runId, { type: 'tool_call', leg, round, name, args });
        this.emit({ type: 'tool_call', leg, round, name, args });

        if (MESSAGE_TOOL_NAMES.includes(name)) {
          // Live delivery gets the real text; only the DB copy is redacted when sensitive.
          this.emit({ type: 'message', text: phpStr(args.text ?? ''), sensitive: phpBool(args.sensitive ?? false) });
        }

        const result = await this.space.execute(runId, leg, name, args);

        this.transcript.append(runId, { type: 'tool_result', leg, round, name, result });
        this.emit({ type: 'tool_result', leg, round, name, result });

        messages.push({ role: 'tool', tool_call_id: toolCall.id ?? uniqid('tc_'), name, content: phpJson(result) });

        if (result.terminal === true || result.gate_ended_leg === true) terminal = true;
        if (result.unattended === true) {
          handedOff = true;
          continue;
        }
        if (name === 'resolve_request') summary = phpTrim(phpStr(args.summary ?? ''));
      }

      if (terminal) {
        return this.endLeg(runId, leg, await this.currentStatus(runId), summary !== '' ? summary : (text ?? ''));
      }
    }

    // Round budget exhausted.
    await this.state.setStatus(runId, 'failed');
    await this.space.execute(runId, leg, 'leave_internal_note', {
      text: `Round budget of ${this.maxRounds} exhausted without resolving the request.`,
    });
    return this.endLeg(runId, leg, 'failed', '');
  }

  private endLeg(runId: number, leg: number, status: string, output: string): { status: string; output: string } {
    this.transcript.append(runId, { type: 'leg_ended', leg, status });
    this.emit({ type: 'final', leg, status, text: output });
    return { status, output };
  }

  private async currentStatus(runId: number): Promise<string> {
    const run = await this.state.getRun(runId);
    return phpStr(run.status ?? 'failed');
  }

  private buildAssistantMessage(text: string | null, toolCalls: LlmToolCall[]): Record<string, any> {
    const calls = toolCalls.map((tc) => ({
      id: tc.id ?? uniqid('tc_'),
      type: 'function',
      function: { name: tc.name, arguments: phpJson(phpArray(tc.arguments ?? [])) },
    }));
    return { role: 'assistant', content: text, tool_calls: calls };
  }

  private buildSystemPrompt(doc: PlaybookDocument, requester: any): string {
    // {} (not []) when the document has no approvers: it reads unambiguously as "none".
    const approvers = doc.approvers;
    const noApprovers = approvers === null || approvers === undefined
      || (Array.isArray(approvers) ? approvers.length === 0 : typeof approvers === 'object' && Object.keys(approvers).length === 0);
    const values: Record<string, string> = {
      '{domain}': doc.domain !== '' ? doc.domain : 'this organization',
      '{instructions}': doc.instructions,
      '{policy_json}': phpJson(doc.policy),
      '{requester_json}': phpJson(requester),
      '{approvers_json}': noApprovers ? '{}' : phpJson(approvers),
    };
    // str_replace with arrays: each search is replaced in turn over the running subject.
    let out = SYSTEM_PROMPT_TEMPLATE;
    for (const [search, replace] of Object.entries(values)) out = out.split(search).join(replace);
    return out;
  }

  private buildUserMessage(requestText: string, variables: any): string {
    const lines = ['REQUEST:', requestText];
    const empty = variables === null || variables === undefined
      || (Array.isArray(variables) ? variables.length === 0 : typeof variables === 'object' && Object.keys(variables).length === 0);
    if (!empty) lines.push('VARIABLES: ' + phpJson(variables));
    return lines.join('\n');
  }

  private emit(event: Record<string, any>): void {
    if (this.onEvent !== null) this.onEvent(event);
  }
}
