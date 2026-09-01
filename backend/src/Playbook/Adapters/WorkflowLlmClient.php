<?php
declare(strict_types=1);
namespace Quantis\AIPortfolioAssistant\Playbook\Adapters;

use AgentTeam\Models\Agent;
use AgentTeam\Services\AgentRunner;
use PDO;
use Quantis\AIPortfolioAssistant\AIPortfolioAssistant;
use Quantis\AIPortfolioAssistant\Services\LLMProviderResolver;
use Quantis\AIPortfolioAssistant\Services\MCPToolsLoader;

/**
 * Adapts one LLM round of the existing AgentTeam engine to the interpreter's
 * LLM-closure contract: `fn(array $messages, array $toolDefs): array{
 * text:?string, tool_calls:array}`.
 *
 * Built from GraphWorkflowRunner.php:1840-1980 (state construction) and
 * ParallelAgentExecutor::dispatchChunk (~line 194-228): dispatchChunk calls
 * `buildAgentLLMRequestWithTools($state['agent'], $state['messages'],
 * $state['tools'])` — it takes tool definitions straight from the state's
 * 'tools' entry rather than deriving them from the agent/runner (there is no
 * buildToolsForParallelAgent-style lookup in the dispatch path itself), so we
 * pass $toolDefs through verbatim via that field. No agent-tools lookup is
 * needed.
 */
final class WorkflowLlmClient
{
    public function __construct(
        private readonly array $nodeConfig,
        private readonly array $config,
        private readonly PDO $pdo,
    ) {
    }

    public function __invoke(array $messages, array $toolDefs): array
    {
        $config = LLMProviderResolver::applyDbSettings($this->pdo, $this->config);
        $assistant = new AIPortfolioAssistant($config);
        $assistant->setDatabase($this->pdo);

        $agentRunner = new AgentRunner(
            $assistant->getLLMManager(),
            $assistant->getToolsManager(),
            new MCPToolsLoader($this->pdo),
            $this->pdo,
            $config
        );

        // Instructions are intentionally left empty: the interpreter's full
        // system prompt (playbook instructions + policy) already travels as
        // the first entry of $messages (see PlaybookInterpreter::buildSystemPrompt),
        // so anything set here would never reach the model.
        $agent = new Agent([
            'provider' => $this->nodeConfig['agent_provider'] ?? $this->nodeConfig['provider'] ?? 'openai',
            'model' => $this->nodeConfig['model'] ?? null,
            'instructions' => '',
            'settings' => $this->nodeConfig['settings'] ?? [],
        ]);

        // State shape mirrors GraphWorkflowRunner's parallel agentStates entries
        // (node/agent/input/messages/tools/tools_filter) — see
        // GraphWorkflowRunner.php:1850-1865. 'tools_filter' is left null: the
        // interpreter's PlaybookActionSpace already whitelists exactly the
        // tools it hands to us in $toolDefs, so there is nothing further to filter.
        $state = [
            'key' => 'playbook',
            'agent' => $agent,
            'input' => '',
            'messages' => $messages,
            'tools' => $this->flattenToolDefs($toolDefs),
            'tools_filter' => null,
        ];

        $responses = $agentRunner->createParallelExecutor(false)->runConcurrentRound(['playbook' => $state]);
        $response = $responses['playbook'] ?? ['success' => false, 'error' => 'No response from LLM'];

        if (!($response['success'] ?? false)) {
            return ['text' => 'Error: ' . ($response['error'] ?? 'LLM call failed'), 'tool_calls' => []];
        }

        $parsed = $response['parsed'] ?? [];
        return [
            'text' => $parsed['text'] ?? null,
            'tool_calls' => $this->normalizeToolCalls($parsed['tool_calls'] ?? []),
        ];
    }

    /**
     * Convert the interpreter's OpenAI-nested tool definitions
     * ({type:'function', function:{name, description, parameters}} — the
     * shape pinned by PlaybookActionSpaceTest/PlaybookNativeToolsTest) to the
     * flat {name, description, input_schema} shape the rest of the AgentTeam
     * engine actually expects for the 'tools' state entry (see
     * MCPToolsLoader::getToolDefinitions and OpenAIProvider::convertToOpenAITools,
     * which converts FROM this flat shape — i.e. flat is the common-denominator
     * format ParallelAgentExecutor/ProviderRequestFactory/ClaudeProvider read;
     * passing the nested shape through verbatim, as this adapter used to do,
     * makes ClaudeProvider send tools with no top-level `name` and the API
     * rejects the request with "tools.0.custom.name: Input should be a valid string").
     */
    private function flattenToolDefs(array $toolDefs): array
    {
        $flat = [];
        foreach ($toolDefs as $def) {
            if (isset($def['function']) && is_array($def['function'])) {
                $flat[] = [
                    'name' => $def['function']['name'] ?? '',
                    'description' => $def['function']['description'] ?? '',
                    'input_schema' => $def['function']['parameters'] ?? ['type' => 'object', 'properties' => []],
                ];
            } else {
                // Already flat (defensive — no current caller does this).
                $flat[] = $def;
            }
        }
        return $flat;
    }

    /**
     * Normalize provider tool-call shapes to the interpreter's
     * {id, name, arguments:array} contract. Every provider parser in
     * ProviderRequestFactory already emits the OpenAI-style
     * `function.name` / `function.arguments` (JSON string) shape (see
     * OpenAIProvider::parseHttpResponse, ClaudeProvider::parseHttpResponse),
     * but we also accept a flat `name`/`input` (or `name`/`arguments` array)
     * shape defensively, matching the same fallback GraphWorkflowRunner uses
     * elsewhere (`$tc['function']['name'] ?? $tc['name']`).
     */
    private function normalizeToolCalls(array $toolCalls): array
    {
        $normalized = [];
        foreach ($toolCalls as $tc) {
            $name = $tc['function']['name'] ?? $tc['name'] ?? '';
            $rawArgs = $tc['function']['arguments'] ?? $tc['input'] ?? $tc['arguments'] ?? [];
            $args = is_string($rawArgs) ? (json_decode($rawArgs, true) ?? []) : (array)$rawArgs;

            $normalized[] = [
                'id' => $tc['id'] ?? \AgentTeam\Services\SkillToolBridge::generateToolCallId(),
                'name' => $name,
                'arguments' => $args,
            ];
        }
        return $normalized;
    }
}
