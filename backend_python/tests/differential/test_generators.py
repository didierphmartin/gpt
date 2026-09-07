"""Differential tests for WorkflowController's code-generator endpoints
(Phase 6, Task 4) -- `generate-python`, `generate-adk`, `generate-maf`,
`generate-nooa`. Port of
backend/src/AgentTeam/Controllers/WorkflowController.php:240-467.

PHP live at http://localhost/gpt/backend, Python in-process. Enumerates
EVERY workflow of user 3 (`SELECT id FROM agent_workflows WHERE user_id =
3`) x each of the 4 generators x each query-string mode the controller
supports (default JSON, `?download=1`, and -- generate-python only --
`?a2a=1`), asserting the response JSON is equal AND the code field(s) are
byte-equal between the two backends. No LLM calls: generation is pure
graph-to-source compilation, no agent execution.

Timestamp normalisation: PythonEmitHelpers.php:650 stamps every generated
module docstring with `date('Y-m-d H:i:s T')` (real wall clock, no
`generated_at` override passed by any generator) -- so PHP's own oracle,
GeneratedDocParityTest.php:102, does not byte-freeze this line either; it
only pattern-matches it:
    '/Generated:  \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} \\S+ by the SynergyAI workflow editor/'
Per constraints.md ("Normalise ONLY a generated-at timestamp line if PHP
emits one, and only if PHP's own tests do"), `_normalize` below replaces
that line with a fixed placeholder on both sides before comparing -- this
is the only normalisation applied; every other byte is compared as-is.

A byte mismatch here (outside the Generated: line) means the Python
generator (lang_graph_generator.py / adk_generator.py / maf_generator.py /
nooa_generator.py / python_emit_helpers.py / workflow_graph_analyzer.py)
has a bug -- fix the generator, never the test or the output.
"""
from __future__ import annotations

import re
import time

import httpx
import pytest

from app.db import open_primary
from tests.differential.conftest import DIFF_USER_ID

pytestmark = pytest.mark.differential


def _both_retrying(both, method, path, retries=2):
    """`both()` wrapped with a couple of retries on a transient network
    timeout -- this suite shares the live PHP/Python servers with every
    other concurrently-running Phase 6 agent's own differential runs, and
    a large-workflow ?download=1 response can occasionally miss the `php`
    fixture's 60s httpx timeout under that contention. Not a correctness
    relaxation: every retry still goes through the same `both()` call and
    the eventual response is compared byte-for-byte exactly as before."""
    last_exc = None
    for attempt in range(retries + 1):
        try:
            return both(method, path)
        except httpx.TimeoutException as e:
            last_exc = e
            if attempt < retries:
                time.sleep(2)
    raise last_exc

GENERATE_ENDPOINTS = [
    ('generate-python', True),   # (path segment, supports ?a2a=1)
    ('generate-adk', False),
    ('generate-maf', False),
    ('generate-nooa', False),
]

# Mirrors GeneratedDocParityTest.php:102's pattern exactly (PythonEmitHelpers.php:650's
# `date('Y-m-d H:i:s T')` format), so a malformed stamp on either side still fails loudly
# instead of being silently swallowed by a looser regex.
_GENERATED_RE = re.compile(
    r'Generated:  \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ by the SynergyAI workflow editor')
_GENERATED_PLACEHOLDER = 'Generated:  <normalized-timestamp> by the SynergyAI workflow editor'


def _normalize(obj):
    """Deep-walk a decoded JSON value (or a raw code string), replacing the
    wall-clock Generated: line with a fixed placeholder. Safe to apply
    broadly: the pattern only ever appears inside a generator's 'code'
    string(s)."""
    if isinstance(obj, str):
        return _GENERATED_RE.sub(_GENERATED_PLACEHOLDER, obj)
    if isinstance(obj, dict):
        return {k: _normalize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_normalize(v) for v in obj]
    return obj


def same_normalized(a, b):
    """Like tests/differential/conftest.py's `same()`, but normalises the
    Generated: timestamp line on both sides first."""
    assert a.status_code == b.status_code, (a.status_code, b.status_code, a.text, b.text)
    ja, jb = _normalize(a.json()), _normalize(b.json())
    assert ja == jb, (ja, jb)


@pytest.fixture(scope='module')
def workflow_ids(config):
    db = open_primary(config)
    try:
        rows = db.fetch_all(
            'SELECT id FROM agent_workflows WHERE user_id = ? ORDER BY id', [DIFF_USER_ID])
    finally:
        db.close()
    return [int(r['id']) for r in rows]


def test_generate_endpoints_not_found_parity(both):
    for path, _ in GENERATE_ENDPOINTS:
        same_normalized(*both('GET', f'/api/v1/workflows/999999999/{path}'))


def test_generate_endpoints_unauthenticated_parity(both):
    for path, _ in GENERATE_ENDPOINTS:
        same_normalized(*both('GET', f'/api/v1/workflows/1/{path}', auth=False))


def test_generate_all_workflows_default_mode_parity(both, workflow_ids):
    """Default JSON mode: {success, data: {filename, code}, status_code}."""
    assert workflow_ids, 'user 3 has no workflows to enumerate'
    mismatches = []
    for wf_id in workflow_ids:
        for path, _a2a in GENERATE_ENDPOINTS:
            a, b = both('GET', f'/api/v1/workflows/{wf_id}/{path}')
            try:
                same_normalized(a, b)
            except AssertionError as e:
                mismatches.append(f'{path} wf={wf_id}: {e}')
    assert not mismatches, '\n'.join(mismatches)


def test_generate_all_workflows_download_mode_parity(both, workflow_ids):
    """?download=1: raw text/x-python body, Content-Type + Content-Disposition
    headers, no JSON envelope."""
    assert workflow_ids
    mismatches = []
    for wf_id in workflow_ids:
        for path, _a2a in GENERATE_ENDPOINTS:
            a, b = _both_retrying(both, 'GET', f'/api/v1/workflows/{wf_id}/{path}?download=1')
            if a.status_code != b.status_code:
                mismatches.append(f'{path} wf={wf_id}: status {a.status_code} != {b.status_code}')
                continue
            if a.status_code != 200:
                # error path -- still JSON, compared by the default-mode test
                continue
            if a.headers.get('content-type') != b.headers.get('content-type'):
                mismatches.append(
                    f'{path} wf={wf_id}: content-type {a.headers.get("content-type")!r} '
                    f'!= {b.headers.get("content-type")!r}')
            if a.headers.get('content-disposition') != b.headers.get('content-disposition'):
                mismatches.append(
                    f'{path} wf={wf_id}: content-disposition '
                    f'{a.headers.get("content-disposition")!r} != {b.headers.get("content-disposition")!r}')
            a_norm = _GENERATED_RE.sub(_GENERATED_PLACEHOLDER, a.content.decode('utf-8'))
            b_norm = _GENERATED_RE.sub(_GENERATED_PLACEHOLDER, b.content.decode('utf-8'))
            if a_norm != b_norm:
                mismatches.append(f'{path} wf={wf_id}: byte mismatch in downloaded source '
                                   f'({len(a.content)} vs {len(b.content)} bytes)')
    assert not mismatches, '\n'.join(mismatches)


def test_generate_python_all_workflows_a2a_mode_parity(both, workflow_ids):
    """?a2a=1 (generate-python only): always JSON {success, data: {root,
    files: [{path, code}, ...]}}, download ignored."""
    assert workflow_ids
    mismatches = []
    for wf_id in workflow_ids:
        a, b = both('GET', f'/api/v1/workflows/{wf_id}/generate-python?a2a=1')
        try:
            same_normalized(a, b)
        except AssertionError as e:
            mismatches.append(f'generate-python a2a wf={wf_id}: {e}')
    assert not mismatches, '\n'.join(mismatches)
