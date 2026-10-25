import { PlaybookRunState } from './PlaybookRunState';
import { isAssoc, phpArray, phpEmpty, phpStr } from './php';

/**
 * Presents a human gate (form / approval / handoff / await-message) and waits until it is answered
 * or times out. Mirrors backend/src/Playbook/GateBridgeInterface.php.
 */
export interface GateBridge {
  /** The decision payload the human gave, or null on timeout. */
  ask(runId: number, kind: string, payload: Record<string, any>, timeoutMs: number): Promise<Record<string, any> | null>;
}

const KIND_MAP: Record<string, { kind: string; asked_of: string; status: string }> = {
  trigger_form: { kind: 'form', asked_of: 'requester', status: 'awaiting_requester' },
  request_approval: { kind: 'approval', asked_of: 'approver', status: 'awaiting_approval' },
  prompt_handoff: { kind: 'handoff', asked_of: 'operator', status: 'handed_off' },
  await_message: { kind: 'await_message', asked_of: 'requester', status: 'awaiting_requester' },
};

/**
 * Immediate-mode human gates: trigger_form / request_approval / prompt_handoff / await_message.
 * execute() opens a playbook_run_gates row, moves the run into the matching waiting status, waits on
 * the bridge, then closes the row and returns the run to 'running' before handing the decision back
 * to the interpreter as an ordinary tool result. Unattended: never waits, never auto-approves — the
 * gate closes and the run is handed off. Mirrors backend/src/Playbook/GateManager.php.
 */
export class GateManager {
  static readonly REDACTED = '«redacted»';

  constructor(
    private readonly state: PlaybookRunState,
    private readonly bridge: GateBridge,
    private readonly timeoutMs: number = 900000,
    private readonly unattended: boolean = false,
  ) {}

  definitions(): any[] {
    return [
      {
        type: 'function',
        function: {
          name: 'trigger_form',
          description: 'Present a form to the requester and wait for it to be submitted',
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Instructions shown above the form' },
              fields: {
                type: 'array',
                description: 'Form fields to collect',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    label: { type: 'string' },
                    type: { type: 'string' },
                    options: { type: 'array', items: { type: 'string' } },
                    sensitive: { type: 'boolean', description: "Redact this field's value when stored" },
                  },
                  required: ['name', 'label', 'type'],
                },
              },
            },
            required: ['prompt', 'fields'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'request_approval',
          description: 'Ask an approver to approve or deny an action and wait for their decision',
          parameters: {
            type: 'object',
            properties: {
              approver: { type: 'string', description: 'Who must approve' },
              question: { type: 'string', description: 'What is being approved' },
              context: { type: 'string', description: 'Supporting context for the decision' },
            },
            required: ['approver', 'question'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'prompt_handoff',
          description: 'Hand off to a human team or person and wait for their response',
          parameters: {
            type: 'object',
            properties: {
              team_or_person: { type: 'string', description: 'Who to hand off to' },
              reason: { type: 'string', description: 'Why this needs a human' },
              summary: { type: 'string', description: 'Summary of the situation so far' },
            },
            required: ['team_or_person', 'reason'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'await_message',
          description: 'Wait for a message from the requester before continuing',
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'What to wait for' },
            },
            required: ['prompt'],
          },
        },
      },
    ];
  }

  async execute(runId: number, leg: number, name: string, args: Record<string, any>): Promise<Record<string, any>> {
    const mapping = KIND_MAP[name];
    if (mapping === undefined) {
      return { ok: false, error: `Unknown gate: ${name}` };
    }

    const gateId = await this.state.gateOpen(runId, leg, mapping.kind, args, mapping.asked_of);

    // Unattended (server-side runner, compiled --watch): never wait and never auto-approve. Close the
    // gate and hand the run off; the interpreter ends the leg on gate_ended_leg.
    if (this.unattended) {
      await this.state.gateClose(gateId, { decision: 'unattended' }, '');
      await this.state.setStatus(runId, 'handed_off');
      return { ok: false, gate_ended_leg: true, unattended: true, kind: mapping.kind };
    }

    await this.state.setStatus(runId, mapping.status);
    this.state.disconnect();

    const answer = await this.bridge.ask(runId, mapping.kind, args, this.timeoutMs);

    if (answer === null) {
      await this.state.gateClose(gateId, { decision: 'timeout' }, '');
      await this.state.setStatus(runId, 'running');
      return {
        ok: false,
        timeout: true,
        guidance: 'No human answered in time. Leave an internal note and resolve as uncompleted.',
      };
    }

    const actor = phpStr(answer.actor ?? '');
    await this.state.gateClose(gateId, GateManager.redactSensitiveFields(args, answer), actor);
    await this.state.setStatus(runId, 'running');

    return { ok: true, decision: answer };
  }

  /**
   * Replace the values of any fields[].sensitive === true name inside decision with the redaction
   * marker. Used for what GateManager stores and what PlaybookActionSpace ledgers; the caller always
   * still gets the decision verbatim.
   */
  static redactSensitiveFields(args: Record<string, any>, decision: Record<string, any>): Record<string, any> {
    const sensitiveNames: string[] = [];
    for (const field of Object.values(phpArray(args.fields ?? []))) {
      if (isAssoc(field) && !phpEmpty(field.sensitive)) sensitiveNames.push(phpStr(field.name ?? ''));
    }
    if (sensitiveNames.length === 0) return decision;
    const redacted: Record<string, any> = { ...decision };
    for (const fieldName of sensitiveNames) {
      if (Object.prototype.hasOwnProperty.call(redacted, fieldName)) redacted[fieldName] = GateManager.REDACTED;
    }
    return redacted;
  }
}
