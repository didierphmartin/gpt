// node frontend/tools/md-roundtrip/run.mjs [--opts '{"json":"editor options"}']
// Round-trips every SKILL.md body and references/**/*.md through Toast UI (md -> WYSIWYG -> md).
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { mergeBlocks } = require('./merge-blocks.js');
const { marked } = require('marked');
const lexer = (s) => marked.lexer(s);

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(os.homedir(), 'Documents/synergyAI/skills');
const REPORT = '/private/tmp/claude-501/-Applications-XAMPP-xamppfiles-htdocs-gpt/f0deb36f-aec0-4ae0-8587-73e349dd10fa/scratchpad/md-roundtrip-report.md';
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

// Only the brief's normalisations.
function normalise(s) {
  return s.replace(/\r\n/g, '\n').split('\n').map((l) => {
    l = l.replace(/[ \t]+$/, '');
    l = l.replace(/^(\s*)[*+](\s+)/, '$1-$2');
    l = l.replace(/__([^_\n]+)__/g, '**$1**');
    if (/^\s*\|.*\|\s*$/.test(l)) l = l.replace(/[ \t]*\|[ \t]*/g, '|').replace(/^\s+/, '');
    return l;
  }).join('\n').replace(/\n{2,}/g, '\n').replace(/^\n+|\n+$/g, '');
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
await page.goto('file://' + path.join(here, 'roundtrip.html'));
await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });

const bodies = files.map((f) => { const md = fs.readFileSync(f.file, 'utf8'); return f.body ? stripFrontmatter(md) : md; });
const rt = async (md, cfg) => page.evaluate(([m, c]) => window.roundtrip(m, c), [md, cfg]);
const rtEdit = async (md, cfg, w) => page.evaluate(([m, c, x]) => window.roundtripEdit(m, c, x), [md, cfg, w]);

// ---- fidelity per Toast config (normalised comparison, brief's normalisation only) ----
async function fidelity(cfg) {
  let pass = 0; const fails = []; const rts = []; const crashes = [];
  for (let k = 0; k < files.length; k++) {
    let out = await rt(bodies[k], cfg);
    if (out && out.error) { crashes.push({ name: files[k].name, error: out.error }); rts.push(bodies[k]); fails.push({ name: files[k].name, classes: ['CRASH (Toast throws)'], diff: [out.error] }); continue; }
    rts.push(out);
    const a = normalise(bodies[k]), b = normalise(out);
    if (a === b) { pass++; continue; }
    const diff = lineDiff(a, b);
    fails.push({ name: files[k].name, classes: classify(a, b, diff), diff });
  }
  const classCount = {};
  for (const f of fails) for (const c of f.classes) classCount[c] = (classCount[c] || 0) + 1;
  return { pass, fails, classCount, rts, crashes };
}

const CONFIGS = [
  ['shipped (hr only)', { hr: 1 }],
  ['+ text (minimal escaping)', { hr: 1, text: 1 }],
  ['+ tableDelim (--- per column)', { hr: 1, tableDelim: 1 }],
  ['+ listIndent (marker-width indent, - bullets)', { hr: 1, listIndent: 1 }],
  ['+ html (keep unknown inline tags as text)', { hr: 1, html: 1 }],
  ['+ customHTMLSanitizer identity', { hr: 1, sanitizer: 1 }],
  ['+ softbreak (keep line breaks inside bold/emphasis/links)', { hr: 1, softbreak: 1 }],
  ['ALL fixes (hr,text,tableDelim,listIndent,html,softbreak)', { hr: 1, text: 1, tableDelim: 1, listIndent: 1, html: 1, softbreak: 1 }],
];
const results = [];
for (const [label, cfg] of CONFIGS) results.push({ label, cfg, ...(await fidelity(cfg)) });

// ---- B: mergeBlocks ----
function lineRangeOfFirstParagraph(md) {
  const toks = lexer(md); let off = 0;
  if (toks.map((t) => t.raw).join('') !== md) return { unmeasurable: true };
  for (const t of toks) {
    if (t.type === 'paragraph' && t.text.trim()) {
      const l0 = md.slice(0, off).split('\n').length - 1;
      const l1 = l0 + t.raw.replace(/\n+$/, '').split('\n').length;
      return { l0, l1 };
    }
    off += t.raw.length;
  }
  return { none: true };
}
async function blockTests(label, cfg, rts) {
  let identical = 0; const notIdentical = [];
  for (let k = 0; k < files.length; k++) {
    const merged = mergeBlocks(bodies[k], rts[k], lexer);
    if (merged === bodies[k]) identical++; else notIdentical.push({ name: files[k].name, diff: lineDiff(bodies[k], merged) });
  }
  let crashed = 0, measured = 0, clean = 0, noPara = 0, unmeasurable = 0, editLost = 0; const outside = [];
  for (let k = 0; k < files.length; k++) {
    const r = lineRangeOfFirstParagraph(bodies[k]);
    if (r.none) { noPara++; continue; }
    if (r.unmeasurable) { unmeasurable++; continue; }
    const edited = await rtEdit(bodies[k], cfg, ' EDITEDWORD');
    if (edited === null) { noPara++; continue; }
    if (edited.error) { crashed++; continue; }
    const merged = mergeBlocks(bodies[k], edited, lexer);
    measured++;
    if (merged === bodies[k]) { editLost++; }
    const O = bodies[k].split('\n'), M = merged.split('\n');
    let p = 0; while (p < O.length && p < M.length && O[p] === M[p]) p++;
    let s = 0; while (s < O.length - p && s < M.length - p && O[O.length - 1 - s] === M[M.length - 1 - s]) s++;
    const lastOrig = O.length - s; // changed original lines are [p, lastOrig)
    if (p >= r.l0 && lastOrig <= r.l1 && merged !== bodies[k]) clean++;
    else if (merged !== bodies[k]) outside.push({ name: files[k].name, para: [r.l0 + 1, r.l1], changed: [p + 1, lastOrig], diff: lineDiff(bodies[k], merged) });
  }
  return { label, crashed, identical, notIdentical, measured, clean, outside, noPara, unmeasurable, editLost };
}
const noneRts = []; for (const b of bodies) { const o = await rt(b, {}); noneRts.push(o && o.error ? b : o); }
const bNone = await blockTests('B alone (Toast with no fixes at all)', {}, noneRts);
const allRes = results[results.length - 1];
const bAll = await blockTests('B on top of A (ALL fixes)', allRes.cfg, allRes.rts);
await browser.close();

// ---- report ----
const base = results[0];
const sum = (r) => `${files.length} files, ${r.pass} pass, ${r.fails.length} fail`;
let rep = `# Markdown round-trip report\n\nToast UI Editor 3.2.2 (jsDelivr +esm). ${files.length} files = SKILL.md bodies (frontmatter stripped) + every references/**/*.md, found by walking ${ROOT}.\nBrief's normalisation only (trailing ws, blank-line runs, */+ -> -, __x__ -> **x**, table padding).\n\n`;
rep += `## 1. Shipped configuration (customMarkdownRenderer.thematicBreak = ---)\n\n**${sum(base)}**\n\nFailing classes: ${JSON.stringify(base.classCount)}\n\n`;
for (const f of base.fails) rep += `### ${f.name}\nBroken: ${f.classes.join(', ')}\n\n\`\`\`diff\n${f.diff.slice(0, 40).join('\n')}\n\`\`\`\n\n`;
rep += `## 2. Fidelity fixes (A)\n\n| config | pass | fail | classes |\n|---|---|---|---|\n`;
for (const r of results) rep += `| ${r.label} | ${r.pass} | ${r.fails.length} | ${JSON.stringify(r.classCount)} |\n`;
rep += `\n### Remaining failures with ALL fixes\n\n`;
for (const f of allRes.fails) rep += `#### ${f.name}\nBroken: ${f.classes.join(', ')}\n\n\`\`\`diff\n${f.diff.slice(0, 40).join('\n')}\n\`\`\`\n\n`;
rep += `## 3. Block-level merge (B)\n\nTest 1: mergeBlocks(orig, roundtrip(orig)) === orig. Test 2: append " EDITEDWORD" to the end of the first top-level paragraph in WYSIWYG, merge; lines outside that paragraph must be untouched.\n\n`;
for (const b of [bNone, bAll]) {
  rep += `### ${b.label}\n- Test 1 byte-identical: ${b.identical} / ${files.length}\n- Test 2: measured ${b.measured} (Toast crashed: ${b.crashed}, no paragraph: ${b.noPara}, unmeasurable: ${b.unmeasurable}); edit confined to the paragraph: ${b.clean}; lines outside the paragraph changed: ${b.outside.length}; edit lost: ${b.editLost}\n\n`;
  for (const f of b.notIdentical) rep += `#### test 1 not identical: ${f.name}\n\n\`\`\`diff\n${f.diff.slice(0, 20).join('\n')}\n\`\`\`\n\n`;
  for (const f of b.outside) rep += `#### test 2 outside edit: ${f.name} (paragraph lines ${f.para}, changed ${f.changed})\n\n\`\`\`diff\n${f.diff.slice(0, 20).join('\n')}\n\`\`\`\n\n`;
}
fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, rep);
console.log('shipped:', sum(base), JSON.stringify(base.classCount));
for (const r of results) console.log(r.label.padEnd(50), r.pass, r.fails.length, JSON.stringify(r.classCount));
for (const b of [bNone, bAll]) console.log(b.label, 'identical', b.identical, 'measured', b.measured, 'clean', b.clean, 'outside', b.outside.length, 'lost', b.editLost, 'nopara', b.noPara, 'unmeas', b.unmeasurable);
console.log('report:', REPORT);
