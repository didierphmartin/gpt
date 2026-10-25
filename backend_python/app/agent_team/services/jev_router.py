"""Port of backend/src/AgentTeam/Services/JevRouter.php.

Routing decisions from TypeSafe AI's Jev, for dispatcher nodes -- the `typesafe` protocol adapter
(DecisionProtocols). Jev is a "System One" model: text in, a probability distribution out. It cannot
generate text, so it is not a chat provider; it picks one option from a closed set, and its answer is
CONSTRAINED to the options supplied, so a hallucinated branch is unrepresentable.

The synthetic `unclear` option is load-bearing: without it every input saturates onto some branch
("hello" routed to IT claims at 0.97). unclear = absent signal (route nowhere); confidence below the
floor = divided signal. The floor (0.6 by default) is exposed, not hardcoded. See the PHP docblock for
the measurements behind both.
"""
from __future__ import annotations

import time

import httpx

from app.agent_team.services.decision_router import (
    DEFAULT_CONFIDENCE_FLOOR, UNCLEAR, UNCLEAR_DESC, DecisionRouter, blank)


class JevRouter(DecisionRouter):
    # POST target. Captured from typesafe-sdk 0.7.2 rather than inferred.
    URL = 'https://api.typesafe.ai/v1/systemone'
    # Pinned by name, not by version: the API resolves it (answered jev-1.13.0 when written).
    MODEL = 'jev-latest'
    # The synthetic option that lets "I cannot tell" be sayable. Never a real branch name.
    UNCLEAR = UNCLEAR
    DEFAULT_CONFIDENCE_FLOOR = DEFAULT_CONFIDENCE_FLOOR

    def route(self, request: str, targets: list, question: str) -> dict:
        """Choose one target for request, or say why not. targets: DispatchRouting.targets() shape;
        question: what the dispatcher is deciding (the node's own prompt)."""
        if not self.isAvailable():
            return {**blank(), 'outcome': 'unavailable', 'reason': 'no Jev key'}
        named, refusal = self._menu(targets)
        if refusal is not None:
            return refusal

        criteria = {name: self._description(t, name) for name, t in named.items()}
        criteria[UNCLEAR] = UNCLEAR_DESC

        body = {
            'state': {'request': request},
            'model': self.model,
            'questions': {
                'route': {'type': 'choice', 'instructions': question, 'criteria': criteria},
            },
        }

        t0 = time.time()
        try:
            res = self._post(body)
        except httpx.HTTPError as e:
            return {**blank(), 'outcome': 'error', 'reason': self._transportError(e)}
        decoded = self._decode(res)
        ms = self._elapsed_ms(t0)

        answers = decoded.get('answers') if isinstance(decoded, dict) else None
        answer = answers.get('route') if isinstance(answers, dict) else None
        usage = decoded.get('usage') if isinstance(decoded, dict) and isinstance(decoded.get('usage'), (dict, list)) else []
        if not isinstance(answer, dict) or answer.get('choice') is None:
            # Answered, so it keeps its time and usage (both are recorded).
            return {'outcome': 'error', 'ms': ms, 'usage': usage, 'reason': 'no choice in the response',
                    'target': None, 'confidence': None, 'probabilities': []}
        return self._classify(answer, named, ms, usage)
