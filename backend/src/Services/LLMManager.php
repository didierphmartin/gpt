<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Services;

use Quantis\AIPortfolioAssistant\Config\Configuration;
use Quantis\AIPortfolioAssistant\Contracts\AIProviderInterface;
use Quantis\AIPortfolioAssistant\Exceptions\ProviderException;
use Quantis\AIPortfolioAssistant\Providers\ClaudeProvider;

/**
 * Manages multiple LLM providers with fallback support
 */
class LLMManager
{
    private Configuration $config;

    /**
     * @var array<string, AIProviderInterface> Registered providers
     */
    private array $providers = [];

    /**
     * @var string[] Provider fallback order
     */
    private array $fallbackOrder = ['claude', 'openai', 'grok', 'gemini'];

    public function __construct(Configuration $config)
    {
        $this->config = $config;
    }

    /**
     * Register a provider
     */
    public function registerProvider(string $name, AIProviderInterface $provider): self
    {
        $this->providers[$name] = $provider;
        return $this;
    }

    /**
     * Get a provider by name
     */
    public function getProvider(string $name): ?AIProviderInterface
    {
        return $this->providers[$name] ?? null;
    }

    /**
     * Get the default provider
     */
    public function getDefaultProvider(): AIProviderInterface
    {
        $defaultName = $this->config->getDefaultProvider();

        if (isset($this->providers[$defaultName]) && $this->providers[$defaultName]->isAvailable()) {
            return $this->providers[$defaultName];
        }

        // Fallback to first available provider
        foreach ($this->fallbackOrder as $name) {
            if (isset($this->providers[$name]) && $this->providers[$name]->isAvailable()) {
                return $this->providers[$name];
            }
        }

        throw new ProviderException("No available LLM providers configured");
    }

    /**
     * Get all available provider names
     */
    public function getAvailableProviders(): array
    {
        $available = [];

        foreach ($this->providers as $name => $provider) {
            if ($provider->isAvailable()) {
                $available[] = $name;
            }
        }

        return $available;
    }

    /**
     * Check if a provider is available
     */
    public function isProviderAvailable(string $name): bool
    {
        return isset($this->providers[$name]) && $this->providers[$name]->isAvailable();
    }

    /**
     * Normalize conversation history for cross-provider compatibility
     *
     * This ensures all providers receive a consistent format regardless of
     * which provider generated the original response. Enables heterogeneous
     * LLM provider conversations where different providers can be used
     * within the same conversation context.
     *
     * @param array $conversationHistory Raw conversation history
     * @return array Normalized history with consistent format
     */
    public function normalizeConversationHistory(array $conversationHistory): array
    {
        $normalized = [];

        foreach ($conversationHistory as $entry) {
            // Handle stdClass objects (from JSON decode)
            if (is_object($entry)) {
                $entry = json_decode(json_encode($entry), true);
            }

            // Skip invalid entries
            if (!is_array($entry)) {
                continue;
            }

            // Normalize role: 'model' (Gemini) → 'assistant'
            $role = $entry['role'] ?? 'user';
            if ($role === 'model') {
                $role = 'assistant';
            }

            // B3: tool_result turns from a prior client-side tool dispatch
            // carry tool_call_id but their content is the raw JSON result —
            // they must NOT be flattened to text-only or they'd lose the id
            // the model needs to bind tool_use → tool_result. Pass through.
            if ($role === 'tool' && !empty($entry['tool_call_id'])) {
                $out = [
                    'role' => 'tool',
                    'tool_call_id' => $entry['tool_call_id'],
                    'content' => is_string($entry['content'] ?? null)
                        ? $entry['content']
                        : json_encode($entry['content'] ?? null),
                ];
                // Preserve the function name when the frontend includes it
                // (Gemini's functionResponse needs it; OpenAI-shape ignores).
                if (!empty($entry['name']) && is_string($entry['name'])) {
                    $out['name'] = $entry['name'];
                }
                $normalized[] = $out;
                continue;
            }

            // B3: assistant turns that include tool_calls (the LLM's own
            // tool_use from the prior round) often arrive with empty
            // content. They still matter — Claude needs to see its own
            // tool_use to match the tool_result that follows. Pass them
            // through with tool_calls preserved instead of skipping.
            if ($role === 'assistant' && !empty($entry['tool_calls'])) {
                $textContent = $this->extractTextContent($entry['content'] ?? '');
                $normalized[] = [
                    'role' => 'assistant',
                    'content' => $textContent,
                    'tool_calls' => $entry['tool_calls'],
                ];
                continue;
            }

            // Extract text content from various formats
            $content = $this->extractTextContent($entry['content'] ?? $entry['text'] ?? '');

            // Skip empty content
            if (empty(trim($content))) {
                continue;
            }

            // Check if this entry has metadata about provider/tool usage
            $metadata = [];
            if (isset($entry['provider'])) {
                $metadata['provider'] = $entry['provider'];
            }
            if (isset($entry['tool_results']) || isset($entry['function_results'])) {
                // Preserve tool result context as text annotation
                $toolResults = $entry['tool_results'] ?? $entry['function_results'] ?? [];
                if (!empty($toolResults) && is_array($toolResults)) {
                    $toolSummary = $this->summarizeToolResults($toolResults);
                    if (!empty($toolSummary)) {
                        $content .= "\n\n[Tool Results: " . $toolSummary . "]";
                    }
                }
            }

            $normalized[] = [
                'role' => $role,
                'content' => $content,
            ];
        }

        return $normalized;
    }

    /**
     * Extract text content from various content formats
     *
     * @param mixed $content Content in various formats (string, array, object)
     * @return string Extracted text content
     */
    private function extractTextContent($content): string
    {
        // Already a string
        if (is_string($content)) {
            return $content;
        }

        // Handle stdClass
        if (is_object($content)) {
            $content = json_decode(json_encode($content), true);
        }

        // Not an array - convert to string
        if (!is_array($content)) {
            return (string) $content;
        }

        // Array of content blocks (Claude format)
        $textParts = [];
        foreach ($content as $block) {
            if (is_object($block)) {
                $block = json_decode(json_encode($block), true);
            }

            if (is_string($block)) {
                $textParts[] = $block;
            } elseif (is_array($block)) {
                // Claude format: { type: 'text', text: '...' }
                if (isset($block['type']) && $block['type'] === 'text' && isset($block['text'])) {
                    $textParts[] = $block['text'];
                }
                // Simple text field
                elseif (isset($block['text'])) {
                    $textParts[] = $block['text'];
                }
                // Content field
                elseif (isset($block['content'])) {
                    $textParts[] = is_string($block['content']) ? $block['content'] : json_encode($block['content']);
                }
                // Gemini parts format
                elseif (isset($block['parts'])) {
                    foreach ($block['parts'] as $part) {
                        if (is_array($part) && isset($part['text'])) {
                            $textParts[] = $part['text'];
                        }
                    }
                }
                // Tool use blocks - include summary instead of stripping
                elseif (isset($block['type']) && $block['type'] === 'tool_use') {
                    $toolName = $block['name'] ?? 'unknown_tool';
                    $textParts[] = "[Called tool: {$toolName}]";
                }
                // Tool result blocks
                elseif (isset($block['type']) && $block['type'] === 'tool_result') {
                    $textParts[] = "[Tool returned results]";
                }
            }
        }

        return implode("\n", $textParts);
    }

    /**
     * Summarize tool results for context preservation
     *
     * @param array $toolResults Array of tool results
     * @return string Summary of tool results
     */
    private function summarizeToolResults(array $toolResults): string
    {
        $summaries = [];
        foreach ($toolResults as $result) {
            if (is_object($result)) {
                $result = json_decode(json_encode($result), true);
            }
            if (is_array($result)) {
                $toolName = $result['name'] ?? $result['tool_name'] ?? 'tool';
                $summaries[] = $toolName;
            }
        }
        return implode(', ', $summaries);
    }

    /**
     * Process a chat message with the specified provider (no fallback)
     */
    public function chat(
        string $message,
        array $conversationHistory = [],
        array $options = []
    ): array {
        // Provider MUST be specified explicitly — silent fallback to a
        // default provider has been removed because it masks caller bugs.
        if (empty($options['provider'])) {
            throw new \InvalidArgumentException(
                "LLMManager::chat requires \$options['provider'] to be set explicitly. " .
                "Missing provider at this point indicates a bug in the caller."
            );
        }
        $providerName = $options['provider'];
        $provider = $this->providers[$providerName] ?? null;

        if (!$provider) {
            throw new ProviderException("Provider '{$providerName}' not found");
        }

        if (!$provider->isAvailable()) {
            throw new ProviderException("Provider '{$providerName}' is not available (check API key)");
        }

        // Normalize conversation history for cross-provider compatibility
        $normalizedHistory = $this->normalizeConversationHistory($conversationHistory);

        // No fallback - use the specified provider directly
        $result = $provider->chat($message, $normalizedHistory, $options);
        $result['provider_used'] = $providerName;
        $result['fallback_used'] = false;

        return $result;
    }

    /**
     * Process a streaming chat message with the specified provider
     */
    public function streamChat(
        string $message,
        callable $onChunk,
        array $conversationHistory = [],
        array $options = []
    ): array {
        if (empty($options['provider'])) {
            throw new \InvalidArgumentException(
                "LLMManager::streamChat requires \$options['provider'] to be set explicitly. " .
                "Missing provider at this point indicates a bug in the caller."
            );
        }
        $providerName = $options['provider'];
        $provider = $this->providers[$providerName] ?? null;

        // Debug: Log provider selection
        error_log("[LLMManager] streamChat - requested provider: " . ($options['provider'] ?? 'not specified'));
        error_log("[LLMManager] streamChat - resolved provider: {$providerName}");
        error_log("[LLMManager] streamChat - registered providers: " . implode(', ', array_keys($this->providers)));

        if (!$provider) {
            throw new ProviderException("Provider '{$providerName}' not found");
        }

        if (!$provider->isAvailable()) {
            throw new ProviderException("Provider '{$providerName}' is not available (check API key)");
        }

        // Normalize conversation history for cross-provider compatibility
        $normalizedHistory = $this->normalizeConversationHistory($conversationHistory);

        error_log("[LLMManager] streamChat - raw history count: " . count($conversationHistory));
        error_log("[LLMManager] streamChat - normalized history count: " . count($normalizedHistory));
        if (!empty($normalizedHistory)) {
            foreach ($normalizedHistory as $idx => $entry) {
                $preview = substr($entry['content'] ?? '', 0, 100);
                error_log("[LLMManager] History[$idx]: role={$entry['role']}, content=\"{$preview}...\"");
            }
        }

        // Check if provider supports streaming
        if (!method_exists($provider, 'streamChat')) {
            // Fallback to regular chat
            $result = $provider->chat($message, $normalizedHistory, $options);
            $onChunk($result['text']);
            $result['provider_used'] = $providerName;
            $result['fallback_used'] = false;
            return $result;
        }

        // Use the provider's streamChat method
        $result = $provider->streamChat($message, $onChunk, $normalizedHistory, $options);
        $result['provider_used'] = $providerName;
        $result['fallback_used'] = false;

        return $result;
    }

    /**
     * Get providers to try in order
     */
    private function getProvidersToTry(?string $preferred): array
    {
        $providers = [];

        // Add preferred provider first
        if ($preferred && isset($this->providers[$preferred])) {
            $providers[] = $preferred;
        }

        // Add default provider
        $default = $this->config->getDefaultProvider();
        if ($default && !in_array($default, $providers) && isset($this->providers[$default])) {
            $providers[] = $default;
        }

        // Add remaining providers in fallback order
        foreach ($this->fallbackOrder as $name) {
            if (!in_array($name, $providers) && isset($this->providers[$name])) {
                $providers[] = $name;
            }
        }

        return $providers;
    }

    /**
     * Set the fallback order
     */
    public function setFallbackOrder(array $order): self
    {
        $this->fallbackOrder = $order;
        return $this;
    }

    /**
     * Get provider information
     */
    public function getProviderInfo(?string $provider = null): array
    {
        if ($provider) {
            $p = $this->providers[$provider] ?? null;
            if (!$p) {
                return ['error' => "Provider '{$provider}' not found"];
            }

            return [
                'name' => $p->getName(),
                'model' => $p->getModel(),
                'available' => $p->isAvailable(),
                'supported_models' => $p->getSupportedModels(),
            ];
        }

        $info = [];
        foreach ($this->providers as $name => $p) {
            $info[$name] = [
                'name' => $p->getName(),
                'model' => $p->getModel(),
                'available' => $p->isAvailable(),
            ];
        }

        return $info;
    }

    /**
     * Get configuration
     */
    public function getConfig(): Configuration
    {
        return $this->config;
    }
}
