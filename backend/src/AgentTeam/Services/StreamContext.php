<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Stream Context
 *
 * Holds the SSE callback and provides methods for emitting agent activity events.
 * This context is passed through the delegation chain to enable real-time updates.
 */
class StreamContext
{
    /** @var callable|null */
    private $onEvent = null;
    private int $userId = 0;
    private ?int $rootExecutionId = null;

    public function __construct(?callable $onEvent = null, int $userId = 0)
    {
        $this->onEvent = $onEvent;
        $this->userId = $userId;
    }

    /**
     * Set the event callback
     */
    public function setEventCallback(callable $callback): self
    {
        $this->onEvent = $callback;
        return $this;
    }

    /**
     * Set the root execution ID (the top-level manager execution)
     */
    public function setRootExecutionId(int $executionId): self
    {
        $this->rootExecutionId = $executionId;
        return $this;
    }

    /**
     * Get the root execution ID
     */
    public function getRootExecutionId(): ?int
    {
        return $this->rootExecutionId;
    }

    /**
     * Get user ID
     */
    public function getUserId(): int
    {
        return $this->userId;
    }

    /**
     * Check if streaming is enabled
     */
    public function isStreaming(): bool
    {
        return $this->onEvent !== null;
    }

    /**
     * Emit an agent_start event
     */
    public function emitAgentStart(
        int $agentId,
        string $agentName,
        string $agentType,
        ?int $parentAgentId = null,
        ?int $executionId = null
    ): void {
        $this->emit([
            'type' => 'agent_start',
            'agent_id' => $agentId,
            'agent_name' => $agentName,
            'agent_type' => $agentType,
            'parent_agent_id' => $parentAgentId,
            'execution_id' => $executionId,
            'timestamp' => microtime(true),
        ]);
    }

    /**
     * Emit an agent_delegate event
     */
    public function emitAgentDelegate(
        int $fromAgentId,
        string $fromAgentName,
        int $toAgentId,
        string $toAgentName,
        string $task
    ): void {
        $this->emit([
            'type' => 'agent_delegate',
            'from_agent_id' => $fromAgentId,
            'from_agent_name' => $fromAgentName,
            'to_agent_id' => $toAgentId,
            'to_agent_name' => $toAgentName,
            'task' => mb_substr($task, 0, 200) . (mb_strlen($task) > 200 ? '...' : ''),
            'timestamp' => microtime(true),
        ]);
    }

    /**
     * Emit an agent_complete event
     */
    public function emitAgentComplete(
        int $agentId,
        string $agentName,
        string $agentType,
        bool $success = true,
        ?string $error = null,
        ?int $executionId = null
    ): void {
        $this->emit([
            'type' => 'agent_complete',
            'agent_id' => $agentId,
            'agent_name' => $agentName,
            'agent_type' => $agentType,
            'success' => $success,
            'error' => $error,
            'execution_id' => $executionId,
            'timestamp' => microtime(true),
        ]);
    }

    /**
     * Emit an agent_thinking event (for progress indication)
     */
    public function emitAgentThinking(
        int $agentId,
        string $agentName,
        string $status = 'thinking'
    ): void {
        $this->emit([
            'type' => 'agent_thinking',
            'agent_id' => $agentId,
            'agent_name' => $agentName,
            'status' => $status,
            'timestamp' => microtime(true),
        ]);
    }

    /**
     * Emit a text chunk (for streaming responses)
     */
    public function emitChunk(string $text, int $agentId, string $agentName): void
    {
        $this->emit([
            'type' => 'chunk',
            'text' => $text,
            'agent_id' => $agentId,
            'agent_name' => $agentName,
        ]);
    }

    /**
     * Emit an error event
     */
    public function emitError(string $error, ?int $agentId = null): void
    {
        $this->emit([
            'type' => 'error',
            'error' => $error,
            'agent_id' => $agentId,
            'timestamp' => microtime(true),
        ]);
    }

    /**
     * Emit a generic event
     */
    public function emit(array $data): void
    {
        if ($this->onEvent !== null) {
            error_log("[StreamContext] Emitting event: " . ($data['type'] ?? 'unknown') . " - " . json_encode($data));
            ($this->onEvent)($data);
        } else {
            error_log("[StreamContext] WARNING: No callback set, cannot emit: " . ($data['type'] ?? 'unknown'));
        }
    }
}
