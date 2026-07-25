/**
 * GenesisProposer — faithful TS mirror of src/Services/GenesisProposer.php.
 * Pure prompt-building + response-parsing for the one-shot "propose a skill
 * from this conversation / prompt" reflection (L0 of
 * docs/specs/2026-07-14-skill-genesis-design.md). The LLM call itself is made
 * by the caller (GenesisController) so provider settings apply uniformly.
 */

/** Parsed + validated proposal (parseProposal's non-null return). */
export interface GenesisProposal {
  skill_name: string;
  description: string;
  eval_queries: Array<{ query: string; should_trigger: boolean }>;
  parameter_schema: Record<string, any> | null;
  merge_target: string | null;
  rationale: string;
  is_merge: boolean;
}

export class GenesisProposer {
  /** Cap transcript/run material so the reflection stays one cheap call. */
  private static readonly MAX_TRANSCRIPT_CHARS = 12000;

  private static readonly OUTPUT_CONTRACT =
    'Respond with ONE JSON object only — no markdown fences, no commentary:\n' +
    '{\n' +
    '  "skill_name": "<kebab-case name, max 60 chars>",\n' +
    '  "description": "<WHEN <trigger> DO <steps> — one paragraph, trigger-shaped, generalized (parameters, not literals)>",\n' +
    '  "eval_queries": [{"query": "<realistic user prompt>", "should_trigger": true|false}, ...  6-12 items, mix of positives (paraphrases of the real trigger) and negatives (adjacent but out-of-scope)],\n' +
    '  "parameter_schema": {"<param>": {"type": "string", "examples": ["..."], "default": "..."}} or null,\n' +
    '  "merge_target": "<existing skill name from the catalog that already covers this>" or null,\n' +
    '  "rationale": "<one sentence: why this is a repeatable procedure worth a skill>"\n' +
    '}\n' +
    'If an existing catalog skill already covers this procedure, you MUST set merge_target instead of inventing a near-duplicate name.\n' +
    'The user EXPLICITLY requested this promotion — demand is already established, so do NOT judge whether the procedure is "worth" a skill. Generalize the best skill you can from the material (uniform run histories are fine: parameterize by inspecting the structure). Return {"skill_name": null} ONLY when the material is truly unusable — empty, or containing no identifiable action at all.';

  static buildConversationPrompt(messages: Array<{ role?: string; content?: any }>, catalog: any[]): string {
    const lines: string[] = [];
    for (const m of messages) {
      const role = String(m?.role ?? 'user').toUpperCase();
      const content = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
      if (String(content).trim() === '') continue;
      lines.push(`${role}: ${content}`);
    }
    const transcript = GenesisProposer.truncate(lines.join('\n\n'), GenesisProposer.MAX_TRANSCRIPT_CHARS);

    return (
      'You analyse ONE conversation between a user and an AI assistant and decide whether it ' +
      'contains a repeatable multi-step PROCEDURE the user is likely to want again — and if so, ' +
      'propose a skill that encapsulates it.\n\n' +
      'EXISTING SKILL CATALOG (name — description):\n' + GenesisProposer.catalogBlock(catalog) + '\n\n' +
      'CONVERSATION TRANSCRIPT:\n---\n' + transcript + '\n---\n\n' +
      GenesisProposer.OUTPUT_CONTRACT
    );
  }

  /** A saved, reused prompt is a proto-skill: its text is the trigger material. */
  static buildPromptLibraryPrompt(name: string, content: string, catalog: any[]): string {
    return (
      "You analyse ONE saved prompt from the user's prompt library — a prompt they saved to reuse — " +
      'and propose a skill that encapsulates the procedure it invokes.\n' +
      'The prompt text is the best possible evidence of the trigger: derive the WHEN from how the ' +
      'prompt is phrased, and the DO from what it instructs. Lift concrete values (topics, formats, ' +
      'currencies, counts) into parameters with the observed values as defaults/examples.\n\n' +
      'SAVED PROMPT "' + name + '":\n---\n' + GenesisProposer.truncate(content, GenesisProposer.MAX_TRANSCRIPT_CHARS) + '\n---\n\n' +
      'EXISTING SKILL CATALOG (name — description):\n' + GenesisProposer.catalogBlock(catalog) + '\n\n' +
      GenesisProposer.OUTPUT_CONTRACT
    );
  }

  /** Parse + validate the LLM's proposal. Null = no usable proposal. */
  static parseProposal(llmText: string): GenesisProposal | null {
    const m = /\{[\s\S]*\}/.exec(llmText);
    if (!m) return null;
    let data: any;
    try {
      data = JSON.parse(m[0]);
    } catch {
      return null;
    }
    if (data === null || typeof data !== 'object') return null;

    const mergeTarget: string | null =
      typeof data.merge_target === 'string' && data.merge_target !== '' ? data.merge_target : null;

    const hasSkillName = typeof data.skill_name === 'string' && data.skill_name !== '';
    const isMerge = !hasSkillName && mergeTarget !== null;

    if (!hasSkillName && !isMerge) {
      return null; // includes the explicit {"skill_name": null} no-procedure answer
    }
    if (typeof data.description !== 'string' || data.description.trim() === '') {
      return null;
    }

    // Merge proposals carry the name in merge_target; non-merge proposals carry it in skill_name.
    const rawName: string = isMerge ? (mergeTarget as string) : data.skill_name;
    let name = rawName.trim().toLowerCase();
    name = name.replace(/[^a-z0-9]+/g, '-');
    name = name.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    name = name.slice(0, 60);
    if (name === '') return null;

    const evals: Array<{ query: string; should_trigger: boolean }> = [];
    const rawEvals = Array.isArray(data.eval_queries) ? data.eval_queries : [];
    for (const q of rawEvals) {
      if (q && typeof q === 'object' && typeof q.query === 'string' && 'should_trigger' in q) {
        evals.push({ query: q.query, should_trigger: !!q.should_trigger });
      }
    }

    return {
      skill_name: name,
      description: data.description.trim(),
      eval_queries: evals,
      parameter_schema:
        data.parameter_schema !== null && typeof data.parameter_schema === 'object' ? data.parameter_schema : null,
      merge_target: mergeTarget,
      rationale: typeof data.rationale === 'string' ? data.rationale : '',
      is_merge: isMerge,
    };
  }

  private static catalogBlock(catalog: any[]): string {
    if (!Array.isArray(catalog) || catalog.length === 0) return '(catalog empty)';
    const lines: string[] = [];
    for (const s of catalog) {
      if (!s || typeof s !== 'object' || !s.name) continue;
      lines.push('- ' + s.name + ' — ' + String(s.description ?? ''));
    }
    return lines.length ? lines.join('\n') : '(catalog empty)';
  }

  private static truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max) + '\n[…truncated…]';
  }
}
