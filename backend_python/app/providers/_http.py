"""Shared HTTP plumbing for the provider classes.

Two Python-only pieces with no PHP counterpart of their own — both exist to
reproduce what Guzzle/curl do for free:

1. `SHARED_SSL_CONTEXT` — `ChatController::_initializeDefaultProvider`
   instantiates every enabled provider on every chat request. httpx 0.28 does
   not cache SSL contexts, so each `httpx.Client()` builds its own
   `ssl.SSLContext` and loads certifi's CA bundle into it (~50 ms apiece,
   ~410 ms for eight clients). curl — and therefore Guzzle — caches CA
   material process-wide, so sharing one context here restores PHP's cost
   profile rather than deviating from it. No behaviour change: the context is
   built with httpx's own defaults.

2. `guzzle_body_summary` — Guzzle's `RequestException::getMessage()` embeds
   `GuzzleHttp\\Psr7\\Message::bodySummary($response)`, which reads at most 120
   bytes of the response body and appends `' (truncated...)'` when there is
   more. The ported providers append the body explicitly (httpx's `str(e)`
   carries only the status line), so they must apply the same cap or the
   user-visible text, `humanizeProviderError`'s regex surface and the
   `error_message` column all diverge from PHP.

   Only the 120-char rule is mirrored. Guzzle additionally returns `null` for
   an empty/non-seekable/non-readable body and for a summary containing
   non-printable characters; here an empty body yields `''` (the callers guard
   on truthiness anyway) and binary bodies are passed through — dropping the
   whole body on a stray control character would lose diagnostics that the
   ported callers, unlike Guzzle, have no other way to surface.
"""
from __future__ import annotations

import httpx

#: One SSL context reused by every provider's httpx.Client (see module docstring).
SHARED_SSL_CONTEXT = httpx.create_ssl_context()

#: Guzzle's Message::bodySummary default $truncateAt.
GUZZLE_BODY_SUMMARY_LIMIT = 120


def guzzle_body_summary(text: str, truncateAt: int = GUZZLE_BODY_SUMMARY_LIMIT) -> str:
    """Port of GuzzleHttp\\Psr7\\Message::bodySummary's truncation rule."""
    if not text:
        return ''
    if len(text) > truncateAt:
        return text[:truncateAt] + ' (truncated...)'
    return text


def headers_list_to_dict(headers: list) -> dict:
    """PHP's CURLOPT_HTTPHEADER list (['Name: value', ...], the shape
    ProviderRequestFactory::buildRequest()['headers'] returns) -> a header
    dict for httpx. Shared by parallel_agent_executor.py and
    graph_workflow_runner.py (Phase 5 final wave -- was duplicated in both)."""
    out = {}
    for h in headers:
        if ':' in h:
            k, v = h.split(':', 1)
            out[k.strip()] = v.strip()
    return out
