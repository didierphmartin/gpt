"""Ported one-to-one from backend/scripts/test-vector-mcp-store.php (same
inputs, same expected values; `php backend/scripts/test-vector-mcp-store.php`
passes 28/28 against the current source, 2026-09-07).

VectorMcpStore is the store node's writer/reader. The MCP dispatch is
INJECTED (a callable) so no live vector server is needed -- this class does
no HTTP of its own; the real HTTP dispatch closure is built in
IngestionController (Task 6). Verifies the unified `store` (one batch call
per file, items:[{text,metadata}]) and `find` contract, and the mcp_qrant
envelope decode (payload in content[0].text; errors ride INSIDE the payload
as {error:true,...}).
"""
from __future__ import annotations

import json

import pytest

from app.agent_team.services.vector_mcp_store import VectorMcpStore


def _envelope(payload: dict) -> dict:
    """Wrap a payload in the mcp_qrant envelope the dispatch callable returns."""
    return {'content': [{'type': 'text', 'text': json.dumps(payload)}]}


# --- store: ONE `store` call carrying items[{text,metadata}] + provider/connection ---

def test_store_makes_one_batch_call_with_expected_shape():
    calls = []

    def dispatch(serverId, tool, args):
        calls.append({'serverId': serverId, 'tool': tool, 'args': args})
        return _envelope({'stored': 3, 'errors': 0})

    store = VectorMcpStore(dispatch)
    res = store.store(7, ['alpha', 'beta', '   ', 'gamma'], {
        'provider': 'qdrant',
        'connection': {'mode': 'local', 'path': '/tmp/q'},
        'collection': 'docs',
        'metadata': {'source': 'a/x.pdf'},
    })

    assert len(calls) == 1                                    # one store call total (batch per file)
    assert calls[0]['tool'] == 'store'                         # uses the `store` tool
    assert calls[0]['serverId'] == 7                           # targets the server id
    assert calls[0]['args']['provider'] == 'qdrant'            # passes provider
    assert calls[0]['args']['connection'].get('path') == '/tmp/q'  # passes connection
    assert calls[0]['args']['collection'] == 'docs'            # passes collection
    assert len(calls[0]['args']['items']) == 3                 # items skip the blank chunk (3 items)
    assert calls[0]['args']['items'][0]['text'] == 'alpha'     # item carries text
    assert calls[0]['args']['items'][0]['metadata'].get('source') == 'a/x.pdf'  # item carries metadata (provenance)
    assert 'embedding' not in calls[0]['args']                 # omits embedding when unset
    assert res['stored'] == 3                                  # returns stored from payload
    assert res['errors'] == 0                                  # returns errors from payload
    assert res['collection'] == 'docs'                         # returns collection


def test_store_all_blank_chunks_makes_no_call():
    calls2 = []

    def dispatch(serverId, tool, args):
        calls2.append(args)
        return _envelope({'stored': 0, 'errors': 0})

    store2 = VectorMcpStore(dispatch)
    res2 = store2.store(1, ['   ', ''], {'provider': 'qdrant', 'connection': {}, 'collection': 'c'})
    assert res2['stored'] == 0 and len(calls2) == 0


def test_store_forwards_embedding_when_set():
    ecalls = []

    def dispatch(serverId, tool, args):
        ecalls.append(args)
        return _envelope({'stored': 1, 'errors': 0})

    VectorMcpStore(dispatch).store(1, ['x'], {
        'provider': 'pgvector', 'connection': {}, 'collection': 'c', 'embedding': 'hf:all-MiniLM-L6-v2',
    })
    assert ecalls[0].get('embedding') == 'hf:all-MiniLM-L6-v2'


def test_store_payload_error_raises():
    def dispatch(serverId, tool, args):
        return _envelope({'error': True, 'code': 'store_failed', 'message': 'boom'})

    with pytest.raises(RuntimeError) as exc:
        VectorMcpStore(dispatch).store(1, ['x'], {'provider': 'qdrant', 'connection': {}, 'collection': 'c'})
    assert str(exc.value) == 'boom'


def test_store_transport_error_raises():
    def dispatch(serverId, tool, args):
        return {'error': True, 'message': 'HTTP 500'}   # normalized transport error, no envelope

    with pytest.raises(RuntimeError) as exc:
        VectorMcpStore(dispatch).store(1, ['x'], {'provider': 'qdrant', 'connection': {}, 'collection': 'c'})
    assert str(exc.value) == 'HTTP 500'


# --- find: builds args and maps results {text,metadata,score} ---

def test_find_builds_args_and_maps_results():
    fcalls = []

    def dispatch(serverId, tool, args):
        fcalls.append({'t': tool, 'a': args})
        return _envelope({'results': [
            {'text': 'solar power', 'metadata': {'source': 'energy.txt'}, 'score': 0.91},
            {'text': 'no score', 'metadata': {}, 'score': None},
        ]})

    finder = VectorMcpStore(dispatch)
    fr = finder.find(5, 'renewable energy', {
        'provider': 'qdrant', 'connection': {'mode': 'local'}, 'collection': 'docs',
    })

    assert fcalls[0]['t'] == 'find'                     # find uses the `find` tool
    assert fcalls[0]['a']['query'] == 'renewable energy'  # find passes query
    assert fcalls[0]['a']['limit'] == 5                 # find default limit = 5
    assert fr['results'][0]['text'] == 'solar power'    # find maps text
    assert fr['results'][0]['metadata'].get('source') == 'energy.txt'  # find maps metadata
    assert fr['results'][0]['score'] == 0.91            # find maps score
    assert fr['results'][1]['score'] is None            # find tolerates null score


def test_find_payload_error_raises():
    def dispatch(serverId, tool, args):
        return _envelope({'error': True, 'message': 'find boom'})

    with pytest.raises(RuntimeError) as exc:
        VectorMcpStore(dispatch).find(1, 'q', {'provider': 'qdrant', 'connection': {}, 'collection': 'c'})
    assert str(exc.value) == 'find boom'


# --- store/find: a response with NO {stored}/{results} field is a hard error
# (not a silent 0) -- this is the class of bug a 307 redirect / wrong
# endpoint produced: an empty or non-MCP body used to map to {stored:0} with
# no error. ---

def test_store_empty_non_mcp_response_raises():
    def dispatch(serverId, tool, args):
        return {}   # e.g. a redirect/non-MCP body

    with pytest.raises(RuntimeError) as exc:
        VectorMcpStore(dispatch).store(1, ['x'], {'provider': 'qdrant', 'connection': {}, 'collection': 'c'})
    assert 'no {stored}' in str(exc.value)


def test_store_response_without_stored_field_raises():
    def dispatch(serverId, tool, args):
        return _envelope({'ok': True})   # valid-looking, no `stored`

    with pytest.raises(RuntimeError) as exc:
        VectorMcpStore(dispatch).store(1, ['x'], {'provider': 'qdrant', 'connection': {}, 'collection': 'c'})
    assert 'no {stored}' in str(exc.value)


def test_find_empty_non_mcp_response_raises():
    def dispatch(serverId, tool, args):
        return {}

    with pytest.raises(RuntimeError) as exc:
        VectorMcpStore(dispatch).find(1, 'q', {'provider': 'qdrant', 'connection': {}, 'collection': 'c'})
    assert 'no {results}' in str(exc.value)


# --- connection default: PHP `(array) ($cfg['connection'] ?? [])` -- an
# unset connection is an empty PHP array, encoded as `[]` not `{}`. ---

def test_store_default_connection_is_empty_list_when_unset():
    calls = []

    def dispatch(serverId, tool, args):
        calls.append(args)
        return _envelope({'stored': 1, 'errors': 0})

    VectorMcpStore(dispatch).store(1, ['x'], {'provider': 'qdrant', 'collection': 'c'})
    assert calls[0]['connection'] == []
