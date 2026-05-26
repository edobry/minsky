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
COPY packages/domain/package.json ./packages/domain/package.json
# services/site is also a workspace declared by root package.json. The root
# bun.lock includes its workspace entries, so --frozen-lockfile at line ~24
# requires services/site/package.json in the build context even though the
# reviewer service doesn't consume it at runtime. Omitting it broke 8
# consecutive reviewer deploys 2026-05-20 (~4 hours, mt#1991). The root
# Dockerfile already follows the same pattern (mt#1977 / mt#1984); this
# extends the discipline to the reviewer sub-project Dockerfile. The
# structural follow-up to make mt#1984's pre-commit guard catch this class
# automatically is tracked under mt#1992.
COPY services/site/package.json ./services/site/package.json
COPY services/reviewer/package.json ./services/reviewer/package.json
COPY services/cockpit/package.json ./services/cockpit/package.json

# Hoist deps via the root workspace install. `--production` skips dev deps,
# `--frozen-lockfile` enforces lockfile fidelity, `--ignore-scripts` skips
# the root `prepare: husky` and any other install hooks (none of which need
# to run inside the production container — husky is a dev-only git-hooks
# helper and is not present in --production deps anyway).
RUN bun install --frozen-lockfile --production --ignore-scripts

# Source for workspace packages and the reviewer service.
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/tsconfig.json
COPY packages/domain/src ./packages/domain/src
COPY packages/domain/tsconfig.json ./packages/domain/tsconfig.json
COPY services/reviewer/src ./services/reviewer/src
COPY services/reviewer/migrations ./services/reviewer/migrations
COPY services/reviewer/tsconfig.json ./services/reviewer/tsconfig.json

# Railway provides PORT; we default to 3000 for local.
ENV PORT=3000
EXPOSE 3000

# Bun runs TypeScript directly; no separate build step needed.
CMD ["bun", "run", "services/reviewer/src/server.ts"]