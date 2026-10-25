"""PHP's built-in \\InvalidArgumentException. A ValueError subclass, so callers that catch it can tell it
from any other ValueError (PHP catch clauses that name \\InvalidArgumentException catch only it)."""
from __future__ import annotations


class InvalidArgumentException(ValueError):
    pass
