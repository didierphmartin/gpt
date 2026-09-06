"""Port of Providers/ProviderRequestFactory.php.

Factory for building provider HTTP requests and parsing responses.

This provides a single entry point for GraphWorkflowRunner and other
parallel execution contexts to build requests and parse responses
using the same logic as the provider classes.

Line-for-line port; PHP's `class_implements($class)` interface-implements
guard becomes `issubclass(cls, HttpRequestBuilderInterface)`, additionally
guarded with `isinstance(cls, type)` since Python has no static analogue
of PHP silently returning `false`/`[]` for a non-class value.
"""
from __future__ import annotations

from app.contracts.http_request_builder import HttpRequestBuilderInterface
from app.providers.claude_provider import ClaudeProvider
from app.providers.custom_provider import CustomProvider
from app.providers.deepseek_provider import DeepSeekProvider
from app.providers.gemini_provider import GeminiProvider
from app.providers.grok_provider import GrokProvider
from app.providers.kimi_provider import KimiProvider
from app.providers.openai_provider import OpenAIProvider
from app.support.logger import error_log


class ProviderRequestFactory:
    """
    Map of provider names to their implementing classes.
    Includes aliases (anthropic -> claude, google -> gemini).
    """
    _providerClasses: dict[str, type] = {
        'claude': ClaudeProvider,
        'anthropic': ClaudeProvider,
        'gemini': GeminiProvider,
        'google': GeminiProvider,
        'openai': OpenAIProvider,
        'deepseek': DeepSeekProvider,
        'grok': GrokProvider,
        'kimi': KimiProvider,
        # Gamma4: OpenAI-compatible, no dedicated class — handled generically by
        # CustomProvider (same as DeepSeek's instance path). Config comes from the
        # system_llm_settings 'gamma4' row via LLMProviderResolver.
        'gamma4': CustomProvider,
        # GLM 5.2 (z.ai / Zhipu): OpenAI-compatible, no dedicated class — handled
        # generically by CustomProvider. Config comes from the system_llm_settings
        # 'glm' row via LLMProviderResolver.
        'glm': CustomProvider,
    }

    @staticmethod
    def buildRequest(
        provider: str,
        model: str,
        messages: list,
        tools: list,
        config: dict,
        maxTokens: int,
        temperature: float,
    ) -> dict | None:
        """
        Build an HTTP request for the given provider.

        Args:
            provider: The provider name (claude, gemini, openai, etc.)
            model: The model to use
            messages: The messages array (OpenAI-compatible format)
            tools: The tools array (Claude format)
            config: Provider configuration
            maxTokens: Maximum tokens
            temperature: Temperature
        Returns:
            dict [url, headers, payload, provider] or None if provider not found
        """
        providerLower = provider.lower()
        cls = ProviderRequestFactory._providerClasses.get(providerLower)

        if cls is None:
            # Unknown provider - try OpenAI-compatible as fallback
            error_log(f"[ProviderRequestFactory] Unknown provider '{provider}', using OpenAI-compatible format")
            cls = OpenAIProvider

        # Check if class implements the interface
        if not (isinstance(cls, type) and issubclass(cls, HttpRequestBuilderInterface)):
            error_log(f"[ProviderRequestFactory] Provider class {cls} does not implement HttpRequestBuilderInterface")
            return None

        return cls.buildHttpRequest(model, messages, tools, config, maxTokens, temperature)

    @staticmethod
    def parseResponse(provider: str, decoded: dict) -> dict:
        """
        Parse an HTTP response for the given provider.

        Args:
            provider: The provider name
            decoded: The decoded JSON response
        Returns:
            dict [text, tool_calls, usage]
        """
        providerLower = provider.lower()
        cls = ProviderRequestFactory._providerClasses.get(providerLower)

        if cls is None:
            # Unknown provider - try OpenAI-compatible as fallback
            cls = OpenAIProvider

        # Check if class implements the interface
        if not (isinstance(cls, type) and issubclass(cls, HttpRequestBuilderInterface)):
            error_log(f"[ProviderRequestFactory] Provider class {cls} does not implement HttpRequestBuilderInterface")
            return {'text': '', 'tool_calls': [], 'usage': None}

        return cls.parseHttpResponse(decoded)

    @staticmethod
    def getApiFamily(provider: str) -> str:
        """
        Get the API family for a provider.

        Args:
            provider: The provider name
        Returns:
            One of: 'claude', 'gemini', 'openai'
        """
        providerLower = provider.lower()
        cls = ProviderRequestFactory._providerClasses.get(providerLower)

        if cls is None:
            return 'openai'  # Default to OpenAI-compatible

        if not (isinstance(cls, type) and issubclass(cls, HttpRequestBuilderInterface)):
            return 'openai'

        return cls.getApiFamily()

    @staticmethod
    def isSupported(provider: str) -> bool:
        """
        Check if a provider is supported.

        Args:
            provider: The provider name
        Returns:
            True if supported
        """
        return provider.lower() in ProviderRequestFactory._providerClasses

    @staticmethod
    def getSupportedProviders() -> list:
        """
        Get list of supported providers.

        Returns:
            List of provider names
        """
        return list(ProviderRequestFactory._providerClasses.keys())

    @classmethod
    def registerProvider(cls, name: str, providerClass: type) -> None:
        """
        Register a custom provider class.

        Args:
            name: The provider name
            providerClass: The provider class
        """
        cls._providerClasses[name.lower()] = providerClass
