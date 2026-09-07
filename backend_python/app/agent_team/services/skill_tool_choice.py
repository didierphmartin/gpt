"""Builds the provider-specific `tool_choice` payload that forces an agent to
call run_skill_script on its first parallel round. Mirrors how the
sequential path forces the skill (GraphWorkflowRunner::runAgentNode), but
as a pure value so the parallel path can inject it into an already-built
request payload without touching the provider request interface.

Ported from backend/src/AgentTeam/Services/SkillToolChoice.php.
"""
from typing import Optional


class SkillToolChoice:
    TOOL_NAME = 'run_skill_script'

    @staticmethod
    def forProvider(provider: str) -> Optional[dict]:
        p = provider.lower()
        if p in ('openai', 'grok', 'deepseek', 'kimi'):
            return {'type': 'function', 'function': {'name': SkillToolChoice.TOOL_NAME}}
        if p in ('claude', 'anthropic'):
            return {'type': 'tool', 'name': SkillToolChoice.TOOL_NAME}
        # Gemini uses function_calling_config (not payload tool_choice);
        # unknown providers fall back to the prompt instruction.
        return None
