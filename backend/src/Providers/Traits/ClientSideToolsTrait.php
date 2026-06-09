<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Providers\Traits;

/**
 * Shared client-side tool dispatch helpers for B3.
 *
 * "Client-side tools" are LLM-callable tools whose execution lives in
 * the browser, not on the server. Two sources:
 *   1. STATIC: getClientSideToolNames() — names hard-coded in the trait
 *      (run_skill_script, discover_skill, Task). Each one is tightly
 *      coupled to a specific frontend dispatcher.
 *   2. PER-REQUEST: setPerRequestClientSideToolNames() — names supplied
 *      by the frontend at request time (e.g. webmcp_get_machine_specs
 *      from the active tab). The provider doesn't know what they do;
 *      it just short-circuits when the LLM picks one and emits the
 *      client_tool_call SSE event for the frontend to dispatch.
 */
trait ClientSideToolsTrait
{
    /**
     * Names of statically-known client-side tools.
     */
    public static function getClientSideToolNames(): array
    {
        return ['run_skill_script', 'discover_skill', 'Task'];
    }

    /**
     * Per-request additional client-side tool names. Set by ChatController
     * before tool dispatch. Lives on the provider instance for the duration
     * of one request.
     */
    private array $perRequestClientSideToolNames = [];

    public function setPerRequestClientSideToolNames(array $names): void
    {
        // Defensive: only accept strings.
        $this->perRequestClientSideToolNames = array_values(array_filter(
            $names,
            fn($n) => is_string($n) && $n !== ''
        ));
    }

    /**
     * True iff the given tool name is delegated to the browser — either
     * because it's in the static list OR because the current request
     * registered it as a per-request client-side tool.
     */
    public function isClientSideTool(string $toolName): bool
    {
        if (in_array($toolName, self::getClientSideToolNames(), true)) return true;
        if (in_array($toolName, $this->perRequestClientSideToolNames, true)) return true;
        return false;
    }

    /**
     * Emit the standard `client_tool_call` SSE event the frontend listens
     * for. Unchanged from before.
     */
    protected function emitClientToolCallEvent(array $toolCalls, string $assistantText = ''): array
    {
        $payload = [
            'assistant_text' => $assistantText,
            'tool_calls' => $toolCalls,
        ];
        $this->sseClient?->sendCustomEvent('client_tool_call', $payload);
        return [
            '_pending_client_tool_call' => true,
            '_pending_tool_calls' => $toolCalls,
            '_pending_assistant_text' => $assistantText,
        ];
    }
}
