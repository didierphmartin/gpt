// node frontend/tools/md-roundtrip/run.mjs [--opts '{"json":"editor options"}']
// Round-trips every SKILL.md body and references/**/*.md through Toast UI (md -> WYSIWYG -> md).
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { merge } = require('./merge-blocks.js');
const { marked } = require('marked');
const lexer = (s) => marked.lexer(s);

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(os.homedir(), 'Documents/synergyAI/skills');
const ei = process.argv.indexOf('--editor');
const EDITOR = ei > 0 ? process.argv[ei + 1] : 'toast';   // toast | milkdown
if (!['toast', 'milkdown'].includes(EDITOR)) throw new Error('--editor toast|milkdown');
const REPORT = `/private/tmp/claude-501/-Applications-XAMPP-xamppfiles-htdocs-gpt/f0deb36f-aec0-4ae0-8587-73e349dd10fa/scratchpad/md-roundtrip-report${EDITOR === 'toast' ? '' : '-' + EDITOR}.md`;
function stripFrontmatter(s) { return s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''); }

function collect() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'SKILL.md') files.push({ name: path.relative(ROOT, p), file: p, body: true });
      else if (e.name.endsWith('.md') && p.split(path.sep).includes('references')) files.push({ name: path.relative(ROOT, p), file: p, body: false });
    }
  };
  walk(ROOT);
  return files.sort((x, y) => x.name.localeCompare(y.name));
}

// The brief's normalisation only, and never inside a fenced code block:
// trailing whitespace per line; runs of blank lines -> ONE blank line; */+ list markers -> -; __x__ -> **x**; table padding.
function normalise(s) {
  const out = []; let inCode = false, blank = false;
  for (let l of s.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(l)) { l = l.replace(/[ \t]+$/, ''); inCode = !inCode; blank = false; out.push(l); continue; }
    if (inCode) { out.push(l); continue; }
    l = l.replace(/[ \t]+$/, '');
    l = l.replace(/^(\s*)[*+](\s+)/, '$1-$2');
    l = l.replace(/__([^_\n]+)__/g, '**$1**');
    if (/^\s*\|.*\|\s*$/.test(l)) l = l.replace(/[ \t]*\|[ \t]*/g, '|').replace(/^\s+/, '');
    if (l === '') { if (blank) continue; blank = true; } else blank = false;
    out.push(l);
  }
  return out.join('\n').replace(/^\n+|\n+$/g, '');
}

function lineDiff(a, b, max = 40) {
  const A = a.split('\n'), B = b.split('\n'), out = [];
  // simple LCS diff
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { i++; j++; }
    else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) out.push('- ' + A[i++]);
    else out.push('+ ' + B[j++]);
  }
  return out;
}

function classify(a, b, diff) {
  const c = new Set();
  const comm = (s) => (s.match(/<!--[\s\S]*?-->/g) || []).join('\u0001');
  if (comm(a) !== comm(b)) c.add('html-comment');
  const fences = (s) => (s.match(/^\s*```.*\n[\s\S]*?^\s*```/gm) || []).join('\u0001');
  const langs = (s) => (s.match(/^\s*```.*$/gm) || []).filter((_, i) => i % 2 === 0).map((x) => x.trim()).join('\u0001');
  if (langs(a) !== langs(b)) c.add('code-lang');
  if (fences(a) !== fences(b)) c.add('code-contents');
  const heads = (s) => (s.match(/^#{1,6} .*/gm) || []).join('\u0001');
  if (heads(a) !== heads(b)) c.add('heading');
  const isSep = (l) => /^\|[\s:|-]+\|$/.test(l);
  const rows = (s) => (s.match(/^\|.*\|$/gm) || []).filter((l) => !isSep(l)).join('\u0001');
  const seps = (s) => (s.match(/^\|.*\|$/gm) || []).filter(isSep).map((l) => l.replace(/-+/g, '-')).join('\u0001');
  if (rows(a) !== rows(b)) c.add('table-cell');
  else if (seps(a) !== seps(b)) c.add('table-separator-alignment');
  else if (/^\|[\s:|-]+\|$/m.test(diff.join('\n').replace(/^[-+] /gm, ''))) c.add('table-separator-dash-width (cosmetic)');
  if (diff.some((l) => /^- ---$/.test(l)) ) c.add('hr-as-***');
  if (diff.some((l) => /^\+ <br>/.test(l))) c.add('<br>-inserted');
  if (diff.some((l) => /\\_/.test(l))) c.add('underscore-escaped');
  const links = (s) => (s.match(/\]\([^)]*\)/g) || []).join('\u0001');
  if (links(a) !== links(b)) c.add('link-target');
  if (!c.size) c.add('other');
  return [...c];
}



const files = collect();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('file://' + path.join(here, EDITOR === 'toast' ? 'roundtrip.html' : 'milkdown.html'));
await page.waitForFunction(() => window.ready === true, null, { timeout: 90000 });

const bodies = files.map((f) => { const md = fs.readFileSync(f.file, 'utf8'); return f.body ? stripFrontmatter(md) : md; });
const rt = async (md, cfg) => page.evaluate(([m, c]) => window.roundtrip(m, c), [md, cfg]);
const rtEdit = async (md, cfg, w) => page.evaluate(([m, c, x]) => window.roundtripEdit(m, c, x), [md, cfg, w]);
const MD = { lexer, parse: (s) => marked.parse(s) };

// ---- 1. fidelity per Toast config (normalised comparison; reported for information) ----
async function fidelity(cfg) {
  let pass = 0; const fails = []; const rts = [];
  for (let k = 0; k < files.length; k++) {
    const out = await rt(bodies[k], cfg);
    if (out && out.error) { rts.push(null); fails.push({ name: files[k].name, classes: ['CRASH (Toast throws)'], diff: [out.error] }); continue; }
    rts.push(out);
    const a = normalise(bodies[k]), b = normalise(out);
    if (a === b) { pass++; continue; }
    const diff = lineDiff(a, b);
    fails.push({ name: files[k].name, classes: classify(a, b, diff), diff });
  }
  const classCount = {};
  for (const f of fails) for (const c of f.classes) classCount[c] = (classCount[c] || 0) + 1;
  return { pass, fails, classCount, rts };
}

const SHIPPED = { hr: 1 };
const ALL = { hr: 1, text: 1, tableDelim: 1, listIndent: 1, html: 1, softbreak: 1, deepHeading: 1 };
const TOAST_CONFIGS = [
  ['shipped (hr only)', SHIPPED],
  ['+ text (minimal escaping)', { hr: 1, text: 1 }],
  ['+ tableDelim (--- per column)', { hr: 1, tableDelim: 1 }],
  ['+ listIndent (marker-width indent, - bullets)', { hr: 1, listIndent: 1 }],
  ['+ html (keep unknown inline/block tags)', { hr: 1, html: 1 }],
  ['+ customHTMLSanitizer identity', { hr: 1, sanitizer: 1 }],
  ['+ softbreak (line breaks in marks, hard breaks)', { hr: 1, softbreak: 1 }],
  ['+ deepHeading (headings inside quotes and list items)', { hr: 1, deepHeading: 1 }],
  ['ALL fixes (A)', ALL],
];
const MILKDOWN_CONFIGS = [['shipped (default options)', {}], ['tuned (official remark-stringify options)', { tuned: 1 }]];
const CONFIGS = EDITOR === 'toast' ? TOAST_CONFIGS : MILKDOWN_CONFIGS;
const results = [];
for (const [label, cfg] of CONFIGS) results.push({ label, cfg, ...(await fidelity(cfg)) });

// ---- 2. the three honest measures, per row: shipped / A / B alone / A+B ----
const identityMerge = (o, e) => ({ md: e, merged: false, reason: 'no merge' });
const realMerge = (o, e) => merge(o, e, MD);

function firstParagraph(md) {
  const toks = lexer(md); let off = 0;
  if (toks.map((t) => t.raw).join('') !== md) return { unmeasurable: true };
  for (const t of toks) {
    if (t.type === 'paragraph' && t.text.trim()) {
      const l0 = md.slice(0, off).split('\n').length - 1;
      return { l0, l1: l0 + t.raw.replace(/\n+$/, '').split('\n').length };
    }
    off += t.raw.length;
  }
  return { none: true };
}
const count = (s, sub) => s.split(sub).length - 1;

// probes: a user edit made on the markdown Toast produced, touching characters a sloppy key could fold away.
// Each returns { edited, survives(merged, orig) } or null when the file has nothing to probe.
const PROBES = {
  'code indent': (orig, ed) => {
    const lines = ed.split('\n'); let inF = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*```/.test(lines[i])) { inF = !inF; continue; }
      if (inF && lines[i].trim()) { const m = '  ' + lines[i]; lines[i] = m; return { edited: lines.join('\n'), survives: (g, o) => count(g, m) > count(o, m) }; }
    }
    return null;
  },
  '<br> added': (orig, ed) => paraEdit(ed, (p) => p + '<br>', (g, o) => count(g, '<br>') > count(o, '<br>')),
  'escape added': (orig, ed) => paraEdit(ed, (p) => p + ' \\*zq\\*', (g, o) => g.includes(' \\*zq\\*') && !o.includes(' \\*zq\\*')),
  'link target': (orig, ed) => { const m = /\]\(([^)\s]+)\)/.exec(ed); if (!m) return null; const nu = m[1] + 'X'; return { edited: ed.replace(m[0], '](' + nu + ')'), survives: (g, o) => g.includes('](' + nu + ')') }; },
};
function paraEdit(ed, fn, survives) {
  const t = lexer(ed).find((x) => x.type === 'paragraph' && x.text.trim());
  if (!t || ed.indexOf(t.raw) < 0) return null;
  const nr = fn(t.raw.replace(/\n+$/, '')) + t.raw.slice(t.raw.replace(/\n+$/, '').length);
  return { edited: ed.replace(t.raw, nr), survives };
}

async function measure(label, cfg, mergeFn, isMerge) {
  const R = { isMerge, label, n: files.length, ident: 0, crashed: [], refused: [], notIdent: [], plainN: 0, plainOk: 0, plainOutside: [], probes: {} };
  for (const k of Object.keys(PROBES)) R.probes[k] = { n: 0, ok: 0, lost: [] };
  for (let k = 0; k < files.length; k++) {
    const orig = bodies[k];
    // (1) no edit
    const out = await rt(orig, cfg);
    if (out && out.error) R.crashed.push(files[k].name);
    else {
      const r = mergeFn(orig, out);
      if (isMerge && !r.merged) R.refused.push(files[k].name);
      if (r.md === orig) R.ident++; else R.notIdent.push({ name: files[k].name, diff: lineDiff(orig, r.md) });
    }
    // (2) plain word appended to the first top-level paragraph, in WYSIWYG
    const fp = firstParagraph(orig);
    if (!fp.none && !fp.unmeasurable) {
      R.plainN++;
      const edited = await rtEdit(orig, cfg, ' EDITEDWORD');
      if (edited && !edited.error && edited !== null) {
        const g = mergeFn(orig, edited).md;
        const O = orig.split('\n'), M = g.split('\n');
        let p = 0; while (p < O.length && p < M.length && O[p] === M[p]) p++;
        let s = 0; while (s < O.length - p && s < M.length - p && O[O.length - 1 - s] === M[M.length - 1 - s]) s++;
        const last = O.length - s;
        if (g.includes('EDITEDWORD') && p >= fp.l0 && last <= fp.l1) R.plainOk++;
        else R.plainOutside.push({ name: files[k].name, para: [fp.l0 + 1, fp.l1], changed: [p + 1, last], diff: lineDiff(orig, g) });
      } else R.plainOutside.push({ name: files[k].name, para: [fp.l0 + 1, fp.l1], changed: [], diff: ['Toast crashed'] });
    }
    // (3) probes (only for the merge rows: without a merge the edited text is taken as is)
    if (isMerge && out && !out.error) for (const [pn, fn] of Object.entries(PROBES)) {
      const pr = fn(orig, out);
      if (!pr) continue;
      R.probes[pn].n++;
      const g = mergeFn(orig, pr.edited).md;
      if (pr.survives(g, orig)) R.probes[pn].ok++; else R.probes[pn].lost.push(files[k].name);
    }
  }
  return R;
}
const rows = EDITOR === 'toast' ? [
  await measure('shipped (Toast as is)', SHIPPED, identityMerge, false),
  await measure('A (Toast + fixes)', ALL, identityMerge, false),
  await measure('B alone (shipped + mergeBlocks)', SHIPPED, realMerge, true),
  await measure('A + B', ALL, realMerge, true),
] : [
  await measure('shipped (Milkdown default)', {}, identityMerge, false),
  await measure('tuned (Milkdown options)', { tuned: 1 }, identityMerge, false),
  await measure('tuned + B', { tuned: 1 }, realMerge, true),
];
await browser.close();

// ---- report ----
const base = results[0], allRes = results[results.length - 1];  // milkdown: base = default, allRes = tuned
const sum = (r) => `${files.length} files, ${r.pass} pass, ${r.fails.length} fail`;
let rep = `# Markdown round-trip report\n\n${EDITOR === 'toast' ? 'Toast UI Editor 3.2.2 (jsDelivr +esm)' : 'Milkdown 7.23.0 (esm.sh)'}. ${files.length} files = SKILL.md bodies (frontmatter stripped) + every references/**/*.md under ${ROOT}.\nNormalisation (section 1 only): the brief's list, never inside code fences; blank-line runs become ONE blank line.\n\n`;
rep += `## 1. Normalised fidelity per Toast configuration\n\n| config | pass | fail | classes |\n|---|---|---|---|\n`;
for (const r of results) rep += `| ${r.label} | ${r.pass} | ${r.fails.length} | ${JSON.stringify(r.classCount)} |\n`;
rep += `\n### Shipped: failing files\n\n`;
for (const f of base.fails) rep += `#### ${f.name}\nBroken: ${f.classes.join(', ')}\n\n\`\`\`diff\n${f.diff.slice(0, 40).join('\n')}\n\`\`\`\n\n`;
rep += `### A (all fixes): failing files\n\n`;
for (const f of allRes.fails) rep += `#### ${f.name}\nBroken: ${f.classes.join(', ')}\n\n\`\`\`diff\n${f.diff.slice(0, 40).join('\n')}\n\`\`\`\n\n`;
rep += `## 2. Honest measures (exact bytes, no normalisation; a Toast crash counts as a failure)\n\n`;
rep += `(1) no edit: result === original, byte for byte. (2) plain word appended to the first paragraph in WYSIWYG: only that paragraph's lines change. (3) edits made on Toast's markdown that touch characters a sloppy comparison could fold (indent inside a code block, a <br>, an added escape, a changed link target): the edit must survive the merge; n/a without a merge.\n\n`;
const N = (a, b) => `${a} of ${b}`;
rep += `| row | (1) no-edit identical | (2) plain-word edit confined | (3) code indent | (3) <br> | (3) escape | (3) link target | Toast crashes | merge refused |\n|---|---|---|---|---|---|---|---|---|\n`;
for (const r of rows) {
  const pr = (k) => (r.isMerge ? N(r.probes[k].ok, r.probes[k].n) : 'n/a');
  rep += `| ${r.label} | ${N(r.ident, r.n)} | ${N(r.plainOk, r.plainN)} | ${pr('code indent')} | ${pr('<br> added')} | ${pr('escape added')} | ${pr('link target')} | ${r.crashed.length} | ${r.refused.length} |\n`;
}
rep += '\n';
for (const r of rows) {
  rep += `### ${r.label}\n\n- Toast crashed on: ${r.crashed.join(', ') || 'none'}\n- merge refused on: ${r.refused.join(', ') || 'none'}\n`;
  for (const [k, v] of Object.entries(r.probes)) if (v.lost.length) rep += `- probe "${k}" lost on: ${v.lost.join(', ')}\n`;
  rep += '\n';
  if (!r.isMerge) continue;
  for (const f of r.notIdent) rep += `#### (1) not identical: ${f.name}\n\n\`\`\`diff\n${f.diff.slice(0, 20).join('\n')}\n\`\`\`\n\n`;
  for (const f of r.plainOutside) rep += `#### (2) outside the edit: ${f.name} (paragraph lines ${f.para}, changed ${f.changed})\n\n\`\`\`diff\n${f.diff.slice(0, 20).join('\n')}\n\`\`\`\n\n`;
}
fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, rep);
console.log('normalised shipped:', sum(base), '| A:', sum(allRes));
for (const r of rows) console.log(r.label.padEnd(36), '(1)', N(r.ident, r.n), '(2)', N(r.plainOk, r.plainN), Object.entries(r.probes).map(([k, v]) => `${k} ${N(v.ok, v.n)}`).join(' | '), '| crashes', r.crashed.length, 'refused', r.refused.length);
console.log('report:', REPORT);
