"""Exception for SSE streaming errors."""
from .ai_assistant_exception import AIAssistantException


class StreamingException(AIAssistantException):
    """Exception for SSE streaming errors."""

    @staticmethod
    def connectionFailed(reason: str):
        """Create exception for connection failure."""
        return StreamingException(f"SSE connection failed: {reason}", 503)

    @staticmethod
    def writeFailed(reason: str):
        """Create exception for write failure."""
        return StreamingException(f"Failed to write to SSE stream: {reason}", 500)
