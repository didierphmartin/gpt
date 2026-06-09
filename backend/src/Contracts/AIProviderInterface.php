<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Contracts;

/**
 * Interface for AI providers (Claude, OpenAI, etc.)
 */
interface AIProviderInterface
{
    /**
     * Get the provider name
     */
    public function getName(): string;

    /**
     * Check if the provider is available (configured with valid API key)
     */
    public function isAvailable(): bool;

    /**
     * Send a chat message and get a response
     *
     * @param string $message User message
     * @param array $conversationHistory Previous messages in the conversation
     * @param array $options Additional options (tools, system prompt, etc.)
     * @return array Response with 'text', 'usage', and other metadata
     */
    public function chat(
        string $message,
        array $conversationHistory = [],
        array $options = []
    ): array;

    /**
     * Send a chat message with streaming response
     *
     * @param string $message User message
     * @param callable $onChunk Callback for each chunk of the response
     * @param array $conversationHistory Previous messages
     * @param array $options Additional options
     */
    public function streamChat(
        string $message,
        callable $onChunk,
        array $conversationHistory = [],
        array $options = []
    ): array;

    /**
     * Get the model being used
     */
    public function getModel(): string;

    /**
     * Set the model to use
     */
    public function setModel(string $model): self;

    /**
     * Get supported models for this provider
     */
    public function getSupportedModels(): array;
}
