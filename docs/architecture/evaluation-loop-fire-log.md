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
  // mt#3892 / mt#3757 — what KIND of record this is. OPTIONAL, and absence is
  // deliberately NOT read as "decided": records written before the field
  // existed carry no evidence either way. See §guardOutcome below.
  guardOutcome?: "decided" | "crashed" | "deadline-skipped";
  durationMs: number; // per-fire cost, not cumulative
  // mt#3757 — set ONLY when the guard crossed its DECLARED timeoutMs and
  // FINISHED ANYWAY. Carries the budget it crossed; `durationMs` is the cost.
  // Deliberately ABSENT on a "deadline-skipped" record: that guard did not
  // finish, so a value there would make the field mean two different things.
  budgetExceededMs?: number;
  overrideEnvVar?: string; // the env-var name that produced the override, if any
  overrideClassification?: "authorized_exception" | "unclassified" | "contested";
  overrideSource?: "env" | "grant"; // which checkOverride() channel decided (dispatcher only; R1 fix)
  toolName?: string; // PreToolUse/PostToolUse only
  sessionId?: string;
}
```

## Override classification

Per the RFC's explicit three-way split, computed against
`OPERATOR_OVERRIDE_ENV_VARS` in
`packages/domain/src/configuration/sources/environment.ts` — the
`operator-override` slice of the mt#1788 registry that also gates the CLI's
env-var-to-config dot-path parser:

> **Corrected 2026-08-17 (mt#3882).** This paragraph used to name
> `HOOK_ONLY_ENV_VARS` — the FULL registry — as the oracle, which was wrong and
> known to be wrong at two definition sites that documented specific vars as
> "deliberately NOT in `known-override-env-vars.ts` — it is not an operator
> escape hatch." The full registry holds every `MINSKY_*` var with no
> config-schema home: reviewer credentials, MCP server config, test fixtures,
> timeout knobs. Classifying those `authorized_exception` would report an
> operator authorization that never happened. The oracle is the categorized
> slice, and `known-override-env-vars.test.ts` now holds the hooks-tree copy
> equal to it in both directions.

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
`OPERATOR_OVERRIDE_ENV_VARS` directly; `.minsky/hooks/known-override-env-vars.ts`
carries a literal copy, matching the established duplication-over-cross-import
precedent (`guard-health.ts` / `mcp-daemon-staleness-detector.ts` each duplicate a
src-side reader rather than importing it, for the same reason).
`src/hooks/pre-commit-fire-log.ts` has no such constraint (it's part of the root
tsconfig program) and imports `OPERATOR_OVERRIDE_ENV_VARS` directly, so both
sides now read the same oracle.

**The copy is CHECKED, not hand-maintained (mt#3882).** This paragraph used to
call the drift "soft-failing by design — a missing entry only downgrades a
classification." True of any single guard's allow/deny decision, and false about
the measurement the log exists to produce: by 2026-08-17 the copy was 63 entries
behind, carried 45 entries that were never escape hatches, and held one
(`MINSKY_POLICY_COVERAGE_MODE`) whose detector mt#4197 had retired — at which
point `unclassified` mostly meant "a registered override nobody mirrored" rather
than "an unregistered var was used." Six hand-syncs failed to hold it. A test
file is not bound by the hooks tree's dependency-free constraint (that invariant
is about the tree staying RUNNABLE), so
`.minsky/hooks/known-override-env-vars.test.ts` imports both sides and asserts
equality in both directions.

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

## `guardOutcome`, and why an overrun is not one of its values (mt#3892, mt#3757)

`guardOutcome` says what KIND of record a line is. Its consumer that must not ignore
it is guard-health's recovery join, which counts `"decided"` records **only** —
otherwise a continuously crashing guard reads as recovered, because each crash
writes its own `allow` microseconds after its own failure event.

| Value                | Meaning                                                                          | Counts as a clean run? |
| -------------------- | -------------------------------------------------------------------------------- | ---------------------- |
| `"decided"`          | the guard returned a verdict                                                     | **yes**                |
| `"crashed"`          | the guard threw; the dispatcher failed open (mt#2597)                            | no                     |
| `"deadline-skipped"` | the guard passed its hard deadline and was skipped — no verdict exists (mt#3757) | no                     |
| absent               | written before the field existed — no evidence either way                        | no (dormant)           |

**An overrun is deliberately NOT a fourth value.** A guard that crossed its declared
`timeoutMs` and still returned a verdict _decided_; it was merely slow. Recording
that as a distinct `guardOutcome` would drop it out of the join above, so a guard
that worked correctly would read as never having produced a clean run — the same
false-health signal mt#3892 exists to prevent. It is therefore an additive
`budgetExceededMs` field alongside `guardOutcome: "decided"`: a fact about **cost**,
not a different outcome.

`"deadline-skipped"` is the opposite case and _is_ a new value, because that guard
produced nothing to count.

**The two are mutually exclusive, and that is the contract** (PR #3213 R3):
`budgetExceededMs` is present ⟺ the guard overran and STILL RETURNED. It is absent on a
`"deadline-skipped"` record, because that guard did not return. Setting it on both would
collapse "slow but fine" and "cut off" into one signal at every reader — which is exactly
what a reader consults this field to tell apart.

**Operator reading.** A rising `budgetExceededMs` population for one guard means its
declared budget no longer matches reality — re-budget it, or investigate why it slowed.
A `"deadline-skipped"` record means a verdict was genuinely LOST for that turn; the
merged context block carries a matching named notice, so the agent that ran the turn was
told rather than left to read the silence as an all-clear.

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
  - `policy-coverage-detector.ts` — MOOT as of 2026-08-16 (mt#4197): the hook,
    its module, and its canary are deleted. The paragraph below is retained as
    the record of how the gap was closed while the detector existed, because
    its reasoning about synthetic-corpus canaries generalizes to the next
    decision-function guard. It was NO LONGER A GAP as of mt#3393; a
    `policy-coverage` canary shipped in `STANDALONE_GUARD_CANARIES`. The
    original exclusion reasoned that a canary "would be structurally brittle
    (depends on live corpus content)"; that holds only if the canary loads the
    live corpus. Injecting a synthetic two-entry `PolicyCorpus` straight into
    `decideCoverage` — one entry that speaks to the action, one that does not,
    asserting both directions — exercises the real decision function with no
    dependence on what `CLAUDE.md` happens to say today. The 8 early-exit
    branches are in the hook ENTRYPOINT, which the canary deliberately does
    not cover; the entrypoint's own wiring is pinned by a spawn-based test in
    `policy-coverage-detector.test.ts` instead.

    Why it mattered: with no canary AND (per mt#3393) no live receipt either —
    its records were resolving to a cwd-derived root and landing outside the
    repo — this detector had NEITHER half of the two-part coverage story. When
    the coverage-receipt gate below flagged it, nothing on either axis could
    distinguish a broken detector from a dormant one, and the resulting
    investigation opened on the wrong hypothesis (assumed-dead) for a
    mechanism that had in fact fired that morning.

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
write-failure). Beyond the unit tests, forced synthetic invocations of several of the REAL
hook scripts (run directly via `bun`, stdin-fed a crafted `ToolHookInput`, `MINSKY_STATE_DIR`
pointed at a scratch temp dir so no production state was touched) produced both outcomes
end-to-end against a real `fire-log.jsonl`:

```
{"guardName":"block-subagent-bypass-merge","event":"PreToolUse","decision":"deny", ...}
{"guardName":"dispatch-intent-write-gate","event":"PreToolUse","decision":"allow", ...}
{"guardName":"require-growth-justification-before-merge","event":"PreToolUse","decision":"allow", ...}
{"guardName":"block-nested-fork-dispatch","event":"PreToolUse","decision":"allow", ...}
{"guardName":"require-review-before-merge","event":"PreToolUse","decision":"allow", ...}
```

(the forced deny came from feeding `block-subagent-bypass-merge.ts` a `gh api PUT .../merge`
command with no override active; the allow entries came from feeding four different gates a
tool call outside their trigger condition — each gate's own early-exit path, not a single
script producing both outcomes).

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
  `checkDetectorCoverage`) reads a detector's calibration log and PASSES when ≥1 live
  receipt falls inside a rolling window (default 7 days). An entry explicitly labelled
  `truePositive:false` (a known false positive) does not count, so a detector firing only on
  FPs is still flagged. TP/FP labelling is not mechanized at write time in Phase 1 (RFC "no
  early labelling"), so an unlabelled live fire is treated as a receipt.
- **Three states, not two (mt#3502).** An EMPTY calibration log has two causes that demand
  opposite responses, and reporting both as FLAGGED — which is what this gate did until
  mt#3502 — makes the signal unactionable:

  | State                  | Records in window | Invocations in window | Reported    | Exits |
  | ---------------------- | ----------------- | --------------------- | ----------- | ----- |
  | `covered`              | ≥1                | (not consulted)       | `[OK]`      | 0     |
  | `dormant`              | 0                 | ≥1                    | `[DORMANT]` | 0     |
  | `no-liveness-evidence` | 0                 | 0 or unknown          | `[FLAGGED]` | 1     |

  Invocation evidence comes from the **fire log** (`recordFireLogEntry`, above), which
  records every guard invocation regardless of whether the guard fired — so it answers "does
  it still run" where the calibration log only answers "did it have anything to say". The
  canary is NOT a substitute: it calls the guard's exported pure decision function, so it
  proves the LOGIC works while saying nothing about whether anything invokes it (the
  mt#3019 / mt#3046 / mt#3308 dead-entry-point class). The three instruments are
  complementary — canary: does it decide correctly; fire log: does it run; calibration log:
  did it have anything to report.

  Both failure modes were live simultaneously when this shipped: `causal-premise` was
  FLAGGED with 3 lifetime records while the fire log showed it invoked minutes earlier, and
  `policy-coverage` read `[OK]` on borrowed records while appearing ZERO times in a 39 MB
  fire log (it is standalone, so it never got the dispatcher's automatic recording; mt#3502
  added an explicit `recordFireLogEntry` call).

- **The join is declared, never string-matched (mt#3502).** A calibration-log name and its
  guard name differ for real detectors — log `untaken-action` is guard
  `turn-end-untaken-action-scan`, `retrospective-trigger` is `turn-end-retro-scan` — and a
  name-matching first pass reported both as having zero invocations when they had 874 and 1531. The join key is `GuardRegistration.calibrationLog` (registry guards) and
  `StandaloneGuardCanary.calibrationLog` (standalone guards); `check-coverage-receipts.ts`
  builds the map from those declarations and NAMES any calibration log that resolves to no
  guard, rather than letting it silently read as a dead entry point.
- **The join is many-to-many in BOTH directions (mt#3519).** One log can be written by
  several guards (`operator-deferral`, `retrospective-trigger`), and one guard can write
  several logs — the execution-evidence merge gate writes `execution-evidence-at-coverage`
  itself and `execution-evidence-test-first` through `test-first-evidence.ts`, which it calls
  in-process. Either declaration field therefore accepts a string OR a list. When a
  REGISTRY guard declares a list, the FIRST entry is its primary log: the dispatcher writes
  that guard's one `outcome.calibration` record there and nowhere else, since writing one
  record to N logs would inflate every downstream fire count. The remaining entries exist
  purely so this join can find the guard's invocations.
- **A log written by something that is NOT a guard is its own category (mt#3519).**
  `ask-form-lint` is written by `src/adapters/shared/commands/ask-form-lint-calibration.ts`
  on the `asks_create` command path — it has no guard name, no dispatcher invocation, and no
  canary, so no declaration can reach it and it is NOT the "no guard declares this" defect
  the `Unmapped` line reports. `check-coverage-receipts.ts` carries a
  `NON_GUARD_CALIBRATION_PRODUCERS` map naming the producer, reports those logs on a
  `[NON-GUARD]` line, and EXCLUDES them from the coverage results entirely — `FLAGGED`
  asserts "no evidence the entry point ran", which for a log with no entry point to
  instrument is a false claim rather than a weak one. **A RETIRED producer gets the same
  treatment on the same reasoning (mt#4204):** `RETIRED_CALIBRATION_PRODUCERS` names logs
  whose producer was deleted on purpose while the log itself was kept as history, reported
  on a `[RETIRED]` line and likewise excluded. Without it, retiring a detector and keeping
  its log — which is what you want when the log is the evidence the retirement rested on —
  moves that log from `[DORMANT]` to `[FLAGGED]` permanently, because deleting the producer
  also deletes its only invocation-evidence join (mt#4197 is the originating case). This is
  NOT a mute for a detector that has gone quiet: a live producer with zero fires and zero
  invocations is the "shipped is not firing" defect, and still flags. Recording fire-log entries from the
  command path was rejected: the fire log is the GUARD invocation log (`guardName` is its
  identity field), and `src/` is bundled into the deployed MCP server, which must not import
  `.minsky/hooks/`.
- **Invocation path.** `scripts/check-coverage-receipts.ts` checks the UNION of every
  DECLARED detector (`calibrationLog` on `GUARD_REGISTRY` plus `STANDALONE_GUARD_CANARIES`)
  and every `.minsky/*-calibration.jsonl` on disk, prints an `[OK]`/`[DORMANT]`/`[FLAGGED]`
  report, and exits non-zero when any detector is flagged. **The declared half is load-bearing
  (mt#3742):** a detector that has never fired writes no file, so a disk-only scan cannot see
  it — and "no records at all" is the dead-entry-point symptom this gate exists to catch, so
  enumerating by presence-of-output made the check structurally blind to its own subject.
  The "nothing to check" early exit therefore gates on whether ANY calibration log exists on
  disk, not on the detector set: the union is never empty while any guard declares a log, and
  calibration logs are gitignored, so gating on the set would flag everything in a fresh clone. It runs at calibration-review cadence
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
  `HOOK_ONLY_ENV_VAR_CATEGORIES` and its derived `OPERATOR_OVERRIDE_ENV_VARS`,
  the override-classification oracle (mt#3882).
- `.minsky/hooks/known-override-env-vars.test.ts` — the equality check holding
  the hooks-tree copy to that oracle in both directions (mt#3882).
- mt#3078 — invocation-path audit that classified the merge-gate fire-log absence as by-design
  (not a wiring bug) and named the alternative evidence sources (see the dedicated section
  above); mt#3084 — the Phase-3 build-out task this classification filed.

## Tuning ownership and project scoping (mt#3518, 2026-08-01)

Two amendments to this document's original single-operator framing, both governed by the
beyond-Minsky RFC's 2026-08-01 amendment (Notion `37a937f0-3cb4-81ed-9a08-fbdeebd8845d`, §3
"Tuning-loop ownership") and the mem#802 principle (customers emit signal; the system/vendor
tunes; calibration review never routes to a customer):

- **Tuning ownership is now a registry field.** Every `GUARD_REGISTRY` entry carries
  `tuningOwnership: "invariant" | "preference" | "advisory"` (see the field's doc comment in
  `.minsky/hooks/registry.ts` for the class definitions and per-class decision surfaces), and
  `registry.test.ts` requires the stamp on every entry — new guards are classified at birth.
  Preference-class thresholds read their values via `readTunedThreshold` (`types.ts`), which
  resolves THREE sources in order (mt#3581): an explicit registered `MINSKY_*` env var wins,
  then a locally-tuned value from `.minsky/hooks/guard-tuning-store.ts`
  (`~/.local/state/minsky/guard-tuning.json`), then the shipped constant. The env var ranks
  first deliberately — a human typed that number, and an automatic tune must not silently
  overrule it. The tuned value is re-bounds-checked on read, so a hand-edited store cannot
  reach past the 10x ceiling the env path enforces. First instances:
  `MINSKY_WALL_OF_TEXT_WORD_BUDGET`, `MINSKY_SILENT_STRETCH_GAP_MINUTES`,
  `MINSKY_SILENT_STRETCH_TOOL_CALLS`. A state-dir file rather than `config.yaml` because
  guards run in the hook process, which is dependency-free (cannot load domain config) and
  which mt#1427's boot-cache would otherwise leave reading a stale value until a `/mcp`
  reconnect.
  Guards NOT yet migrated into the registry (the merge-gate stack and other
  settings.json-direct hooks, ADR-028 Phases 4–6) are uniformly **invariant**-class; they
  inherit a structural stamp when their phase migrates them.

- **Scoping decision for ingest (constrains mt#3334).** The storage decision above (one
  machine-local file) stands for the ON-DISK format — no JSONL schema change. Project scoping
  happens AT INGEST into the DB: stamped on write from the record's `cwd` (or the session's
  project), following the `resolveRunStateProjectId` precedent in
  `packages/domain/src/conversation-run-state/repository.ts` (nullable on resolution failure;
  ingest never blocks on it). This gives the ingested streams their second consumer —
  per-project calibration-signal aggregation for vendor-side tuning — without touching the
  emit path. Cold-start is the registry defaults: a project with zero fires gets shipped
  behavior; no local auto-adaptation ships yet.

**What consumes these streams for tuning (ADR-032, mt#3577).**
`docs/architecture/adr-032-guard-threshold-tuning-loop.md` decides how a threshold actually
moves, and separates three streams this document had treated as one: decision INPUTS (the
measured value a threshold was compared against — per-guard `.minsky/*-calibration.jsonl`),
decision OUTCOMES (this file's `allow`/`warn`/`deny` plus override consultation), and operator
RESPONSE (whether a fire changed behavior — recorded NOWHERE as of that ADR, and the reason its
first child task is an emitter rather than a tuner). The decider itself ships pure and inert at
`src/domain/calibration/threshold-tuning.ts`; it discards records written before 2026-07-29
(mt#3280's turn-attribution fix, commit `4b88d928c`) as a provenance boundary, which does not
affect the count-based reads the rationalization panel above performs.

## Laptop-freshness coupling (mt#4035, SC4)

The DB-ingested copy of this stream — and every other guard/calibration stream mt#4035's ingest
covers — carries the SAME freshness property as `agent_transcripts` (mt#2192/mt#2320's ADR-017
capture layer): **the data is only as fresh as the last time the operator's laptop was open and
running an ingest tick.** Both the SessionEnd hook
(`.minsky/hooks/guard-events-ingest-on-session-end.ts`) and the cockpit daemon sweep
(`startGuardEventsSweepBackstop`, `src/cockpit/sweepers.ts`) run ON the laptop, reading files
that live ON the laptop (`.minsky/*.jsonl` in the checked-out repo, and the state-dir streams
under `~/.local/state/minsky/`). A closed laptop means:

- No new fires are written to `guard_events` for any stream, because nothing runs the ingest.
- A cloud-side query over an ingested window (mt#4009's consumer, or mt#4035 AT3's "denials per
  guard per week" query) silently answers as of the last tick BEFORE the laptop closed — it has
  no signal that the laptop is closed, only that no new rows have landed.
- Re-opening the laptop and running one ingest tick (either invocation path) catches the gap up
  completely — nothing is lost, because the on-disk JSONL/JSON-array files (the system of record
  per the schema doc-comment) keep accumulating locally while the laptop is open and running
  Claude Code sessions; only the DB copy's freshness lags. A closed laptop also means no NEW
  local fires are being produced at all (the guard/hook dispatcher itself only runs during an
  active session), so "stale" here means "as of the last session," not "missing data that
  happened while closed."

This is the same shape mt#2320's ADR-017 module doc already names for transcripts; recorded here
so a miner reading THIS corpus's freshness guarantee does not have to cross-reference the
transcript path to learn it applies here too.

## Sweep-time claims on a calibration log (mt#4164)

`observability calibration-review` takes a **claim** on each review-due log at SWEEP time — before
it returns any records — so a second pass can see the first one working. Two passes classifying the
same window is pure waste: both read the same records, both file findings, and only one ack can
survive.

### Why the claim exists rather than the prose probe alone

`/calibration-review` Step 1 has carried a probe against this since R1: search for a tune task or
disposition ask already filed. That probe searches for **artifacts**, and a pass that is
mid-classification has filed none — classification is the entire expensive part and all of it is
upstream of any artifact. R3 (2026-08-16) is the demonstration: two passes over the same
`bare-entity-ref` window, filed one minute apart, the second's probe correctly finding nothing.

The probe is still useful for what the claim cannot see: a pass that already FINISHED and released.

### Store

`.minsky/calibration-review-claims.json` — repo-local, gitignored, a sibling of
`calibration-review-watermarks.json` and written under the **same** mkdir lock, so a claim and the
watermark it will later advance are never inconsistent.

```json
{ "<log path>": { "actorId": "...", "claimedAt": "<iso>", "lastRefreshedAt": "<iso>" } }
```

Freshness is **derived at read**, never stored. `presence.ts` states the reason: _"a stored
`presence = 'LIVE'` is a claim no writer can retract when the process dies mid-tool-call."_ A pass
killed mid-classification therefore ages out on its own, with no reaper to run. `CLAIM_STALE_MS` is
30 minutes, from observed sweep→ack spans of 4–10 minutes.

It is deliberately NOT the `presence_claims` table, though that table is grain-agnostic and would
have accepted a fourth `subject_kind`: the sweep is filesystem-only and runs in hook and CLI
contexts with no database bootstrap, and `presence_claims` backs an operator-facing fleet-state
surface that an internal coordination row has no business in (mt#2569).

### Result fields

| Field               | Meaning                                                                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claimedByOthers`   | Log paths another actor is classifying right now. These are EXCLUDED from `reviewDue` on a read pass — the pass stands down rather than duplicating the work. Empty on every uncontended run.                                             |
| `claimsUnavailable` | `true` when the runtime could not name this pass (`CLAUDE_AGENT_ID` / `CLAUDE_CODE_SESSION_ID` both absent). No claim was taken and none was honoured, so the pass runs with the pre-mt#4164 collision risk. Reported rather than silent. |

Text mode adds a `Stood down on N log(s)` block naming each holder and how long it has held.

### What the claim deliberately does NOT gate

**The ack.** A claim answers "who is WORKING"; the receipt (`reviewToken`, mt#3906) answers "what
was READ". Filtering the ack set by concurrent claims would conflate them, and a pass that
legitimately classified a log would be unable to RECORD that because someone else started working
on it in the interim — silently discarding real review work. `logsToActOn` keeps the two apart, and
its `isAck` branch is asserted by test.

**`driftedPaths` (mt#3899).** That is the after-the-fact DETECTION half and is unchanged. Detection
and prevention are not substitutes: a claim can be missing (unidentifiable runtime) or stale, and
the drift check is what still catches the resulting race.
