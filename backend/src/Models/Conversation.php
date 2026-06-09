<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Models;

/**
 * Represents a conversation with message history
 */
class Conversation
{
    private string $id;
    private ?string $userId;
    private array $messages = [];
    private \DateTimeImmutable $createdAt;
    private ?\DateTimeImmutable $updatedAt;
    private array $metadata;

    public function __construct(
        ?string $id = null,
        ?string $userId = null,
        array $metadata = []
    ) {
        $this->id = $id ?? uniqid('conv_');
        $this->userId = $userId;
        $this->createdAt = new \DateTimeImmutable();
        $this->updatedAt = null;
        $this->metadata = $metadata;
    }

    /**
     * Add a message to the conversation
     */
    public function addMessage(Message $message): self
    {
        $this->messages[] = $message;
        $this->updatedAt = new \DateTimeImmutable();
        return $this;
    }

    /**
     * Add a user message
     */
    public function addUserMessage(string $content): self
    {
        return $this->addMessage(Message::user($content));
    }

    /**
     * Add an assistant message
     */
    public function addAssistantMessage(string $content, array $metadata = []): self
    {
        return $this->addMessage(Message::assistant($content, $metadata));
    }

    /**
     * Get all messages
     */
    public function getMessages(): array
    {
        return $this->messages;
    }

    /**
     * Get message history as array for API
     */
    public function getHistory(): array
    {
        return array_map(fn(Message $m) => $m->toArray(), $this->messages);
    }

    /**
     * Get the last N messages
     */
    public function getLastMessages(int $count): array
    {
        return array_slice($this->messages, -$count);
    }

    /**
     * Get the last message
     */
    public function getLastMessage(): ?Message
    {
        return end($this->messages) ?: null;
    }

    /**
     * Clear all messages
     */
    public function clear(): self
    {
        $this->messages = [];
        $this->updatedAt = new \DateTimeImmutable();
        return $this;
    }

    /**
     * Get message count
     */
    public function getMessageCount(): int
    {
        return count($this->messages);
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getUserId(): ?string
    {
        return $this->userId;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }

    public function getUpdatedAt(): ?\DateTimeImmutable
    {
        return $this->updatedAt;
    }

    public function getMetadata(): array
    {
        return $this->metadata;
    }

    public function setMetadata(array $metadata): self
    {
        $this->metadata = $metadata;
        return $this;
    }

    /**
     * Create from message history array
     */
    public static function fromHistory(array $history, ?string $userId = null): self
    {
        $conversation = new self(null, $userId);

        foreach ($history as $msg) {
            $conversation->addMessage(Message::fromArray($msg));
        }

        return $conversation;
    }

    /**
     * Export to array
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'user_id' => $this->userId,
            'messages' => $this->getHistory(),
            'message_count' => $this->getMessageCount(),
            'created_at' => $this->createdAt->format('c'),
            'updated_at' => $this->updatedAt?->format('c'),
            'metadata' => $this->metadata,
        ];
    }
}
