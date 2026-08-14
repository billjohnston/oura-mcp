# syntax=docker/dockerfile:1
ARG NODE_VERSION=22

# --- Build ------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilds, but fall back to compiling if none matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential \
 && rm -rf /var/lib/apt/lists/* \
 && npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# --- Runtime ----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runner

# curl drives the healthcheck below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential \
 && npm ci --omit=dev \
 && apt-get purge -y python3 build-essential \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /root/.npm
COPY --from=builder /app/dist ./dist

# HOME points at the volume so the optional SQLite cache and any local config
# land on persistent storage rather than the container's ephemeral layer.
ENV HOME=/data \
    OURA_MCP_TRANSPORT=http \
    OURA_MCP_HOST=0.0.0.0 \
    PORT=3000 \
    TOKENS_PATH=/data/oauth-tokens.json \
    NODE_ENV=production

# Holds the OAuth access-token store and, if enabled, the Oura response cache.
VOLUME ["/data"]
EXPOSE 3000

# Podman fires the first healthcheck within ~100ms of container start, well before
# node has bound the port. It records that as health_status=starting, but the
# transient systemd unit wrapping the check still exits non-zero, which is enough
# to make `nixos-rebuild switch` report a failed unit and return exit 4.
# --retry-connrefused rides out the startup window (and --retry also covers 5xx),
# so the check only reports failure when the server is genuinely unhealthy.
HEALTHCHECK --interval=60s --timeout=15s --start-period=20s --retries=3 \
  CMD curl -fsS --retry 5 --retry-connrefused --retry-delay 1 \
      "http://localhost:${PORT}/health" || exit 1

# No argv: runCliCommand() runs before transport selection, so a stray argument
# would make the process print CLI output and exit instead of serving.
CMD ["node", "dist/index.js"]
