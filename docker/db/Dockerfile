FROM mysql:8.4
# Baked rather than bind-mounted: a bind mount makes the whole stack depend on
# the clone living somewhere Docker Desktop is allowed to share, which fails
# outright on macOS outside its allowlist. Baking also removes the trap where a
# MISSING mount source is silently created as a directory, which MySQL then
# chokes on. Changing either file needs `docker compose up --build` -- and since
# /docker-entrypoint-initdb.d/ only runs on an empty volume, such a change
# already required `down -v`, so this adds a flag, not a step.
COPY backend/schema/chatbot.sql /docker-entrypoint-initdb.d/01-schema.sql
COPY docker/db/02-seed.sql      /docker-entrypoint-initdb.d/02-seed.sql
