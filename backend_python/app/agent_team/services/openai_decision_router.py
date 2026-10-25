"""Port of backend/src/AgentTeam/Services/OpenAIDecisionRouter.php.

Routing decisions from OpenAI's Decisions API (GPT-6 Luna) -- the `openai` protocol adapter
(DecisionProtocols). Same contract as JevRouter: POST /v1/decisions answers a `choice` question with one
of the values supplied, never a value outside them, and bills no output; the synthetic `unclear` option
is offered on every call.

Wire differences from Jev: `input` instead of `state`; `questions` and `answers` are arrays matched by
`name`; choices are [{value, description}] (2..255); an answer may come back as type `refusal`.
"""
from __future__ import annotations

import json
import time

import httpx

from app.agent_team.services.decision_router import UNCLEAR, UNCLEAR_DESC, DecisionRouter, blank
from app.support.phpcompat import php_strval, php_trim

# The API's limit on choices per question, the unclear option included.
MAX_CHOICES = 255


class OpenAIDecisionRouter(DecisionRouter):
    URL = 'https://api.openai.com/v1/decisions'
    # The only model the Decisions API serves (public beta, 2026-10).
    MODEL = 'gpt-6-luna'
    UNCLEAR = UNCLEAR

    def route(self, request: str, targets: list, question: str) -> dict:
        if not self.isAvailable():
            return {**blank(), 'outcome': 'unavailable', 'reason': 'no OpenAI key'}
        named, refusal = self._menu(targets)
        if refusal is not None:
            return refusal
        if len(named) + 1 > MAX_CHOICES:
            return {**blank(), 'outcome': 'error', 'reason': f'a menu allows at most {MAX_CHOICES - 1} targets'}

        choices = [{'value': name, 'description': self._description(t, name)} for name, t in named.items()]
        choices.append({'value': UNCLEAR, 'description': UNCLEAR_DESC})

        body = {
            'model': self.model,
            'input': request,
            'questions': [
                {'type': 'choice', 'name': 'route', 'instructions': question, 'choices': choices},
            ],
        }

        t0 = time.time()
        try:
            res = self._post(body)
        except httpx.HTTPStatusError as e:
            return {**blank(), 'outcome': 'error', 'reason': self._apiError(e.response)}
        except httpx.HTTPError as e:
            return {**blank(), 'outcome': 'error', 'reason': str(e)}
        decoded = self._decode(res)
        ms = self._elapsed_ms(t0)

        answer = None
        answers = decoded.get('answers') if isinstance(decoded, dict) else None
        for a in (answers.values() if isinstance(answers, dict) else answers if isinstance(answers, list) else []):
            if isinstance(a, dict) and a.get('name') == 'route':
                answer = a
                break
        usage = decoded.get('usage') if isinstance(decoded, dict) and isinstance(decoded.get('usage'), (dict, list)) else []
        if isinstance(answer, dict) and answer.get('type') == 'refusal':
            return {'outcome': 'error', 'ms': ms, 'usage': usage, 'reason': 'the model refused to answer',
                    'target': None, 'confidence': None, 'probabilities': []}
        if not isinstance(answer, dict) or answer.get('choice') is None:
            return {'outcome': 'error', 'ms': ms, 'usage': usage, 'reason': 'no choice in the response',
                    'target': None, 'confidence': None, 'probabilities': []}
        return self._classify(answer, named, ms, usage)

    @staticmethod
    def _apiError(res: httpx.Response) -> str:
        """An HTTP error as OpenAI states it ("OpenAI HTTP 429 (insufficient_quota): You have no
        credits..."), instead of Guzzle's message, which truncates the body mid-sentence."""
        try:
            decoded = json.loads(res.text)
        except ValueError:
            decoded = None
        err = decoded.get('error') if isinstance(decoded, dict) else None
        out = f'OpenAI HTTP {res.status_code}'
        if not isinstance(err, dict):
            return out
        code = err.get('code') if err.get('code') is not None else err.get('type')
        code = php_strval(code if code is not None else '')
        msg = php_trim(php_strval(err.get('message') if err.get('message') is not None else ''))
        return out + (f' ({code})' if code != '' else '') + (f': {msg}' if msg != '' else '')
