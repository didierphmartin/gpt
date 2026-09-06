"""Port of Providers/Traits/ProviderRequestBuilderTrait.php.

Shared helper methods for provider request building, as a mixin class.
Used by providers implementing HttpRequestBuilderInterface to avoid
duplicating common utility methods.

Instances using this mixin must expose `sseClient`, `model`, `maxTokens`,
`getName()`, and `getDefaultSystemPrompt()`.
"""
from __future__ import annotations

from app.support.phpcompat import php_date, php_empty, php_strval


class ProviderRequestBuilderMixin:
    """Shared helper methods for provider request building."""

    def getContextWindow(self) -> int:
        """Context window (total tokens) for the current model. 0 = disabled.

        Providers should override with a model-aware value.
        """
        return 0

    def emitUsageWarningIfTruncated(self, finishReason: str, outputTokens: int) -> None:
        """Emit a usage_warning SSE event when the model truncated its output.

        Accepts the various per-provider reason strings.

        Suppresses the warning when reported output is 0 — that's a false
        positive we hit during B3 client-side tool turns where the stream
        closes with finish_reason="length" while the model was emitting a
        tool_call (no text actually generated). Truncation requires real
        output to be cut off; "0 / 8192" is contradictory and confusing.
        """
        truncationReasons = ['max_tokens', 'length', 'MAX_TOKENS']
        if finishReason not in truncationReasons:
            return
        if outputTokens <= 0:
            return
        if self.sseClient:
            self.sseClient.sendCustomEvent('usage_warning', {
                'reason': 'output_truncated',
                'provider': self.getName(),
                'model': self.model,
                'max_tokens': self.maxTokens,
                'output_tokens': outputTokens,
            })

    def emitContextWarningIfHigh(self, inputTokens: int) -> None:
        """Emit a usage_warning when input tokens exceed 75% of the context window."""
        window = self.getContextWindow()
        if window <= 0:
            return
        percent = int((inputTokens / window) * 100 + 0.5)  # round-half-up, matches PHP round()
        if percent < 75:
            return
        if self.sseClient:
            self.sseClient.sendCustomEvent('usage_warning', {
                'reason': 'context_high',
                'provider': self.getName(),
                'model': self.model,
                'input_tokens': inputTokens,
                'context_window': window,
                'percent': percent,
            })

    def buildSystemPrompt(self, options: dict) -> str:
        """Assemble the full system prompt: current date + default/custom
        prompt + optional memory_context + optional skill_content.

        Each provider implements its own getDefaultSystemPrompt() because
        config paths differ (e.g. claude.system_prompt vs
        providers.deepseek.system_prompt).
        """
        systemPrompt = options.get('system_prompt') if options.get('system_prompt') is not None else self.getDefaultSystemPrompt()

        datePrefix = f"Current date: {php_date('Y-m-d')} ({php_date('l')})."
        systemPrompt = datePrefix + "\n\n" + systemPrompt.lstrip()

        if not php_empty(options.get('memory_context')):
            systemPrompt = systemPrompt.rstrip() + "\n\n" + options['memory_context']
        if not php_empty(options.get('skill_content')):
            systemPrompt = systemPrompt.rstrip() + "\n\n" + options['skill_content']

        return systemPrompt

    @staticmethod
    def convertEmptyArraysToObjects(data):
        """Recursively convert empty arrays/lists to dicts for proper JSON
        encoding. Required for APIs that expect {} not [] for empty objects.
        """
        if not isinstance(data, (dict, list)):
            return data

        if len(data) == 0:
            return {}

        if isinstance(data, list):
            return [
                ProviderRequestBuilderMixin.convertEmptyArraysToObjects(v) if isinstance(v, (dict, list)) else v
                for v in data
            ]

        return {
            k: (ProviderRequestBuilderMixin.convertEmptyArraysToObjects(v) if isinstance(v, (dict, list)) else v)
            for k, v in data.items()
        }

    @staticmethod
    def convertEmptyArraysToObjectsForClaude(data, currentKey: str = ''):
        """Convert empty arrays to objects for Claude, but preserve
        'required' fields as arrays. Claude tool schema requires 'required'
        to be a list, not an object.
        """
        if not isinstance(data, (dict, list)):
            return data

        # 'required' field must stay as an array even if empty
        if currentKey == 'required':
            return data

        if len(data) == 0:
            return {}

        if isinstance(data, list):
            return [
                ProviderRequestBuilderMixin.convertEmptyArraysToObjectsForClaude(v, str(i)) if isinstance(v, (dict, list)) else v
                for i, v in enumerate(data)
            ]

        return {
            k: (ProviderRequestBuilderMixin.convertEmptyArraysToObjectsForClaude(v, str(k)) if isinstance(v, (dict, list)) else v)
            for k, v in data.items()
        }

    @staticmethod
    def normalizeUsage(usage: dict | None, provider: str) -> dict | None:
        """Normalize usage data to a common format.

        Returns normalized usage with prompt_tokens, completion_tokens,
        total_tokens.
        """
        if usage is None:
            return None

        if provider in ('claude', 'anthropic'):
            inputTokens = usage.get('input_tokens') if usage.get('input_tokens') is not None else 0
            outputTokens = usage.get('output_tokens') if usage.get('output_tokens') is not None else 0
            return {
                'prompt_tokens': inputTokens,
                'completion_tokens': outputTokens,
                'total_tokens': inputTokens + outputTokens,
            }

        if provider in ('gemini', 'google'):
            return {
                'prompt_tokens': usage.get('promptTokenCount') if usage.get('promptTokenCount') is not None else 0,
                'completion_tokens': usage.get('candidatesTokenCount') if usage.get('candidatesTokenCount') is not None else 0,
                'total_tokens': usage.get('totalTokenCount') if usage.get('totalTokenCount') is not None else 0,
            }

        # OpenAI-compatible format
        promptTokens = usage.get('prompt_tokens') if usage.get('prompt_tokens') is not None else 0
        completionTokens = usage.get('completion_tokens') if usage.get('completion_tokens') is not None else 0
        return {
            'prompt_tokens': promptTokens,
            'completion_tokens': completionTokens,
            'total_tokens': usage.get('total_tokens') if usage.get('total_tokens') is not None else (promptTokens + completionTokens),
        }

    @staticmethod
    def convertToolsToOpenAIFormat(claudeTools: list) -> list:
        """Convert tools from Claude format to OpenAI format."""
        openAITools = []
        for tool in claudeTools:
            openAITools.append({
                'type': 'function',
                'function': {
                    'name': tool['name'],
                    'description': tool.get('description') if tool.get('description') is not None else '',
                    'parameters': (
                        tool.get('input_schema') if tool.get('input_schema') is not None
                        else (tool.get('parameters') if tool.get('parameters') is not None else {'type': 'object', 'properties': {}})
                    ),
                },
            })
        return openAITools

    @classmethod
    def convertToolsToGeminiFormat(cls, claudeTools: list) -> list:
        """Convert tools from Claude format to Gemini format (functionDeclarations).

        A classmethod (PHP: a plain static on the trait) so that the
        `cls.fixSchemaForGemini` call below reproduces PHP's `self::` inside a
        trait, which resolves to the USING class — GeminiProvider's override,
        not this mixin's copy.
        """
        functions = []
        for tool in claudeTools:
            inputSchema = tool.get('input_schema') if tool.get('input_schema') is not None else {'type': 'object', 'properties': {}}
            inputSchema = cls.fixSchemaForGemini(inputSchema)

            functions.append({
                'name': tool['name'],
                'description': tool.get('description') if tool.get('description') is not None else '',
                'parameters': inputSchema,
            })

        return [{'functionDeclarations': functions}]

    @classmethod
    def fixSchemaForGemini(cls, schema) -> dict:
        """Fix schema to be valid for Gemini API.

        A classmethod for the same late-binding reason as
        `convertToolsToGeminiFormat`: PHP's `self::fixSchemaForGemini`
        recursion inside a trait resolves to the using class.
        """
        if not isinstance(schema, dict) or len(schema) == 0:
            return {'type': 'string'}

        schema = dict(schema)

        unsupportedFields = [
            '$schema', '$id', '$ref', '$defs', 'additionalProperties',
            'definitions', 'examples', 'default', 'const', 'title', 'format',
            'nullable', 'deprecated', 'readOnly', 'writeOnly', 'externalDocs',
            'xml', 'discriminator', 'minLength', 'maxLength', 'pattern',
            'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
            'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else',
        ]
        for field in unsupportedFields:
            schema.pop(field, None)

        # Ensure type exists
        if 'type' not in schema:
            schema['type'] = 'string'

        # Convert enum to description
        if isinstance(schema.get('enum'), list):
            enumValues = ', '.join(php_strval(v) for v in schema['enum'])   # PHP array_map('strval', ...)
            desc = schema.get('description') if schema.get('description') is not None else ''
            schema['description'] = (desc + f" Allowed values: {enumValues}").strip()
            del schema['enum']

        # Fix properties recursively
        if 'properties' in schema:
            props = schema['properties']
            if isinstance(props, dict) and len(props) > 0:
                fixedProps = {}
                for propName, propSchema in props.items():
                    fixedProps[propName] = cls.fixSchemaForGemini(propSchema)
                schema['properties'] = fixedProps
            else:
                schema['properties'] = {}
        elif schema.get('type') == 'object':
            schema['properties'] = {}

        # Fix items for array type
        if 'items' in schema:
            schema['items'] = cls.fixSchemaForGemini(schema['items'])
        elif schema.get('type') == 'array':
            schema['items'] = {'type': 'string'}

        # Remove empty required arrays
        if 'required' in schema and php_empty(schema['required']):
            del schema['required']

        return schema
