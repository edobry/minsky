# Minsky MCP Server image — serves the MCP tool registry over HTTP.
#
# Built from repo root because the MCP server needs the full Minsky source
# tree. Runs `minsky mcp start --http ...` by default; override CMD in Railway
# or docker-run to change the invocation.
#
# See docs/deploy-minsky-railway.md for deployment specifics (env vars, auth).

# Base-image digest pin (mt#1726). The mutable `oven/bun:1.2-slim` tag is
# pinned to a content-addressed digest so the build is reproducible and so
# image-tag drift cannot silently alter the runtime bun version. The pin
# itself is the safety measure — without it, a `docker pull` weeks from now
# could surface a different bun version against the same lockfile.
#
# To rotate the digest (only when intentionally adopting a newer bun): run
# `docker pull oven/bun:1.2-slim`, copy the `Digest:` line it prints,
# replace the `@sha256:...` suffix below, verify locally that
# `bun install --frozen-lockfile --production --ignore-scripts` still
# succeeds against the committed lockfile, commit, let Railway rebuild.
FROM oven/bun:1.2-slim@sha256:9654aa08d4b7e778b84148921bab8edc1409c8d0a85707b8c801dd7cf1878971 AS base

WORKDIR /app

# Dependency layer — cached unless package.json/bun.lock changes.
COPY package.json bun.lock ./

# Workspace package manifests (mt#1681 / mt#1722 / mt#1727 / mt#1977). The
# root declares `workspaces: ["packages/*", "services/*"]`, and bun's
# `--frozen-lockfile` install rejects any divergence between the workspace
# topology in the build context and the committed lockfile.
#
# **Invariant (mt#1977):** every directory matched by the workspaces glob in
# root `package.json` MUST have its `package.json` explicitly COPYed below
# before the `RUN bun install --frozen-lockfile` step. Otherwise bun walks
# the glob, finds workspace entries in the lockfile that aren't present in
# the build context, and aborts with:
#   `error: lockfile had changes, but lockfile is frozen`
# The local `bun install` succeeds because the full repo is mounted; the
# Railway build fails because COPY is selective. Sync this list whenever a
# new workspace is added under `packages/` or `services/`.
#
# Notes on individual entries:
# - `packages/shared` is a direct dep of root.
# - `services/reviewer` is NOT used by minsky-mcp at runtime but its
#   manifest must be present so bun's workspace install computes the same
#   tree as the lockfile.
# - `services/site` is the marketing site (mt#1934); same rationale as
#   reviewer — manifest required by the workspace install, but the runtime
#   image does not ship its source (selective COPY below excludes it).
COPY packages/shared/package.json ./packages/shared/package.json
COPY services/reviewer/package.json ./services/reviewer/package.json
COPY services/site/package.json ./services/site/package.json

# Hoist deps via the root workspace install (mt#1726).
#
# - `--frozen-lockfile`: enforces lockfile fidelity. Build fails on drift.
# - `--production`: skips dev deps. Verified by grep that no runtime import
#   from `src/cli.ts mcp start --http` reaches commander, ts-morph, eslint,
#   prettier, vite/tailwind, husky, lint-staged, testcontainers, or the
#   other 22 devDependencies. Each was checked explicitly.
# - `--ignore-scripts`: skips package.json's `prepare: husky` install
#   hook, which installs git-hook stubs. No .git in the image
#   (`.git` is .dockerignore'd), so husky would no-op-with-warning at
#   best, error at worst. (A `postinstall: npx skills experimental_install`
#   hook was also previously skipped here; retired in mt#1902.)
#
# Mirrors `services/reviewer/Dockerfile:24` which uses the same flag set
# and ships to production without issue.
RUN bun install --frozen-lockfile --production --ignore-scripts

# Source layer — selective COPY (mt#1726). Replaces the prior blanket
# `COPY . .` which pulled in tests, docs, scripts, eslint configuration,
# and unrelated service trees. Order: stable files (tsconfig, shared
# sources) first, main src/ tree last because it changes most often.
#
# Invariants on what is INTENTIONALLY omitted (verified at PR-creation):
# - `bunfig.toml` (root) contains only `[test]` config — irrelevant to
#   `bun run src/cli.ts mcp start --http`. Bun does not read it at runtime
#   for a `bun run <file>` invocation.
# - `packages/shared/` contains only `package.json`, `tsconfig.json`, and
#   TypeScript sources under `src/` (verified by `find packages/shared
#   -type f`). No build artifacts, JSON data, or non-TS assets — so the
#   `package.json` (in the deps layer) + `tsconfig.json` + `src/` copy
#   here is the complete runtime dependency set for `@minsky/shared`.
# - `.git/` is excluded by `.dockerignore`. The MCP server reads its repo
#   backend from `.minsky/config.yaml` (copied below), not from a git
#   remote — without that file the container exits with
#   `git remote get-url: command not found` at boot.
COPY tsconfig.json ./tsconfig.json
COPY packages/shared/tsconfig.json ./packages/shared/tsconfig.json
COPY packages/shared/src ./packages/shared/src
COPY .minsky/config.yaml ./.minsky/config.yaml
COPY src ./src

# Default HTTP port. Railway injects $PORT at runtime; MCP server reads it
# via the --port CLI flag (see CMD below).
ENV PORT=3000
EXPOSE 3000

# Profile B (Railway HTTP): build the bundle at image-build time.
# This bypasses the bin entry entirely — the bin entry is for source installs
# (Profile A/C) only. Direct bundle exec avoids the freshness-check overhead
# and the need for git at runtime.
RUN bun build --target=bun --outfile=dist/minsky.js src/cli.ts

# mt#1767 — copy Drizzle migrations next to the bundle so the bundled
# `postgres-provider.ts`'s `resolveMigrationsFolder()` can find them via the
# `./storage/migrations/pg` candidate (relative to `import.meta.url` of
# `dist/minsky.js` = `/app/dist/storage/migrations/pg/`).
#
# Without this COPY, mt#1763's auto-migrate path crashed Railway in a boot
# loop on 2026-05-12 because the source-relative path `../../storage/...`
# resolved outside `/app`. mt#1787's bundle-boot-smoke CI gate now catches
# any future regression of this exact class at PR time before merge.
RUN mkdir -p dist/storage/migrations && cp -r src/domain/storage/migrations/pg dist/storage/migrations/pg

# Default: start MCP over HTTP with auth required. The MINSKY_MCP_AUTH_TOKEN
# env var must be set for this to succeed. $PORT expands at container start
# via the shell form.
CMD bun run dist/minsky.js mcp start --http --host 0.0.0.0 --port $PORT --require-auth