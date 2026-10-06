"""Port of Services/Edition.php (minimal): which edition this backend runs as,
'individual', 'corporate', or '' (hosted)."""
from __future__ import annotations

import os


def current(config: dict) -> str:
    """config['edition'] (ai_config.php reads GPT_EDITION into it); GPT_EDITION when the config has no key."""
    value = config['edition'] if 'edition' in config else os.environ.get('GPT_EDITION', '')
    return str(value or '')


def is_corporate(config: dict) -> bool:
    return current(config) == 'corporate'
