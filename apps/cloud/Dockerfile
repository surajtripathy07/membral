# Self-hosted Membral cloud app (W7 7.1). Build from the repo root:
#   docker build -f apps/cloud/Dockerfile -t membral-cloud:dev .
#
# NEXT_PUBLIC_* values are inlined by `next build`, so the image is built with
# sentinel values and docker/entrypoint.sh swaps in the real ones at container
# start. Runtime env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
# NEXT_PUBLIC_APP_URL, SUPABASE_SERVICE_ROLE_KEY, optional SUPABASE_INTERNAL_URL.
# SQL migrations ship read-only at /app/migrations.

ARG NODE_IMAGE=node:20-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
# Dependencies first, keyed on the manifests and lockfile only, so a source
# change reuses this layer.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/extension/package.json packages/extension/
COPY packages/test-kit/package.json packages/test-kit/
COPY apps/cloud/package.json apps/cloud/
# The lockfile records only some platform builds of Tailwind's native binding
# (npm/cli#4828), so fetch the one for this platform when npm ci skipped it.
RUN set -e; \
    npx -y npm@11.19.0 ci --no-audit --no-fund --ignore-scripts; \
    pkg="@tailwindcss/oxide-linux-$(node -p process.arch)-gnu"; \
    if [ ! -d "node_modules/${pkg}" ]; then \
      v="$(node -p "require('./node_modules/@tailwindcss/oxide/package.json').version")"; \
      (cd /tmp && npm pack --silent "${pkg}@${v}" >/dev/null); \
      mkdir -p "node_modules/${pkg}"; \
      tar -xzf /tmp/tailwindcss-oxide-linux-*.tgz --strip-components=1 -C "node_modules/${pkg}"; \
    fi; \
    rm -rf /root/.npm /tmp/*

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=3072 \
    MEMBRAL_STANDALONE=1 \
    NEXT_PUBLIC_SUPABASE_URL=http://membral-sentinel-supabase-url.invalid \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=membral-sentinel-anon-key \
    NEXT_PUBLIC_APP_URL=http://membral-sentinel-app-url.invalid
COPY . .
# next build type-checks the whole app, golden harnesses included, which import
# the dist types of these workspaces (turbo's ^build does the same).
RUN npm run build --workspace=@membral/core \
    && npm run build --workspace=@membral/test-kit \
    && npm run build --workspace=@membral/cli \
    && cd apps/cloud && npx next build \
    && rm -rf .next/cache

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
# The image carries no Claude Code. With MEMBRAL_LLM_PROVIDER=claude-code the
# entrypoint downloads the version pinned in docker/claude-cli/package-lock.json
# from npm into the /claude-cli volume on first start (docker/claude-cli/install.sh).
# /claude-cli is created here so a fresh named volume mounted on it is owned by node.
RUN mkdir -p /claude-cli && chown node:node /claude-cli
COPY --from=build --chown=node:node /repo/apps/cloud/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/cloud/.next/static ./apps/cloud/.next/static
COPY --from=build --chown=node:node /repo/apps/cloud/public ./apps/cloud/public
COPY apps/cloud/supabase/migrations /app/migrations
COPY apps/cloud/docker/entrypoint.sh /usr/local/bin/membral-entrypoint
COPY apps/cloud/docker/substitute-env.mjs /app/docker/substitute-env.mjs
COPY apps/cloud/docker/claude-cli/package.json apps/cloud/docker/claude-cli/package-lock.json apps/cloud/docker/claude-cli/install.sh /app/docker/claude-cli/
USER node
EXPOSE 3000
ENTRYPOINT ["membral-entrypoint"]
CMD ["node", "apps/cloud/server.js"]
