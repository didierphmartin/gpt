<?php
declare(strict_types=1);
namespace AgentTeam\Services;

use AgentTeam\Models\Agent;
use Quantis\AIPortfolioAssistant\Providers\ProviderRequestFactory;
use PDO;

/**
 * Concurrency engine for running multiple agents' LLM calls in parallel via
 * curl_multi, round-tripping tool calls, and looping until every agent
 * completes or the round cap is hit.
 *
 * Extracted from GraphWorkflowRunner's round loop / makeParallelLLMCalls /
 * buildAgentLLMRequestWithTools / parseParallelLLMResponse /
 * getProviderConfigForParallel so both the graph runner and agent-to-agent
 * delegation (run_agents_parallel) can share one implementation.
 */
class ParallelAgentExecutor
{
    public function __construct(
        private AgentRunner $agentRunner,
        private PDO $db,
        private array $config,
        private bool $recordExecutions = false,
        private ?ParallelRunObserver $observer = null,
        private ?ParallelClientToolBridge $bridge = null,
        private int $maxConcurrency = 6
    ) {}

    /** @param array $states list of ['key','agent','input','messages','tools','tools_filter'] */
    public function run(array $states, int $maxRounds = 10): array
    {
        $agentStates = [];
        foreach ($states as $s) {
            $key = $s['key'];
            $agent = $s['agent'];
            $executionId = null;
            if ($this->recordExecutions && $agent->getId() !== null) {
                $executionId = $this->agentRunner->recordExecutionStart(
                    $agent, (int) ($s['user_id'] ?? 0), $s['input']);
            }
            $this->observer?->onAgentStart((string) $key, $agent, $s['input']);
            $agentStates[$key] = [
                'key' => $key,
                'agent' => $agent,
                'input' => $s['input'],
                'messages' => $s['messages'],
                'tools' => $s['tools'],
                'tools_filter' => $s['tools_filter'] ?? null,
                'execution_id' => $executionId,
                'completed' => false,
                'output' => '',
                'success' => false,
                'usage' => null,
                'start_time' => microtime(true),
            ];
        }

        $results = [];
        for ($round = 0; $round < $maxRounds; $round++) {
            $pending = array_filter($agentStates, fn($s) => !$s['completed']);
            if (empty($pending)) break;

            $responses = $this->callLLMs($pending);

            foreach ($responses as $key => $response) {
                $state = &$agentStates[$key];
                if (!($response['success'] ?? false)) {
                    $state['completed'] = true;
                    $state['success'] = false;
                    $state['output'] = 'Error: ' . ($response['error'] ?? 'Unknown error');
                    $this->finalize($key, $state, $results);
                    continue;
                }
                $parsed = $response['parsed'];
                if (!empty($parsed['tool_calls'])) {
                    $state['messages'][] = [
                        'role' => 'assistant',
                        'content' => $parsed['text'] ?? null,
                        'tool_calls' => $parsed['tool_calls'],
                    ];
                    foreach ($parsed['tool_calls'] as $tc) {
                        $name = $tc['function']['name'] ?? $tc['name'] ?? 'function';
                        if ($this->bridge && $this->bridge->isClientSideTool($name)) {
                            $this->bridge->emit($tc, (string) $key, $parsed['text'] ?? '');
                            $content = $this->bridge->await($tc, (string) $key);
                        } else {
                            $content = $this->executeServerTool($tc, $state['tools_filter']);
                        }
                        $state['messages'][] = [
                            'role' => 'tool',
                            'tool_call_id' => $tc['id'] ?? null,
                            'name' => $name,
                            'content' => is_string($content) ? $content : json_encode($content),
                        ];
                    }
                    // needs another round
                } else {
                    $state['completed'] = true;
                    $state['success'] = true;
                    $state['output'] = $parsed['text'] ?? '';
                    $state['usage'] = $parsed['usage'] ?? null;
                    $this->finalize($key, $state, $results);
                }
            }
            unset($state);
        }

        // Any agent that never finished within the round cap.
        foreach ($agentStates as $key => $state) {
            if (isset($results[$key])) continue;
            $state['success'] = false;
            $state['output'] = $state['output'] !== ''
                ? $state['output']
                : 'Agent did not finish within the tool-round limit.';
            $this->finalize($key, $state, $results);
        }
        return $results;
    }

    private function finalize(string|int $key, array $state, array &$results): void
    {
        $agent = $state['agent'];
        if ($this->recordExecutions && $state['execution_id']) {
            $rt = (microtime(true) - $state['start_time']) * 1000;
            $this->agentRunner->recordExecutionComplete((int) $state['execution_id'], [
                'text' => $state['output'] ?? '',
                'usage' => $state['usage'] ?? [],
                'tool_calls' => [],
            ], $rt);
        }
        $this->observer?->onAgentComplete((string) $key, $agent,
            (bool) $state['success'], $state['output'], $state['usage']);
        $results[$key] = [
            'agent_id' => $agent->getId(),
            'agent_name' => $agent->getName(),
            'input' => $state['input'] ?? '',
            'output' => $state['output'] ?? null,
            'success' => (bool) $state['success'],
            'usage' => $state['usage'] ?? null,
            'execution_id' => $state['execution_id'] ?? null,
        ];
    }

    public function buildToolsFor(Agent $agent, ?array $toolsFilter): array
    {
        $all = $this->agentRunner->getToolsManager()->getToolDefinitions();
        if (empty($toolsFilter)) return $all;
        return array_values(array_filter($all, fn($t) => in_array($t['name'], $toolsFilter, true)));
    }

    private function executeServerTool(array $toolCall, ?array $toolsFilter): string
    {
        $name = $toolCall['function']['name'] ?? '';
        $args = json_decode($toolCall['function']['arguments'] ?? '{}', true) ?? [];
        try {
            $result = $this->agentRunner->getToolsManager()->execute($name, $args);
            return is_string($result) ? $result : json_encode($result);
        } catch (\Exception $e) {
            return json_encode(['error' => $e->getMessage()]);
        }
    }

    /**
     * One concurrent round via curl_multi (capped at $this->maxConcurrency
     * in-flight requests per batch). Overridable in tests.
     *
     * Adapted from GraphWorkflowRunner::makeParallelLLMCalls(): the
     * handle-adding loop is chunked so no more than maxConcurrency requests
     * are ever in flight at once; responses are merged across chunks.
     */
    /**
     * Public entry for callers (e.g. GraphWorkflowRunner) that keep their own
     * round loop but want the shared, concurrency-capped multi-provider LLM
     * round. Returns key => ['success'=>bool,'parsed'=>?array,'error'=>?string].
     */
    public function runConcurrentRound(array $states): array
    {
        return $this->callLLMs($states);
    }

    protected function callLLMs(array $agentStates): array
    {
        $responses = [];
        $chunks = array_chunk($agentStates, max(1, $this->maxConcurrency), true);

        foreach ($chunks as $chunk) {
            // Merge with the union operator (NOT array_merge) to preserve the
            // string/int state keys across chunks — renumbering would break the
            // key => response contract the round loop relies on.
            $responses += $this->dispatchChunk($chunk);
        }

        return $responses;
    }

    /**
     * Dispatch a single capped chunk of agent states as one concurrent
     * curl_multi batch. Returns key => ['success'=>bool,'parsed'=>?array,
     * 'error'=>?string] for the chunk. Split out from callLLMs() so the
     * chunking/cap/key-preservation is testable without touching the network.
     */
    protected function dispatchChunk(array $chunk): array
    {
        $responses = [];
        $multiHandle = curl_multi_init();
        $curlHandles = [];

        foreach ($chunk as $nodeId => $state) {
                $request = $this->buildAgentLLMRequestWithTools($state['agent'], $state['messages'], $state['tools']);
                if (!$request) continue;

                // Force the skill call until it has run once. The parallel path
                // builds requests via ProviderRequestFactory (no tool_choice
                // param), so inject the provider-shaped value into the payload.
                if (!empty($state['force_skill']) && empty($state['skill_ran'])) {
                    $toolChoice = SkillToolChoice::forProvider($request['provider']);
                    if ($toolChoice !== null) {
                        $request['payload']['tool_choice'] = $toolChoice;
                    }
                }

                $ch = curl_init($request['url']);
                curl_setopt_array($ch, [
                    CURLOPT_POST => true,
                    CURLOPT_POSTFIELDS => json_encode($request['payload']),
                    CURLOPT_HTTPHEADER => $request['headers'],
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT => 300,
                    CURLOPT_SSL_VERIFYPEER => true,
                    CURLOPT_SSL_VERIFYHOST => 2,
                    CURLOPT_FOLLOWLOCATION => true,
                ]);

                curl_multi_add_handle($multiHandle, $ch);
                $curlHandles[$nodeId] = ['handle' => $ch, 'provider' => $request['provider']];
            }

            // Execute this chunk in parallel
            $running = null;
            do {
                curl_multi_exec($multiHandle, $running);
                curl_multi_select($multiHandle, 0.5);
            } while ($running > 0);

            // Collect responses
            foreach ($curlHandles as $nodeId => $info) {
                $ch = $info['handle'];
                $response = curl_multi_getcontent($ch);
                $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                $curlError = curl_error($ch);
                $curlErrno = curl_errno($ch);

                curl_multi_remove_handle($multiHandle, $ch);
                curl_close($ch);

                // Log curl errors with more info
                if ($curlErrno !== 0) {
                    $effectiveUrl = curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
                    $connectTime = curl_getinfo($ch, CURLINFO_CONNECT_TIME);
                    error_log("[ParallelAgentExecutor] Node {$nodeId} CURL error ({$curlErrno}): {$curlError}, URL: {$effectiveUrl}, connect_time: {$connectTime}");
                    $responses[$nodeId] = ['success' => false, 'error' => "CURL error: {$curlError}"];
                    continue;
                }

                // Log HTTP code for debugging
                error_log("[ParallelAgentExecutor] Node {$nodeId} HTTP {$httpCode}, response_len=" . strlen($response));

                // HTTP 0 means connection failed
                if ($httpCode === 0) {
                    error_log("[ParallelAgentExecutor] Node {$nodeId} connection failed (HTTP 0)");
                    $responses[$nodeId] = ['success' => false, 'error' => "Connection failed"];
                    continue;
                }

                if ($httpCode >= 400) {
                    error_log("[ParallelAgentExecutor] HTTP error {$httpCode}: " . substr($response, 0, 500));
                    // Extract error message from API response for better debugging
                    $errorMessage = "HTTP {$httpCode}";
                    $decoded = json_decode($response, true);
                    if ($decoded) {
                        // OpenAI/Grok/DeepSeek format
                        if (isset($decoded['error']['message'])) {
                            $errorMessage = $decoded['error']['message'];
                        }
                        // Claude format
                        elseif (isset($decoded['error']['type'])) {
                            $errorMessage = $decoded['error']['type'] . ': ' . ($decoded['error']['message'] ?? '');
                        }
                        // Gemini format
                        elseif (isset($decoded['error']['status'])) {
                            $errorMessage = $decoded['error']['status'] . ': ' . ($decoded['error']['message'] ?? '');
                        }
                    }
                    $responses[$nodeId] = ['success' => false, 'error' => $errorMessage];
                } else {
                    $parsed = $this->parseParallelLLMResponse($response, $info['provider']);
                    // Debug: Log parsed response
                    $toolCallCount = count($parsed['tool_calls'] ?? []);
                    $textLen = strlen($parsed['text'] ?? '');
                    error_log("[ParallelAgentExecutor] Node {$nodeId} response: provider={$info['provider']}, tool_calls={$toolCallCount}, text_len={$textLen}, has_usage=" . ($parsed['usage'] ? 'yes' : 'no'));
                    // If empty response, log raw response for debugging
                    if ($toolCallCount === 0 && $textLen === 0) {
                        error_log("[ParallelAgentExecutor] Node {$nodeId} EMPTY response, raw: " . substr($response, 0, 1000));
                    }
                    $responses[$nodeId] = ['success' => true, 'parsed' => $parsed];
                }
            }

        curl_multi_close($multiHandle);

        return $responses;
    }

    /**
     * Build LLM request with tools for parallel execution
     * Supports all providers: OpenAI, Claude, Gemini, Grok, DeepSeek, Kimi
     * Uses ProviderRequestFactory for unified request building.
     */
    private function buildAgentLLMRequestWithTools(Agent $agent, array $messages, array $tools): ?array
    {
        $provider = strtolower($agent->getProvider());
        $model = $agent->getModel();
        $settings = $agent->getSettings();

        $providerConfig = $this->getProviderConfigForParallel($provider);
        if (!$providerConfig || empty($providerConfig['api_key'])) {
            error_log("[ParallelAgentExecutor] Agent {$agent->getName()}: No API key for provider {$provider}");
            return null;
        }

        $maxTokens = $settings['max_tokens'] ?? ($providerConfig['max_tokens'] ?? 4096);
        $temperature = $settings['temperature'] ?? 0.7;
        $modelToUse = $model ?: ($providerConfig['model'] ?? '');

        // Debug log
        error_log("[ParallelAgentExecutor] Agent {$agent->getName()}: provider={$provider}, model={$modelToUse}");

        // Use the ProviderRequestFactory for unified request building
        return ProviderRequestFactory::buildRequest(
            $provider,
            $modelToUse,
            $messages,
            $tools,
            $providerConfig,
            $maxTokens,
            $temperature
        );
    }

    /**
     * Parse LLM response including tool_calls - handles all provider formats.
     * Uses ProviderRequestFactory for unified response parsing.
     */
    private function parseParallelLLMResponse(string $response, string $provider): array
    {
        $decoded = json_decode($response, true);
        if (!$decoded) {
            error_log("[ParallelAgentExecutor] Failed to decode response for provider {$provider}");
            return ['text' => '', 'tool_calls' => [], 'usage' => null];
        }

        // Use the ProviderRequestFactory for unified response parsing
        return ProviderRequestFactory::parseResponse($provider, $decoded);
    }

    /**
     * Get provider config for parallel execution
     * Handles provider aliases (anthropic/claude, google/gemini)
     */
    private function getProviderConfigForParallel(string $name): ?array
    {
        $name = strtolower($name);

        // Handle provider aliases
        $aliases = [
            'anthropic' => 'claude',
            'google' => 'gemini',
        ];
        $primaryName = $aliases[$name] ?? $name;
        $alternateName = array_search($name, $aliases) ?: null;

        // Check database first
        try {
            // Try primary name first, then alternate
            $sql = "SELECT * FROM system_llm_settings WHERE provider_key IN (:key1, :key2) AND enabled = 1 LIMIT 1";
            $stmt = $this->db->prepare($sql);
            $stmt->execute([':key1' => $primaryName, ':key2' => $alternateName ?? $primaryName]);
            $dbConfig = $stmt->fetch(\PDO::FETCH_ASSOC);

            // Get config file for API key fallback - try both names
            $configSettings = $this->config[$primaryName]
                ?? $this->config['providers'][$primaryName]
                ?? ($alternateName ? ($this->config[$alternateName] ?? $this->config['providers'][$alternateName] ?? null) : null)
                ?? null;

            if ($dbConfig) {
                $dbApiKey = $dbConfig['api_key'] ?? '';
                $configApiKey = $configSettings['api_key'] ?? '';

                return [
                    'api_key' => !empty($dbApiKey) ? $dbApiKey : $configApiKey,
                    'model' => $dbConfig['model'] ?: ($configSettings['model'] ?? ''),
                    'base_url' => $dbConfig['base_url'] ?: ($configSettings['base_url'] ?? ''),
                    'max_tokens' => (int)($dbConfig['max_tokens'] ?: ($configSettings['max_tokens'] ?? 4096)),
                    'chat_endpoint' => $dbConfig['chat_endpoint'] ?: ($configSettings['chat_endpoint'] ?? '/v1/chat/completions'),
                ];
            }

            // No DB config, try config file
            if ($configSettings) {
                return $configSettings;
            }
        } catch (\Exception $e) {
            error_log("[ParallelAgentExecutor] Error loading provider config: " . $e->getMessage());
        }

        // Fallback to config array
        return $this->config[$primaryName]
            ?? $this->config['providers'][$primaryName]
            ?? ($alternateName ? ($this->config[$alternateName] ?? $this->config['providers'][$alternateName] ?? null) : null)
            ?? null;
    }
}
