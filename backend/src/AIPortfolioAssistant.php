<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant;

use PDO;
use Quantis\AIPortfolioAssistant\Config\Configuration;
use Quantis\AIPortfolioAssistant\Contracts\StreamingClientInterface;
use Quantis\AIPortfolioAssistant\Functions\AnalysisFunctions;
use Quantis\AIPortfolioAssistant\Functions\PortfolioFunctions;
use Quantis\AIPortfolioAssistant\Functions\MetalsNewsFunctions;
use Quantis\AIPortfolioAssistant\Functions\SearchFunctions;
use Quantis\AIPortfolioAssistant\Functions\WatchlistFunctions;
use Quantis\AIPortfolioAssistant\Models\Conversation;
use Quantis\AIPortfolioAssistant\Providers\ClaudeProvider;
use Quantis\AIPortfolioAssistant\Providers\OpenAIProvider;
use Quantis\AIPortfolioAssistant\Providers\CustomProvider;
use Quantis\AIPortfolioAssistant\Providers\GeminiProvider;
use Quantis\AIPortfolioAssistant\Providers\GrokProvider;
use Quantis\AIPortfolioAssistant\Providers\DeepSeekProvider;
use Quantis\AIPortfolioAssistant\Providers\KimiProvider;
use Quantis\AIPortfolioAssistant\Services\DebugLogger;
use Quantis\AIPortfolioAssistant\Services\LLMManager;
use Quantis\AIPortfolioAssistant\Services\SSEHubClient;
use Quantis\AIPortfolioAssistant\Services\ToolsManager;
use Quantis\AIPortfolioAssistant\Services\UsageTracker;

/**
 * AI Portfolio Assistant - Main entry point
 *
 * A reusable Composer package for AI-powered portfolio analysis
 * with Claude integration, streaming support, and extensible functions.
 *
 * @example
 * ```php
 * $assistant = new AIPortfolioAssistant([
 *     'claude' => ['api_key' => 'your-api-key'],
 * ]);
 *
 * $response = $assistant->chat("What's in my portfolio?", $userId);
 * ```
 */
class AIPortfolioAssistant
{
    private Configuration $config;
    private LLMManager $llmManager;
    private ToolsManager $toolsManager;
    private ?UsageTracker $usageTracker = null;
    private ?DebugLogger $logger = null;
    private ?PDO $pdo = null;

    /**
     * @param array|Configuration $config Configuration array or Configuration instance
     */
    public function __construct(array|Configuration $config = [])
    {
        $this->config = $config instanceof Configuration ? $config : new Configuration($config);
        $this->toolsManager = new ToolsManager();
        $this->llmManager = new LLMManager($this->config);

        if ($this->config->isDebugEnabled()) {
            $this->logger = new DebugLogger(true);
        }

        $this->initializeDefaultProvider();
    }

    /**
     * Create instance from environment variables
     */
    public static function fromEnvironment(): self
    {
        return new self(Configuration::fromEnvironment());
    }

    /**
     * Create instance from config file
     */
    public static function fromConfigFile(string $path): self
    {
        return new self(Configuration::fromFile($path));
    }

    /**
     * Set database connection for portfolio functions
     */
    public function setDatabase(PDO $pdo): self
    {
        $this->pdo = $pdo;
        $this->registerDatabaseFunctions();

        // Enable usage tracking with database
        if ($this->config->get('tracking.enabled', true)) {
            $this->usageTracker = new UsageTracker($pdo, true);

            // Set usage tracker on all registered providers
            $this->propagateUsageTrackerToProviders();
        }

        return $this;
    }

    /**
     * Propagate usage tracker to all registered providers
     */
    private function propagateUsageTrackerToProviders(): void
    {
        if (!$this->usageTracker) {
            return;
        }

        // Get all registered providers and set usage tracker on each
        $providerInfo = $this->llmManager->getProviderInfo();
        foreach (array_keys($providerInfo) as $providerName) {
            $provider = $this->llmManager->getProvider($providerName);
            if ($provider && method_exists($provider, 'setUsageTracker')) {
                $provider->setUsageTracker($this->usageTracker);
            }
        }
    }

    /**
     * Send a chat message and get a response
     *
     * @param string $message User message
     * @param mixed $userId User ID for context
     * @param array $conversationHistory Previous messages
     * @param array $options Additional options (provider, system_prompt, etc.)
     * @return array Response with 'text', 'usage', and metadata
     */
    public function chat(
        string $message,
        mixed $userId = null,
        array $conversationHistory = [],
        array $options = []
    ): array {
        $options['user_id'] = $userId;

        // Merge base tools with any additional tools passed in options (e.g., MCP tools).
        // EXCEPTION: when the caller has set skill_metadata (a folder-backed skill
        // is the active turn target), it has already narrowed options['tools'] to
        // exactly the run_skill_script tool with the correct script enum and the
        // intent is "MCP and base tools are suppressed". Merging base tools here
        // unconditionally has the effect of (a) re-introducing 9+ unrelated tools
        // (search/finance/SEC), inflating prompt tokens by ~6-12K, and (b) diluting
        // the schema attention so Gemini sometimes drops required fields like
        // `script` from the run_skill_script call — observed empirically as
        // "Tool execution failed: runSkillScript: script is required" when the
        // model attached the rest of the call (argv, input_files, read_outputs)
        // but omitted the script enum value.
        $additionalTools = $options['tools'] ?? [];
        if (!empty($options['skill_metadata'])) {
            $options['tools'] = $additionalTools;
        } else {
            $baseTools = $this->toolsManager->getToolDefinitions();
            $options['tools'] = array_merge($baseTools, $additionalTools);
        }

        return $this->llmManager->chat($message, $conversationHistory, $options);
    }

    /**
     * Send a chat message with streaming response
     *
     * @param string $message User message
     * @param string $sessionId SSE session ID
     * @param mixed $userId User ID
     * @param array $conversationHistory Previous messages
     * @param array $options Additional options
     * @return array Final response
     */
    public function streamChat(
        string $message,
        string $sessionId,
        mixed $userId = null,
        array $conversationHistory = [],
        array $options = []
    ): array {
        $sseClient = SSEHubClient::create(
            $sessionId,
            $this->config->get('sse.hub_url'),
            $this->config->isDebugEnabled()
        );

        // Mark headers as initialized (chat.php already sent SSE headers)
        $sseClient->markHeadersInitialized();

        // Provider MUST be explicit. A missing provider is a caller bug.
        if (empty($options['provider'])) {
            throw new \InvalidArgumentException(
                "AIPortfolioAssistant::streamChat requires \$options['provider']. " .
                "Silent fallback to a default provider has been removed."
            );
        }
        $providerName = $options['provider'];
        error_log("[AIPortfolioAssistant] streamChat - provider: {$providerName}");
        $provider = $this->llmManager->getProvider($providerName);

        if ($provider && method_exists($provider, 'setSSEClient')) {
            $provider->setSSEClient($sseClient);
        }

        $options['user_id'] = $userId;

        // Merge base tools with any additional tools passed in options (e.g., MCP tools).
        // EXCEPTION: when the caller has set skill_metadata (a folder-backed skill
        // is the active turn target), it has already narrowed options['tools'] to
        // exactly the run_skill_script tool with the correct script enum and the
        // intent is "MCP and base tools are suppressed". Merging base tools here
        // unconditionally has the effect of (a) re-introducing 9+ unrelated tools
        // (search/finance/SEC), inflating prompt tokens by ~6-12K, and (b) diluting
        // the schema attention so Gemini sometimes drops required fields like
        // `script` from the run_skill_script call — observed empirically as
        // "Tool execution failed: runSkillScript: script is required" when the
        // model attached the rest of the call (argv, input_files, read_outputs)
        // but omitted the script enum value.
        $additionalTools = $options['tools'] ?? [];
        if (!empty($options['skill_metadata'])) {
            $options['tools'] = $additionalTools;
        } else {
            $baseTools = $this->toolsManager->getToolDefinitions();
            $options['tools'] = array_merge($baseTools, $additionalTools);
        }

        try {
            // Use streamChat instead of chat
            $response = $this->llmManager->streamChat(
                $message,
                function($chunk) use ($sseClient) {
                    // This callback is for providers that don't support native streaming
                    $sseClient->sendChunk($chunk);
                },
                $conversationHistory,
                $options
            );

            // Send final response with usage stats
            $sseClient->sendResponse($response);
            $sseClient->complete();

            return $response;
        } catch (\Throwable $e) {
            $sseClient->sendError($e->getMessage());
            throw $e;
        }
    }

    /**
     * Chat using a Conversation object
     */
    public function chatWithConversation(
        string $message,
        Conversation $conversation,
        array $options = []
    ): array {
        $response = $this->chat(
            $message,
            $conversation->getUserId(),
            $conversation->getHistory(),
            $options
        );

        // Update conversation
        $conversation->addUserMessage($message);
        $conversation->addAssistantMessage($response['text'], [
            'usage' => $response['usage'] ?? [],
            'provider' => $response['provider_used'] ?? 'claude',
        ]);

        return $response;
    }

    /**
     * Register a custom function
     */
    public function registerFunction(string $name, callable $handler, array $schema): self
    {
        $this->toolsManager->registerFunction($name, $handler, $schema);
        return $this;
    }

    /**
     * Register multiple functions
     */
    public function registerFunctions(array $functions): self
    {
        $this->toolsManager->registerFunctions($functions);
        return $this;
    }

    /**
     * Load tool definitions from JSON file
     */
    public function loadToolsFromJson(string $path): self
    {
        $this->toolsManager->loadFromJson($path);
        return $this;
    }

    /**
     * Get the configuration
     */
    public function getConfig(): Configuration
    {
        return $this->config;
    }

    /**
     * Get the LLM manager
     */
    public function getLLMManager(): LLMManager
    {
        return $this->llmManager;
    }

    /**
     * Get the tools manager
     */
    public function getToolsManager(): ToolsManager
    {
        return $this->toolsManager;
    }

    /**
     * Get available providers
     */
    public function getAvailableProviders(): array
    {
        return $this->llmManager->getAvailableProviders();
    }

    /**
     * Get provider information
     */
    public function getProviderInfo(?string $provider = null): array
    {
        return $this->llmManager->getProviderInfo($provider);
    }

    /**
     * Set the model for a specific provider
     */
    public function setModel(string $model, string $provider): self
    {
        $providerInstance = $this->llmManager->getProvider($provider);
        if ($providerInstance) {
            $providerInstance->setModel($model);
        }
        return $this;
    }

    /**
     * Set the active provider
     */
    public function setProvider(string $provider): self
    {
        if (!$this->llmManager->isProviderAvailable($provider)) {
            throw new \InvalidArgumentException("Provider '{$provider}' is not available");
        }
        $this->config->set('default_provider', $provider);
        return $this;
    }

    /**
     * Get the current active provider name
     */
    public function getCurrentProvider(): string
    {
        return $this->config->getDefaultProvider();
    }

    /**
     * Get all registered providers with their info
     */
    public function getAllProviders(): array
    {
        $providers = [];
        $registeredProviders = $this->llmManager->getProviderInfo();

        foreach ($registeredProviders as $name => $info) {
            // Check providers array first, then root level config (for claude/openai)
            $providerConfig = $this->config->get("providers.{$name}", []);
            if (empty($providerConfig)) {
                $providerConfig = $this->config->get($name, []);
            }
            $providers[] = [
                'name' => $name,
                'display_name' => $providerConfig['display_name'] ?? ucfirst($name),
                'model' => $info['model'],
                'available' => $info['available'],
            ];
        }

        return $providers;
    }

    /**
     * Create a new conversation
     */
    public function createConversation(?string $userId = null, array $metadata = []): Conversation
    {
        return new Conversation(null, $userId, $metadata);
    }

    /**
     * Initialize all configured providers
     */
    private function initializeDefaultProvider(): void
    {
        // Initialize Claude provider
        $claude = new ClaudeProvider($this->config);
        $claude->setFunctionExecutor($this->toolsManager);
        if ($this->logger) {
            $claude->setLogger($this->logger);
        }
        $this->llmManager->registerProvider('claude', $claude);
        // Alias: the workflow compiler (and saved workflow DSL) name this
        // provider 'anthropic', while chat names it 'claude'. Register the
        // same instance under both keys so getProvider() resolves either
        // name. Without this, workflow agents with provider 'anthropic'
        // fail with "Provider 'anthropic' not found" and emit empty output.
        $this->llmManager->registerProvider('anthropic', $claude);

        // Initialize OpenAI provider if configured
        if ($this->config->isProviderConfigured('openai')) {
            $openai = new OpenAIProvider($this->config);
            $openai->setFunctionExecutor($this->toolsManager);
            if ($this->logger) {
                $openai->setLogger($this->logger);
            }
            $this->llmManager->registerProvider('openai', $openai);
        }

        // Initialize custom providers from config
        $customProviders = $this->config->get('providers', []);
        foreach ($customProviders as $name => $providerConfig) {
            if (!empty($providerConfig['base_url'])) {
                // Use dedicated providers for specific APIs
                if ($name === 'gemini') {
                    $provider = new GeminiProvider($this->config);
                } elseif ($name === 'grok') {
                    $provider = new GrokProvider($this->config);
                } elseif ($name === 'kimi') {
                    $provider = new KimiProvider($this->config);
                } else {
                    // DeepSeek and others use CustomProvider
                    $provider = new CustomProvider($this->config, $name);
                }
                $provider->setFunctionExecutor($this->toolsManager);
                if ($this->logger) {
                    $provider->setLogger($this->logger);
                }
                $this->llmManager->registerProvider($name, $provider);
            }
        }

        // Update fallback order to include custom providers
        $fallbackOrder = ['claude', 'openai'];
        foreach (array_keys($customProviders) as $name) {
            $fallbackOrder[] = $name;
        }
        $this->llmManager->setFallbackOrder($fallbackOrder);

        // Register search functions (don't need database)
        $this->registerSearchFunctions();
    }

    /**
     * Register database-dependent functions
     */
    private function registerDatabaseFunctions(): void
    {
        if (!$this->pdo) {
            return;
        }

        // Portfolio functions
        $portfolioFunctions = new PortfolioFunctions($this->pdo);
        $this->toolsManager->registerFunctions($portfolioFunctions->getAllFunctions());

        // Watchlist functions
        $watchlistFunctions = new WatchlistFunctions($this->pdo);
        $this->toolsManager->registerFunctions($watchlistFunctions->getAllFunctions());

        // Analysis functions
        $analysisFunctions = new AnalysisFunctions($this->config);
        $this->toolsManager->registerFunctions($analysisFunctions->getAllFunctions());
    }

    /**
     * Register search functions (no database needed)
     */
    private function registerSearchFunctions(): void
    {
        $searchFunctions = new SearchFunctions($this->config);
        $this->toolsManager->registerFunctions($searchFunctions->getAllFunctions());

        // PubMed functions disabled - using MCP server instead (pubmed_search, pubmed_build_query, pubmed_mesh_suggestions)

        // Battery news functions disabled - using MCP server instead (battery_news_get_all, battery_news_search)

        // Metals News functions disabled - using MCP server instead (get_all_metals_news, search_metals_news)
        // $metalsNewsFunctions = new MetalsNewsFunctions($this->config);
        // $this->toolsManager->registerFunctions($metalsNewsFunctions->getAllFunctions());

        // Crypto News functions disabled - using MCP server instead (llm_get_crypto_news, llm_list_crypto_sources, llm_get_news_by_source, llm_get_priority_crypto_news)

        // Financial News functions disabled - using MCP server instead (get_financial_news, list_financial_news_sources)
    }
}
