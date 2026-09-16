const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { swarmRewrite } = require('../swarm-rewrite.js');

const root = path.resolve(__dirname, '../../../..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'backend/tests/fixtures/swarm/rewrite-cases.json'), 'utf8'));
let failed = 0;

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
for (const c of fixture.cases) {
    const got = swarmRewrite(c.graph);
    const want = c.expect;
    const fail = (msg, g, w) => { console.error(`FAIL  ${c.name}\n      ${msg}\n      got:  ${JSON.stringify(g)}\n      want: ${JSON.stringify(w)}`); failed++; };

    if (!want.ok) {
        if (got.ok) { fail('expected a refusal', got.ok, false); continue; }
        if (got.error !== want.error) { fail('error code', got.error, want.error); continue; }
        if (!eq(got.nodes, want.nodes)) { fail('offending nodes', got.nodes, want.nodes); }
        continue;
    }
    if (!got.ok) { fail('expected acceptance', got.error, 'ok'); continue; }
    if (!eq(Object.keys(got.agents), want.agents)) { fail('agents', Object.keys(got.agents), want.agents); continue; }
    if (got.entry !== want.entry) { fail('entry', got.entry, want.entry); }

    const pairs = [];
    for (const [id, a] of Object.entries(got.agents)) for (const to of a.handoffs) pairs.push([id, to]);
    pairs.sort(); const wantPairs = [...want.handoffs].sort();
    if (!eq(pairs, wantPairs)) { fail('handoffs', pairs, wantPairs); }

    for (const needle of want.guide_contains || []) {
        const all = Object.values(got.agents).map(a => a.instructions).join('\n');
        if (!all.includes(needle)) { fail(`guide should mention "${needle}"`, '(absent)', needle); }
    }
    for (const [id, tools] of Object.entries(want.tools_by_agent || {})) {
        if (!eq(got.agents[id].tools, tools)) { fail(`tools of ${id}`, got.agents[id].tools, tools); }
    }
    for (const [id, skills] of Object.entries(want.skills_by_agent || {})) {
        if (!eq(got.agents[id].skills, skills)) { fail(`skills of ${id}`, got.agents[id].skills, skills); }
    }
}

console.log(failed === 0
    ? `swarm-rewrite: ${fixture.cases.length}/${fixture.cases.length} cases match the contract`
    : `swarm-rewrite: ${failed} mismatch(es)`);
process.exit(failed === 0 ? 0 : 1);
