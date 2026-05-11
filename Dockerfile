# Minsky MCP Server image — serves the MCP tool registry over HTTP.
#
# Built from repo root because the MCP server needs the full Minsky source
# tree. Runs `minsky mcp start --http ...` by default; override CMD in Railway
# or docker-run to change the invocation.
#
# See docs/deploy-minsky-railway.md for deployment specifics (env vars, auth).

# Base-image digest pin (mt#1726). The mutable `oven/bun:1.2-slim` tag is
# pinned to a content-addressed digest so the build is reproducible and so
# image-tag drift cannot silently alter the runtime bun version. To rotate
# the digest: run `docker pull oven/bun:1.2-slim`, copy the `Digest:` line
# it prints, replace the `@sha256:...` suffix below, commit, let Railway
# rebuild.
FROM oven/bun:1.2-slim@sha256:9654aa08d4b7e778b84148921bab8edc1409c8d0a85707b8c801dd7cf1878971 AS base

WORKDIR /app

# Dependency layer — cached unless package.json/bun.lock changes.
COPY package.json bun.lock ./

# Workspace package manifests (mt#1681 / mt#1722 / mt#1727). The root declares
# `workspaces: ["packages/*", "services/*"]`, and bun's `--frozen-lockfile`
# install rejects any divergence between the workspace topology in the build
# context and the committed lockfile. packages/shared is a direct dep of
# root; services/reviewer is NOT used by minsky-mcp at runtime but its
# manifest must be present so bun's workspace install computes the same
# tree as the lockfile. See selective COPY below for what actually ships.
COPY packages/shared/package.json ./packages/shared/package.json
COPY services/reviewer/package.json ./services/reviewer/package.json

# Hoist deps via the root workspace install (mt#1726). `--production` skips
# dev deps (smaller image, faster install), `--frozen-lockfile` enforces
# lockfile fidelity, `--ignore-scripts` skips `prepare: husky` and any other
# install hooks — husky is a dev-only git-hooks helper that has no place
# inside a production container. Mirrors `services/reviewer/Dockerfile:24`.
RUN bun install --frozen-lockfile --production --ignore-scripts

# Source layer — selective COPY (mt#1726). Replaces the prior blanket
# `COPY . .` which pulled in tests, docs, scripts, eslint configuration,
# and unrelated service trees. Order: stable files (tsconfig, shared
# sources) first, main src/ tree last because it changes most often.
COPY tsconfig.json ./tsconfig.json
COPY packages/shared/tsconfig.json ./packages/shared/tsconfig.json
COPY packages/shared/src ./packages/shared/src
COPY .minsky/config.yaml ./.minsky/config.yaml
COPY src ./src

# Default HTTP port. Railway injects $PORT at runtime; MCP server reads it
# via the --port CLI flag (see CMD below).
ENV PORT=3000
EXPOSE 3000

# Default: start MCP over HTTP with auth required. The MINSKY_MCP_AUTH_TOKEN
# env var must be set for this to succeed. $PORT expands at container start
# via the shell form.
CMD bun run src/cli.ts mcp start --http --host 0.0.0.0 --port $PORT --require-auth
