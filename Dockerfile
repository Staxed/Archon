# =============================================================================
# Archon - Remote Agentic Coding Platform
# Multi-stage build: deps → web build → production image
# =============================================================================

ARG BUN_VERSION=1.4.2

# ---------------------------------------------------------------------------
# Stage 1: Install dependencies
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS deps

WORKDIR /app

# Copy root package files and lockfile
COPY package.json bun.lock ./

# Copy ALL workspace package.json files (monorepo lockfile depends on all of them)
COPY packages/adapters/package.json ./packages/adapters/
COPY packages/cli/package.json ./packages/cli/
COPY packages/core/package.json ./packages/core/
# docs-web source is NOT copied — it's a static site deployed separately
# (see .github/workflows/deploy-docs.yml). package.json is included only
# so Bun's workspace lockfile resolves correctly.
COPY packages/docs-web/package.json ./packages/docs-web/
COPY packages/forge/package.json ./packages/forge/
COPY packages/git/package.json ./packages/git/
COPY packages/isolation/package.json ./packages/isolation/
COPY packages/paths/package.json ./packages/paths/
COPY packages/plugin-manifest/package.json ./packages/plugin-manifest/
COPY packages/providers/package.json ./packages/providers/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/workflows/package.json ./packages/workflows/

# Install ALL dependencies (including devDependencies needed for web build)
# --linker=hoisted: Bun's default "isolated" linker stores packages in
# node_modules/.bun/ with symlinks that Vite/Rollup cannot resolve during
# production builds. Hoisted layout gives classic flat node_modules.
RUN bun install --frozen-lockfile --linker=hoisted

# ---------------------------------------------------------------------------
# Stage 2: Build web UI (Vite + React)
# ---------------------------------------------------------------------------
FROM deps AS web-build

# Copy full source (needed for workspace resolution and web build)
COPY . .

# Build the web frontend — output goes to packages/web/dist/
RUN bun run build:web && \
    test -f packages/web/dist/index.html || \
    (echo "ERROR: Web build produced no index.html" >&2 && exit 1)

# ---------------------------------------------------------------------------
# Stage 3: Production image
# ---------------------------------------------------------------------------
ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION}-slim AS production

# OCI Labels for GHCR
LABEL org.opencontainers.image.source="https://github.com/coleam00/Archon"
LABEL org.opencontainers.image.description="Control AI coding assistants remotely from Telegram, Slack, Discord, and GitHub"
LABEL org.opencontainers.image.licenses="MIT"

# Prevent interactive prompts during installation
ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Install system dependencies + gosu for privilege dropping in entrypoint
RUN apt-get update && apt-get install -y \
    curl \
    git \
    bash \
    ca-certificates \
    gnupg \
    gosu \
    postgresql-client \
    # ripgrep + jq: expected by Claude Code / Codex agents (rg is their default
    # code-search tool; jq powers JSON handling in bash workflow nodes) — see #1836
    ripgrep \
    jq \
    # python3: runs the Jev shadow judge (stixed's jev_guard.py, mounted read-only
    # from the host's root-owned promoted copy; standard library only). Named here
    # rather than relied on as a dependency of another package.
    python3 \
    # Chromium for agent-browser E2E testing (drives browser via CDP)
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install agent-browser CLI (Vercel Labs) for E2E testing workflows
# - Uses npm (not bun) because postinstall script downloads the native Rust binary
# - After install, symlink the Rust binary directly and purge nodejs/npm (~60MB saved)
# - The npm entry point is a Node.js wrapper; the native binary works standalone
# - agent-browser auto-detects Docker (via /.dockerenv) and adds --no-sandbox to Chromium
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
    && npm install -g agent-browser@0.22.1 \
    && NATIVE_BIN=$(find /usr/local/lib/node_modules/agent-browser -name 'agent-browser-*' -type f -executable 2>/dev/null | head -1) \
    && if [ -n "$NATIVE_BIN" ]; then \
         cp "$NATIVE_BIN" /usr/local/bin/agent-browser-native \
         && chmod +x /usr/local/bin/agent-browser-native \
         && ln -sf /usr/local/bin/agent-browser-native /usr/local/bin/agent-browser; \
       else \
         echo "ERROR: agent-browser native binary not found after npm install" >&2 && exit 1; \
       fi \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/agent-browser \
    && apt-get purge -y nodejs npm \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Point agent-browser to system Chromium (avoids ~400MB Chrome for Testing download)
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

# Node 22 with npm and pnpm, for the projects' own validation (lint, build, tests):
# the base image's `node` is only Bun's fallback shim, and Next.js projects
# (af-website on pnpm; devsite, OmnisView, forumone on npm) need the real one.
# Copied from the official image, after the agent-browser step purges apt's nodejs.
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm install -g pnpm@10 \
    && npm cache clean --force \
    && node --version && npm --version && pnpm --version

# CLAUDE_BIN_PATH is set at container startup (docker-entrypoint.sh).
# The entrypoint pins the glibc variant to bypass the SDK's musl-first resolver.

# Create non-root user for running Claude Code
# Claude Code refuses to run with --dangerously-skip-permissions as root for security
# /app is still empty here (only WORKDIR created it) — non-recursive chown suffices.
RUN useradd -m -u 1001 -s /bin/bash appuser \
    && chown appuser:appuser /app

# Create Archon directories
RUN mkdir -p /.archon/workspaces /.archon/worktrees \
    && chown -R appuser:appuser /.archon

# A trailing `RUN chown -R /app` would duplicate every inode into a new image layer (#1970).
USER appuser

# Copy root package files and lockfile
COPY --chown=appuser:appuser package.json bun.lock ./

# Copy ALL workspace package.json files
COPY --chown=appuser:appuser packages/adapters/package.json ./packages/adapters/
COPY --chown=appuser:appuser packages/cli/package.json ./packages/cli/
COPY --chown=appuser:appuser packages/core/package.json ./packages/core/
# docs-web source is NOT copied — it's a static site deployed separately
# (see .github/workflows/deploy-docs.yml). package.json is included only
# so Bun's workspace lockfile resolves correctly.
COPY --chown=appuser:appuser packages/docs-web/package.json ./packages/docs-web/
COPY --chown=appuser:appuser packages/forge/package.json ./packages/forge/
COPY --chown=appuser:appuser packages/git/package.json ./packages/git/
COPY --chown=appuser:appuser packages/isolation/package.json ./packages/isolation/
COPY --chown=appuser:appuser packages/paths/package.json ./packages/paths/
COPY --chown=appuser:appuser packages/plugin-manifest/package.json ./packages/plugin-manifest/
COPY --chown=appuser:appuser packages/providers/package.json ./packages/providers/
COPY --chown=appuser:appuser packages/server/package.json ./packages/server/
COPY --chown=appuser:appuser packages/web/package.json ./packages/web/
COPY --chown=appuser:appuser packages/workflows/package.json ./packages/workflows/

# Install production dependencies only (--ignore-scripts skips husky prepare hook).
# Cache goes to /tmp and is removed in the same layer: not baked into the image,
# not copied into the /home/appuser volume on first run.
RUN HOME=/home/appuser BUN_INSTALL_CACHE_DIR=/tmp/bun-install-cache \
      bun install --frozen-lockfile --production --ignore-scripts --linker=hoisted \
    && rm -rf /tmp/bun-install-cache

# Copy application source (Bun runs TypeScript directly, no compile step needed)
COPY --chown=appuser:appuser packages/adapters/ ./packages/adapters/
COPY --chown=appuser:appuser packages/cli/ ./packages/cli/
COPY --chown=appuser:appuser packages/core/ ./packages/core/
COPY --chown=appuser:appuser packages/forge/ ./packages/forge/
COPY --chown=appuser:appuser packages/git/ ./packages/git/
COPY --chown=appuser:appuser packages/isolation/ ./packages/isolation/
COPY --chown=appuser:appuser packages/paths/ ./packages/paths/
COPY --chown=appuser:appuser packages/plugin-manifest/ ./packages/plugin-manifest/
COPY --chown=appuser:appuser packages/providers/ ./packages/providers/
COPY --chown=appuser:appuser packages/server/ ./packages/server/
COPY --chown=appuser:appuser packages/workflows/ ./packages/workflows/

# Copy pre-built web UI from build stage
COPY --from=web-build --chown=appuser:appuser /app/packages/web/dist/ ./packages/web/dist/

# Copy config, migrations, and bundled defaults
COPY --chown=appuser:appuser .archon/ ./.archon/
COPY --chown=appuser:appuser migrations/ ./migrations/
# Fork: Pi gateway provider definitions (FORK.md); ARCHON_PI_MODELS_PATH points here.
COPY --chown=appuser:appuser deploy/pi/ ./deploy/pi/
COPY --chown=appuser:appuser tsconfig*.json ./

# Back to root: the entrypoint must start as root to fix volume ownership,
# and the gosu git-config setup below requires it.
USER root

# Create .codex directory for Codex authentication
RUN mkdir -p /home/appuser/.codex && chown appuser:appuser /home/appuser/.codex
# Local deployment runs the app as 1000:1000 (bun, HOME=/home/bun) with the
# archon_codex_home volume on /home/bun/.codex: a new named volume takes this
# folder's owner, so it exists here owned by bun or `codex login` can't write it.
RUN mkdir -p /home/bun/.codex && chown bun:bun /home/bun/.codex

# Codex CLI on PATH: the same native binary @openai/codex-sdk spawns (installed
# with the production deps above), so a `codex login --device-auth` run in the
# container writes the login Archon's Codex nodes use, and a dependency bump
# moves both together. Fails the build if the SDK's binary is missing.
RUN CODEX_BIN="$(ls /app/node_modules/@openai/codex-linux-*/vendor/*/bin/codex 2>/dev/null | head -n 1)" \
    && [ -n "$CODEX_BIN" ] \
    && ln -sf "$CODEX_BIN" /usr/local/bin/codex \
    && codex --version

# Grok CLI for Grok nodes (fork provider), pinned by version and checksum; bump both
# together (the checksum is the binary at https://x.ai/cli/grok-<version>-linux-x86_64).
# ARCHON_GROK_EXECUTABLE points the provider here, so its login can live in its own
# volume on /home/bun/.grok (`grok login` in the container, like Codex's).
ARG GROK_VERSION=1.0.41
ARG GROK_SHA256=9ce03ed23e16ea01072b4496263d6213a27899e1e3e107f008d36edf82e70407
RUN [ "$(uname -m)" = "x86_64" ] \
    && curl -fsSL "https://x.ai/cli/grok-${GROK_VERSION}-linux-x86_64" -o /usr/local/bin/grok \
    && echo "${GROK_SHA256}  /usr/local/bin/grok" | sha256sum -c - \
    && chmod 755 /usr/local/bin/grok \
    && mkdir -p /home/bun/.grok && chown bun:bun /home/bun/.grok
ENV ARCHON_GROK_EXECUTABLE=/usr/local/bin/grok

# `archon` on PATH: the CLI for `docker exec` (Stixed's `stixctl archon` runs it here).
# docker exec skips docker-entrypoint.sh, so this sets what the entrypoint exports for
# the server (CLAUDE_BIN_PATH), and refuses without DATABASE_URL: on SQLite the CLI
# would open and migrate a fork-era ~/.archon/archon.db.
RUN printf '%s\n' \
    '#!/bin/sh' \
    'if [ -z "${DATABASE_URL:-}" ]; then echo "archon: refused, no DATABASE_URL in this environment" >&2; exit 1; fi' \
    'case "$(uname -m)" in' \
    '  x86_64) _b=/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude ;;' \
    '  aarch64) _b=/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude ;;' \
    'esac' \
    'if [ -z "${CLAUDE_BIN_PATH:-}" ] && [ -x "${_b:-}" ]; then export CLAUDE_BIN_PATH="$_b"; fi' \
    'exec bun /app/packages/cli/src/cli.ts "$@"' \
    > /usr/local/bin/archon \
    && chmod 755 /usr/local/bin/archon

# Configure git to trust Archon directories (as appuser)
RUN gosu appuser git config --global --add safe.directory '/.archon/workspaces' && \
    gosu appuser git config --global --add safe.directory '/.archon/workspaces/*' && \
    gosu appuser git config --global --add safe.directory '/.archon/worktrees' && \
    gosu appuser git config --global --add safe.directory '/.archon/worktrees/*'

# Copy entrypoint script (fixes volume permissions, drops to appuser)
# sed strips Windows CRLF in case .gitattributes eol=lf was bypassed
COPY docker-entrypoint.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

# Default port (matches .env.example PORT=3000)
EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
