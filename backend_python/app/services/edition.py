"""Port of Services/Edition.php: which edition this backend runs as,
'individual', 'corporate', or '' (hosted)."""
from __future__ import annotations

import os


def current(config: dict) -> str:
    """config['edition'] (ai_config.php reads GPT_EDITION into it); GPT_EDITION when the config has no key."""
    value = config['edition'] if 'edition' in config else os.environ.get('GPT_EDITION', '')
    return str(value or '')


def is_corporate(config: dict) -> bool:
    return current(config) == 'corporate'


def refuse_local_sign_in(config: dict) -> dict | None:
    """On a corporate install every session comes from the login service via sso_exchange; gpt's own
    credential paths must not issue one."""
    if not is_corporate(config):
        return None
    return {
        'success': False,
        'message': 'This installation signs in through its login service.',
        'status_code': 403,
    }
