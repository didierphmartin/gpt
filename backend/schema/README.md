# Database schema

`chatbot.sql` — schema-only dump (no data) of the **contexts database**, which
holds everything gpt owns: `users`, `agents`, `agent_workflows`, `app_keys`,
`system_llm_settings`, `conversation_contexts`, the `playbook_run*` tables and
more (50 tables).

Import into a fresh database to recreate the structure, then configure secrets
via `backend/.env` (copy `backend/.env.example`). The Docker stack mounts this
same file into MySQL's init hook, so it is exercised on every fresh `docker
compose up` — see the Docker section of the top-level README.

## On the second connection

`backend/.env` also requires `DB_*` (the "main" database). No code path reads
it: every `new PDO` site resolves `$config['contexts_database'] ??
$config['database']`, and the portfolio tables that connection would serve
(`portfolios`, `portfolio_assets`, `transactions`, `assets`, `watchlist`) exist
in neither this dump nor the live database. Point `DB_*` at the same database as
`CTX_DB_*`; the Docker stack does exactly that.

## Known gap

`llm_function_usage_stats` is written by `UsageTracker.php:109` and `:133` but
is not created here and does not exist in the live database either. Those writes
currently fail. Tracked separately from the schema.
