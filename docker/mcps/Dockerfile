# MCP server host for the Docker app: the supervisor plus whatever servers the
# user imports into /mcps (a volume). Standard library only, so no pip step.
FROM python:3.12-slim

# bash: imported servers start through run.sh-style scripts. php-*: PHP servers
# start with php -S (and run background jobs via /usr/local/bin/php).
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends bash php-cli php-curl php-xml php-mbstring; \
    rm -rf /var/lib/apt/lists/*; \
    if [ ! -e /usr/local/bin/php ]; then ln -s /usr/bin/php /usr/local/bin/php; fi; \
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
