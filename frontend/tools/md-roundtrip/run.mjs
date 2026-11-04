// node frontend/tools/md-roundtrip/run.mjs [--opts '{"json":"editor options"}']
// Round-trips every SKILL.md body and references/**/*.md through Toast UI (md -> WYSIWYG -> md).
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(os.homedir(), 'Documents/synergyAI/skills');
const REPORT = '/private/tmp/claude-501/-Applications-XAMPP-xamppfiles-htdocs-gpt/f0deb36f-aec0-4ae0-8587-73e349dd10fa/scratchpad/md-roundtrip-report.md';
const oi = process.argv.indexOf('--opts');
const OPTS = oi > 0 ? JSON.parse(process.argv[oi + 1]) : { __hrDashes: true }; // kept option: thematicBreak -> ---
const jsOpts = process.argv.includes('--plugins-none') ? {} : OPTS;

function stripFrontmatter(s) { return s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''); }

function collect() {
  const files = [];
  for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const skill = path.join(ROOT, d.name, 'SKILL.md');
    if (fs.existsSync(skill)) files.push({ name: `${d.name}/SKILL.md`, file: skill, body: true });
    const refs = path.join(ROOT, d.name, 'references');
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.md')) files.push({ name: path.relative(ROOT, p), file: p, body: false });
      }
    };
    walk(refs);
  }
  return files;
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

let pass = 0; const fails = [];
for (const f of files) {
  let md = fs.readFileSync(f.file, 'utf8');
  if (f.body) md = stripFrontmatter(md);
  const rt = await page.evaluate(([m, o]) => window.roundtrip(m, o), [md, jsOpts]);
  const a = normalise(md), b = normalise(rt);
  if (a === b) { pass++; continue; }
  const diff = lineDiff(a, b);
  fails.push({ name: f.name, classes: classify(a, b, diff), diff });
}
await browser.close();

const classCount = {};
for (const f of fails) for (const c of f.classes) classCount[c] = (classCount[c] || 0) + 1;
const summary = `${files.length} files, ${pass} pass, ${fails.length} fail`;
let rep = `# Markdown round-trip report\n\nToast UI Editor 3.2.2, options: ${JSON.stringify(OPTS)}\n\n**${summary}**\n\nFailing classes: ${JSON.stringify(classCount)}\n\n`;
for (const f of fails) {
  rep += `## ${f.name}\nBroken: ${f.classes.join(', ')}\n\n\`\`\`diff\n${f.diff.slice(0, 40).join('\n')}\n\`\`\`\n\n`;
}
fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, rep);
console.log(summary);
console.log('classes:', JSON.stringify(classCount));
console.log('report:', REPORT);
