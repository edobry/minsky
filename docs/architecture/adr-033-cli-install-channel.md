# ADR-033: Install channel for the Minsky CLI

**Status:** Proposed (principal decision pending — routed via ask, mt#3578)
**Date:** 2026-08-03
**Task:** mt#3578

## Decision

**Distribute the Minsky CLI as a published npm-registry package installed via `bun add -g minsky`, with the existing `dist/` bundle + adjacent-assets layout as the shipped artifact.** The tag-triggered compiled-binary release workflow (`release.yml`, 5-platform `bun build --compile` matrix) stays as a secondary artifact and is NOT the supported install channel until its asset story is built. Homebrew is deferred; if added later it wraps the decided channel rather than introducing a new layout.

Consequences, one line each:

- A user installs with `bun add -g minsky` (Bun is a stated prerequisite); `minsky init` then provisions working hooks — verified by the cold-start smoke this ADR ships with.
- The npm package name `minsky` must be claimed (verified unclaimed on the npm registry 2026-08-03 — a 404 from `npm view minsky`); until claimed it is squattable.
- Publishing requires npm account/token provisioning and a versioning source — mt#233 (conventional-commit version bump) becomes the version supplier for the publish step.
- The compiled binaries `release.yml` already publishes carry NO runtime assets (no migrations, no hook sources) and would fail loudly on first `init` or `persistence migrate`; they are demoted to "experimental artifact" until an embedding design exists.
- The cockpit web SPA does not ship in the package (it resolves via a source-checkout walk); packaged installs have no cockpit UI until the follow-up task closes that gap.

Accepting this ADR = agreeing the npm/bun global package is the supported way Minsky reaches a user's machine, and that binary + Homebrew channels are explicitly deferred, not implicitly promised.

## Context

Until mt#3578 there was no decision — and no task — covering how Minsky is installed on a machine that is not the dev checkout. The working install is a symlink from `~/.bun/install/global/node_modules/minsky` to the source checkout; everything downstream quietly assumed it.

The condition is load-bearing because the runtime must reach non-JS assets at execution time, and each asset class needs a resolution path that survives packaging. The repo already contains the template — the mt#1767 / beyond-Minsky RFC Phase 0 triad, applied to migrations: the bundler EMITS the assets next to the bundle (`build:copy-migrations`), an ordered-candidate resolver finds them (`resolvePgMigrationsFolder()`), and a cold-start CI test proves it from outside the checkout (`cold-start-migrate.yml`).

### Asset inventory (mt#3578 success criterion)

Every non-JS file the runtime must reach at execution time, swept 2026-08-03 (`import.meta.url` / `__dirname`-relative reads across `src/` and `packages/`):

| Asset                                                                              | Resolver                                                                        | Bundled-layout emission                                | Status                                                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Postgres migrations (`storage/migrations/pg/**`: SQL, journal, bootstrap snapshot) | `resolvePgMigrationsFolder()` — 2 candidates + env override                     | `build:copy-migrations` → `dist/storage/migrations/pg` | Solved (mt#1767/mt#2369/mt#2439)                                                           |
| Observability-baseline hook sources (3 files from `.claude/hooks/`)                | `resolveHookSourceDir()` (mt#3499) — 2 candidates + env override                | `build:copy-hooks` → `dist/hooks` (THIS task)          | Solved by mt#3578                                                                          |
| Cockpit web SPA (`src/cockpit/web/dist`)                                           | `findRepoRoot()` walk requiring a literal `src/cockpit/web` directory (mt#2283) | none — source-checkout-bound                           | OPEN gap — packaged installs cannot serve the cockpit UI (follow-up task filed by mt#3578) |
| Completion manifest (`src/generated/completion-manifest.json`)                     | static `import ... with { type: "json" }` — bundled into `dist/minsky.js`       | n/a                                                    | No runtime resolution needed                                                               |
| Init rule/config templates                                                         | generated from TypeScript code, bundled                                         | n/a                                                    | No runtime resolution needed                                                               |

Skills/agents under `.claude/` are repo-development artifacts, not runtime assets of the installed CLI; their distribution is mt#1064's question, out of scope here.

### Prior art already in the repo

- **`scripts/cli-entry.ts` (mt#1740, from the mt#1720 RFC)** already models four install profiles and explicitly implements **Profile D — published npm install (no `src/` present)**: the `bin` entry imports `dist/minsky.js` when no source tree exists. `package.json` already carries the publish-shaped `bin` and `files` fields (`dist/`, `scripts/cli-entry.ts`, no source). The npm channel is thus the one this codebase has been implicitly building toward; this ADR makes it the recorded decision instead of an unexercised code path.
- **`release.yml` + `justfile`** already cross-compile 5 platform binaries per `v*` tag and attach them to GitHub releases (mt#233 refresh, 2026-07-16). Those binaries embed nothing: `bun build --compile` only ships what is imported, and neither `build:copy-migrations` nor `build:copy-hooks` runs on that path — so a released binary fails migrations resolution and hook provisioning by construction.

## Rationale

1. **Bun is a target-machine prerequisite regardless of channel.** The provisioned hooks carry `#!/usr/bin/env bun` shebangs and are executed by the harness as standalone Bun scripts; sessions and the test-runner also assume Bun. The single-file binary's headline advantage — no runtime dependency — therefore does not hold for Minsky's product surface today. Requiring `bun add -g` adds no prerequisite that the product doesn't already impose.
2. **The npm layout preserves the already-shipped resolver contract.** A global npm/bun install materializes the package directory verbatim: `node_modules/minsky/dist/minsky.js` with `dist/hooks` and `dist/storage/migrations` beside it — exactly the bundled-layout candidate both resolvers try first. No new resolution mechanism is needed; the cold-start smoke in this PR proves the whole chain.
3. **The binary channel needs real design work before it is honest to offer.** Authoritative-source check (gate l): Bun's single-file-executable docs (bun.com/docs/bundler/executables, read 2026-08-03) document embedding assets via `with { type: "file" }` imports, `Bun.embeddedFiles`, and an `--asset` flag for directory trees under a `/$bunfs/` virtual path. Hook sources must ultimately exist as REAL files the harness can execute by path, so a binary channel needs an extract-on-first-run step on top of embedding — a design, not a flag. Deviation from "just ship the binary" is deliberate and recorded here.
4. **Name availability is a fact, not an assumption.** `npm view minsky` returned 404 (unclaimed) on 2026-08-03. Claiming it is cheap now and may not be later.

## Alternatives considered

- **Compiled single binary as primary (adopt release.yml as the channel).** Rejected for now: asset embedding + extraction design required (see Rationale 3), and it duplicates the Bun prerequisite anyway. The matrix build stays as an experimental artifact; promoting it later is an amendment to this ADR, not a contradiction.
- **Homebrew formula as primary.** Deferred: a formula wraps whichever artifact exists; choosing it first would still require deciding the artifact. Add-on channel candidate after the npm channel is live.
- **"Install = git clone" (status quo, documented).** Rejected: it conflates the dev environment with the product install, forecloses non-developer users, and leaves every provisioning decision resting on an accident.

## External preconditions (gate n enumeration)

Not provisioned today; each is a blocking precondition for EXECUTING this decision (none blocks accepting it):

1. **npm account/organization + publish token** — owner: principal (vendor commitment). Not provisioned as of 2026-08-03.
2. **Claim of the `minsky` package name** — follows from (1); verified available 2026-08-03.
3. **Version source** — `package.json` has no `version` field and `src/cli.ts` hardcodes `1.0.0`; mt#233 (TODO) owns the conventional-commit bump + `v*` tag automation the publish step would consume.
4. **Publish automation** — a `release.yml` job addition (or sibling workflow) running `npm publish`/`bun publish` on the version tag; owned by the implementation follow-up once this ADR is accepted.

## Relationship to the hosted/self-host fork

This ADR decides the **local CLI install channel only**. The hosted deployment path — the Railway image (mt#1677, cli-entry "Profile B", which builds the bundle at image-build time and never uses an install channel) and the harness-host program (mem#524) — is a separate distribution question, deliberately untouched here.

## Cross-references

mt#3578 (this decision + asset inventory + cold-start test) · mt#3499 (hook provisioning + resolver) · mt#1767/mt#2369/mt#2439 (migrations triad precedent) · mt#1740/mt#1720 (bin-entry install profiles) · mt#233 (release version automation — coordinate) · mt#2201 (tray app distribution — orthogonal artifact) · mt#1064 (skill distribution — adjacent asset class) · mem#340 (progressive adoption T0 presumes an install channel).
