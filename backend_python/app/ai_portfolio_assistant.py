"""Port of AIPortfolioAssistant.php.

AI Portfolio Assistant - Main entry point.

A reusable orchestrator for AI-powered portfolio analysis with Claude
integration, streaming support, and extensible functions.

Line-for-line port; PHP private methods become `_name`. All six dedicated
provider classes plus CustomProvider are wired here (Phase 2b).
"""
from __future__ import annotations

from app.config_.configuration import Configuration
from app.functions.search_functions import SearchFunctions
from app.models.conversation import Conversation
from app.providers.claude_provider import ClaudeProvider
from app.providers.custom_provider import CustomProvider
from app.providers.deepseek_provider import DeepSeekProvider
from app.providers.gemini_provider import GeminiProvider
from app.providers.grok_provider import GrokProvider
from app.providers.kimi_provider import KimiProvider
from app.providers.openai_provider import OpenAIProvider
from app.services.debug_logger import DebugLogger
from app.services.llm_manager import LLMManager
from app.services.sse_hub_client import SSEHubClient
from app.services.tools_manager import ToolsManager
from app.services.usage_tracker import UsageTracker
from app.support.logger import error_log
from app.support.phpcompat import php_empty, ucfirst


class AIPortfolioAssistant:
    """AI Portfolio Assistant - Main entry point."""

    # Providers with a dedicated handler class. Any other provider that
    # appears in config['providers'] with a base_url is OpenAI-compatible
    # and is served by the generic CustomProvider (glm, gamma4, future
    # providers added through system_llm_settings). Keep this map in sync
    # with ProviderRequestFactory's provider classes (and PHP
    # AIPortfolioAssistant::DEDICATED_PROVIDERS, same order).
    DEDICATED_PROVIDERS = {
        'claude': ClaudeProvider,
        'deepseek': DeepSeekProvider,
        'gemini': GeminiProvider,
        'grok': GrokProvider,
        'kimi': KimiProvider,
        'openai': OpenAIProvider,
    }

    def __init__(self, config: dict | Configuration = {}):
        self.config = config if isinstance(config, Configuration) else Configuration(config)
        self.toolsManager = ToolsManager()
        self.llmManager = LLMManager(self.config)
        self.usageTracker: UsageTracker | None = None
        self.logger: DebugLogger | None = None
        self.pdo = None
        self._searchFunctions: SearchFunctions | None = None

        if self.config.isDebugEnabled():
            self.logger = DebugLogger(True)

        self._initializeDefaultProvider()

    @staticmethod
    def fromEnvironment() -> 'AIPortfolioAssistant':
        """Create instance from environment variables."""
        return AIPortfolioAssistant(Configuration.fromEnvironment())

    @staticmethod
    def fromConfigFile(path: str) -> 'AIPortfolioAssistant':
        """Create instance from config file."""
        return AIPortfolioAssistant(Configuration.fromFile(path))

    def setDatabase(self, pdo) -> 'AIPortfolioAssistant':
        """Set database connection for portfolio functions."""
        self.pdo = pdo
        self._registerDatabaseFunctions()

        # Enable usage tracking with database
        if self.config.get('tracking.enabled', True):
            self.usageTracker = UsageTracker(pdo, True)

            # Set usage tracker on all registered providers
            self._propagateUsageTrackerToProviders()

        return self

    def _propagateUsageTrackerToProviders(self) -> None:
        """Propagate usage tracker to all registered providers."""
        if not self.usageTracker:
            return

        # Get all registered providers and set usage tracker on each
        providerInfo = self.llmManager.getProviderInfo()
        for providerName in providerInfo.keys():
            provider = self.llmManager.getProvider(providerName)
            if provider and hasattr(provider, 'setUsageTracker'):
                provider.setUsageTracker(self.usageTracker)

    # The tool list handed to the provider (providers prefer options['tools']
    # over their executor, so this is where a filter must be enforced):
    #  - default (conversation): base tools + caller tools (e.g. MCP);
    #  - skill turn (skill_metadata set): caller tools only — see the note in
    #    git history about Gemini dropping required fields when diluted;
    #  - tools_filter array (workflow node): EXACTLY the named tools from both
    #    sets, [] meaning no tools at all.
    @staticmethod
    def resolveToolsForRequest(baseTools: list, callerTools: list, options: dict) -> list:
        toolsFilter = options.get('tools_filter')
        if toolsFilter is not None and isinstance(toolsFilter, (list, dict)):
            allow = {str(t) for t in (toolsFilter.values() if isinstance(toolsFilter, dict) else toolsFilter)}
            merged = list(baseTools) + list(callerTools)
            return [t for t in merged if str(t.get('name') if t.get('name') is not None else '') in allow]
        if not php_empty(options.get('skill_metadata')):
            return callerTools
        return list(baseTools) + list(callerTools)

    def chat(
        self,
        message: str,
        userId=None,
        conversationHistory: list = None,
        options: dict = None,
    ) -> dict:
        if conversationHistory is None:
            conversationHistory = []
        if options is None:
            options = {}
        options = dict(options)
        options['user_id'] = userId

        # Merge base tools with any additional tools passed in options (e.g., MCP tools).
        # EXCEPTION: when the caller has set skill_metadata (a folder-backed skill
        # is the active turn target), it has already narrowed options['tools'] to
        # exactly the run_skill_script tool with the correct script enum and the
        # intent is "MCP and base tools are suppressed". Merging base tools here
        # unconditionally has the effect of (a) re-introducing 9+ unrelated tools
        # (search/finance/SEC), inflating prompt tokens by ~6-12K, and (b) diluting
        # the schema attention so Gemini sometimes drops required fields like
        # `script` from the run_skill_script call — observed empirically as
        # "Tool execution failed: runSkillScript: script is required" when the
        # model attached the rest of the call (argv, input_files, read_outputs)
        # but omitted the script enum value.
        options['tools'] = self.resolveToolsForRequest(
            self.toolsManager.getToolDefinitions(),
            options.get('tools') if options.get('tools') is not None else [],
            options,
        )

        return self.llmManager.chat(message, conversationHistory, options)

    def streamChat(
        self,
        message: str,
        sessionId: str,
        userId=None,
        conversationHistory: list = None,
        options: dict = None,
    ) -> dict:
        if conversationHistory is None:
            conversationHistory = []
        if options is None:
            options = {}
        options = dict(options)

        sseClient = SSEHubClient.create(
            sessionId,
            self.config.get('sse.hub_url'),
            self.config.isDebugEnabled(),
        )

        # Mark headers as initialized (chat.php already sent SSE headers)
        sseClient.markHeadersInitialized()

        # Provider MUST be explicit. A missing provider is a caller bug.
        if php_empty(options.get('provider')):
            raise ValueError(
                "AIPortfolioAssistant::streamChat requires $options['provider']. "
                "Silent fallback to a default provider has been removed."
            )
        providerName = options['provider']
        error_log(f"[AIPortfolioAssistant] streamChat - provider: {providerName}")
        provider = self.llmManager.getProvider(providerName)

        if provider and hasattr(provider, 'setSSEClient'):
            provider.setSSEClient(sseClient)

        options['user_id'] = userId

        # Merge base tools with any additional tools passed in options (e.g., MCP tools).
        # EXCEPTION: when the caller has set skill_metadata (a folder-backed skill
        # is the active turn target), it has already narrowed options['tools'] to
        # exactly the run_skill_script tool with the correct script enum and the
        # intent is "MCP and base tools are suppressed". Merging base tools here
        # unconditionally has the effect of (a) re-introducing 9+ unrelated tools
        # (search/finance/SEC), inflating prompt tokens by ~6-12K, and (b) diluting
        # the schema attention so Gemini sometimes drops required fields like
        # `script` from the run_skill_script call — observed empirically as
        # "Tool execution failed: runSkillScript: script is required" when the
        # model attached the rest of the call (argv, input_files, read_outputs)
        # but omitted the script enum value.
        options['tools'] = self.resolveToolsForRequest(
            self.toolsManager.getToolDefinitions(),
            options.get('tools') if options.get('tools') is not None else [],
            options,
        )

        try:
            # Use streamChat instead of chat
            def onChunk(chunk):
                # This callback is for providers that don't support native streaming
                sseClient.sendChunk(chunk)

            response = self.llmManager.streamChat(
                message,
                onChunk,
                conversationHistory,
                options,
            )

            # Send final response with usage stats
            sseClient.sendResponse(response)
            sseClient.complete()

            return response
        except Exception as e:
            sseClient.sendError(str(e))
            raise

    def chatWithConversation(
        self,
        message: str,
        conversation: Conversation,
        options: dict = None,
    ) -> dict:
        """Chat using a Conversation object."""
        if options is None:
            options = {}
        response = self.chat(
            message,
            conversation.getUserId(),
            conversation.getHistory(),
            options,
        )

        # Update conversation
        conversation.addUserMessage(message)
        conversation.addAssistantMessage(response.get('text'), {
            'usage': response.get('usage') if response.get('usage') is not None else {},
            'provider': response.get('provider_used') if response.get('provider_used') is not None else 'claude',
        })

        return response

    def registerFunction(self, name: str, handler, schema: dict) -> 'AIPortfolioAssistant':
        """Register a custom function."""
        self.toolsManager.registerFunction(name, handler, schema)
        return self

    def registerFunctions(self, functions: dict) -> 'AIPortfolioAssistant':
        """Register multiple functions."""
        self.toolsManager.registerFunctions(functions)
        return self

    def loadToolsFromJson(self, path: str) -> 'AIPortfolioAssistant':
        """Load tool definitions from JSON file."""
        self.toolsManager.loadFromJson(path)
        return self

    def getConfig(self) -> Configuration:
        """Get the configuration."""
        return self.config

    def getLLMManager(self) -> LLMManager:
        """Get the LLM manager."""
        return self.llmManager

    def getToolsManager(self) -> ToolsManager:
        """Get the tools manager."""
        return self.toolsManager

    def getAvailableProviders(self) -> list:
        """Get available providers."""
        return self.llmManager.getAvailableProviders()

    def getProviderInfo(self, provider: str | None = None) -> dict:
        """Get provider information."""
        return self.llmManager.getProviderInfo(provider)

    def setModel(self, model: str, provider: str) -> 'AIPortfolioAssistant':
        """Set the model for a specific provider."""
        providerInstance = self.llmManager.getProvider(provider)
        if providerInstance:
            providerInstance.setModel(model)
        return self

    def setProvider(self, provider: str) -> 'AIPortfolioAssistant':
        """Set the active provider."""
        if not self.llmManager.isProviderAvailable(provider):
            raise ValueError(f"Provider '{provider}' is not available")
        self.config.set('default_provider', provider)
        return self

    def getCurrentProvider(self) -> str:
        """Get the current active provider name."""
        return self.config.getDefaultProvider()

    def getAllProviders(self) -> list:
        """Get all registered providers with their info."""
        providers = []
        registeredProviders = self.llmManager.getProviderInfo()

        for name, info in registeredProviders.items():
            # Check providers array first, then root level config (for claude/openai)
            providerConfig = self.config.get(f"providers.{name}", {})
            if php_empty(providerConfig):
                providerConfig = self.config.get(name, {})
            providers.append({
                'name': name,
                'display_name': providerConfig.get('display_name') if isinstance(providerConfig, dict) and providerConfig.get('display_name') is not None else ucfirst(name),
                'model': info['model'],
                'available': info['available'],
            })

        return providers

    def close(self) -> None:
        """Python-only addition: PHP has no equivalent — Guzzle clients die
        with the request. Closes the LLM manager (which closes every
        registered provider's httpx.Client) and this instance's
        SearchFunctions httpx.Client."""
        self.llmManager.close()
        if self._searchFunctions is not None:
            try:
                self._searchFunctions.close()
            except Exception as e:  # noqa: BLE001
                error_log(f"[AIPortfolioAssistant] close() failed for SearchFunctions: {e}")

    def createConversation(self, userId: str | None = None, metadata: dict = None) -> Conversation:
        """Create a new conversation."""
        if metadata is None:
            metadata = {}
        return Conversation(None, userId, metadata)

    def _makeProvider(self, name: str):
        """
        Instantiate a provider (dedicated class when one exists, generic
        CustomProvider otherwise) and wire the shared collaborators.
        """
        cls = self.DEDICATED_PROVIDERS.get(name)
        provider = cls(self.config) if cls is not None else CustomProvider(self.config, name)
        provider.setFunctionExecutor(self.toolsManager)
        if self.logger:
            provider.setLogger(self.logger)
        return provider

    def _initializeDefaultProvider(self) -> None:
        """Initialize all configured providers."""
        # Claude is the baseline provider — always registered.
        claude = self._makeProvider('claude')
        self.llmManager.registerProvider('claude', claude)
        # Alias: the workflow compiler (and saved workflow DSL) name this
        # provider 'anthropic', while chat names it 'claude'. Register the
        # same instance under both keys so getProvider() resolves either
        # name. Without this, workflow agents with provider 'anthropic'
        # fail with "Provider 'anthropic' not found" and emit empty output.
        self.llmManager.registerProvider('anthropic', claude)

        # OpenAI when configured (its config lives outside config['providers']).
        if self.config.isProviderConfigured('openai'):
            self.llmManager.registerProvider('openai', self._makeProvider('openai'))

        # Everything declared in config['providers'] (DB-driven via
        # system_llm_settings): deepseek/gemini/grok/kimi resolve to their
        # dedicated classes through the map; the rest get CustomProvider.
        customProviders = self.config.get('providers', {})
        if not isinstance(customProviders, dict):
            customProviders = {}
        for name, providerConfig in customProviders.items():
            if not isinstance(providerConfig, dict) or php_empty(providerConfig.get('base_url')):
                continue
            self.llmManager.registerProvider(name, self._makeProvider(name))

        # Update fallback order to include custom providers
        fallbackOrder = ['claude', 'openai']
        for name in customProviders.keys():
            fallbackOrder.append(name)
        self.llmManager.setFallbackOrder(fallbackOrder)

        # Register search functions (don't need database)
        self._registerSearchFunctions()

    def _registerDatabaseFunctions(self) -> None:
        """
        Register database-dependent functions.

        Phase 2a: PortfolioFunctions/WatchlistFunctions/AnalysisFunctions
        land in 2c — nothing is registered here yet.
        """
        error_log("[AIPortfolioAssistant] database functions pending 2c")

    def _registerSearchFunctions(self) -> None:
        """Register search functions (no database needed)."""
        searchFunctions = SearchFunctions(self.config)
        self._searchFunctions = searchFunctions  # kept for close() (Python-only addition)
        self.toolsManager.registerFunctions(searchFunctions.getAllFunctions())
