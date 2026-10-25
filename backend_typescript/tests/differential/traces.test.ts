/**
 * TracesController PHP-vs-TS differential — twin of backend_python/tests/differential/test_traces.py.
 * Validation (empty body → no row) and the read-only diagnosis; no case writes data.
 */
import { dtest, same } from './harness';

dtest('test_traces_validation_and_diagnosis_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/traces', { json: {}, auth: false })));
  same(...(await hx.both('POST', '/api/v1/traces', { json: {} })));
  same(...(await hx.both('GET', '/api/v1/traces/diagnosis', { auth: false })));
  same(...(await hx.both('GET', '/api/v1/traces/diagnosis?days=30')));
});
