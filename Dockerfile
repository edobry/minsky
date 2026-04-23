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
RUN bun install --frozen-lockfile

# Source layer.
COPY . .

# Default HTTP port. Railway injects $PORT at runtime; MCP server reads it
# via the --port CLI flag (see CMD below).
ENV PORT=3000
EXPOSE 3000

# Default: start MCP over HTTP with auth required. The MINSKY_MCP_AUTH_TOKEN
# env var must be set for this to succeed. $PORT expands at container start
# via the shell form.
CMD bun run src/cli.ts mcp start --http --host 0.0.0.0 --port $PORT --require-auth
