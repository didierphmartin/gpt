"""Minimal FastRoute equivalent: same pattern syntax, same FOUND / NOT_FOUND /
METHOD_NOT_ALLOWED outcomes, first-registered route wins."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

_PLACEHOLDER = re.compile(r'\{(\w+)(?::([^{}]*(?:\{[^{}]*\}[^{}]*)*))?\}')


@dataclass
class DispatchResult:
    status: str
    handler: tuple[str, str] | None = None
    params: dict[str, str] = field(default_factory=dict)
    allowed: list[str] = field(default_factory=list)


def compile_pattern(pattern: str) -> re.Pattern:
    out, pos = [], 0
    for m in _PLACEHOLDER.finditer(pattern):
        out.append(re.escape(pattern[pos:m.start()]))
        name, rx = m.group(1), m.group(2) or '[^/]+'
        out.append(f'(?P<{name}>{rx})')
        pos = m.end()
    out.append(re.escape(pattern[pos:]))
    return re.compile('^' + ''.join(out) + '$')


class Dispatcher:
    def __init__(self, routes):
        self._routes = [(method.upper(), compile_pattern(p), p, handler) for method, p, handler in routes]

    def dispatch(self, method: str, uri: str) -> DispatchResult:
        method = method.upper()
        allowed: list[str] = []
        for m, rx, _raw, handler in self._routes:
            match = rx.match(uri)
            if not match:
                continue
            if m == method or (method == 'HEAD' and m == 'GET'):
                return DispatchResult('FOUND', handler, match.groupdict())
            if m not in allowed:
                allowed.append(m)
        if allowed:
            return DispatchResult('METHOD_NOT_ALLOWED', allowed=allowed)
        return DispatchResult('NOT_FOUND')
