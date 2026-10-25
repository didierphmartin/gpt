import { isAssoc, phpArray, phpBool, phpStr, phpTrim } from './php';

/** PHP's \InvalidArgumentException from the document parsers (PlaybookController maps it to 422). */
export class InvalidPlaybookError extends Error {}

export type PlaybookPolicy = { writes_enabled: boolean; on_unbound: string; on_failure: string };

/**
 * A parsed playbook: JSON form (fromArray) or the Console library text format (fromConsoleText).
 * Mirrors backend/src/Playbook/PlaybookDocument.php.
 */
export class PlaybookDocument {
  /** Section header: optional "1." / "-" / "##" / "**" prefix, keyword, colon. */
  static readonly SECTION_HEADER_RE = /^\s*(\d+[.)]|[-*•]|#{1,6})?\s*\**(Title|Trigger|Instructions|Tools used|Actions used|Domain)\**\s*:\**\s*(.*)$/i;

  private constructor(
    readonly title: string,
    readonly trigger: { kind: string; description: string },
    readonly instructions: string,
    readonly toolsUsed: string[],
    readonly actionsUsed: string[],
    /** "#Action" => "server.tool" | "agent.<name>" | null */
    readonly bindings: Record<string, any>,
    readonly policy: PlaybookPolicy,
    readonly approvers: any,
    readonly domain: string = '',
  ) {}

  static fromArray(a: Record<string, any>): PlaybookDocument {
    const title = phpTrim(phpStr(a.title ?? ''));
    const instructions = phpTrim(phpStr(a.instructions ?? ''));
    if (title === '' || instructions === '') {
      const missing = Object.entries({ title: title === '', instructions: instructions === '' }).filter(([, v]) => v).map(([k]) => k);
      throw new InvalidPlaybookError(
        'Playbook JSON is missing the required "' + missing.join('" and "') + '" field'
        + (missing.length > 1 ? 's' : '') + ' (or it is empty).',
      );
    }
    const trigger = a.trigger ?? [];
    const list = (v: any): string[] => Object.values(phpArray(v)).map((x) => phpTrim(phpStr(x)));
    const policy = isAssoc(a.policy) ? a.policy : {};
    const bindings = phpArray(a.bindings ?? []);
    return new PlaybookDocument(
      title,
      { kind: phpStr(trigger?.kind ?? 'request'), description: phpStr(trigger?.description ?? '') },
      instructions,
      list(a.tools_used ?? []),
      list(a.actions_used ?? []),
      isAssoc(bindings) ? bindings : {},
      {
        writes_enabled: phpBool(policy.writes_enabled ?? false),
        on_unbound: phpStr(policy.on_unbound ?? 'handoff'),
        on_failure: phpStr(policy.on_failure ?? 'continue_then_handoff'),
      },
      phpArray(a.approvers ?? []),
      phpTrim(phpStr(a.domain ?? '')),
    );
  }

  /** Parse the Console library format: "Title: …", "Trigger: …", "Instructions: …", "Tools used: a; b", "Actions used: #A; #B". */
  static fromConsoleText(text: string): PlaybookDocument {
    const sections: Record<string, string> = {
      'title': '', 'trigger': '', 'instructions': '', 'tools used': '', 'actions used': '', 'domain': '',
    };
    let current: string | null = null;
    for (const line of text.split(/\r?\n/)) {
      // Tolerate a list marker / markdown heading / bold before the keyword. A numeric marker is kept in
      // the section body so the author's step 1 survives.
      const m = PlaybookDocument.SECTION_HEADER_RE.exec(line);
      if (m) {
        current = m[2].toLowerCase();
        const marker = m[1] !== undefined && /^\d/.test(m[1]) ? m[1] + ' ' : '';
        sections[current] = m[3] === '' ? '' : marker + m[3];
      } else if (current !== null) {
        sections[current] += '\n' + line;
      }
    }
    const semiList = (s: string): string[] => s.split(';').map(phpTrim).filter((x) => x !== '');
    const missing: string[] = [];
    if (phpTrim(sections['title']) === '') missing.push('Title');
    if (phpTrim(sections['instructions']) === '') missing.push('Instructions');
    if (missing.length) {
      const labels: Record<string, string> = {
        'title': 'Title', 'trigger': 'Trigger', 'instructions': 'Instructions',
        'tools used': 'Tools used', 'actions used': 'Actions used', 'domain': 'Domain',
      };
      const found = Object.entries(labels).filter(([k]) => phpTrim(sections[k]) !== '').map(([, l]) => l);
      throw new InvalidPlaybookError(
        `Missing "${missing.join(':" and "')}:" section. Recognized sections: ${found.length ? found.join(', ') : 'none'}. `
        + `Each section must start on its own line as "${missing[0]}: …" (a list number, "##" or "**" before the keyword is fine).`,
      );
    }
    return PlaybookDocument.fromArray({
      title: phpTrim(sections['title']),
      trigger: { kind: 'request', description: phpTrim(sections['trigger']) },
      instructions: phpTrim(sections['instructions']),
      tools_used: semiList(sections['tools used']),
      actions_used: semiList(sections['actions used']),
      domain: phpTrim(sections['domain']),
    });
  }

  toArray(): Record<string, any> {
    return {
      title: this.title, trigger: this.trigger,
      instructions: this.instructions, tools_used: this.toolsUsed,
      actions_used: this.actionsUsed, bindings: Object.keys(this.bindings).length ? this.bindings : [],
      policy: this.policy, approvers: this.approvers,
      domain: this.domain,
    };
  }
}
