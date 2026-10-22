/**
 * Monitoring survives a Save: the reload after a Save clears the canvas (currentWorkflowId briefly null), which
 * stops Monitoring's stream; a workflow that was being monitored must be followed again, into the same overlay.
 *
 * Extracts the REAL _reloadAfterSave from workflow-editor.js and drives it over stubs. No DOM, no network.
 *
 * Run: node frontend/assets/js/__tests__/monitoring-after-save.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const file = fs.readFileSync(path.resolve(__dirname, '../workflow-editor.js'), 'utf8');
const END = '\n    }\n';
function extract(signature) {
    const start = file.indexOf(signature);
    if (start < 0) throw new Error('could not find: ' + signature.trim());
    return file.slice(start, file.indexOf(END, start) + END.length).trim();
}
const methodSrc = extract('    async _reloadAfterSave(savedWorkflowId) {');

/** An editor monitoring workflow `monitoring` (null: not monitoring), whose loadWorkflow behaves like the real reload. */
function makeEditor(monitoring, source = { kind: 'server' }) {
    const ed = eval('({ ' + methodSrc + ' })');
    Object.assign(ed, {
        currentWorkflowId: 64, _monitoring: monitoring, _liveSource: monitoring ? source : null,
        stopped: 0, connects: [], overlayOpens: 0, loads: [],
        _liveStop: monitoring ? () => { ed.stopped++; } : null,
        // The real reload: clear (id null) -> _refreshMonitoring stops the stream -> the workflow is back.
        async loadWorkflow(id, opts) {
            ed.loads.push([id, opts]);
            ed.currentWorkflowId = null;
            ed._liveStop?.(); ed._liveStop = null; ed._monitoring = null;
            ed.currentWorkflowId = id;
        },
        _liveConnect(signal, id, src) { ed.connects.push({ signal, id, src }); return Promise.resolve(); },
        _refreshMonitoring() {},
        _pbOverlayOpen() { ed.overlayOpens++; },
    });
    return ed;
}

(async () => {
    // Monitored: the stream is back on the same workflow and source, the overlay is not reopened (its feed stays).
    let ed = makeEditor(64);
    await ed._reloadAfterSave(64);
    assert.deepStrictEqual(ed.loads, [[64, { quiet: true }]]);
    assert.strictEqual(ed._monitoring, 64);
    assert.strictEqual(ed.connects.length, 1);
    assert.strictEqual(ed.connects[0].id, 64);
    assert.deepStrictEqual(ed.connects[0].src, { kind: 'server' });
    assert.strictEqual(ed.connects[0].signal.aborted, false);
    assert.strictEqual(ed.overlayOpens, 0);
    ed._liveStop();   // the new stream can be stopped
    assert.strictEqual(ed.connects[0].signal.aborted, true);

    // A compiled program's stream comes back as compiled.
    ed = makeEditor(64, { kind: 'compiled', base: 'http://localhost:8000/' });
    await ed._reloadAfterSave(64);
    assert.deepStrictEqual(ed.connects[0].src, { kind: 'compiled', base: 'http://localhost:8000/' });

    // Not monitoring: nothing starts.
    ed = makeEditor(null);
    await ed._reloadAfterSave(64);
    assert.strictEqual(ed.connects.length, 0);
    assert.strictEqual(ed._monitoring, null);

    // Monitoring another workflow than the one saved (a save flushed while opening another): nothing starts.
    ed = makeEditor(12);
    await ed._reloadAfterSave(64);
    assert.strictEqual(ed.connects.length, 0);

    console.log('monitoring-after-save: ok');
})().catch((e) => { console.error(e); process.exit(1); });
