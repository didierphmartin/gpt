<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Models;

/**
 * Represents a message in a conversation
 */
class Message
{
    public const ROLE_USER = 'user';
    public const ROLE_ASSISTANT = 'assistant';
    public const ROLE_SYSTEM = 'system';

    private string $role;
    private string $content;
    private ?string $id;
    private ?\DateTimeImmutable $createdAt;
    private array $metadata;

    public function __construct(
        string $role,
        string $content,
        ?string $id = null,
        ?\DateTimeImmutable $createdAt = null,
        array $metadata = []
    ) {
        $this->role = $role;
        $this->content = $content;
        $this->id = $id ?? uniqid('msg_');
        $this->createdAt = $createdAt ?? new \DateTimeImmutable();
        $this->metadata = $metadata;
    }

    /**
     * Create a user message
     */
    public static function user(string $content, array $metadata = []): self
    {
        return new self(self::ROLE_USER, $content, null, null, $metadata);
    }

    /**
     * Create an assistant message
     */
    public static function assistant(string $content, array $metadata = []): self
    {
        return new self(self::ROLE_ASSISTANT, $content, null, null, $metadata);
    }

    /**
     * Create a system message
     */
    public static function system(string $content): self
    {
        return new self(self::ROLE_SYSTEM, $content);
    }

    /**
     * Create from array
     */
    public static function fromArray(array $data): self
    {
        return new self(
            $data['role'] ?? self::ROLE_USER,
            $data['content'] ?? '',
            $data['id'] ?? null,
            isset($data['created_at']) ? new \DateTimeImmutable($data['created_at']) : null,
            $data['metadata'] ?? []
        );
    }

    public function getRole(): string
    {
        return $this->role;
    }

    public function getContent(): string
    {
        return $this->content;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }

    public function getMetadata(): array
    {
        return $this->metadata;
    }

    public function isUser(): bool
    {
        return $this->role === self::ROLE_USER;
    }

    public function isAssistant(): bool
    {
        return $this->role === self::ROLE_ASSISTANT;
    }

    /**
     * Convert to array for API
     */
    public function toArray(): array
    {
        return [
            'role' => $this->role,
            'content' => $this->content,
        ];
    }

    /**
     * Convert to Claude API format
     */
    public function toClaudeFormat(): array
    {
        return [
            'role' => $this->role,
            'content' => [
                ['type' => 'text', 'text' => $this->content]
            ],
        ];
    }
}
