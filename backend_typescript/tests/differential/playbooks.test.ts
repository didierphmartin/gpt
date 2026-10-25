/**
 * Differential: POST /api/v1/playbooks/validate — PHP vs TS (twin of
 * backend_python/tests/differential/test_playbooks.py).
 *
 * Uses a native-verb-only playbook (only #Resolve Request, no MCP tool binding) so the result is
 * deterministic regardless of user 3's actual live MCP tool registry — the same fixture
 * PlaybookControllerTest.php's simplest case exercises (a fully-resolvable document with no
 * dangling bindings). Read-only.
 */
import { dtest, same } from './harness';

dtest('test_playbooks_validate_parity', async (hx) => {
  // Auth / validation edge cases — exact compare.
  same(...(await hx.both('POST', '/api/v1/playbooks/validate', { json: { playbook: {} }, auth: false })));
  same(...(await hx.both('POST', '/api/v1/playbooks/validate', { json: {} })));

  // Native-verb-only object playbook: no MCP dependency, deterministic on both backends.
  const doc = {
    title: 'T',
    trigger: { kind: 'request', description: 'd' },
    instructions: '#Resolve Request.',
  };
  same(...(await hx.both('POST', '/api/v1/playbooks/validate', { json: { playbook: doc } })));

  // Console-text form of the same document.
  const text = 'Title: T\n\nTrigger: d\n\nInstructions: #Resolve Request.\n\nActions used: #Resolve Request';
  same(...(await hx.both('POST', '/api/v1/playbooks/validate', { json: { playbook: text } })));

  // Missing "playbook" field entirely -> 422 with the exact error text.
  same(...(await hx.both('POST', '/api/v1/playbooks/validate', { json: { not_playbook: true } })));
});
