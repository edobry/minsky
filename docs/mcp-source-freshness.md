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

## Cross-references

- mt#1740 — `cli-entry.ts` lazy bundle-rebuild-on-startup.
- mt#1714 — stdio respawn proxy (absorbs `staleness_exit`, triggers the rebuild).
- mt#1322 — daemon `staleness_exit` mechanism.
- `.minsky/rules/mcp-disconnect-cadence.mdc` — sibling `systemInfo` diagnostic
  (`mcpDisconnects`).
