"""Port of Services/LLMManager.php.

Manages multiple LLM providers with fallback support.

Line-for-line port; PHP private methods become `_name`. PHP semantics are
reproduced with the helpers in app.support.phpcompat (`php_empty` for
`empty()`, dict-or-list for `is_array()`).
"""
from __future__ import annotations

from app.config_.configuration import Configuration
from app.exceptions import ProviderException
from app.support.logger import error_log
from app.support.phpcompat import php_empty
from app.support.phpjson import dumps


class LLMManager:
    """Manages multiple LLM providers with fallback support."""

    def __init__(self, config: Configuration):
        self.config = config
        # @var dict<str, AIProviderInterface> Registered providers
        self.providers: dict = {}
        # Provider fallback order
        self.fallbackOrder: list = ['claude', 'openai', 'grok', 'gemini']

    def registerProvider(self, name: str, provider) -> 'LLMManager':
        """Register a provider."""
        self.providers[name] = provider
        return self

    def getProvider(self, name: str):
        """Get a provider by name."""
        return self.providers.get(name)

    def getDefaultProvider(self):
        """Get the default provider."""
        defaultName = self.config.getDefaultProvider()

        p = self.providers.get(defaultName)
        if p is not None and p.isAvailable():
            return p

        # Fallback to first available provider
        for name in self.fallbackOrder:
            p = self.providers.get(name)
            if p is not None and p.isAvailable():
                return p

        raise ProviderException("No available LLM providers configured")

    def getAvailableProviders(self) -> list:
        """Get all available provider names."""
        available = []
        for name, provider in self.providers.items():
            if provider.isAvailable():
                available.append(name)
        return available

    def isProviderAvailable(self, name: str) -> bool:
        """Check if a provider is available."""
        p = self.providers.get(name)
        return p is not None and p.isAvailable()

    def normalizeConversationHistory(self, conversationHistory: list) -> list:
        """
        Normalize conversation history for cross-provider compatibility.

        This ensures all providers receive a consistent format regardless of
        which provider generated the original response. Enables heterogeneous
        LLM provider conversations where different providers can be used
        within the same conversation context.
        """
        normalized = []

        for entry in conversationHistory:
            # Skip invalid entries (PHP: is_object($entry) handling is moot in
            # Python — JSON decodes to dict/list already, never stdClass).
            if not isinstance(entry, dict):
                continue

            # Normalize role: 'model' (Gemini) → 'assistant'
            role = entry.get('role') if entry.get('role') is not None else 'user'
            if role == 'model':
                role = 'assistant'

            # B3: tool_result turns from a prior client-side tool dispatch
            # carry tool_call_id but their content is the raw JSON result —
            # they must NOT be flattened to text-only or they'd lose the id
            # the model needs to bind tool_use → tool_result. Pass through.
            if role == 'tool' and not php_empty(entry.get('tool_call_id')):
                content = entry.get('content')
                out = {
                    'role': 'tool',
                    'tool_call_id': entry['tool_call_id'],
                    'content': content if isinstance(content, str) else dumps(content),
                }
                # Preserve the function name when the frontend includes it
                # (Gemini's functionResponse needs it; OpenAI-shape ignores).
                if not php_empty(entry.get('name')) and isinstance(entry.get('name'), str):
                    out['name'] = entry['name']
                normalized.append(out)
                continue

            # B3: assistant turns that include tool_calls (the LLM's own
            # tool_use from the prior round) often arrive with empty
            # content. They still matter — Claude needs to see its own
            # tool_use to match the tool_result that follows. Pass them
            # through with tool_calls preserved instead of skipping.
            if role == 'assistant' and not php_empty(entry.get('tool_calls')):
                textContent = self._extractTextContent(entry.get('content') if entry.get('content') is not None else '')
                turn = {
                    'role': 'assistant',
                    'content': textContent,
                    'tool_calls': entry['tool_calls'],
                }
                # DeepSeek thinking mode: the reasoning that preceded the
                # tool calls must travel back with the replayed turn.
                reasoning = entry.get('reasoning_content')
                if isinstance(reasoning, str) and reasoning != '':
                    turn['reasoning_content'] = reasoning
                normalized.append(turn)
                continue

            # Extract text content from various formats
            rawContent = entry.get('content')
            if rawContent is None:
                rawContent = entry.get('text') if entry.get('text') is not None else ''
            content = self._extractTextContent(rawContent)

            # Skip empty content
            if php_empty(content.strip()):
                continue

            # Check if this entry has metadata about provider/tool usage
            # (PHP builds $metadata but never uses it beyond this check —
            # replicated faithfully, unused variable included for parity).
            if entry.get('tool_results') is not None or entry.get('function_results') is not None:
                # Preserve tool result context as text annotation
                toolResults = entry.get('tool_results')
                if toolResults is None:
                    toolResults = entry.get('function_results') if entry.get('function_results') is not None else []
                if not php_empty(toolResults) and isinstance(toolResults, (list, dict)):
                    toolSummary = self._summarizeToolResults(toolResults)
                    if not php_empty(toolSummary):
                        content += "\n\n[Tool Results: " + toolSummary + "]"

            normalized.append({
                'role': role,
                'content': content,
            })

        return normalized

    def _extractTextContent(self, content) -> str:
        """Extract text content from various content formats."""
        # Already a string
        if isinstance(content, str):
            return content

        # Not an array/dict - convert to string
        if not isinstance(content, (list, dict)):
            return self._php_str(content)

        # Array of content blocks (Claude format)
        textParts = []
        blocks = content.values() if isinstance(content, dict) else content
        for block in blocks:
            if isinstance(block, str):
                textParts.append(block)
            elif isinstance(block, dict):
                # Claude format: { type: 'text', text: '...' }
                if block.get('type') == 'text' and block.get('text') is not None:
                    textParts.append(block['text'])
                # Simple text field
                elif block.get('text') is not None:
                    textParts.append(block['text'])
                # Content field
                elif block.get('content') is not None:
                    c = block['content']
                    textParts.append(c if isinstance(c, str) else dumps(c))
                # Gemini parts format
                elif block.get('parts') is not None:
                    for part in block['parts']:
                        if isinstance(part, dict) and part.get('text') is not None:
                            textParts.append(part['text'])
                # Tool use blocks - include summary instead of stripping
                elif block.get('type') == 'tool_use':
                    toolName = block.get('name') if block.get('name') is not None else 'unknown_tool'
                    textParts.append(f"[Called tool: {toolName}]")
                # Tool result blocks
                elif block.get('type') == 'tool_result':
                    textParts.append("[Tool returned results]")

        return "\n".join(textParts)

    @staticmethod
    def _php_str(v) -> str:
        """PHP (string) cast for scalars encountered here."""
        if v is None:
            return ''
        if v is True:
            return '1'
        if v is False:
            return ''
        return str(v)

    def _summarizeToolResults(self, toolResults) -> str:
        """Summarize tool results for context preservation."""
        summaries = []
        items = toolResults.values() if isinstance(toolResults, dict) else toolResults
        for result in items:
            if isinstance(result, dict):
                toolName = result.get('name')
                if toolName is None:
                    toolName = result.get('tool_name') if result.get('tool_name') is not None else 'tool'
                summaries.append(toolName)
        return ', '.join(summaries)

    def chat(
        self,
        message: str,
        conversationHistory: list = None,
        options: dict = None,
    ) -> dict:
        """Process a chat message with the specified provider (no fallback)."""
        if conversationHistory is None:
            conversationHistory = []
        if options is None:
            options = {}

        # Provider MUST be specified explicitly — silent fallback to a
        # default provider has been removed because it masks caller bugs.
        if php_empty(options.get('provider')):
            raise ValueError(
                "LLMManager::chat requires $options['provider'] to be set explicitly. "
                "Missing provider at this point indicates a bug in the caller."
            )
        providerName = options['provider']
        provider = self.providers.get(providerName)

        if not provider:
            raise ProviderException(f"Provider '{providerName}' not found")

        if not provider.isAvailable():
            raise ProviderException(f"Provider '{providerName}' is not available (check API key)")

        # Normalize conversation history for cross-provider compatibility
        normalizedHistory = self.normalizeConversationHistory(conversationHistory)

        # No fallback - use the specified provider directly
        result = provider.chat(message, normalizedHistory, options)
        result['provider_used'] = providerName
        result['fallback_used'] = False

        return result

    def streamChat(
        self,
        message: str,
        onChunk,
        conversationHistory: list = None,
        options: dict = None,
    ) -> dict:
        """Process a streaming chat message with the specified provider."""
        if conversationHistory is None:
            conversationHistory = []
        if options is None:
            options = {}

        if php_empty(options.get('provider')):
            raise ValueError(
                "LLMManager::streamChat requires $options['provider'] to be set explicitly. "
                "Missing provider at this point indicates a bug in the caller."
            )
        providerName = options['provider']
        provider = self.providers.get(providerName)

        # Debug: Log provider selection
        error_log("[LLMManager] streamChat - requested provider: " + (options.get('provider') if options.get('provider') is not None else 'not specified'))
        error_log(f"[LLMManager] streamChat - resolved provider: {providerName}")
        error_log("[LLMManager] streamChat - registered providers: " + ', '.join(self.providers.keys()))

        if not provider:
            raise ProviderException(f"Provider '{providerName}' not found")

        if not provider.isAvailable():
            raise ProviderException(f"Provider '{providerName}' is not available (check API key)")

        # Normalize conversation history for cross-provider compatibility
        normalizedHistory = self.normalizeConversationHistory(conversationHistory)

        error_log(f"[LLMManager] streamChat - raw history count: {len(conversationHistory)}")
        error_log(f"[LLMManager] streamChat - normalized history count: {len(normalizedHistory)}")
        if not php_empty(normalizedHistory):
            for idx, entry in enumerate(normalizedHistory):
                content = entry.get('content') if entry.get('content') is not None else ''
                preview = content[:100]
                error_log(f"[LLMManager] History[{idx}]: role={entry['role']}, content=\"{preview}...\"")

        # Check if provider supports streaming
        if not hasattr(provider, 'streamChat'):
            # Fallback to regular chat
            result = provider.chat(message, normalizedHistory, options)
            onChunk(result['text'])
            result['provider_used'] = providerName
            result['fallback_used'] = False
            return result

        # Use the provider's streamChat method
        result = provider.streamChat(message, onChunk, normalizedHistory, options)
        result['provider_used'] = providerName
        result['fallback_used'] = False

        return result

    def _getProvidersToTry(self, preferred: str | None) -> list:
        """Get providers to try in order."""
        providers = []

        # Add preferred provider first
        if preferred and preferred in self.providers:
            providers.append(preferred)

        # Add default provider
        default = self.config.getDefaultProvider()
        if default and default not in providers and default in self.providers:
            providers.append(default)

        # Add remaining providers in fallback order
        for name in self.fallbackOrder:
            if name not in providers and name in self.providers:
                providers.append(name)

        return providers

    def setFallbackOrder(self, order: list) -> 'LLMManager':
        """Set the fallback order."""
        self.fallbackOrder = order
        return self

    def getProviderInfo(self, provider: str | None = None) -> dict:
        """Get provider information."""
        if provider:
            p = self.providers.get(provider)
            if not p:
                return {'error': f"Provider '{provider}' not found"}

            return {
                'name': p.getName(),
                'model': p.getModel(),
                'available': p.isAvailable(),
                'supported_models': p.getSupportedModels(),
            }

        info = {}
        for name, p in self.providers.items():
            info[name] = {
                'name': p.getName(),
                'model': p.getModel(),
                'available': p.isAvailable(),
            }

        return info

    def getConfig(self) -> Configuration:
        """Get configuration."""
        return self.config

    def close(self) -> None:
        """Python-only addition: PHP has no equivalent — Guzzle clients die
        with the request. Closes every registered provider that has a
        `close()` (e.g. ClaudeProvider's httpx.Client). Providers may be
        registered under multiple names for the same instance (e.g. 'claude'
        and 'anthropic' alias the same ClaudeProvider) — dedupe by identity
        so each underlying connection pool is closed once."""
        seen: set[int] = set()
        for provider in self.providers.values():
            if provider is None or id(provider) in seen:
                continue
            seen.add(id(provider))
            close = getattr(provider, 'close', None)
            if callable(close):
                try:
                    close()
                except Exception as e:  # noqa: BLE001
                    error_log(f"[LLMManager] close() failed for provider: {e}")
