"""Decision-model protocols (twin of Services/DecisionProtocols.php; no adapters here)."""
from __future__ import annotations

import re

DECISION_PROTOCOLS = {
    'typesafe': {
        'label': 'TypeSafe (Jev)',
        'url': 'https://api.typesafe.ai/v1/systemone',
        'model': 'jev-latest',
        'console_url': 'https://console.typesafe.ai/',
        'legacy_env': {'key': 'TYPESAFE_API_KEY', 'url': 'TYPESAFE_BASE_URL'},
    },
    'openai': {
        'label': 'OpenAI Decisions (GPT-6 Luna)',
        'url': 'https://api.openai.com/v1/decisions',
        'model': 'gpt-6-luna',
        'console_url': 'https://platform.openai.com/api-keys',
        'legacy_env': None,
    },
}


def decision_protocol_catalog() -> list[dict]:
    return [{'id': pid, 'label': p['label'], 'url': p['url'], 'model': p['model'], 'console_url': p['console_url']}
            for pid, p in DECISION_PROTOCOLS.items()]


def env_stem(key: str) -> str:
    """Env var stem for a row key: upper case, every char outside A-Z0-9 -> '_'."""
    return re.sub(r'[^A-Z0-9]', '_', key.upper())
