# Minsky MCP Server image — serves the MCP tool registry over HTTP.
#
# Built from repo root because the MCP server needs the full Minsky source
# tree. Runs `minsky mcp start --http ...` by default; override CMD in Railway
# or docker-run to change the invocation.
#
# See docs/deploy-minsky-railway.md for deployment specifics (env vars, auth).

FROM oven/bun:1.2-slim AS base

WORKDIR /app

# Dependency layer — cached unless package.json/bun.lock changes.
COPY package.json bun.lock ./

# Workspace package manifests (mt#1681 / mt#1722 / mt#1727): bun install needs
# the full workspace tree visible to validate --frozen-lockfile consistency.
# packages/shared is a direct dep of root; services/reviewer is NOT used by
# minsky-mcp at runtime but its manifest must be present so bun's workspace
# install computes the same tree as the committed lockfile.
COPY packages/shared/package.json ./packages/shared/package.json
COPY services/reviewer/package.json ./services/reviewer/package.json

RUN bun install --frozen-lockfile

# Source layer.
COPY . .

# Default HTTP port. Railway injects $PORT at runtime; MCP server reads it
# via the --port CLI flag (see CMD below).
ENV PORT=3000
EXPOSE 3000

# Profile B (Railway HTTP): build the bundle at image-build time.
# This bypasses the bin entry entirely — the bin entry is for source installs
# (Profile A/C) only. Direct bundle exec avoids the freshness-check overhead
# and the need for git at runtime.
RUN bun build --target=bun --outfile=dist/minsky.js src/cli.ts

# Default: start MCP over HTTP with auth required. The MINSKY_MCP_AUTH_TOKEN
# env var must be set for this to succeed. $PORT expands at container start
# via the shell form.
CMD bun run dist/minsky.js mcp start --http --host 0.0.0.0 --port $PORT --require-auth
