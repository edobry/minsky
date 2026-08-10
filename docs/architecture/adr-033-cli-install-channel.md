# ADR-033: Install channel for the Minsky CLI

**Status:** Accepted (ask#6804 answered "(a) npm/bun global package" by the principal, 2026-08-03T21:52Z)
**Date:** 2026-08-03
**Task:** mt#3578 (decision + analysis) · mt#3616 (execution) · mt#3915 (amendment)

> **Amendment, 2026-08-10 — the package name is `@edobry/minsky`, not `minsky`.**
>
> npm **refuses to create** the unscoped name. Verified with a real authenticated `PUT`:
>
> ```
> 403 Forbidden - PUT https://registry.npmjs.org/minsky
> Package name too similar to existing package minify;
> try renaming your package to '@edobry/minsky' and publishing with 'npm publish --access=public'
> ```
>
> Everywhere below that says `bun add -g minsky`, read `bun add -g @edobry/minsky`. **The decision
> itself is unchanged** — npm/bun global package, same `dist/` bundle + adjacent-assets layout,
> binaries and Homebrew still deferred. Only the name moves.
>
> **The CLI command is NOT scoped.** `bin` maps command names independently of package name, so a
> scoped package still installs a plain `minsky`. The user-visible change is one line of install
> documentation; nothing about using the tool differs.
>
> **Correcting this ADR's own reasoning:** the consequence line below reads "verified unclaimed on
> the npm registry 2026-08-03 — a 404 from `npm view minsky`". A 404 does **not** mean a name is
> claimable. `minsky` returned 404 on 2026-08-10 too, and npm still refused it — the similarity
> guard runs at `PUT` time and has no pre-flight endpoint. The only names knowably available in
> advance are scoped ones under a scope you already own.
>
> **The guard is measurably inconsistent, so an appeal stays open.** `minsky`→`minify` is
> Levenshtein distance 2; `mintlify`→`minify` is _also_ distance 2, and `mintlify` exists
> (`GET /mintlify` → 200, `GET /minify` → 200, `GET /minsky` → 404). If npm support grants an
> exception, the unscoped name would be ADDED alongside the scoped one — it would not invalidate
> this amendment.

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

| Asset                                                                              | Resolver                                                                                                            | Bundled-layout emission                                           | Status                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres migrations (`storage/migrations/pg/**`: SQL, journal, bootstrap snapshot) | `resolvePgMigrationsFolder()` — 2 candidates + env override                                                         | `build:copy-migrations` → `dist/storage/migrations/pg`            | Solved (mt#1767/mt#2369/mt#2439)                                                                                                                                                                                                      |
| Observability-baseline hook sources (3 files from `.claude/hooks/`)                | `resolveHookSourceDir()` (mt#3499) — 2 candidates + env override                                                    | `build:copy-hooks` → `dist/hooks` (THIS task)                     | Solved by mt#3578                                                                                                                                                                                                                     |
| Cockpit web SPA (`src/cockpit/web/dist`)                                           | `cockpitWebDistDir()` — bundled candidate (mt#3611) checked before the `findRepoRoot()` dev-checkout walk (mt#2283) | `build:copy-cockpit-web` → `dist/cockpit-web` (THIS row, mt#3611) | Solved by mt#3611 — built SPA measures 1.6M, well under the size threshold that would have required a size-tradeoff ask; cold-start smoke: `scripts/smoke-cold-start-cockpit-web.ts` / `.github/workflows/cold-start-cockpit-web.yml` |
| Completion manifest (`src/generated/completion-manifest.json`)                     | static `import ... with { type: "json" }` — bundled into `dist/minsky.js`                                           | n/a                                                               | No runtime resolution needed                                                                                                                                                                                                          |
| Init rule/config templates                                                         | generated from TypeScript code, bundled                                                                             | n/a                                                               | No runtime resolution needed                                                                                                                                                                                                          |

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

Provisioning state as of mt#3616's execution (2026-08-03):

1. **npm account** — PROVISIONED: principal ran `npm login` (verified `npm whoami` → `edobry`, 2026-08-03T21:57Z). No long-lived publish token is used — see (4).
2. **Claim of the `minsky` package name** — executed by mt#3616's manual first publish (0.1.0).
3. **Version source** — `package.json` now carries `"version"` (added by mt#3616; `src/cli.ts` reads it, retiring the hardcoded `1.0.0`); mt#233 (TODO) owns automating the bump + `v*` tag.
4. **Publish automation** — `.github/workflows/publish-npm.yml` (mt#3616) publishes on `v*` tags via npm **trusted publishing** (OIDC, docs.npmjs.com/trusted-publishers): short-lived workflow-specific credentials, automatic provenance, no `NPM_TOKEN` secret. ONE-TIME OPERATOR STEP still open: register the trusted publisher (repo `edobry/minsky`, workflow `publish-npm.yml`) in the package's npmjs.com settings — until then the workflow fails at the publish step by design.

## Relationship to the hosted/self-host fork

This ADR decides the **local CLI install channel only**. The hosted deployment path — the Railway image (mt#1677, cli-entry "Profile B", which builds the bundle at image-build time and never uses an install channel) and the harness-host program (mem#524) — is a separate distribution question, deliberately untouched here.

## Cross-references

mt#3578 (this decision + asset inventory + cold-start test) · mt#3499 (hook provisioning + resolver) · mt#1767/mt#2369/mt#2439 (migrations triad precedent) · mt#1740/mt#1720 (bin-entry install profiles) · mt#233 (release version automation — coordinate) · mt#2201 (tray app distribution — orthogonal artifact) · mt#1064 (skill distribution — adjacent asset class) · mem#340 (progressive adoption T0 presumes an install channel).
