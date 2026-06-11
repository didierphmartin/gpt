(function () {
  const root = (typeof window !== 'undefined') ? window : globalThis;
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;

  class PyodideWorkerPool {
    constructor({ workerFactory, maxWorkers, idleMs = 120000 } = {}) {
      if (typeof workerFactory !== 'function') throw new Error('workerFactory required');
      this._make = workerFactory;
      this._max = Math.max(1, maxWorkers || Math.min(hc - 1, 4));
      this._idleMs = idleMs;
      this._idle = [];      // available workers
      this._live = 0;       // total spawned
      this._timer = null;
    }

    _acquire() {
      if (this._idle.length) return this._idle.pop();
      if (this._live < this._max) { this._live++; return this._make(); }
      return null; // caller must queue
    }

    _release(w) { this._idle.push(w); this._scheduleReap(); }

    _scheduleReap() {
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => {
        while (this._idle.length) { const w = this._idle.pop(); try { w.terminate(); } catch (_) {} this._live--; }
      }, this._idleMs);
    }

    // Run `items` concurrently (<= maxWorkers at once), preserving order.
    async runBatch(items) {
      const results = new Array(items.length);
      let next = 0;
      const runOne = async () => {
        while (next < items.length) {
          const i = next++;
          let w = this._acquire();
          while (!w) { await new Promise(r => setTimeout(r, 1)); w = this._acquire(); }
          try {
            const result = await w.run(items[i]);
            results[i] = { ok: true, result };
          } catch (err) {
            results[i] = { ok: false, error: String(err && err.message || err) };
          } finally {
            this._release(w);
          }
        }
      };
      const lanes = Math.min(this._max, items.length);
      await Promise.all(Array.from({ length: lanes }, runOne));
      return results;
    }

    async shutdown() {
      if (this._timer) clearTimeout(this._timer);
      while (this._idle.length) { const w = this._idle.pop(); try { w.terminate(); } catch (_) {} }
      this._live = 0;
    }
  }

  root.PyodideWorkerPool = PyodideWorkerPool;
})();
