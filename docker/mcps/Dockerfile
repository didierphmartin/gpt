# MCP server host for the Docker app: the supervisor plus whatever servers the
# user imports into /mcps (a volume). Standard library only, so no pip step.
FROM python:3.12-slim

# bash: imported servers start through run.sh-style scripts.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends bash; \
    rm -rf /var/lib/apt/lists/*; \
    useradd --create-home --uid 1000 mcps; \
    mkdir /mcps; \
    chown mcps:mcps /mcps

WORKDIR /app
COPY docker/mcps/supervisor.py ./supervisor.py
COPY docker/mcps/mcphost ./mcphost

USER mcps
ENV MCPS_ROOT=/mcps PYTHONUNBUFFERED=1
EXPOSE 9000 8790
CMD ["python", "supervisor.py"]
