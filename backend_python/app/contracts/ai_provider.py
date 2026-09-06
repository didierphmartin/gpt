"""Interface for AI providers (Claude, OpenAI, etc.)"""
from abc import ABC, abstractmethod


class AIProviderInterface(ABC):
    """Interface for AI providers (Claude, OpenAI, etc.)"""

    @abstractmethod
    def getName(self) -> str:
        """Get the provider name."""
        pass

    @abstractmethod
    def isAvailable(self) -> bool:
        """Check if the provider is available (configured with valid API key)."""
        pass

    @abstractmethod
    def chat(
        self,
        message: str,
        conversation_history: list = None,
        options: dict = None,
    ) -> dict:
        """
        Send a chat message and get a response.

        Args:
            message: User message
            conversation_history: Previous messages in the conversation
            options: Additional options (tools, system prompt, etc.)

        Returns:
            Response with 'text', 'usage', and other metadata
        """
        pass

    @abstractmethod
    def streamChat(
        self,
        message: str,
        on_chunk,
        conversation_history: list = None,
        options: dict = None,
    ) -> dict:
        """
        Send a chat message with streaming response.

        Args:
            message: User message
            on_chunk: Callback for each chunk of the response
            conversation_history: Previous messages
            options: Additional options
        """
        pass

    @abstractmethod
    def getModel(self) -> str:
        """Get the model being used."""
        pass

    @abstractmethod
    def setModel(self, model: str):
        """Set the model to use."""
        pass

    @abstractmethod
    def getSupportedModels(self) -> list:
        """Get supported models for this provider."""
        pass
