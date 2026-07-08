/**
 * Builds the provider-specific `tool_choice` payload that forces an agent to
 * call run_skill_script on its first parallel round. Mirrors how the sequential
 * path forces the skill (GraphWorkflowRunner.runAgentNode), but as a pure value
 * so the parallel path can inject it into an already-built request payload
 * without touching the provider request interface.
 *
 * Behavior-identical port of PHP src/AgentTeam/Services/SkillToolChoice.php.
 */
export class SkillToolChoice {
  static readonly TOOL_NAME = 'run_skill_script';

  /**
   * Provider-shaped tool_choice forcing run_skill_script, or null when the
   * provider forces tools differently (Gemini uses function_calling_config,
   * not a payload tool_choice) or is unknown (caller falls back to the prompt
   * instruction).
   */
  static forProvider(provider: string): Record<string, unknown> | null {
    switch ((provider ?? '').toLowerCase()) {
      case 'openai':
      case 'grok':
      case 'deepseek':
      case 'kimi':
        return { type: 'function', function: { name: SkillToolChoice.TOOL_NAME } };
      case 'claude':
      case 'anthropic':
        return { type: 'tool', name: SkillToolChoice.TOOL_NAME };
      default:
        // Gemini uses function_calling_config (not payload tool_choice);
        // unknown providers fall back to the prompt instruction.
        return null;
    }
  }
}
