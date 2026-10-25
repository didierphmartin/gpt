import { PlaybookDocument } from './PlaybookDocument';
import { mbLen, mbSub, phpTrim } from './php';

export type AnalyzedAction = { name: string; kind: 'native' | 'bound' | 'unbound'; target: string | null; auto: boolean };
export type Analysis = {
  actions: AnalyzedAction[];
  gates: string[];
  checklist: string[];
  errors: string[];
  warnings: string[];
  notices: string[];
};

const PHP_INT_MAX = Number.MAX_SAFE_INTEGER;
/** A prose #Action: capitalised words (at most six), optionally a "(Qualifier)". */
const ACTION_RE = /#[A-Z][\p{L}\p{N}_'’]*(?: [A-Z][\p{L}\p{N}_'’]*){0,5}(?: \([A-Za-z ]+\))?/gu;

/**
 * Registration-time analysis of a playbook: classify each #Action (native verb, bound to an MCP tool
 * or agent, unbound), the human gates it uses, the checklist in prose order, and the author-facing
 * errors/warnings/notices. Mirrors backend/src/Playbook/PlaybookAnalyzer.php.
 */
export class PlaybookAnalyzer {
  /** #Action name (case-insensitive, trimmed) => native tool id */
  static readonly NATIVE_VERBS: Record<string, string> = {
    '#send direct message': 'send_direct_message',
    '#send channel message': 'send_channel_message',
    '#send email': 'send_email',
    '#leave internal note': 'leave_internal_note',
    '#resolve request': 'resolve_request',
    '#escalate request': 'set_priority',
    '#request approval': 'request_approval',
    '#prompt for handoff': 'prompt_handoff',
    '#trigger form': 'trigger_form',
  };
  private static readonly GATE_BY_NATIVE: Record<string, string> = {
    request_approval: 'approval', prompt_handoff: 'handoff', trigger_form: 'form',
  };

  /** availableTools: "server.tool" ids; availableAgents: agent names. */
  analyze(doc: PlaybookDocument, availableTools: string[], availableAgents: string[] = []): Analysis {
    const actions: AnalyzedAction[] = [];
    const gates: string[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const notices: string[] = [];
    // Checklist = #Actions in prose order. Find positions longest-name-first on a working copy of the
    // instructions, masking each match as it's found, so a shorter name occurring only inside a longer
    // one isn't mistaken for its own, earlier occurrence.
    const names = [...doc.actionsUsed].sort((a, b) => Buffer.byteLength(b) - Buffer.byteLength(a));
    let working = doc.instructions;
    const positions: Record<string, number> = {};
    for (const name of names) {
      const pos = name === '' ? 0 : working.toLowerCase().indexOf(name.toLowerCase());
      positions[name] = pos === -1 ? PHP_INT_MAX : pos;
      if (pos !== -1) {
        working = working.slice(0, pos) + ' '.repeat(name.length) + working.slice(pos + name.length);
      }
    }
    const ordered = [...doc.actionsUsed].sort((a, b) => positions[a] - positions[b]);

    // "where" = the step/line of the Instructions the action first appears on, quoted.
    const where = (name: string): string => PlaybookAnalyzer.locate(doc.instructions, name);

    // #Actions written in the prose but absent from "Actions used" never get an action-space entry —
    // point at the exact line.
    const listed = doc.actionsUsed.map((n) => phpTrim(n).toLowerCase());
    const seen: Record<string, boolean> = {};
    let step = '';
    doc.instructions.split(/\r?\n/).forEach((line, i) => {
      step = PlaybookAnalyzer.stepOf(line, step);
      const found = line.match(ACTION_RE);
      if (!found) return;
      for (const f of found) {
        const k = f.toLowerCase();
        if (seen[k]) continue;
        // Skip if it is (a prefix of) a listed action on this line.
        if (listed.some((l) => l.startsWith(k) || k.startsWith(l))) continue;
        seen[k] = true;
        warnings.push(`${f} is used in the Instructions but not listed under "Actions used", so it will not be bound`
          + ' — ' + PlaybookAnalyzer.describeLine(i, line, step) + '.');
      }
    });

    for (const name of ordered) {
      if (positions[name] === PHP_INT_MAX) {
        notices.push(`${name} is listed under "Actions used" but never appears in the Instructions.`);
      }
      const key = phpTrim(name).toLowerCase();
      const native = PlaybookAnalyzer.NATIVE_VERBS[key];
      if (native !== undefined) {
        actions.push({ name, kind: 'native', target: native, auto: false });
        const gate = PlaybookAnalyzer.GATE_BY_NATIVE[native];
        if (gate !== undefined) gates.push(gate);
        continue;
      }
      const hasExplicit = Object.prototype.hasOwnProperty.call(doc.bindings, name);
      const rawTarget = doc.bindings[name];
      const target: string | null = rawTarget === undefined || rawTarget === null ? null : String(rawTarget);
      if (target === null) {
        // Console text is the source format: when the author gave NO binding (key absent), translate the
        // #Action to a connected tool by name-matching. An explicit null stays deliberately unbound.
        const auto = hasExplicit ? null : this.autoBind(name, availableTools);
        if (auto !== null) {
          actions.push({ name, kind: 'bound', target: auto, auto: true });
          // Informational, not a problem: goes to 'notices', never 'warnings'.
          notices.push(`Auto-bound ${name} → ${auto} (matched by name; add an explicit binding to override).`);
          continue;
        }
        actions.push({ name, kind: 'unbound', target: null, auto: false });
        warnings.push(`Unbound action ${name}: at run time the '${doc.policy.on_unbound}' policy applies` + where(name) + '.');
        continue;
      }
      if (target.startsWith('agent.')) {
        const agent = target.slice(6);
        if (availableAgents.includes(agent)) {
          actions.push({ name, kind: 'bound', target, auto: false });
        } else {
          actions.push({ name, kind: 'unbound', target, auto: false });
          errors.push(`${name} is bound to ${target} but no such agent exists` + where(name) + '.');
        }
        continue;
      }
      if (availableTools.includes(target)) {
        actions.push({ name, kind: 'bound', target, auto: false });
      } else {
        actions.push({ name, kind: 'unbound', target, auto: false });
        errors.push(`${name} is bound to ${target} but that tool is not available on any connected MCP server` + where(name) + '.');
      }
    }
    return {
      actions, gates: [...new Set(gates)], checklist: ordered, errors, warnings, notices,
    };
  }

  /** " — step 7: \"7. #Foo …\"" for the first Instructions line containing name, else "". */
  private static locate(instructions: string, name: string): string {
    let step = '';
    const lines = instructions.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      step = PlaybookAnalyzer.stepOf(lines[i], step);
      if (lines[i].toLowerCase().includes(name.toLowerCase())) return ' — ' + PlaybookAnalyzer.describeLine(i, lines[i], step);
    }
    return '';
  }

  /** The author's step number on this line ("7", "2.1"), else the enclosing one carried in. */
  private static stepOf(line: string, current: string): string {
    const m = /^\s*(\d+(?:\.\d+)*)[.)]?\s/.exec(line);
    return m ? m[1] : current;
  }

  /** 'step 7: "…"' on a numbered line; 'step 4, line 7: "…"' for a sub-line; 'Instructions line N: "…"' outside any step. */
  private static describeLine(index: number, line: string, step: string): string {
    let t = phpTrim(line);
    const numbered = /^\d+(?:\.\d+)*[.)]?\s/.test(t);
    const label = numbered ? `step ${step}` : (step !== '' ? `step ${step}, line ${index + 1}` : `Instructions line ${index + 1}`);
    if (mbLen(t) > 90) t = mbSub(t, 0, 87) + '…';
    return label + ': "' + t + '"';
  }

  /**
   * Deterministic name-match of a prose #Action to one connected "server.tool". Tokens are lowercased,
   * de-pluralized words; server-name tokens weigh double. Needs score >= 4 and a strictly unique best
   * candidate. Returns the tool id or null.
   */
  private autoBind(actionName: string, availableTools: string[]): string | null {
    const stop = ['custom', 'the', 'a', 'an', 'by', 'for', 'to', 'and', 'of', 'action'];
    const tok = (t: string): string[] => {
      const out: string[] = [];
      for (const w of t.toLowerCase().split(/[^a-z0-9]+/)) {
        if (w === '' || stop.includes(w)) continue;
        const r = w.replace(/s+$/, '');
        out.push(r === '' || r === '0' ? w : r);
      }
      return [...new Set(out)];
    };
    const actionTokens = tok(actionName);
    if (actionTokens.length === 0) return null;

    let best: string | null = null;
    let bestScore = 0;
    let tie = false;
    for (const id of availableTools) {
      const dot = id.indexOf('.');
      const server = dot === -1 ? '' : id.slice(0, dot);
      const tool = dot === -1 ? id : id.slice(dot + 1);
      // Integer-scaled: server token = 4, tool token = 2, +1 when the action covers the WHOLE tool name.
      let score = 0;
      for (const st of tok(server)) if (actionTokens.includes(st)) score += 4;
      const toolTokens = tok(tool);
      let toolHits = 0;
      for (const tt of toolTokens) if (actionTokens.includes(tt)) toolHits++;
      score += 2 * toolHits;
      if (toolTokens.length > 0 && toolHits === toolTokens.length) score += 1;
      if (score > bestScore) {
        best = id; bestScore = score; tie = false;
      } else if (score === bestScore && score > 0) {
        tie = true;
      }
    }
    return bestScore >= 4 && !tie ? best : null;
  }
}
