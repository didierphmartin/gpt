"""Port of backend/src/Automation/AutomationError.php."""
from __future__ import annotations


class AutomationError(RuntimeError):
    def __init__(self, message: str, status: int = 400, errorCode: str = 'bad_request'):
        super().__init__(message)
        self.status = status
        self.errorCode = errorCode
