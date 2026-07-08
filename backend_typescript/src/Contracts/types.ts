/** Shared DTOs for the chat/provider layer (mirrors the array shapes passed around in PHP). */

export interface ClientTool {
  name: string;
  description?: string;
  input_schema?: any;
}

export interface ToolCall {
  id: string;
  name: string;
  input: any;
}

export interface SkillMetadata {
  dir_name: string;
  scripts: string[];
}

export interface AvailableSkill {
  dir_name: string;
  description: string;
  scripts: string[];
}

export interface ChatOptions {
  message: string;
  conversation_history: any[];
  system_prompt?: string;
  client_tools?: ClientTool[];
  client_tool_names?: string[];
  user_id?: number | null;
  /** SKILL.md body for a chip-dragged skill — appended to the system prompt (mirrors PHP). */
  skill_content?: string;
  /** Single active skill (chip override) — its run_skill_script tool is forced via tool_choice. */
  skill_metadata?: SkillMetadata;
  /** All installed folder-backed skills — the multi-skill auto-routing catalog. */
  available_skills?: AvailableSkill[];
  /** Provider-conditional forcing shape (OpenAI object form or 'required'); providers translate. */
  tool_choice?: string | Record<string, any>;
}

export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  function_calls: number;
}

export interface ChatResult {
  text: string;
  usage: ChatUsage;
  model: string;
  provider: string;
  pending_client_tool_call?: boolean;
  pending_tool_calls?: ToolCall[];
}

/** Runtime config for one provider, resolved from system_llm_settings. */
export interface ProviderConfig {
  provider_key: string;
  api_key: string;
  model: string;
  base_url: string;
  chat_endpoint: string;
  api_format: string;
  max_tokens: number;
  temperature: number;
  system_prompt: string | null;
}
