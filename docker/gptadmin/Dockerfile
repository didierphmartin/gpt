# Builds gpt_admin (a separate, private repository) into a dist/ that the
# corporate image copies out. Lives here rather than in gpt_admin so that repo
# needs no changes; `docker build -f` allows a Dockerfile outside the context.
#
# Build with gpt_admin's own directory as the context, e.g.:
#   docker build -t gpt-admin-dist:latest -f docker/gptadmin/Dockerfile "$GPT_ADMIN_SRC"
FROM node:20-bookworm-slim
WORKDIR /admin
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# base: './' in its vite config means the bundle works from any URL path, which
# is what lets it be served at /gpt_admin/ beside gpt at /gpt/.
RUN npm run build          # "tsc -b && vite build" -> /admin/dist
