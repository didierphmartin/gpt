"""Mirror of the TS backend's Logger: everything to stderr AND logs/backend.log."""
from __future__ import annotations

import logging
from pathlib import Path

_LOG_DIR = Path(__file__).resolve().parent.parent.parent / 'logs'
_logger: logging.Logger | None = None


def get_logger() -> logging.Logger:
    global _logger
    if _logger is not None:
        return _logger
    _LOG_DIR.mkdir(exist_ok=True)
    lg = logging.getLogger('gpt-backend-py')
    lg.setLevel(logging.INFO)
    fmt = logging.Formatter('[%(asctime)s] %(message)s', '%Y-%m-%d %H:%M:%S')
    fh = logging.FileHandler(_LOG_DIR / 'backend.log', encoding='utf-8')
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    lg.addHandler(fh)
    lg.addHandler(sh)
    lg.propagate = False
    _logger = lg
    return lg


def error_log(msg: str) -> None:
    """PHP error_log() equivalent."""
    get_logger().info(msg)
