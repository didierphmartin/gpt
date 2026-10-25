import { PlaybookStore, isValidKey } from '../Playbook/PlaybookStore';
import { RobotAccount } from '../Services/RobotAccount';

/** The parent's text without its leading "## <name>" header line, trimmed. */
function stripHeader(parentText: string): string {
  return parentText.replace(/^\s+/, '').replace(/^## [^\n]*\n/, '').trim();
}

function decode(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Playbook node "from input": the parent's output (JSON) names the playbook key; it resolves to the
 * robot's published copy, never the owner's draft. Mirrors backend/src/AgentTeam/Services/PlaybookSource.php.
 */
export const PlaybookSource = {
  isFromInput(nodeConfig: Record<string, any>): boolean {
    return (nodeConfig.playbook_source ?? 'fixed') === 'input';
  },

  /**
   * "Job: <compact JSON>" when the parent's text (header stripped) is a JSON object, else null.
   * Downstream complete/hand-back nodes read the last line starting with "Job: ".
   */
  jobLine(parentText: string): string | null {
    const data = decode(stripHeader(parentText));
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? 'Job: ' + JSON.stringify(data) : null;
  },

  async fromInput(ownerId: number, nodeConfig: Record<string, any>, parentText: string, store: PlaybookStore = new PlaybookStore()):
    Promise<{ ok: true; key: string; text: string } | { ok: false; reason: string }> {
    let field = nodeConfig.playbook_input_field ?? 'playbook';
    field = typeof field === 'string' && field !== '' ? field : 'playbook';
    const data = decode(stripHeader(parentText));
    const key = data !== null && typeof data === 'object' && !Array.isArray(data) ? (data[field] ?? null) : null;
    if (typeof key !== 'string' || !isValidKey(key)) return { ok: false, reason: 'bad_input' };
    const robotId = await RobotAccount.id();
    const row = robotId === null ? null : await store.getByKey(robotId, key);
    if (row !== null) return { ok: true, key, text: String(row.text) };
    return {
      ok: false,
      reason: ((await store.getByKey(ownerId, key)) !== null ? 'playbook_not_published:' : 'playbook_not_found:') + key,
    };
  },
};
