# Database schema

`chatbot.sql` — schema-only dump (no data) of the **`contexts_database`**
(`netfo587_chatbot`), which holds gpt's core tables: `app_keys`, `users`,
`system_llm_settings` (global LLM keys), `user_api_keys` (per-user LLM keys),
`user_provider_settings`, `conversation_contexts`, and more (41 tables).

Import into a fresh DB to recreate the structure, then configure secrets via
`backend/.env` (copy `backend/.env.example`).

## Note on the second database

gpt also connects to a second DB via the `database` connection
(`portfolio_manager`). gpt was derived from that product and still reads a few
tables from it (e.g. `conversations`). That DB belongs to the other product, so
its schema is intentionally **not** included here. Making gpt fully standalone at
the DB level would mean migrating the handful of tables it reads from
`portfolio_manager` into this chatbot DB — a separate cleanup, not done here.
