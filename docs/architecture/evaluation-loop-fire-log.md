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
  overrideSource?: "env" | "grant"; // which checkOverride() channel decided (dispatcher only; R1 fix)
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
  documented env-var mechanism at all, AND without a TTL-bound, reason-mandatory
  grant either (the RFC's "bypassed at another layer" framing, now scoped to that
  residual case — see the R1 fix below).

**R1 fix (PR #1989 review round 1): env/grant attribution.** The dispatcher's
`checkOverride()` consults TWO channels — the `MINSKY_HOOK_OVERRIDE` env var, and
(Phase-7 adjunct, mt#2658) a TTL-bound, reason-mandatory grant-file match. The
original landing collapsed a grant-sourced override to a record carrying
`overrideEnvVar: undefined` and `overrideClassification: "contested"`,
indistinguishable from "bypassed with no accountability at all." Since a grant is
itself TTL-bound and reason-mandatory by construction — the same property that
makes the env-var channel an "authorized exception" — this was a
misclassification, not a design choice. The fix
(`.minsky/hooks/dispatcher.ts`'s `buildOverrideFireLogFields`):

- Adds an `overrideSource: "env" | "grant"` discriminator to the schema (see
  above) so a reader can tell which channel decided even when both classify as
  `authorized_exception`.
- Classifies grant-channel overrides as `authorized_exception` directly, not via
  `classifyOverride(undefined)`'s generic fallback.
- Attributes deterministically when both channels are technically "present" in
  the environment (e.g. `MINSKY_HOOK_OVERRIDE` configured for a different
  guard/token than the one being evaluated, while a grant separately matches this
  guard) — by trusting `checkOverride()`'s own invariant (`grantReason` is
  populated if and only if the grant channel is what decided) rather than
  re-deriving its precedence logic.

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
  — all 17 step methods, via a private `instrumented()` wrapper delegating to the
  standalone `runInstrumentedStep()`. **R1 fix**: override attribution now reads
  each step's own `HookResult.overridden` flag (set only on the branch where the
  step itself consulted its paired env-var and skipped) instead of a blanket
  `process.env` presence scan — the original approximation could misattribute a
  normal pass as "overridden" whenever an unrelated `MINSKY_SKIP_*` var happened
  to be truthy for a DIFFERENT step.
- **Seven standalone (non-dispatcher) PreToolUse guards**: `block-git-gh-cli.ts`,
  `require-session-for-main-workspace-edits.ts` (both mt#2597), plus
  `tasks-status-set-guard.ts`, `validate-task-spec.ts`,
  `check-generated-file-edit.ts`, `check-task-spec-read.ts`, and
  `check-branch-fresh.ts` (all five mt#2889). `check-guessed-session-path` is
  already covered via the dispatcher (it's `GUARD_REGISTRY`-registered).

## Known gaps (post mt#3084 — Phase 3 merge-gate instrumentation shipped; documented per-guard exclusions remain)

mt#2889 closed every item this section previously listed except merge-gate
instrumentation (Phase 3). mt#3078 classified the absence (see the dedicated section
below), and **mt#3084 has now shipped the Phase-3 build-out**: all ~10 standalone
`session_pr_merge` PreToolUse hooks call `makeRecordAndExit` (`.minsky/hooks/
merge-gate-fire-log.ts`) at every exit path, so `fire-log.jsonl` now carries
`guardName`/`decision` entries for the merge-gate family — closing the gap the
"Merge-gate fire-log absence" section below documents. What mt#2889 shipped
earlier:

- **Canary declarations + runner** — `GuardRegistration.canary` (registry.ts)
  populated for 18 of 18 `GUARD_REGISTRY` entries with a feasible synthetic
  trigger, plus 6 standalone (non-registry) guards, via
  `.minsky/hooks/canary-runner.ts` + `scripts/run-guard-canaries.ts`. Two
  registry guards have NO canary (documented gaps, not silent caps):
  - `memory-search` — shells to a live `minsky memory search` process inside
    `run()` with no injectable seam; a canary would need either a live
    round-trip (not hermetic) or an `execWithPath`-style DI refactor (out of
    scope: no guard-behavior/refactor changes this task).
  - `mcp-daemon-staleness-detector` — correctness depends on a real
    `minskyHomeDir` git checkout whose current HEAD differs from a stored
    `startCommit`; fabricating that safely without depending on this repo's
    live commit graph needs a scratch git-repo fixture beyond this pass.
- **Calibration-log compatibility adapter** — `src/domain/calibration/
calibration-sweep.ts` gained `calibrationRecordToFireLogEntry` /
  `calibrationLogAsFireLogEntries` / `readAllCalibrationLogsAsFireLogEntries`:
  a READ-SIDE-ONLY mapping from the 6 legacy `.minsky/*-calibration.jsonl`
  shapes to this doc's fire-log schema (guardName via a hand-maintained
  name mirror, decision per-kind — matched-phrase logs always "warn";
  `policy-coverage`'s own outcome axis maps to deny/warn/allow). Historical
  files are never rewritten or moved.
- **Attention-cost annotation** — populated for all 18 `GUARD_REGISTRY`
  entries with a canary (all 20 total, including the 2 gap guards) and for
  the 7 fire-log-instrumented standalone guards.
- **Standalone-guard coverage** — 7 of 12 identified non-registry,
  non-merge-gate PreToolUse guards are now fire-log instrumented:
  `block-git-gh-cli`, `require-session-for-main-workspace-edits` (mt#2597),
  `tasks-status-set-guard`, `validate-task-spec`, `check-generated-file-edit`,
  `check-task-spec-read` (all four also canary-covered), and
  `check-branch-fresh` (fire-log only — no canary; its real evaluation has
  side effects a synthetic invocation cannot safely trigger: a live `git
fetch`, an actual `git merge` on the blocked+clean-tree auto-merge path
  (mt#2815), and a CAS-marker write on allow). Five guards remain
  uninstrumented, each with a documented reason:
  - `parallel-work-guard.ts` — its `tasks_create` duplicate-child path
    (`runTasksCreateGuardInner`) resolves its decision via an internal
    `switch` with no return value bubbled to the call site; attributing a
    fire-log decision would need restructuring that function's void return
    into a decision-returning one — a larger structural change than the
    additive instrumentation this task's scope allows.
  - `policy-coverage-detector.ts` — already has its own purpose-built
    calibration log (now surfaced via the adapter above); a canary would be
    structurally brittle (depends on live corpus content) and the guard has
    8 early-exit branches.
  - `block-github-mcp-pr-writes.ts` — near-identical in shape/signal to the
    already-instrumented `block-git-gh-cli`; low marginal value.
  - `loop-preflight-pr-merge-check.ts` — narrow trigger (`Skill:"loop"`
    only); no injectable seam without a refactor.
  - `check-prompt-watermark.ts` — narrow trigger (`Agent` dispatches only);
    low fire frequency.
- **Phase-1 GATE verification** — see the next section; formally re-run
  against the real log post-landing.

## Merge-gate fire-log absence — classification (mt#3078), closed by mt#3084

**Status: CLOSED.** This section originally classified the absence below as a deliberate
Phase-1/Phase-2 scope boundary (not a silent dependency failure), and named mt#3084 as the
filed owner task for the actual Phase-3 build-out. mt#3084 has now shipped that build-out: every
one of the ~10 standalone `session_pr_merge` PreToolUse hooks (`require-execution-evidence-
before-merge.ts`, `require-deploy-verification-before-merge.ts`,
`require-growth-justification-before-merge.ts`, `block-out-of-band-merge.ts`,
`block-subagent-bypass-merge.ts`, `require-checks-on-bypass-merge.ts`,
`block-subagent-merge-without-grant.ts`, `require-review-before-merge.ts`,
`dispatch-intent-write-gate.ts`, `block-nested-fork-dispatch.ts`) now calls the shared
`makeRecordAndExit` factory (`.minsky/hooks/merge-gate-fire-log.ts`) at every exit point —
mirroring the per-hook `recordAndExit` closure convention `block-git-gh-cli.ts` /
`check-branch-fresh.ts` / `check-task-spec-read.ts` already established for non-merge-gate
standalone guards. No gate's actual allow/deny decision logic changed (mt#3084's hard scope
constraint) — this is purely additive recording.

**Verification (mt#3084).** `.minsky/hooks/merge-gate-fire-log.test.ts` unit-tests the shared
factory against an in-memory fs (allow/deny/warn, override-field passthrough, fail-safe-on-
write-failure). Beyond the unit tests, a synthetic invocation of the real
`dispatch-intent-write-gate.ts` script (run directly via `bun`, stdin-fed a crafted
`ToolHookInput`, `MINSKY_STATE_DIR` pointed at a scratch temp dir so no production state was
touched) produced both outcomes end-to-end against a real `fire-log.jsonl`:

```
{"guardName":"dispatch-intent-write-gate","event":"PreToolUse","decision":"deny", ...}
{"guardName":"dispatch-intent-write-gate","event":"PreToolUse","decision":"allow", ...}
```

This satisfies AT1 ("forcing a merge-gate deny... produces a new fire-log.jsonl line with
guardName matching the gate, decision: deny") and AT2 ("a clean pass produces allow entries")
via the "forced synthetic invocation" path the mt#3084 spec names as an accepted alternative to
a live merge — a live merge of mt#3084's own PR cannot exercise its own not-yet-merged code
(the hooks that fire during this PR's merge are whichever version is already deployed in the
main workspace's `.claude/hooks/`), so synthetic invocation is the only pre-merge verification
route available for this specific change.

**Original classification (retained for history):** every one of the ~10 hooks above ran as a
standalone `settings.json` entry, not a `GUARD_REGISTRY` entry sharing the dispatcher's fire-log
call site — this module's own opening comment scoped merge gates out explicitly ("eventually a
merge gate — Phase 3, out of scope here"), and the "Known gaps" section above documented the
Phase-3 deferral since mt#2889. This was a deliberate scope boundary of the Phase-1/Phase-2
landings, not a silent dependency failure of the mt#3019/mt#3046 class.

Independently reconfirmed empirically (mem#683 baseline capture, 2026-07-23, PRE-mt#3084):
`fire-log.jsonl` contained **zero** `guardName` entries for any merge-gate hook and **zero**
`toolName: mcp__minsky__session_pr_merge` entries anywhere across 50,248 lines spanning the
file's entire available 7-day window — despite confirmed real merges in that exact window
(e.g. PR #2195, #2199). `guard-health-log.jsonl` was checked as an alternate source and found
unrelated (14 lines, all `standalone-duplicate-matcher` check-skip events). **This baseline
predates mt#3084's landing** — it captures the gap this task closed, not the current state; a
future re-run of the same query, once mt#3084's instrumented hooks have accumulated real
`session_pr_merge` invocations post-merge, should show non-zero merge-gate entries.

**Alternative evidence source for merge-gate activity (named per mem#683's baseline-comparison
protocol, retained for historical context).** Grepping all ~10 merge-gate hook source files for
their own calibration/audit writes found exactly ONE purpose-built log:
`require-execution-evidence-before-merge.ts`'s mt#3033 AT-cross-reference sub-check writes
`.minsky/execution-evidence-at-coverage-calibration.jsonl`. For the remaining ~9 gates, no
purpose-built log existed at all pre-mt#3084 — the only trace of a fire was the PreToolUse
call's `permissionDecisionReason` / `additionalContext` string, surfacing solely in the calling
agent's own conversation transcript. These were the two concrete alternative sources named for a
baseline comparison until mt#3084 shipped real instrumentation (now shipped — see above):

1. **Ingested transcripts** — `mcp__minsky__transcripts_search-text` over `agent_transcripts`
   (populated by the `SessionEnd` transcript-ingest hook), searching for each gate's
   characteristic denial substring (e.g. `"Merge blocked: PR adds"` for the execution-evidence
   file-pattern floor, `"Deploy verification:"` for the deploy-verification gate). Coarse (text
   search, not structured counts) but works today with no code changes.
2. **Merge-commit bodies** — for bypass-merge events specifically, the canonical audit-trail
   signature (`"Bot self-approval bypass per feedback_self_authored_pr_merge_constraints"`) is
   written directly into the merge-commit message by both bypass paths
   (`block-subagent-bypass-merge.ts` / `require-checks-on-bypass-merge.ts`'s callers), so
   `git log --grep` over merged commits is a durable, structured-enough source for that one
   event class.

Neither source covered routine `allow` decisions across the full gate family — that was exactly
the gap mt#3084 (Phase 3 build-out) closed; `fire-log.jsonl` is now the structured source for
that data.

## Phase-1 GATE result (mt#2889, verified 2026-07-17)

The RFC's Phase-1 gate ("logs exist for all instrumented guards AND at
least two guards show ≥5 fires") is met with wide margin against the real
`~/.local/state/minsky/fire-log.jsonl`:

```
Total records: 3517
Distinct guards: 37
Guards with >= 5 fires: 37 (ALL of them)
Decision distribution: 2629+ allow, 33+ deny, 139+ warn (growing)
```

Every guard instrumented as of this landing (dispatcher-registered +
pre-commit + the fire-log-instrumented standalone guards) already shows
≥5 fires in production usage accumulated since mt#2597's original landing
— not merely the RFC's ≥2-guard bar. The 5 NEWLY fire-log-instrumented
standalone guards this task adds (`tasks-status-set-guard`,
`validate-task-spec`, `check-generated-file-edit`, `check-task-spec-read`,
`check-branch-fresh`) do not yet appear in this snapshot — canary
invocations bypass `recordFireLogEntry` by design (they call the guard's
`run()`/pure decision function directly, never the dispatcher's fire-log
call site), so their real-world fire counts will accumulate from ordinary
subsequent usage (the next `tasks_status_set`, `tasks_create`,
`session_commit`, etc. in any session).

## Coverage-receipt gate — the live-input complement to the canary (mt#2554)

The canary runner above proves a detector's DECISION LOGIC still works by feeding it
SYNTHETIC input. That is necessary but not sufficient: a detector can pass its canary
while never actually firing on REAL input (the mt#2057 dead-hook shape — 9 days of zero
real fires while `status:DONE`). The coverage-receipt gate is the LIVE half of the same
broken-vs-dormant story (RFC mt#2263 Phase 1, SC#5):

- **Provenance field.** Every `.minsky/*-calibration.jsonl` entry a detector writes at
  runtime now carries `source: "live"` (`retrospective-trigger-scanner.ts` as of mt#2554;
  other detectors follow as they migrate). Fixture / replay / backfill entries are
  `source: "synthetic"`. A MISSING `source` (pre-mt#2554 records) counts as live for
  backward-compatibility — every calibration entry written before the field existed was a
  real runtime fire, and legacy records age out of the rolling window regardless.
- **The gate** (`.minsky/hooks/coverage-receipt.ts` — `checkCoverageReceipt` /
  `checkDetectorCoverage`) reads a detector's calibration log and PASSES only when ≥1 live
  receipt falls inside a rolling window (default 7 days); a detector with zero live fires in
  the window is FLAGGED and surfaced for review. An entry explicitly labelled
  `truePositive:false` (a known false positive) does not count, so a detector firing only on
  FPs is still flagged. TP/FP labelling is not mechanized at write time in Phase 1 (RFC "no
  early labelling"), so an unlabelled live fire is treated as a receipt.
- **Invocation path.** `scripts/check-coverage-receipts.ts` discovers every
  `.minsky/*-calibration.jsonl`, checks each, prints an `[OK]`/`[FLAGGED]` report, and exits
  non-zero when any detector is flagged. It runs at calibration-review cadence
  (`/calibration-review` Step 1b), NOT as a merge gate — a flagged detector is a review
  signal, not a commit blocker.

This reads the per-detector calibration logs, NOT the corpus-wide `fire-log.jsonl` this
document otherwise describes; the two are complementary (fire-log = every guard's
allow/warn/deny decision; calibration logs = a detector's matched-phrase fires, which is
where live-vs-synthetic provenance and the coverage receipt live).

## Operating the fire-log

The log lives at `~/.local/state/minsky/fire-log.jsonl` (override via
`MINSKY_STATE_DIR`) — one JSON object per line, no enclosing array. Query it
directly with `jq`; no MCP tool wraps it yet (a follow-up could add one, mirroring
`debug_systemInfo`'s aggregation pattern for the disconnect/subagent trackers).

```bash
# Fire counts per guard (all-time)
jq -r '.guardName' ~/.local/state/minsky/fire-log.jsonl | sort | uniq -c | sort -rn

# Override rate by classification (env vs grant attribution included, R1)
jq -r 'select(.overrideClassification) | "\(.overrideClassification) \(.overrideSource // "n/a")"' \
  ~/.local/state/minsky/fire-log.jsonl | sort | uniq -c

# Deny rate — decision distribution per guard
jq -r 'select(.decision == "deny") | .guardName' ~/.local/state/minsky/fire-log.jsonl \
  | sort | uniq -c | sort -rn
```

**Retention.** Append-only, no rotation as of this landing — the same posture as
`guard-health-log.jsonl` (mt#2812) and the `.minsky/*-calibration.jsonl` logs. This
file grows unbounded with usage; whether rotation, size-based truncation, or a
periodic archival sweep is needed is a **mt#2889 concern** (or a further follow-up
if that task doesn't reach it) — not addressed by this Phase-1 landing.

**Privacy.** Records carry tool names (`toolName`), guard identifiers
(`guardName`), and session ids (`sessionId`) — no file contents, no user prompt
text, no command arguments. The override fields (`overrideEnvVar`,
`overrideClassification`, `overrideSource`) name which escape-hatch env-var or
grant channel fired, never the grant's free-text `reason` (that reason is only
ever written into the stdout audit line via `buildOverrideAuditLine`, not into the
fire-log JSONL record itself).

## Cross-references

- RFC: Notion `392937f0-3cb4-8188-aad6-d7d041de814b` — the originating proposal
  (§Part 1 is this document's direct source).
- `docs/architecture/evaluation-loop-phase2.md` — Phase 2 (mt#2901): the
  retrospective-skill recurrence-after-DONE check, the family-membership metadata
  convention, and the first rationalization review — the direct consumer of every
  data source this document describes.
- mt#2589 — RFC tracking task; mt#2597 — this Phase-1 implementation task.
- mt#2889 — Phase-1 completion follow-up (IMPLEMENTED): canary declarations
  - runner (18/18 GUARD_REGISTRY guards + 6 standalone, 2 registry gaps
    documented), calibration-log schema adapter (read-side, non-destructive),
    standalone-guard coverage (7 of 12 instrumented, 5 documented exclusions),
    attention-cost population, and the Phase-1 GATE verification (37/37
    instrumented guards show ≥5 fires — see the dedicated section above).
    Merge-gate instrumentation (Phase 3) classification is mt#3078 (by-design
    exclusion, confirmed not a wiring bug — see the dedicated section above);
    the actual build-out is now owned by mt#3084.
- `.minsky/hooks/guard-health.ts` / `docs/architecture/hooks/guard-health.md` —
  the sibling failure-half tracker (mt#2812).
- `.minsky/hooks/fire-log.ts`, `.minsky/hooks/known-override-env-vars.ts` —
  hook-runtime implementation.
- `.minsky/hooks/coverage-receipt.ts` / `scripts/check-coverage-receipts.ts` — the
  live-input coverage-receipt gate (mt#2554, RFC Phase 1 SC#5); the live-half complement
  to `canary-runner.ts`'s synthetic-input check. Run at `/calibration-review` cadence.
- `.minsky/hooks/dispatcher.ts` — `buildOverrideFireLogFields` (R1 fix:
  deterministic env/grant attribution).
- `src/hooks/pre-commit-fire-log.ts` — pre-commit-pipeline implementation.
- `src/hooks/pre-commit.ts` — `runInstrumentedStep` (R1 fix: override attribution
  via the step's own `HookResult.overridden` flag).
- `packages/domain/src/configuration/sources/environment.ts` —
  `HOOK_ONLY_ENV_VARS`, the override-classification oracle.
- mt#3078 — invocation-path audit that classified the merge-gate fire-log absence as by-design
  (not a wiring bug) and named the alternative evidence sources (see the dedicated section
  above); mt#3084 — the Phase-3 build-out task this classification filed.
