FROM oven/bun:1.2-slim AS base

WORKDIR /app

# Build context is the repo root (Railway service `source.rootDirectory: ""`),
# so we can pull in the workspace shared package alongside the reviewer
# service. See mt#1681 — moved from `services/reviewer/` build context to
# repo root to support the @minsky/shared workspace dep.

# Workspace manifest + lockfile.
COPY package.json bun.lock ./

# Package manifests for the workspaces this service needs to resolve.
# Listing only manifests (not src) keeps this layer cacheable until a
# package.json changes.
COPY packages/shared/package.json ./packages/shared/package.json
COPY services/reviewer/package.json ./services/reviewer/package.json

# Hoist deps via the root workspace install. `--production` skips dev deps,
# `--frozen-lockfile` enforces lockfile fidelity, `--ignore-scripts` skips
# the root `prepare: husky` and any other install hooks (none of which need
# to run inside the production container — husky is a dev-only git-hooks
# helper and is not present in --production deps anyway).
RUN bun install --frozen-lockfile --production --ignore-scripts

# Source for the workspace shared package and the reviewer service.
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/tsconfig.json
COPY services/reviewer/src ./services/reviewer/src
COPY services/reviewer/migrations ./services/reviewer/migrations
COPY services/reviewer/tsconfig.json ./services/reviewer/tsconfig.json

# Railway provides PORT; we default to 3000 for local.
ENV PORT=3000
EXPOSE 3000

# Bun runs TypeScript directly; no separate build step needed.
CMD ["bun", "run", "services/reviewer/src/server.ts"]
