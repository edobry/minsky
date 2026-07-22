# SubagentStop invocation-recording hook

`.minsky/hooks/record-subagent-invocation.ts` (generated to `.claude/hooks/`) — the writer of
every Stop-time column in `subagent_invocations`. Registered as a standalone `SubagentStop`
entry in `.claude/settings.json` (not a `GUARD_REGISTRY` member), so it runs as its own bare
Bun process.

Not a permission gate: it emits no decision and its fail-safe contract is absolute — any error
logs to stderr and exits 0. It must never block a subagent stop.

## What it writes

`tasks.dispatch` writes a PENDING row at dispatch time (`dispatch-command.ts`, Step 5) carrying
`task_id`, `agent_type`, `suggested_model`, `started_at`, and the pessimistic placeholder
`outcome: "crashed-no-output"`. This hook is what turns that placeholder into a real record. It
owns, exclusively:

| Column                                                     | Source                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| `agent_session_id`                                         | the harness `agent_id` (joins `agent_transcripts`, mt#1313) |
| `ended_at`                                                 | Stop time — **the dispatch watchdog's liveness signal**     |
| `outcome`, `pr_url`, `last_commit_hash`, `handoff_written` | `classifyWorkspaceOutcome`                                  |
| `tool_use_count`, `total_tokens`, `duration_ms`            | `readTranscriptMetrics` (mt#2649)                           |
| `actual_model`                                             | `extractActualModel` (mt#2796)                              |

If this hook does not run, `outcome` is a constant and `ended_at` is never set — which means
`src/cockpit/dispatch-watchdog.ts`'s `WHERE ended_at IS NULL` in-flight set never drains.

## The entry-point bootstrap contract (mt#3019)

A hook is its OWN entry point. It inherits nothing from the CLI's `cli.ts` or the MCP server
boot, and two of those inherited things are mandatory before ANY domain import:

1. **`reflect-metadata`** — domain classes reached via the persistence factory are
   `@injectable()`. Without the polyfill, the very IMPORT of
   `packages/domain/src/persistence/factory` throws. Critically, that throw happens at MODULE
   LOAD, OUTSIDE `resolvePersistenceProvider`'s try/catch, so it never becomes the documented
   `null` return.
2. **Domain configuration** — `PersistenceService.initialize()` throws "Configuration not
   initialized" without it. This one IS inside the factory's try, so it degrades to `null` and
   is indistinguishable from a genuinely unreachable database.

Both are handled by `.minsky/hooks/domain-bootstrap.ts`'s `ensureHookDomainBootstrap()`, which
also applies the mt#2982 fail-fast Postgres connect (2s). Import it STATICALLY — that static
import is what guarantees the polyfill is installed before any dynamic domain import runs.

**This hook was missing both for the entire life of the table.** 62 rows written between
2026-07-08 and 2026-07-22; zero carried any hook-written column. Three features shipped onto the
dead path (mt#1737 the hook, mt#2796 `actual_model`, mt#2831 the strong-binding marker), each
green on unit tests that mock the tracker and therefore never load the module that throws.
mt#3046 tracks the CI smoke test that makes this class detectable.

## Correlation keys

The upsert key is the SUBAGENT's Minsky session id, extracted from the last `/sessions/<id>/`
path segment of `cwd` — NOT the harness `agent_id`, and NOT the task id. Dispatch wrote the
pending row keyed on it.

- **Strong binding** — when the current-invocation marker names an exact row, it is passed as
  `id` and the tracker updates THAT row, immune to late-Stop misattribution across an
  auto-resumed dispatch (mt#2831).
- **Unresolved task id** — the hook records anyway, sending `UNKNOWN_TASK_ID`; the tracker's
  UPDATE path drops the sentinel so the real dispatch-time `task_id` survives. Same treatment
  `UNKNOWN_AGENT_TYPE` gets for `agent_type` (mt#2653). Before mt#3019 the hook dropped the
  whole write here, contradicting its own comment (mt#2315, subsumed).
- **Neither key** — the only case where the write is genuinely skipped: an INSERT would create
  an orphan row keyed on nothing.

## Timeouts

`RECORD_INVOCATION_TIMEOUT_MS` (8s) bounds the whole recording path, matching
`STANDALONE_DUP_PROBE_TIMEOUT_MS`. Before mt#3019 the hook was fast only by accident — it died
at its first domain import. With the DB path live, a slow Postgres is a real hang risk against
the harness host cap, so the deadline is load-bearing, not decorative.

## Verification

`bun scripts/verify-hook-domain-bootstrap.ts` walks bootstrap → provider → connection → a real
tracker write, reads the row back, then deletes it and asserts zero residue. Skips cleanly with
exit 0 when no Postgres is configured.

## Overrides

None. There is no bypass env var — the hook is fail-safe by construction rather than by opt-out.

## See also

- mt#1737 (original hook), mt#2649 (per-agent transcript resolution), mt#2796 (`actual_model`),
  mt#2831 (strong binding), mt#2653 (`UNKNOWN_AGENT_TYPE`), mt#2315 (subsumed), mt#3019 (the
  bootstrap fix), mt#3046 (entry-point smoke test).
- `guard-dispatcher-framework.md` — why this hook is standalone rather than a registry member.
- `dispatch-watchdog-injection-hook.md` — the primary consumer of `ended_at`.
