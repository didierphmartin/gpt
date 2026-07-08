import { Generated } from 'kysely';

/**
 * Kysely table interfaces for the contexts database (the connection PHP controllers use).
 * Columns marked Generated have DB defaults (auto-increment id, CURRENT_TIMESTAMP) and are
 * therefore optional on insert. Mirrors schema/chatbot.sql.
 */

export interface UsersTable {
  id: Generated<number>;
  email: string;
  phone: string | null;
  password: string | null; // PHP password_hash (bcrypt); NULL for social-only accounts
  first_name: string | null;
  last_name: string | null;
  firebase_uid: string | null;
  provider: 'email' | 'google' | 'facebook';
  role: 'guest' | 'prospect' | 'user' | 'admin' | 'affiliate';
  ledger_user_id: string | null;
  plan: string;
  profile_picture: string | null;
  email_verified: number;
  last_login: string | null;
  created_at: Generated<string | null>;
  updated_at: Generated<string | null>;
  storage_provider: string | null;
  storage_folder: string | null;
  app_key_hash: string | null;
  app_key_prefix: string | null;
  app_key_created_at: string | null;
}

export interface PromptLibraryTable {
  id: Generated<number>;
  user_id: number; // INT (matches users.id / JWT sub) after the 2026-06-30 migration
  parent_id: number | null;
  type: 'folder' | 'prompt';
  name: string;
  content: string | null;
  sort_order: number;
  created_at: Generated<string | null>;
  updated_at: Generated<string | null>;
}

export interface SystemLlmSettingsTable {
  id: Generated<number>;
  provider_key: string;
  display_name: string | null;
  api_key: string | null; // plaintext (no encryption at rest), per PHP
  model: string;
  base_url: string | null;
  max_tokens: number | null;
  temperature: number | null;
  price_input_per_1m: number | null;
  price_output_per_1m: number | null;
  chat_endpoint: string | null;
  streaming: number | null;
  supports_tools: number | null;
  supported_models: string | null; // json
  api_format: string | null;
  system_prompt: string | null;
  enabled: number | null;
  sort_order: number | null;
  created_at: Generated<string | null>;
  updated_at: Generated<string | null>;
}

export interface McpServersTable {
  id: Generated<number>;
  user_id: string | null; // varchar; NULL = global server, else private to that user
  name: string;
  url: string;
  description: string | null;
  headers: any | null; // json — { "Header-Name": "value", ... }
  enabled: number;
  created_at: Generated<string | null>;
  updated_at: Generated<string | null>;
}

export interface McpServerToolsTable {
  id: Generated<number>;
  server_id: number;
  tool_name: string;
  tool_description: string | null;
  input_schema: any | null; // json — JSON Schema object
  has_ui: number;
  ui_resource_uri: string | null;
  cached_at: Generated<string | null>;
}

export interface UserMcpOverridesTable {
  id: Generated<number>;
  user_id: number;
  server_id: number;
  allowed: number; // 1 = force-include, 0 = force-exclude
  created_at: Generated<string | null>;
  updated_at: Generated<string | null>;
}

export interface ConversationContextsTable {
  id: Generated<number>;
  user_id: number;
  title: string;
  context_data: string; // longtext JSON
  provider: string;
  message_count: number;
  created_at: Generated<string | null>;
  updated_at: Generated<string | null>;
}

export interface UserApiKeysTable {
  id: Generated<number>;
  user_id: number;
  provider: string;
  api_key: string | null; // AES-encrypted
  model: string | null;
  base_url: string | null;
  max_tokens: number | null;
}

export interface DB {
  users: UsersTable;
  prompt_library: PromptLibraryTable;
  system_llm_settings: SystemLlmSettingsTable;
  mcp_servers: McpServersTable;
  mcp_server_tools: McpServerToolsTable;
  user_mcp_overrides: UserMcpOverridesTable;
  user_api_keys: UserApiKeysTable;
  conversation_contexts: ConversationContextsTable;
}
