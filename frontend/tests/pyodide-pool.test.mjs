import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadPool() {
  const code = readFileSync(new URL('../assets/js/pyodide-pool.js', import.meta.url), 'utf8');
  // Inject the host realm's Array so arrays the IIFE builds (new Array(...))
  // share this realm's Array.prototype — otherwise assert.deepStrictEqual
  // rejects identical arrays on a cross-realm prototype mismatch. Also pass
  // the timer fns the reaper needs. A real browser has one realm, so this is
  // closer to production than an isolated-globals sandbox.
  const ctx = { Array, navigator: { hardwareConcurrency: 8 }, console, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx; // PyodideWorkerPool is attached to the ctx (globalThis)
}

// Mock worker factory: each "worker" runs a provided async fn keyed by payload.
function mockFactory(behavior) {
  let live = 0; const peak = { n: 0 };
  const make = () => {
    live++; peak.n = Math.max(peak.n, live);
    return {
      run: async (payload) => behavior(payload),
      terminate: () => { live--; },
    };
  };
  return { make, peak, liveCount: () => live };
}

// 1. Batch preserves original order even when later items finish first.
{
  const ctx = loadPool();
  const f = mockFactory(async (p) => { await new Promise(r => setTimeout(r, p.label === 'slow' ? 30 : 1)); return p.label; });
  const pool = new ctx.PyodideWorkerPool({ workerFactory: f.make, maxWorkers: 4 });
  const out = await pool.runBatch([{ label: 'slow' }, { label: 'fast' }]);
  assert.deepStrictEqual(out.map(r => r.result), ['slow', 'fast'], 'results in original order');
  await pool.shutdown();
}

// 2. Concurrency is capped at maxWorkers.
{
  const ctx = loadPool();
  const f = mockFactory(async () => { await new Promise(r => setTimeout(r, 10)); return 'ok'; });
  const pool = new ctx.PyodideWorkerPool({ workerFactory: f.make, maxWorkers: 2 });
  await pool.runBatch(Array.from({ length: 6 }, (_, i) => ({ label: i })));
  assert.strictEqual(f.peak.n, 2, 'never more than 2 workers live');
  await pool.shutdown();
}

// 3. A failing item rejects only that item; siblings still resolve.
{
  const ctx = loadPool();
  const f = mockFactory(async (p) => { if (p.label === 'bad') throw new Error('boom'); return p.label; });
  const pool = new ctx.PyodideWorkerPool({ workerFactory: f.make, maxWorkers: 4 });
  const out = await pool.runBatch([{ label: 'good' }, { label: 'bad' }]);
  assert.strictEqual(out[0].ok, true);
  assert.strictEqual(out[0].result, 'good');
  assert.strictEqual(out[1].ok, false);
  assert.match(out[1].error, /boom/);
  await pool.shutdown();
}

console.log('pyodide-pool.test.mjs: all assertions passed');
