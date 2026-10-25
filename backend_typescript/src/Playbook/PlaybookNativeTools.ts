import { PlaybookRunState } from './PlaybookRunState';
import { phpBool, phpStr } from './php';

const fn = (name: string, description: string, properties: Record<string, any>, required: string[]) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

/**
 * The built-in verbs every playbook may use: messages, notes, priority, resolve. They act on the run
 * record only. Mirrors backend/src/Playbook/PlaybookNativeTools.php.
 */
export class PlaybookNativeTools {
  constructor(private readonly state: PlaybookRunState) {}

  definitions(): any[] {
    return [
      fn('send_direct_message', 'Send a message directly to the requester', {
        text: { type: 'string', description: 'Message text' },
        sensitive: { type: 'boolean', description: 'Mark as sensitive for redaction' },
      }, ['text']),
      fn('send_channel_message', 'Send a message to a channel', {
        channel: { type: 'string', description: 'Channel name' },
        text: { type: 'string', description: 'Message text' },
      }, ['channel', 'text']),
      fn('send_email', 'Send an email', {
        to: { type: 'string', description: 'Email recipient' },
        subject: { type: 'string', description: 'Email subject' },
        text: { type: 'string', description: 'Email body' },
      }, ['to', 'subject', 'text']),
      fn('leave_internal_note', 'Leave an internal note on the run', {
        text: { type: 'string', description: 'Note text' },
      }, ['text']),
      fn('set_priority', 'Set the priority of the request', {
        priority: { type: 'string', description: 'Priority level' },
        reason: { type: 'string', description: 'Reason for priority' },
      }, ['priority', 'reason']),
      fn('resolve_request', 'Mark the request as resolved', {
        outcome: { type: 'string', description: 'Resolution outcome' },
        summary: { type: 'string', description: 'Resolution summary' },
      }, ['outcome', 'summary']),
    ];
  }

  async execute(runId: number, leg: number, name: string, args: Record<string, any>): Promise<Record<string, any>> {
    switch (name) {
      case 'send_direct_message':
        await this.state.addMessage(runId, 'to_requester', null, phpStr(args.text ?? ''), phpBool(args.sensitive ?? false));
        return { ok: true };
      case 'send_channel_message':
        await this.state.addMessage(runId, 'to_channel', phpStr(args.channel ?? ''), phpStr(args.text ?? ''), false);
        return { ok: true };
      case 'send_email':
        await this.state.addMessage(runId, 'to_email', phpStr(args.to ?? ''), phpStr(args.text ?? ''), false);
        return { ok: true };
      case 'leave_internal_note':
        await this.state.addNote(runId, phpStr(args.text ?? ''), 'agent');
        return { ok: true };
      case 'set_priority':
        await this.state.addNote(runId, `priority → ${phpStr(args.priority ?? '')}: ${phpStr(args.reason ?? '')}`, 'agent');
        return { ok: true };
      case 'resolve_request':
        await this.state.setStatus(runId, 'resolved');
        return { ok: true, terminal: true };
      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  }
}
