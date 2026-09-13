# MCP daemon source freshness (`debug_systemInfo.sourceFreshness`)

The `mcp__minsky__debug_systemInfo` response includes a `sourceFreshness` object
(mt#2335) that reports whether the running MCP daemon's code is current with the
repository's `HEAD`. It exists to distinguish two states that otherwise look
identical from the outside:

- **Rebuild latency (benign, self-healing).** Just after a merge, a tool whose
  code just changed can still return pre-merge behavior. The `minsky` binary runs
  the bundled `dist/minsky.js` via `scripts/cli-entry.ts` (mt#1740), which rebuilds
  the bundle lazily on the next staleness-respawn (mt#1714). Until that rebuild
  completes, the daemon serves the old bundle. This resolves itself.
- **Permanent staleness (a real bug).** The loaded code is genuinely wrong and will
  not self-heal.

Before this field, the only way to tell them apart was a prose diagnostic ladder
(operator memory: "post-merge MCP staleness") requiring a multi-step shell probe
(`cat dist/.build-stamp` vs `git rev-parse HEAD`). `sourceFreshness` collapses that
into one field on a tool agents already call.

## Fields

| Field          | Type                                         | Meaning                                                                                                                                                                                                                                                                                                               |
| -------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadedCommit` | `string \| null`                             | The commit the running code was built/loaded from. For a bundle run it is the `dist/.build-stamp` value (the commit the imported bundle reflects); for a source-fallback run it is the load-time `HEAD`. `null` when the process was not launched via `cli-entry` (CLI / published install) or the stamp was missing. |
| `currentHead`  | `string \| null`                             | `git rev-parse HEAD` in the install root at call time. `null` if the package root is unknown or git fails. Not computed when `loadedCommit` is `null` (nothing to compare against).                                                                                                                                   |
| `bundleFresh`  | `boolean \| null`                            | `loadedCommit === currentHead`. `true` = loaded code is current. **`false` = a rebuild is PENDING (benign latency), not necessarily a staleness bug.** `null` = indeterminate (either commit unknown).                                                                                                                |
| `runMode`      | `"bundle" \| "source-fallback" \| "unknown"` | How `cli-entry` served the process. `unknown` when not launched via `cli-entry`.                                                                                                                                                                                                                                      |
| `note`         | `string \| null`                             | Human-readable reason when `bundleFresh` is `null`; `null` when determinate.                                                                                                                                                                                                                                          |

## How to read it

- **`bundleFresh: true`** — the daemon is current. If a just-merged tool still
  misbehaves, it is a genuine code issue, not staleness.
- **`bundleFresh: false`** — a bundle rebuild is pending. This is the normal
  post-merge window; **wait and re-test rather than concluding permanent staleness
  or advising `/mcp`.** It self-heals on the next staleness-respawn + rebuild.
- **`bundleFresh: null`** — freshness could not be determined; read `note` for why
  (typically a non-`cli-entry` launch such as the CLI path, where the signal does
  not apply).

## Implementation

- `scripts/cli-entry.ts` records `MINSKY_LOADED_COMMIT`, `MINSKY_RUN_MODE`, and
  `MINSKY_PACKAGE_ROOT` into process env **before** it `import()`s the bundle (it
  cannot call into a module inside the bundle before importing it). The three vars
  are registered in `HOOK_ONLY_ENV_VARS` so the env-var-to-config parser skips them
  at boot (mt#1785 class).
- `src/mcp/source-freshness.ts` reads those vars and computes `currentHead` at call
  time (short-circuiting the git call when `loadedCommit` is unknown, with a short
  TTL cache so repeated `systemInfo` calls do not re-spawn git).
- `src/adapters/shared/commands/debug.ts` adds the field to the `systemInfo` payload.

## What counts as a source change (the staleness exit's root set)

`sourceFreshness` above REPORTS drift; the `staleness_exit` mechanism (mt#1322) ACTS on it.
`StalenessDetector` (`src/mcp/staleness-detector.ts`) records `HEAD` at startup and, on each
tool call (debounced to once a minute), checks whether `HEAD` moved AND whether the diff between
the two commits touches any of the server's **source roots**:

- `src/` — the entry tree. The daemon is spawned as `bun run src/cli.ts` (or the bundle built
  from it), so a relative import from the entry resolves inside `src/`.
- every `packages/<pkg>/src/` that exists — the `@minsky/*` workspace packages the entry
  imports (`packages/domain`, `packages/shared` today).

The packages roots are **discovered** by listing `packages/` at check time
(`discoverSourceRoots`), never named in code. A hard-coded pair would drift from the real import
closure the day a third package appeared, silently — the same defect one level up. A checkout
without a `packages/` directory degrades to `src/` alone.

**Why it is wider than `src/` (mt#5120).** Until 2026-09-13 the detector diffed `-- src/` only.
That was the whole closure when all served code lived under `src/`; the `packages/domain/`
extraction (mt#2108) moved most of it under `packages/*/src` without moving the pathspec, so a
merge confined to `packages/**` left the tray-supervised daemon serving the OLD build until some
unrelated `src/` change landed. Observed on PR #3741 (mt#5115): three `packages/domain/src/`
files changed, no `staleness_exit` fired, and the daemon ran the pre-merge code for an hour until
a manual `mcp_restart`. The cockpit daemon's tray watcher had the same defect twice — mt#4230
(`packages/` half) and mt#5060 (`src/` half) — and `cockpit_backend_roots()` in
`cockpit-tray/src-tauri/src/watcher_backend.rs` is the sibling list for that daemon; the two are
kept in the same shape deliberately.

Trees outside the closure — `docs/`, `.minsky/hooks/` (the hook tree is a separate module
graph; `src/` does not import it, mt#4010), `services/*` (nothing under `src/` or `packages/`
imports them) — do not trigger the exit. A change confined to one of them never invalidates the
running server.

## Cross-references

- mt#5120 — the root set widened from `src/` to `src/` + discovered `packages/*/src`.
- mt#1740 — `cli-entry.ts` lazy bundle-rebuild-on-startup.
- mt#1714 — stdio respawn proxy (absorbs `staleness_exit`, triggers the rebuild).
- mt#1322 — daemon `staleness_exit` mechanism.
- `.minsky/rules/mcp-disconnect-cadence.mdc` — sibling `systemInfo` diagnostic
  (`mcpDisconnects`).
