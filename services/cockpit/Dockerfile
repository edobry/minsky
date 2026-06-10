# Cockpit preview deploy image (mt#2096).
#
# Build context is the repo root (rootDirectory: "") — same pattern as
# services/reviewer/Dockerfile. The cockpit server imports from src/cockpit/
# and the domain layer, so the full source tree is needed.
#
# Two-stage build: the first stage installs all deps (including Vite) and
# builds the SPA; the second stage installs production deps only and copies
# the pre-built SPA assets.

FROM oven/bun:1.2-slim AS builder

WORKDIR /app

COPY package.json bun.lock ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY services/site/package.json ./services/site/package.json
COPY services/reviewer/package.json ./services/reviewer/package.json
COPY services/cockpit/package.json ./services/cockpit/package.json

# Full install (with devDependencies) — Vite is a devDep needed for the SPA build.
RUN bun install --frozen-lockfile --ignore-scripts

COPY vite.config.ts ./
COPY tailwind.config.ts ./
COPY postcss.config.js ./
# The cockpit SPA imports value code from the workspace domain layer (e.g.
# `snapshotBlocksToConversation` from `@minsky/domain/transcripts/conversation-elements`
# in ConversationView, mt#2374). Rollup must resolve those imports at build
# time, so the domain (and shared) source must be present in the builder — not
# just their package.json. The runtime stage copies these too; keep both in
# sync. (Type-only `@minsky/domain/*/types` imports are erased by esbuild and
# don't need this, but value imports do.) — mt#2409
COPY packages/shared/src ./packages/shared/src
COPY packages/domain/src ./packages/domain/src
COPY src/cockpit/web ./src/cockpit/web

RUN bunx vite build --config vite.config.ts

# ---------------------------------------------------------------------------

FROM oven/bun:1.2-slim AS runtime

WORKDIR /app

COPY package.json bun.lock ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY services/site/package.json ./services/site/package.json
COPY services/reviewer/package.json ./services/reviewer/package.json
COPY services/cockpit/package.json ./services/cockpit/package.json

RUN bun install --frozen-lockfile --production --ignore-scripts

COPY tsconfig.json ./
COPY packages/shared/tsconfig.json ./packages/shared/tsconfig.json
COPY packages/shared/src ./packages/shared/src
COPY packages/domain/tsconfig.json ./packages/domain/tsconfig.json
COPY packages/domain/src ./packages/domain/src
COPY .minsky/config.yaml ./.minsky/config.yaml
COPY src ./src
COPY services/cockpit/src ./services/cockpit/src
COPY services/cockpit/tsconfig.json ./services/cockpit/tsconfig.json

# Copy pre-built SPA assets from the builder stage.
COPY --from=builder /app/src/cockpit/web/dist ./src/cockpit/web/dist

ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "services/cockpit/src/server.ts"]