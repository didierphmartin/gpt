"""Interface for providers that can build HTTP requests for parallel execution."""
from abc import ABC, abstractmethod


class HttpRequestBuilderInterface(ABC):
    """
    Interface for providers that can build HTTP requests for parallel execution.

    This enables GraphWorkflowRunner to use provider classes instead of duplicating
    provider-specific request building and response parsing logic.
    """

    @staticmethod
    @abstractmethod
    def buildHttpRequest(
        model: str,
        messages: list,
        tools: list,
        config: dict,
        max_tokens: int,
        temperature: float,
    ) -> dict:
        """
        Build an HTTP request for the provider's API.

        Args:
            model: The model to use
            messages: The messages array (OpenAI-compatible format)
            tools: The tools array (Claude format: name, description, input_schema)
            config: Provider configuration (api_key, base_url, etc.)
            max_tokens: Maximum tokens for the response
            temperature: Temperature for generation

        Returns:
            dict with keys: url, headers, payload, provider
        """
        pass

    @staticmethod
    @abstractmethod
    def parseHttpResponse(decoded: dict) -> dict:
        """
        Parse the HTTP response from the provider's API.

        Args:
            decoded: The decoded JSON response

        Returns:
            dict with keys: text, tool_calls (OpenAI format), usage (normalized)
        """
        pass

    @staticmethod
    @abstractmethod
    def getApiFamily() -> str:
        """
        Get the API family for this provider.

        Returns:
            One of: 'claude', 'gemini', 'openai'
        """
        pass
