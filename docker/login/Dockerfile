# Builds the login service (a separate, private repository) into /login for
# the corporate image to copy. Built FROM the gpt web base so composer runs on
# the same PHP as production. Build with the login checkout as context:
#   docker build -t gpt-login-src:latest -f docker/login/Dockerfile "$GPT_LOGIN_SRC"
FROM gpt-web-base:latest
WORKDIR /login
COPY . .
# The checkout may hold a developer's real .env and git history: never ship them.
# (.superpowers/ is local planning scratch and the phpunit cache a test artefact.)
RUN rm -rf .git .superpowers backend/vendor backend/.env backend/.env.bak* \
        backend/.phpunit.result.cache \
 && cd backend && composer install --no-dev --optimize-autoloader --no-interaction
