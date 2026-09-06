"""Carrier for PHP by-reference accumulators shared by every provider's recursive tool loop."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class _Totals:
    """Carrier for the PHP `&$inputTokens, &$outputTokens, &$functionCallCount,
    &$functionsCalled, &$mcpToolsCalled` reference parameters of
    handleToolUseRecursive(). Python has no by-reference scalars, so the
    accumulators travel in this mutable holder; the method still returns the
    response array like PHP does.
    """
    inputTokens: int = 0
    outputTokens: int = 0
    functionCallCount: int = 0
    functionsCalled: list = field(default_factory=list)
    mcpToolsCalled: list = field(default_factory=list)
