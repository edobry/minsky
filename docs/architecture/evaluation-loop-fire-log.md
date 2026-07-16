# Evaluation-loop fire-log (Phase 1)

Architecture reference for the shared fire-log instrumentation shipped by mt#2597,
Phase 1 of the evaluation-loop RFC (Notion `392937f0-3cb4-8188-aad6-d7d041de814b`,
Accepted 2026-07-08 via ask `54334d49`). Companion to `hook-files.mdc`'s
guard-dispatcher-framework section and to `docs/architecture/hooks/guard-health.md`
(the sibling failure-half tracker).

## What this is

Every enforcement point — a guard evaluation, a pre-commit step — appends a
one-line JSONL record describing what it decided: allow, warn, or deny; whether an
override was consulted and how it's classified; how long the evaluation took.
Emit-only. No behavior change. Fail-open: a broken log destination degrades to a
stderr marker, never blocks the guarded operation.

This is the **success half** of the enforcement corpus's observability.
`.minsky/hooks/guard-health.ts` (mt#2812) already covers the **failure half** — a
guard throwing, or explicitly degrading past an unreachable dependency. The two
trackers are deliberate siblings, not a merged module: same state-dir resolution,
same fs-dependency-seam shape, same best-effort/swallow-all posture — but they
answer different questions (guard-health: "is this guard broken?"; fire-log: "what
did every evaluation decide, and at what override/attention cost?").

## Storage decision

**One shared `fire-log.jsonl` in the durable state dir** (`~/.local/state/minsky/`,
override via `MINSKY_STATE_DIR`) — the same file for BOTH the hook-runtime side
(`.minsky/hooks/fire-log.ts`) and the pre-commit-pipeline side
(`src/hooks/pre-commit-fire-log.ts`), distinguished by each record's `event` field
(`"PreToolUse"` / `"UserPromptSubmit"` / etc. for guards, `"PreCommit"` for
pre-commit steps).

This was a genuine decision point, not a default. The alternative — following the
existing `.minsky/*-calibration.jsonl` convention (relative to
`CLAUDE_PROJECT_DIR`/cwd) — was rejected for a documented reason: that convention
has **already fragmented calibration logs across session workspaces** in
production (each session clone resolves `CLAUDE_PROJECT_DIR` to its own checkout,
so the "same" calibration log ends up as N disjoint per-session files instead of
one corpus-wide log an operator can query). The durable state-dir path
(`guard-health-log.jsonl`'s existing convention, mt#2812) does not have this
failure mode — it resolves to one fixed location regardless of which session
workspace a hook happens to run from. Since the fire-log's entire purpose is
corpus-wide aggregation (the Phase-1 GATE, the eventual Phase-3 rationalization
review), fragmentation would defeat it before it starts. Splitting hook-runtime and
pre-commit-pipeline fires into two separate files was considered and rejected for
the same reason in miniature: a pre-commit STEP and a guard EVALUATION are both
"an enforcement point firing," and a reviewer doing corpus-wide analysis
(override rates, attention cost, the Phase-1 GATE check) should not have to merge
two files by hand to answer "how many total enforcement fires happened today."

## Schema

```ts
interface FireLogEntry {
  timestamp: string; // ISO-8601
  guardName: string; // e.g. "check-guessed-session-path", "nul-byte-check"
  event: string; // lifecycle event or pipeline stage ("PreToolUse", "PreCommit", ...)
  decision: "allow" | "warn" | "deny";
  durationMs: number; // per-fire cost, not cumulative
  overrideEnvVar?: string; // the env-var name that produced the override, if any
  overrideClassification?: "authorized_exception" | "unclassified" | "contested";
  toolName?: string; // PreToolUse/PostToolUse only
  sessionId?: string;
}
```

## Override classification

Per the RFC's explicit three-way split, computed against the same oracle every
override env-var must already be registered in (`HOOK_ONLY_ENV_VARS`,
`packages/domain/src/configuration/sources/environment.ts` — the mt#1788
registry that also gates the CLI's env-var-to-config dot-path parser):

- **`authorized_exception`** — the override env-var IS a documented, registered
  legitimate-use escape-hatch (present in the oracle).
- **`unclassified`** — an override env-var was used, but it is NOT present in the
  oracle (a not-yet-registered ad hoc var — shouldn't normally happen given the
  mt#1788 ESLint enforcement; this is the honest fallback rather than silently
  mis-classifying it).
- **`contested`** — the decision was overridden WITHOUT going through the
  documented env-var mechanism at all — e.g. the dispatcher's grant-file channel
  (`guard-grant-store.ts`, mt#2658), a TTL-bound mid-session grant that bypasses
  `MINSKY_HOOK_OVERRIDE` entirely. The RFC calls this "bypassed at another layer."

**Dependency boundary.** `.minsky/hooks/` is dependency-free (`SPEC.md`'s
invariant — no `packages/domain` imports, so the hooks tree keeps working even
when the main codebase has type errors). It therefore cannot import
`HOOK_ONLY_ENV_VARS` directly; `.minsky/hooks/known-override-env-vars.ts` is a
hand-maintained mirror, matching the established duplication-over-cross-import
precedent (`guard-health.ts` / `mcp-daemon-staleness-detector.ts` each duplicate a
src-side reader rather than importing it, for the same reason). Staleness there is
soft-failing by design — a missing entry only downgrades a classification from
`authorized_exception` to `unclassified`, never changes a guard's actual decision.
`src/hooks/pre-commit-fire-log.ts` has no such constraint (it's part of the root
tsconfig program) and imports the real `HOOK_ONLY_ENV_VARS` directly.

## Overhead measurement

Target per the RFC: **well under 1ms per append**. Measured
(`bun run <bench>` — 1000 iterations of `recordFireLogEntry` against a real temp
file, 2026-07-16, Apple Silicon dev machine):

```json
{
  "iterations": 1000,
  "totalMs": 53.98,
  "avgMsPerAppend": 0.054,
  "finalFileSizeBytes": 122000
}
```

**~0.054ms average per append** — roughly 18x under the 1ms target. This measures
the append operation itself (JSON.stringify + directory-exists check +
`fs.appendFileSync`), not the wrapped guard's own runtime — the `durationMs` field
guards record includes the GUARD's real work (which for e.g. `eslint-validation`
or `unit-tests` is legitimately multi-second; that's the guard's own cost, not the
fire-log's instrumentation overhead).

## Fail-open verification

Both `recordFireLogEntry` (hook-runtime) and `recordPreCommitFireLogEntry`
(pre-commit pipeline) wrap the entire append operation in a try/catch that never
rethrows — verified directly by unit tests injecting a throwing fs seam
(`fire-log.test.ts`, `pre-commit-fire-log.test.ts`). On a write failure, a
non-JSON stderr "degraded" marker is emitted (itself wrapped in its own try/catch,
so even a broken stderr stream can't escalate into a second throw) — satisfying
the RFC's acceptance test verbatim: "kill the log destination (permission/missing
dir) -> the guarded operation still completes; a degraded marker is emitted."

## What's instrumented (as of this Phase-1 landing)

- **The guard dispatcher loop** (`.minsky/hooks/dispatcher.ts`'s `runDispatcher`)
  — ONE integration point covering every `GUARD_REGISTRY`-registered guard
  (17+ guards across `PreToolUse` and `UserPromptSubmit` as of this writing).
  Records every outcome: override-suppressed, thrown (fail-open), denied,
  additionalContext-only (`"warn"`), and silent-allow (`null`/`undefined`
  outcome) — the RFC's explicit "including silent-allow" requirement.
- **The pre-commit pipeline** (`src/hooks/pre-commit.ts`'s `PreCommitHook.run()`)
  — all 17 step methods, via a private `instrumented()` wrapper.
- **Two standalone (non-dispatcher) PreToolUse guards**: `block-git-gh-cli.ts`,
  `require-session-for-main-workspace-edits.ts`. `check-guessed-session-path` is
  already covered via the dispatcher (it's `GUARD_REGISTRY`-registered).

## Known gaps (not yet landed — see mt#2597's spec status note for the current disposition)

- **Merge-gate instrumentation** — explicitly out of scope for Phase 1 (the
  RFC's own Phase 3, and this task's scope guard).
- **Calibration-log compatibility adapter** — making the 6 existing
  `.minsky/*-calibration.jsonl` logs readable as the shared fire-log schema.
- **Canary declarations** — a per-guard synthetic triggering input + a runnable
  canary check distinguishing a broken guard from a dormant/deterrent one.
- **Attention-cost annotation** — a static per-guard registry field
  (denial-message size / option count).
- **Full standalone-guard coverage** — only 2 of the "highest-traffic" standalone
  guards named in the task prompt are instrumented; the remainder (and any not
  named) are a follow-up sweep.

## Cross-references

- RFC: Notion `392937f0-3cb4-8188-aad6-d7d041de814b` — the originating proposal
  (§Part 1 is this document's direct source).
- mt#2589 — RFC tracking task; mt#2597 — this Phase-1 implementation task.
- `.minsky/hooks/guard-health.ts` / `docs/architecture/hooks/guard-health.md` —
  the sibling failure-half tracker (mt#2812).
- `.minsky/hooks/fire-log.ts`, `.minsky/hooks/known-override-env-vars.ts` —
  hook-runtime implementation.
- `src/hooks/pre-commit-fire-log.ts` — pre-commit-pipeline implementation.
- `packages/domain/src/configuration/sources/environment.ts` —
  `HOOK_ONLY_ENV_VARS`, the override-classification oracle.
