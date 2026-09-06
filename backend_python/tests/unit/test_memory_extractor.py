import json
import httpx
from app.agent_team.services.memory_extractor import MemoryExtractor


def _ex(reply_text, capture=None):
    def handler(req):
        if capture is not None: capture.append(json.loads(req.content))
        assert req.headers['x-api-key'] == 'K' and req.headers['anthropic-version'] == '2023-06-01'
        return httpx.Response(200, json={'content': [{'type': 'text', 'text': reply_text}]})
    e = MemoryExtractor('K'); e.http = httpx.Client(transport=httpx.MockTransport(handler)); return e


def test_extract_parses_json_and_fences():
    cap = []
    e = _ex('```json\n{"memory_additions":["uses pytest",""],"user_additions":["likes tea"],"reason":"r"}\n```', cap)
    out = e.extract('claude-haiku-4-5-20251001', 'M', '', 'a long enough user message', 'reply')
    assert out == {'memory_additions': ['uses pytest'], 'user_additions': ['likes tea'], 'reason': 'r'}
    assert cap[0]['model'] == 'claude-haiku-4-5-20251001' and cap[0]['max_tokens'] == 512 and '=== CURRENT USER ===\n(empty)' in cap[0]['messages'][0]['content']
    assert _ex('not json').extract('m', '', '', 'u', 'a') is None
    assert MemoryExtractor('').extract('m', '', '', 'u', 'a') is None


def test_filter_duplicates_and_compact():
    e = _ex('[1]')
    assert e.filterDuplicates('m', 'existing', ['dup', 'new']) == ['new']
    assert e.filterDuplicates('m', '', ['a']) == ['a']                       # empty current → all kept, no call
    assert _ex('garbage').filterDuplicates('m', 'x', ['a']) == ['a']
    c = _ex('x' * 50)
    assert c.compact('m', 'content', 20, ['keep']) == 'x' * 20 and c.compact('m', '', 20) is None


def _malformed_body():
    def handler(req):
        return httpx.Response(200, content=b'<html>oops</html>', headers={'content-type': 'text/html'})
    e = MemoryExtractor('K'); e.http = httpx.Client(transport=httpx.MockTransport(handler)); return e


def test_malformed_json_body_treated_like_http_error():
    assert _malformed_body().extract('m', '', '', 'a long enough user message', 'reply') is None
    assert _malformed_body().filterDuplicates('m', 'existing', ['a']) == ['a']
    assert _malformed_body().compact('m', 'content', 20) is None
