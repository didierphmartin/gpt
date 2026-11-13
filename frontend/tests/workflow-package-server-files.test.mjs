import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WP = require('../assets/js/workflow-package.js');

// The files of the ServiceNow server folder, as an export would list them.
const SERVICENOW = [
    'index.php', 'src/Config.php', 'fixtures/mock.json',
    'config/pdi.env', 'config/pdi.env.example', 'config/.htaccess',
    '.env', '.env.example', 'prod.env', 'nested/dir/staging.env',
];

test('an exported server never carries a settings file, whatever its name before .env', () => {
    const shipped = WP.selectServerFiles(SERVICENOW, null);
    for (const secret of ['.env', 'config/pdi.env', 'prod.env', 'nested/dir/staging.env']) {
        assert.ok(!shipped.includes(secret), `${secret} must not be exported`);
    }
});

test('the .env.example files still travel (import builds the settings form from them)', () => {
    const shipped = WP.selectServerFiles(SERVICENOW, null);
    assert.ok(shipped.includes('.env.example'));
    assert.ok(shipped.includes('config/pdi.env.example'));
});

test('the server code itself still travels', () => {
    const shipped = WP.selectServerFiles(SERVICENOW, null);
    for (const f of ['index.php', 'src/Config.php', 'fixtures/mock.json']) assert.ok(shipped.includes(f), f);
});

test('a manifest include list cannot bring a settings file back', () => {
    const shipped = WP.selectServerFiles(SERVICENOW, { include: ['config/'] });
    assert.ok(!shipped.includes('config/pdi.env'));
    assert.ok(shipped.includes('config/pdi.env.example'));
});
