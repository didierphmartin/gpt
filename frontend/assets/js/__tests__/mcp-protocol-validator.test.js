const assert = require('assert');
const MCPProtocolValidator = require('../mcp-protocol-validator.js');

// Latest spec revision the copied validator targets.
assert.strictEqual(MCPProtocolValidator.LATEST_VERSION, '2025-11-25');

// validateCapabilities returns { errors, warnings } (no `valid` key); tools as an array is a CRITICAL error.
const v = new MCPProtocolValidator();
const caps = v.validateCapabilities({ tools: [] });
assert.ok(caps.errors.length > 0, 'capabilities.tools = [] must produce an error');
assert.ok(caps.errors.some((e) => e.includes('tools')), 'error must mention "tools"');

// A well-formed tools/list response with an object inputSchema is valid.
const list = v.validateToolsListResponse({
    jsonrpc: '2.0',
    id: 2,
    result: { tools: [{ name: 'a', inputSchema: { type: 'object', properties: {} } }] },
});
assert.strictEqual(list.valid, true, 'expected valid tools/list response, errors: ' + JSON.stringify(list.errors));

console.log('mcp-protocol-validator.test.js: all assertions passed');
