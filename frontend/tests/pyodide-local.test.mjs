import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const files = ['pyodide-runner.js', 'pyodide.worker.js'];

for (const f of files) {
    const src = readFileSync(new URL(`../assets/js/${f}`, import.meta.url), 'utf8');
    test(`${f} does not load Pyodide from the CDN`, () => {
        assert.ok(!src.includes('cdn.jsdelivr.net/pyodide'));
    });
    test(`${f} loads Pyodide from the vendored copy`, () => {
        assert.ok(src.includes('vendor/pyodide/v0.27.7/'));
    });
}
