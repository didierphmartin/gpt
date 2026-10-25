"""Port of backend/src/AgentTeam/Services/DecisionRouter.php (interface) plus the plumbing the two
adapters share.

A decision-model adapter: asks one vendor's API a closed question (which of these targets?) and never
writes text. One class per protocol, registered in DecisionProtocols. Every adapter takes the same
constructor: (apiKey: str|None, http: httpx.Client|None, confidenceFloor: float, url: str, model: str)
where '' url/model mean the protocol default.

route() returns {outcome: 'routed'|'unclear'|'low_confidence'|'unavailable'|'error', target: dict|None,
confidence: float|None, probabilities: dict|list, ms: int|None, usage: dict, reason: str|None}.
'routed' is the only outcome that decides; ms is set only when the vendor answered.
"""
from __future__ import annotations

import json
import time

import httpx

from app.providers._http import SHARED_SSL_CONTEXT
from app.services.hume_tool_sync_service import guzzleErrorMessage
from app.support.phpcompat import php_floatval, php_strval, php_trim

UNCLEAR = 'unclear'
UNCLEAR_DESC = ('The request does not say enough to choose, or it genuinely spans '
                'several of the options. Pick this rather than guessing.')
DEFAULT_CONFIDENCE_FLOOR = 0.6
# 10s: a measured p50 of ~160ms and max of 385ms means a request still running after ten seconds is
# broken, not slow (Guzzle Client(['timeout' => 10])).
HTTP_TIMEOUT_S = 10


def blank() -> dict:
    return {'target': None, 'confidence': None, 'probabilities': [], 'ms': None, 'usage': []}


def _ascii_lower(s: str) -> str:
    return s.translate(str.maketrans('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'))


class DecisionRouter:
    """The interface (PHP DecisionRouter) with the constructor every adapter shares."""
    URL = ''
    MODEL = ''

    def __init__(self, apiKey: str | None = None, http: httpx.Client | None = None,
                 confidenceFloor: float = DEFAULT_CONFIDENCE_FLOOR, url: str = '', model: str = ''):
        # None = not configured. The key comes from DecisionKeyResolver; the environment is never read.
        self.apiKey = apiKey if apiKey is not None else ''
        self.http = http
        self.confidenceFloor = float(confidenceFloor)
        self.url = php_trim(url) if php_trim(url) != '' else self.URL
        self.model = php_trim(model) if php_trim(model) != '' else self.MODEL

    def isAvailable(self) -> bool:
        """Configured = a key is present."""
        return self.apiKey != ''

    def route(self, request: str, targets: list, question: str) -> dict:  # pragma: no cover - interface
        raise NotImplementedError

    # --- shared by the adapters -------------------------------------------------------------

    @staticmethod
    def _menu(targets: list) -> tuple[dict | None, dict | None]:
        """(named targets by name, None) or (None, the refusal) -- a branch named "unclear" would
        collide with the escape hatch and make its answer ambiguous; a menu of one is no choice."""
        named: dict = {}
        for t in targets:
            name = php_trim(php_strval(t.get('name') if isinstance(t, dict) and t.get('name') is not None else ''))
            if name == '' or _ascii_lower(name) == UNCLEAR:
                return None, {**blank(), 'outcome': 'error', 'reason': f"unusable target name: '{name}'"}
            named[name] = t
        if len(named) < 2:
            return None, {**blank(), 'outcome': 'error', 'reason': 'a menu needs at least two targets'}
        return named, None

    @staticmethod
    def _description(t: dict, name: str) -> str:
        # The child's own role is the best description of what it owns; fall back to the name so a
        # target with no prompt is still selectable.
        desc = php_trim(php_strval(t.get('description') if t.get('description') is not None else ''))
        return desc[:400] if desc != '' else name

    def _post(self, body: dict) -> httpx.Response:
        """POST the body as JSON (Guzzle 'json' option); raises httpx errors, HTTPStatusError on >= 400
        like Guzzle's http_errors."""
        headers = {'Authorization': 'Bearer ' + self.apiKey, 'Accept': 'application/json'}
        if self.http is not None:
            res = self.http.post(self.url, headers=headers, json=body)
        else:
            with httpx.Client(timeout=HTTP_TIMEOUT_S, verify=SHARED_SSL_CONTEXT) as client:
                res = client.post(self.url, headers=headers, json=body)
                res.read()
        res.raise_for_status()
        return res

    @staticmethod
    def _transportError(e: Exception) -> str:
        """Guzzle's exception message: its RequestException format for an HTTP error, else the error text."""
        if isinstance(e, httpx.HTTPStatusError):
            return guzzleErrorMessage(e.request, e.response)
        return str(e)

    @staticmethod
    def _decode(res: httpx.Response):
        try:
            return json.loads(res.text)
        except ValueError:
            return None

    def _classify(self, answer: dict, named: dict, ms: int, usage) -> dict:
        """The outcome mapping both adapters share, for an answer that carries a choice."""
        choice = php_strval(answer['choice'])
        conf = php_floatval(answer['confidence']) if answer.get('confidence') is not None else None
        probs = answer.get('probabilities') if isinstance(answer.get('probabilities'), (dict, list)) else []
        common = {'confidence': conf, 'probabilities': probs, 'ms': ms, 'usage': usage}
        if choice == UNCLEAR:
            return {**common, 'outcome': 'unclear', 'target': None, 'reason': 'the request names no branch'}
        if choice not in named:
            # Should be unreachable: the answer is constrained to what we sent. Treated as an error
            # rather than trusted, because the whole reason to use a decision model is that this cannot happen.
            return {**common, 'outcome': 'error', 'target': None, 'reason': f"answer '{choice}' is not on the menu"}
        if conf is not None and conf < self.confidenceFloor:
            return {**common, 'outcome': 'low_confidence', 'target': named[choice],
                    'reason': 'confidence %.2f below floor %.2f' % (conf, self.confidenceFloor)}
        return {**common, 'outcome': 'routed', 'target': named[choice], 'reason': None}

    @staticmethod
    def _elapsed_ms(t0: float) -> int:
        return int(round((time.time() - t0) * 1000))
