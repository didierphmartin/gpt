"""Interface for SSE streaming clients."""
from abc import ABC, abstractmethod


class StreamingClientInterface(ABC):
    """Interface for SSE streaming clients."""

    @abstractmethod
    def sendProgress(self, message: str) -> None:
        """Send a progress message to the client."""
        pass

    @abstractmethod
    def sendResponse(self, data: dict) -> None:
        """Send a response (JSON data) to the client."""
        pass

    @abstractmethod
    def sendError(self, message: str, code: int = 500) -> None:
        """Send an error to the client."""
        pass

    @abstractmethod
    def sendChunk(self, text: str) -> None:
        """Send a chunk of streaming text."""
        pass

    @abstractmethod
    def complete(self) -> None:
        """Signal that streaming is complete."""
        pass

    @abstractmethod
    def sendCustomEvent(self, event_name: str, data: dict) -> None:
        """Send a custom event with arbitrary data."""
        pass

    @abstractmethod
    def getSessionId(self) -> str:
        """Get the session ID."""
        pass

    @abstractmethod
    def isConnected(self) -> bool:
        """Check if the client is connected."""
        pass

    @abstractmethod
    def markHeadersInitialized(self) -> None:
        """Mark that headers have been initialized."""
        pass
