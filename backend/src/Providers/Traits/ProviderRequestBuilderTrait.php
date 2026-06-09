<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Providers\Traits;

/**
 * Shared helper methods for provider request building.
 *
 * Used by providers implementing HttpRequestBuilderInterface to avoid
 * duplicating common utility methods.
 */
trait ProviderRequestBuilderTrait
{
    /**
     * Context window (total tokens) for the current model. 0 = disabled.
     * Providers should override with a model-aware value.
     */
    protected function getContextWindow(): int
    {
        return 0;
    }

    /**
     * Emit a usage_warning SSE event when the model truncated its output.
     * Accepts the various per-provider reason strings.
     *
     * Suppresses the warning when reported output is 0 — that's a false
     * positive we hit during B3 client-side tool turns where the stream
     * closes with finish_reason="length" while the model was emitting a
     * tool_call (no text actually generated). Truncation requires real
     * output to be cut off; "0 / 8192" is contradictory and confusing.
     */
    protected function emitUsageWarningIfTruncated(string $finishReason, int $outputTokens): void
    {
        $truncationReasons = ['max_tokens', 'length', 'MAX_TOKENS'];
        if (!in_array($finishReason, $truncationReasons, true)) return;
        if ($outputTokens <= 0) return;
        $this->sseClient?->sendCustomEvent('usage_warning', [
            'reason' => 'output_truncated',
            'provider' => $this->getName(),
            'model' => $this->model,
            'max_tokens' => $this->maxTokens,
            'output_tokens' => $outputTokens,
        ]);
    }

    /**
     * Emit a usage_warning when input tokens exceed 75% of the context window.
     */
    protected function emitContextWarningIfHigh(int $inputTokens): void
    {
        $window = $this->getContextWindow();
        if ($window <= 0) return;
        $percent = (int) round(($inputTokens / $window) * 100);
        if ($percent < 75) return;
        $this->sseClient?->sendCustomEvent('usage_warning', [
            'reason' => 'context_high',
            'provider' => $this->getName(),
            'model' => $this->model,
            'input_tokens' => $inputTokens,
            'context_window' => $window,
            'percent' => $percent,
        ]);
    }

    /**
     * Assemble the full system prompt: current date + default/custom prompt
     * + optional memory_context + optional skill_content.
     *
     * Each provider implements its own getDefaultSystemPrompt() because
     * config paths differ (e.g. claude.system_prompt vs providers.deepseek.system_prompt).
     */
    protected function buildSystemPrompt(array $options): string
    {
        $systemPrompt = $options['system_prompt'] ?? $this->getDefaultSystemPrompt();

        $datePrefix = "Current date: " . date('Y-m-d') . " (" . date('l') . ").";
        $systemPrompt = $datePrefix . "\n\n" . ltrim($systemPrompt);

        if (!empty($options['memory_context'])) {
            $systemPrompt = rtrim($systemPrompt) . "\n\n" . $options['memory_context'];
        }
        if (!empty($options['skill_content'])) {
            $systemPrompt = rtrim($systemPrompt) . "\n\n" . $options['skill_content'];
        }

        return $systemPrompt;
    }

    /**
     * Recursively convert empty arrays to stdClass objects for proper JSON encoding.
     * Required for APIs that expect {} not [] for empty objects.
     *
     * @param mixed $data The data to process
     * @return mixed The processed data
     */
    protected static function convertEmptyArraysToObjects($data)
    {
        if (!is_array($data)) {
            return $data;
        }

        if (empty($data)) {
            return new \stdClass();
        }

        // Check if it's an associative array
        $isAssociative = array_keys($data) !== range(0, count($data) - 1);

        // Recursively process all values
        foreach ($data as $key => $value) {
            if (is_array($value)) {
                $data[$key] = self::convertEmptyArraysToObjects($value);
            }
        }

        return $data;
    }

    /**
     * Convert empty arrays to objects for Claude, but preserve 'required' fields as arrays.
     * Claude tool schema requires 'required' to be a list, not an object.
     *
     * @param mixed $data The data to process
     * @param string $currentKey The current key being processed
     * @return mixed The processed data
     */
    protected static function convertEmptyArraysToObjectsForClaude($data, string $currentKey = '')
    {
        if (!is_array($data)) {
            return $data;
        }

        // 'required' field must stay as an array even if empty
        if ($currentKey === 'required') {
            return $data;
        }

        if (empty($data)) {
            return new \stdClass();
        }

        // Recursively process all values, passing the key name
        foreach ($data as $key => $value) {
            if (is_array($value)) {
                $data[$key] = self::convertEmptyArraysToObjectsForClaude($value, (string)$key);
            }
        }

        return $data;
    }

    /**
     * Normalize usage data to a common format.
     *
     * @param array|null $usage The provider-specific usage data
     * @param string $provider The provider name
     * @return array|null Normalized usage with prompt_tokens, completion_tokens, total_tokens
     */
    protected static function normalizeUsage(?array $usage, string $provider): ?array
    {
        if ($usage === null) {
            return null;
        }

        switch ($provider) {
            case 'claude':
            case 'anthropic':
                return [
                    'prompt_tokens' => $usage['input_tokens'] ?? 0,
                    'completion_tokens' => $usage['output_tokens'] ?? 0,
                    'total_tokens' => ($usage['input_tokens'] ?? 0) + ($usage['output_tokens'] ?? 0),
                ];

            case 'gemini':
            case 'google':
                return [
                    'prompt_tokens' => $usage['promptTokenCount'] ?? 0,
                    'completion_tokens' => $usage['candidatesTokenCount'] ?? 0,
                    'total_tokens' => $usage['totalTokenCount'] ?? 0,
                ];

            default:
                // OpenAI-compatible format
                return [
                    'prompt_tokens' => $usage['prompt_tokens'] ?? 0,
                    'completion_tokens' => $usage['completion_tokens'] ?? 0,
                    'total_tokens' => $usage['total_tokens'] ?? (($usage['prompt_tokens'] ?? 0) + ($usage['completion_tokens'] ?? 0)),
                ];
        }
    }

    /**
     * Convert tools from Claude format to OpenAI format.
     *
     * @param array $claudeTools Tools in Claude format (name, description, input_schema)
     * @return array Tools in OpenAI format (type, function: {name, description, parameters})
     */
    protected static function convertToolsToOpenAIFormat(array $claudeTools): array
    {
        $openAITools = [];

        foreach ($claudeTools as $tool) {
            $openAITools[] = [
                'type' => 'function',
                'function' => [
                    'name' => $tool['name'],
                    'description' => $tool['description'] ?? '',
                    'parameters' => $tool['input_schema'] ?? $tool['parameters'] ?? ['type' => 'object', 'properties' => []],
                ],
            ];
        }

        return $openAITools;
    }

    /**
     * Convert tools from Claude format to Gemini format.
     *
     * @param array $claudeTools Tools in Claude format
     * @return array Tools in Gemini format (functionDeclarations)
     */
    protected static function convertToolsToGeminiFormat(array $claudeTools): array
    {
        $functions = [];

        foreach ($claudeTools as $tool) {
            // Handle stdClass objects
            if (is_object($tool)) {
                $tool = json_decode(json_encode($tool), true);
            }

            $inputSchema = $tool['input_schema'] ?? ['type' => 'object', 'properties' => (object)[]];

            if (is_object($inputSchema)) {
                $inputSchema = json_decode(json_encode($inputSchema), true);
            }

            // Fix and validate schema for Gemini
            $inputSchema = self::fixSchemaForGemini($inputSchema);

            $functions[] = [
                'name' => $tool['name'],
                'description' => $tool['description'] ?? '',
                'parameters' => $inputSchema,
            ];
        }

        return [['functionDeclarations' => $functions]];
    }

    /**
     * Fix schema to be valid for Gemini API.
     *
     * @param mixed $schema The schema to fix
     * @return array The fixed schema
     */
    protected static function fixSchemaForGemini($schema): array
    {
        // Convert stdClass to array
        if (is_object($schema)) {
            $schema = (array) $schema;
        }

        // Empty or non-array schema defaults to string
        if (!is_array($schema) || empty($schema)) {
            return ['type' => 'string'];
        }

        // Remove fields not supported by Gemini
        $unsupportedFields = [
            '$schema', '$id', '$ref', '$defs', 'additionalProperties',
            'definitions', 'examples', 'default', 'const', 'title', 'format',
            'nullable', 'deprecated', 'readOnly', 'writeOnly', 'externalDocs',
            'xml', 'discriminator', 'minLength', 'maxLength', 'pattern',
            'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
            'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else',
        ];
        foreach ($unsupportedFields as $field) {
            unset($schema[$field]);
        }

        // Ensure type exists
        if (!isset($schema['type'])) {
            $schema['type'] = 'string';
        }

        // Convert enum to description
        if (isset($schema['enum']) && is_array($schema['enum'])) {
            $enumValues = implode(', ', array_map('strval', $schema['enum']));
            $desc = $schema['description'] ?? '';
            $schema['description'] = trim($desc . " Allowed values: " . $enumValues);
            unset($schema['enum']);
        }

        // Fix properties recursively
        if (isset($schema['properties'])) {
            $props = $schema['properties'];
            if (is_object($props)) {
                $props = (array) $props;
            }

            if (is_array($props) && !empty($props)) {
                $fixedProps = [];
                foreach ($props as $propName => $propSchema) {
                    $fixedProps[$propName] = self::fixSchemaForGemini($propSchema);
                }
                $schema['properties'] = $fixedProps;
            } else {
                $schema['properties'] = (object)[];
            }
        } elseif ($schema['type'] === 'object') {
            $schema['properties'] = (object)[];
        }

        // Fix items for array type
        if (isset($schema['items'])) {
            $schema['items'] = self::fixSchemaForGemini($schema['items']);
        } elseif ($schema['type'] === 'array') {
            $schema['items'] = ['type' => 'string'];
        }

        // Remove empty required arrays
        if (isset($schema['required']) && empty($schema['required'])) {
            unset($schema['required']);
        }

        return $schema;
    }
}
