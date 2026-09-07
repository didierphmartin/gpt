"""Shared SSL context across the seven providers (final-review item 1) and the
Guzzle body-summary helper (item 5).

`ChatController::_initializeDefaultProvider` builds every enabled provider per
request; httpx 0.28 does not cache SSL contexts, so eight `httpx.Client()`s
each load certifi and build their own `ssl.SSLContext` (~410 ms measured).
curl (Guzzle) caches CA material process-wide, so this is not a parity
deviation — it restores PHP's behaviour.
"""
import inspect
import ssl
import time

import pytest

from app.config_.configuration import Configuration
from app.providers._http import SHARED_SSL_CONTEXT, guzzle_body_summary, headers_list_to_dict
from app.providers.claude_provider import ClaudeProvider
from app.providers.custom_provider import CustomProvider
from app.providers.deepseek_provider import DeepSeekProvider
from app.providers.gemini_provider import GeminiProvider
from app.providers.grok_provider import GrokProvider
from app.providers.kimi_provider import KimiProvider
from app.providers.openai_provider import OpenAIProvider

SEVEN = [ClaudeProvider, OpenAIProvider, GrokProvider, KimiProvider, DeepSeekProvider, GeminiProvider, CustomProvider]


def _build(cls):
    cfg = Configuration({'claude': {'api_key': 'K'}, 'openai': {'api_key': 'K'},
                         'providers': {'grok': {'api_key': 'K'}, 'kimi': {'api_key': 'K'},
                                       'deepseek': {'api_key': 'K'}, 'gemini': {'api_key': 'K'},
                                       'glm': {'api_key': 'K', 'base_url': 'https://api.z.ai/api/paas/v4'}}})
    return cls(cfg, 'glm') if cls is CustomProvider else cls(cfg)


def test_shared_ssl_context_is_a_real_context():
    assert isinstance(SHARED_SSL_CONTEXT, ssl.SSLContext)


@pytest.mark.parametrize('cls', SEVEN, ids=lambda c: c.__name__)
def test_every_provider_constructor_passes_the_shared_context(cls):
    src = inspect.getsource(cls.__init__)
    assert 'verify=SHARED_SSL_CONTEXT' in src, f'{cls.__name__}.__init__ builds its own SSLContext'


def test_building_all_seven_is_fast():
    providers = []
    t0 = time.time()
    for cls in SEVEN:
        providers.append(_build(cls))
    elapsed = time.time() - t0
    for p in providers:
        p.close()
    assert elapsed < 0.3, f'building seven providers took {elapsed:.3f}s — shared SSL context not in effect'


# ---------------------------------------------------------------------------
# Guzzle bodySummary (item 5)
# ---------------------------------------------------------------------------

def test_guzzle_body_summary_truncates_at_120_chars():
    assert guzzle_body_summary('') == ''
    assert guzzle_body_summary('x' * 120) == 'x' * 120
    assert guzzle_body_summary('x' * 121) == 'x' * 120 + ' (truncated...)'
    long = 'A' * 200 + 'TAIL'
    out = guzzle_body_summary(long)
    assert out == 'A' * 120 + ' (truncated...)' and 'TAIL' not in out


# ---------------------------------------------------------------------------
# headers_list_to_dict (C3, Phase 5 final-review wave -- previously
# duplicated verbatim in parallel_agent_executor.py and
# graph_workflow_runner.py; now the single shared home for both.)
# ---------------------------------------------------------------------------

def test_headers_list_to_dict_parses_and_trims():
    assert headers_list_to_dict(['Content-Type: application/json', 'X-Foo:  bar  ']) == {
        'Content-Type': 'application/json',
        'X-Foo': 'bar',
    }


def test_headers_list_to_dict_skips_entries_without_a_colon():
    assert headers_list_to_dict(['no-colon-here', 'A: b']) == {'A': 'b'}


def test_headers_list_to_dict_empty_list():
    assert headers_list_to_dict([]) == {}
