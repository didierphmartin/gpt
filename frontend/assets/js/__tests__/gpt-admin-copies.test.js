// gpt_admin ships byte-identical copies of the MCP protocol test files; they must not drift.
const fs = require('fs');
const path = require('path');

const adminDir = process.env.GPT_ADMIN_DIR || path.resolve(__dirname, '../../../../../gpt_admin');
const pub = path.join(adminDir, 'public');
if (!fs.existsSync(adminDir) || !fs.existsSync(pub)) {
    console.log('gpt_admin not found, skipped');
    process.exit(0);
}

const files = [
    ['js/mcp-protocol-validator.js', 'mcp-protocol-validator.js'],
    ['js/mcp-protocol-test.js', 'mcp-protocol-test.js'],
    ['../css/mcp-protocol-test.css', 'mcp-protocol-test.css'],
];
let failed = 0;
for (const [src, name] of files) {
    const mine = path.resolve(__dirname, '..', src.replace(/^js\//, ''));
    const theirs = path.join(pub, name);
    let ok = false;
    try { ok = fs.readFileSync(mine).equals(fs.readFileSync(theirs)); } catch (e) { /* missing */ }
    console.log((ok ? 'ok   ' : 'FAIL ') + name);
    if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
