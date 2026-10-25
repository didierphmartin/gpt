/**
 * SSE differential comparator — twin of backend_python/tests/differential/sse.py. Compares two
 * event streams (PHP vs TS) by shape rather than by bytes: token counts and generated text differ
 * run to run, so the skeleton (event order), the response payload's key set / types, and the
 * terminal events are what parity means here.
 */
import assert from 'node:assert/strict';

export type SseEvent = [string, string];

export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const evLine = lines.find((l) => l.startsWith('event:'));
    const ev = evLine ? evLine.slice(6).trim() : '';
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ +/, '')).join('\n');
    if (ev) events.push([ev, data]);
  }
  return events;
}

export function skeleton(events: SseEvent[]): string[] {
  const out: string[] = [];
  for (const [ev] of events) if (!out.length || out[out.length - 1] !== ev) out.push(ev);
  return out;
}

/** The LAST payload of event `name`, JSON-decoded when it parses, else the raw string; null if absent. */
export function payload(events: SseEvent[], name: string): any {
  for (let i = events.length - 1; i >= 0; i--) {
    const [ev, data] = events[i];
    if (ev === name) {
      try {
        return JSON.parse(data);
      } catch {
        return data;
      }
    }
  }
  return null;
}

/** Replace every integer (not boolean) with the string 'int'. */
export function normalizeUsage(d: any): any {
  if (Array.isArray(d)) return d.map(normalizeUsage);
  if (d && typeof d === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(d)) out[k] = typeof v === 'number' && Number.isInteger(v) ? 'int' : normalizeUsage(v);
    return out;
  }
  return d;
}

/**
 * The terminal event families: the primary chat pane plus the verification and comparison panes
 * (ChatController::verify / compareOnly and the in-chat phases). Each is (response, complete, error).
 */
export const TERMINAL_FAMILIES: Array<[string, string, string]> = [
  ['response', 'complete', 'error'],
  ['verification_response', 'verification_complete', 'verification_error'],
  ['compare_response', 'compare_complete', 'compare_error'],
];

/**
 * Parse a stream of BARE `data:` frames (no `event:` line — e.g. AgentController.php:486/:507).
 * Each block becomes the decoded JSON payload or, if not JSON (e.g. `[DONE]`), the raw string.
 */
export function parseDataOnly(text: string): any[] {
  const out: any[] = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const lines = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ +/, ''));
    if (!lines.length) continue;
    const raw = lines.join('\n');
    try {
      out.push(JSON.parse(raw));
    } catch {
      out.push(raw);
    }
  }
  return out;
}

/** Bare-`data:` streams compare by exact decoded payload sequence. */
export function sameDataStream(aText: string, bText: string): void {
  assert.deepStrictEqual(parseDataOnly(bText), parseDataOnly(aText));
}

export function sameStream(aText: string, bText: string, opts: { ignoreResponseKeys?: string[] } = {}): void {
  const ignore = opts.ignoreResponseKeys ?? ['text'];
  const a = parseSse(aText);
  const b = parseSse(bText);
  assert.deepStrictEqual(skeleton(b), skeleton(a), 'event skeleton');
  for (const [resp, complete, error] of TERMINAL_FAMILIES) {
    const ra = payload(a, resp);
    const rb = payload(b, resp);
    assert.equal(ra === null, rb === null, `${resp}: php=${JSON.stringify(ra)} ts=${JSON.stringify(rb)}`);
    if (ra !== null || rb !== null) {
      for (const k of ignore) {
        delete ra[k];
        delete rb[k];
      }
      assert.deepStrictEqual(normalizeUsage(rb), normalizeUsage(ra), resp);
    }
    assert.deepStrictEqual(payload(b, complete), payload(a, complete), complete);
    const ea = payload(a, error);
    const eb = payload(b, error);
    assert.equal(ea === null, eb === null, `${error}: php=${JSON.stringify(ea)} ts=${JSON.stringify(eb)}`);
    if (ea !== null) assert.deepStrictEqual(Object.keys(eb), Object.keys(ea), error);
  }
}
