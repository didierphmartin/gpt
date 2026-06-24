<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * Builds the provider-specific `tool_choice` payload that forces an agent to
 * call run_skill_script on its first parallel round. Mirrors how the
 * sequential path forces the skill (GraphWorkflowRunner::runAgentNode), but
 * as a pure value so the parallel path can inject it into an already-built
 * request payload without touching the provider request interface.
 */
class SkillToolChoice
{
    public const TOOL_NAME = 'run_skill_script';

    public static function forProvider(string $provider): ?array
    {
        switch (strtolower($provider)) {
            case 'openai':
            case 'grok':
            case 'deepseek':
            case 'kimi':
                return ['type' => 'function', 'function' => ['name' => self::TOOL_NAME]];
            case 'claude':
            case 'anthropic':
                return ['type' => 'tool', 'name' => self::TOOL_NAME];
            default:
                // Gemini uses function_calling_config (not payload tool_choice);
                // unknown providers fall back to the prompt instruction.
                return null;
        }
    }
}
