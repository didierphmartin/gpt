"""Port of backend/src/CodeComponent/CodeComponentError.php."""
from __future__ import annotations


class CodeComponentError(RuntimeError):
    """A refused collection operation: kind (not_found, invalid, name_taken, in_use, links_dropped, start_exit,
    is_option, not_option), its HTTP status, and details."""

    def __init__(self, kind: str, message: str, status: int, data: list | None = None):
        super().__init__(message)
        self.kind = kind
        self.status = status
        self.data = data if data is not None else []
