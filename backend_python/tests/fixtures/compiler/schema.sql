CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER, headers TEXT);
CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT);
CREATE TABLE system_llm_settings (provider_key TEXT, display_name TEXT, model TEXT, base_url TEXT, api_format TEXT, protocol TEXT, enabled INTEGER, sort_order INTEGER);
CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT);
CREATE TABLE users (id INTEGER PRIMARY KEY, kind TEXT, email TEXT, first_name TEXT, last_name TEXT);
CREATE TABLE playbooks (id INTEGER PRIMARY KEY, user_id INTEGER, pkey TEXT, title TEXT, text TEXT, updated_at TEXT, published_by INTEGER, published_at TEXT, source_id INTEGER, automation_id INTEGER);
