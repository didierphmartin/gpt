"""Base exception for AI Portfolio Assistant."""


class AIAssistantException(Exception):
    """Base exception for AI Portfolio Assistant."""

    def __init__(
        self,
        message: str = "",
        code: int = 0,
        previous: BaseException | None = None,
        context: dict | None = None,
    ):
        super().__init__(message)
        self.message = message
        self.code = code
        self.previous = previous
        self.context = dict(context or {})

    def __str__(self) -> str:
        """Return the message as string (matches PHP getMessage())."""
        return self.message

    def getMessage(self) -> str:
        """Get the exception message (matches PHP API)."""
        return self.message

    def getContext(self) -> dict:
        """Get additional context for the exception."""
        return self.context

    @classmethod
    def withContext(cls, message: str, context: dict | None = None, code: int = 0):
        """Create exception with context."""
        return cls(message, code, None, context)
