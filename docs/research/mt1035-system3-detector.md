# System 3\* Detector — Unasked-Direction Detection

**Task:** mt#1035
**Type:** Research / Design
**Status:** Draft (2026-04-22)
**Parent:** mt#1034 (Attention-Allocation Subsystem / ADR-006)

## Summary

Design recommendation for the mechanism that surfaces **preference-bound decisions an agent made without asking**. Four detector surfaces are compared; the recommendation is to ship the **policy-coverage detector** as v0.1, add the **diff-signature detector** as v0.2, defer the **trajectory probe** until v0.1+0.2 generate enough signature data to make it useful, and fold the **post-mortem transcript analyzer** into the `AuthorshipJudge` pattern (mt#969) as a second-pass at v0.3.

## Context

### The paradox

An agent cannot reliably introspect "I should ask here." Sonnet-class models optimize for producing answers; loss signal rewards confidence. The failure mode is exactly that the agent does not notice the gap. Therefore the detector must be **structural, not cognitive** — it observes the agent's trajectory from outside and flags mismatches mechanically.

This is Beer's variety-matching recursion: a System 3\* audit channel one level above the agent's own reasoning loop. The precedent is pre-commit hooks — variety attenuation for code quality. System 3\* applies the same move to **scope of authority**.

### Theory placement

`docs/theory-of-operation.md` flags System 3\* as the structured audit/probe channel that is currently missing. Lines 283–295 of that doc describe it as "a gap." The detector is the instrument that fills that gap. The ADR-006 Ask subsystem (mt#1034) consumes the detector's output: each detected gap becomes a `direction.decide` or `authorization.approve` Ask, classified, routed, and accounted for per ADR-006.

### Input contract

The detector produces **Ask intents** (pre-classification) that flow into the mt#1034 router. Intents have the shape described in ADR-006 §Detection. This task does **not** own the Ask entity, the router, or any transport — it owns only the detection mechanism.

## The four detector surfaces

Each surface is evaluated on: mechanism, cost, leverage, false-positive risk, implementation complexity, dependencies.

### Surface 1 — Policy-coverage detector

**Mechanism.** Pre-execution hook. Before any preference-encoding action (edit to a new file, introduction of an abstraction, addition of a dependency, change to a config default, renaming of a user-facing symbol), the detector mechanically checks whether existing policy covers the decision. Policy sources in order: task spec → CLAUDE.md → project rules (`.claude/rules/*`) → long-lived memories → future `.minsky/policy/*`.

Coverage rule (from ADR-006 §Router): an action is covered if policy **names the action or its category AND names the authority**. Name-match alone is insufficient.

If uncovered, the detector emits an `AskIntent(kind: "direction.decide")` and the agent blocks until the Ask is resolved.

**Cost.** Low. Pre-execution check against a bounded policy corpus. Runs synchronously before the action.

**Leverage.** High. Catches the exact failure mode (unasked direction) at the cheapest point in the lifecycle — before the change happens. Reversal cost if it fires correctly: zero (action hasn't happened yet).

**False-positive risk.** Moderate-to-high at v1. The strict coverage rule will over-escalate early. Specifically, the agent will hit this on routine actions that the user clearly trusts (standard refactors, boilerplate) because no policy document explicitly authorizes each. Calibration (see §Calibration and dismissal) must address this.

**Implementation complexity.** Medium. Requires:

- Identifying the hook point (PreToolUse is the natural slot; see §Hook integration)
- Classifying which actions are "preference-encoding" (the first filter — not every edit is a direction decision)
- Policy corpus loader (read the 5 sources; normalize)
- Coverage decision function (keyword + category match)
- Ask-intent emission into the mt#1034 router

**Dependencies.** mt#1068 (Ask entity), mt#1069 (Router). This detector is the first real producer for the router.

### Surface 2 — Diff signature detector

**Mechanism.** Post-edit scan. After an edit (PostToolUse hook or pre-commit), scan the diff for **unasked-direction signatures**:

| Signature                             | Example                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| New top-level names without precedent | A new `UserProfileBuilder` class in a file that had none of that naming pattern |
| Introduced abstractions               | Extracted helper + interface where the code previously had direct calls         |
| Tradeoff-encoding config              | `enableFooByDefault: true` — `true` vs `false` is a preference                  |
| UX-opinion copy                       | Error messages, user-visible defaults, tooltips                                 |
| Default value choices                 | Default `timeout = 30000` — the number is a decision                            |
| Terminology introductions             | A glossary-worthy term appears for the first time                               |

Each signature is a lightweight AST or regex rule (depending on file type). A hit emits an `AskIntent(kind: "direction.decide")` scoped to the specific line range.

**Cost.** Low-to-medium. Runs on the diff, not the whole tree. The signatures are cheap to compute. One run per edit.

**Leverage.** Medium-to-high. Catches directions that slipped past the policy-coverage filter (because no action was "blocked" to check policy against — the agent just edited). The after-the-fact nature makes reversal cost higher (the code exists already) but still much cheaper than post-merge discovery.

**False-positive risk.** Higher than surface 1, because signatures are heuristic. A `Builder` class might be precedented in the codebase even if it's new in this file; a default of `30000` might be imposed by an external API. Calibration must address this.

**Implementation complexity.** Medium-to-high. The signatures themselves are easy; the precedent-lookup that disambiguates false positives is the hard part (e.g., "is `Builder` already a pattern in this codebase?" requires reading the surrounding code).

**Dependencies.** mt#1068 (Ask entity), mt#1069 (Router), some form of codebase-context provider (read-only grep).

### Surface 3 — Trajectory probe (Socratic subagent)

**Mechanism.** Periodic in-flight checkpoint. At defined intervals (N tool calls, M minutes, or at lifecycle boundaries like "before commit"), a Socratic subagent is dispatched **in a separate context**. Input: a snapshot of the agent's trajectory (recent tool calls, edits, commit messages). Prompt: "What choices have you made that the spec did not dictate? Which are reversible? Who authorized them?"

The subagent produces a list of suspected unasked directions. Each entry becomes an `AskIntent`. The separate-context insight: a fresh reader catches what the original rationalized past.

**Cost.** High. Subagent dispatch per checkpoint. Token cost is meaningful.

**Leverage.** High — but only conditional on the other detectors missing things. At v1, the other detectors will catch most structural gaps; the probe's value is in catching subtler cases (narrative drift, scope creep within a single refactor).

**False-positive risk.** Low-to-moderate. A separate-context subagent with a sharpened prompt is better calibrated than heuristics, but still not perfect.

**Implementation complexity.** High. Requires:

- Trajectory snapshot packaging (agent-identity from mt#953; conversation history; edits; tool-use sequence)
- Subagent dispatcher (hook into the Task-tool pathway)
- Prompt engineering + eval loop to tune
- Integration with Ask router

**Dependencies.** Everything from surfaces 1 and 2, plus mt#441 (subagent system) and a trajectory-snapshot API that doesn't exist yet.

### Surface 4 — Post-mortem transcript analyzer

**Mechanism.** Async, runs after sessions merge. Same pattern as `AuthorshipJudge` (mt#969). Input: the full session transcript. Prompt: "What decisions were made in this session that the spec did not dictate? Were any of them preference-bound?" Output: structured list of unasked-direction findings with severity ratings.

Finds unasked directions that shipped. **These findings don't block merge** (too late for that) — they feed the signature library so surfaces 1 and 2 learn from real examples. System 4 loop on System 3\* output.

**Cost.** Low per-run (one LLM call per session, cheap with Haiku per mt#969 pattern). Doesn't block any hot path.

**Leverage.** Observational at v1. The direct leverage is indirect — the analyzer's outputs feed the other detectors' rule sets. High long-term leverage, low short-term.

**False-positive risk.** Moderate. Post-hoc analysis is always subject to "everything looks obvious in hindsight" bias. Human review of the analyzer's outputs is needed during v1 tuning.

**Implementation complexity.** Low-to-medium. The mt#969 `AuthorshipJudge` pattern is directly applicable; this is a sibling analyzer with a different prompt. Infrastructure (Vercel AI SDK, `generateObject` + Zod, post-merge hook slot) already exists.

**Dependencies.** mt#926 (transcript storage), mt#969 (AuthorshipJudge pattern). Not dependent on surfaces 1 or 2; it reads finished sessions.

## Comparison matrix

| Surface            | Cost        | Leverage                  | FP risk             | Complexity  | Dep on #1068/1069            | Standalone value                           |
| ------------------ | ----------- | ------------------------- | ------------------- | ----------- | ---------------------------- | ------------------------------------------ |
| 1 Policy-coverage  | Low         | High                      | Moderate-high at v1 | Medium      | Strong                       | Yes                                        |
| 2 Diff signature   | Low-med     | Medium-high               | Higher              | Medium-high | Strong                       | Yes                                        |
| 3 Trajectory probe | High        | High (conditional)        | Low-mod             | High        | Strong, plus mt#441          | Low at v1 (redundant with 1+2 initially)   |
| 4 Post-mortem      | Low per-run | Observational (long-term) | Moderate            | Low-medium  | None direct; mt#926 + mt#969 | Yes, different value (rule-library feeder) |

## Recommendation

### Starting set: **Surface 1 (Policy-coverage) + Surface 4 (Post-mortem)**

Two detectors at v0.1, positioned at opposite ends of the session lifecycle:

- **Surface 1 at session-start and each preference-encoding action.** Pre-execution; blocks the action. Catches ~70% of unasked directions at the cheapest point.
- **Surface 4 on merge.** Async; non-blocking; feeds the signature library. Catches what surface 1 missed, generates data to tune surface 2.

Defer **surface 2 (diff signature)** to v0.2, after surface 4 has produced 4–8 weeks of data about what the signatures should actually be. Building signatures from hypothesis before we have ground truth risks both false-positive noise and missed real directions.

Defer **surface 3 (trajectory probe)** to v0.3 or later. Its value is incremental on top of 1+2+4 and its cost is meaningful. Build it when the other three leave a diagnosable gap.

### Rationale for the split

- **Cheapest-first.** Surface 1 is pre-execution; surface 4 is offline. Neither costs real latency. Getting these two right first lets us measure false-positive rates without committing to the heavier surfaces.
- **Data-driven tuning of surface 2.** Surface 4's output is exactly the corpus that makes surface 2 calibratable. Without that corpus, surface-2 signatures are guesses.
- **Trajectory probe is expensive to build and expensive to run.** The v0.1 set will tell us whether the probe is needed at all, or whether the pre/post detectors are sufficient for the failure mode in practice.

## Detector interface

All four detectors share a single TypeScript interface. Each surface is a different implementation.

```typescript
// src/domain/detectors/types.ts

/** An unclassified signal that the agent may have made an unasked direction. */
export interface DetectionSignal {
  detectorId: string; // stable identifier: "policy-coverage", "diff-signature", etc.
  detectorVersion: string; // for reproducibility of judgments
  suspectedKind: "direction.decide" | "authorization.approve";
  severity: "low" | "medium" | "high"; // detector's own confidence; router may override
  summary: string; // short; rendered to operator
  evidence: Evidence[]; // concrete pointers: file:line, tool call, diff snippet
  suggestedQuestion?: string; // prompt the operator would answer; optional
  suggestedOptions?: AskOption[]; // decision frame; optional
  contextRefs: ContextRef[]; // from ADR-006
}

export interface Evidence {
  kind: "file-range" | "tool-call" | "diff-snippet" | "policy-gap" | "trajectory-step";
  payload: unknown; // shape depends on kind
}

/** All detectors implement this. */
export interface Detector {
  readonly id: string;
  readonly version: string;
  detect(ctx: DetectionContext): Promise<DetectionSignal[]>;
}

export interface DetectionContext {
  // The hook surface that triggered detection; different surfaces provide different shapes.
  surface: "pre-tool" | "post-tool" | "pre-commit" | "post-merge" | "in-flight-checkpoint";
  agentId: string; // mt#953 agent identity
  sessionId?: string;
  parentTaskId?: string;

  // Surface-specific payloads (discriminated union in practice)
  toolCall?: ToolCallContext; // pre-tool / post-tool
  diff?: DiffContext; // pre-commit
  transcript?: TranscriptContext; // post-merge
  trajectory?: TrajectoryContext; // in-flight-checkpoint
}
```

### Integration with the Ask router (ADR-006)

Each `DetectionSignal` is converted to an `AskIntent` at the boundary:

```typescript
// src/domain/detectors/router-bridge.ts
export function signalToAskIntent(signal: DetectionSignal, ctx: DetectionContext): AskIntent {
  return {
    kind: signal.suspectedKind,
    classifierVersion: signal.detectorId + "@" + signal.detectorVersion,
    requestor: ctx.agentId,
    title: signal.summary,
    question: signal.suggestedQuestion ?? signal.summary,
    options: signal.suggestedOptions,
    contextRefs: signal.contextRefs,
    parentTaskId: ctx.parentTaskId,
    parentSessionId: ctx.sessionId,
    metadata: {
      detectorId: signal.detectorId,
      severity: signal.severity,
      evidence: signal.evidence,
    },
  };
}
```

The router then applies policy-first resolution per ADR-006 §Router. Detection is "suggest," not "decide" — the router has final say on whether to escalate or resolve from policy.

## Hook-pipeline integration

Minsky has an established hook pipeline at `.claude/hooks/*.ts`. New hooks integrate here, ordered by execution time.

| Hook point         | Detector                            | Purpose                                                          |
| ------------------ | ----------------------------------- | ---------------------------------------------------------------- |
| `PreToolUse`       | Surface 1 (policy-coverage)         | Block preference-encoding tool calls until policy is consulted   |
| `PostToolUse`      | Surface 2 (diff signature) — v0.2   | Scan completed edits for unasked-direction signatures            |
| `pre-commit`       | Surface 2 (alternate slot) — v0.2   | Catches signatures just before commit if PostToolUse missed them |
| `Stop` / scheduled | Surface 3 (trajectory probe) — v0.3 | Periodic in-flight checkpoint                                    |
| `post-merge`       | Surface 4 (post-mortem) — v0.1      | Offline analysis; feeds rule library                             |

### Execution order for the v0.1 set

1. **`PreToolUse` — policy-coverage detector** runs first (in-line with the existing Claude Code hook chain). If it fires and the resulting Ask isn't policy-resolvable, the tool call is suspended, an Ask is opened, and the agent blocks.
2. **`post-merge` — post-mortem analyzer** runs asynchronously after a session's PR merges. Outputs are written to a ruleset analyzer log, not surfaced to the operator unless severity is high.

Both hooks integrate through existing slots — no new hook-runner infrastructure needed. The `PreToolUse` slot is a new hook file (`policy-coverage-detector.ts`); the `post-merge` slot already exists and gets a second hook (alongside `post-merge-pull.ts`).

### Preference-encoding action filter

Not every tool call needs the policy-coverage check. The filter (kept in the detector, not the router) fires only on:

- `Write`, `Edit`, `NotebookEdit` against new files, or against files the session hasn't touched before
- Tool calls matching configured "preference-encoding" patterns (new dependency, new config key, new user-facing string)
- Explicit opt-in via a `requires-direction` marker in the tool call (future)

Routine reads, greps, list-directory calls do NOT trigger the filter. Otherwise the detector would escalate on every search.

## Calibration and dismissal

False positives are a given at v1. The calibration model has three mechanisms.

### 1. Dismiss-and-remember

When the operator resolves a `direction.decide` Ask produced by the detector with a "no, this was fine" verdict, the system records a **dismissal signature** that matches the evidence pattern. Future detections matching the dismissal don't re-fire.

Dismissal storage: a dedicated row in the Ask log with `response.responder = "operator"`, `response.payload.action = "dismiss"`, and the evidence signature indexed for lookup. The detector consults dismissals as part of its decision function.

This is **per-project**, not global. A dismissal in one repo doesn't suppress the same signature in another. Scoped to `repoUrl` by default.

### 2. Severity downgrade on dismissal rate

If a detector rule fires with a dismissal rate above a threshold (proposal: 70%), its severity is automatically downgraded from `medium`/`high` to `low`, which the router can choose to log-only instead of escalate.

Downgrade is tracked on the detector's versioned ruleset; rule revisions get a fresh severity baseline.

### 3. Human rule review (surface 4 loop)

Surface 4's post-mortem outputs are reviewed periodically — proposed initial cadence: weekly, 15 min. Findings that correspond to real unasked directions (the reviewer agrees) become new signatures for surface 2 (when v0.2 ships). Findings that don't become dismissal seeds.

This is the System 4 loop: observational data (surface 4) → rule evolution (surfaces 1 and 2) → measurable false-positive reduction over time.

## Relationship to mt#503 (premature-completion guardrails)

mt#503's spec is currently empty (pre-existing data issue; noted in ADR-006). The conceptual relationship:

- **Same shape as this detector**: a meta-cognitive pattern that surfaces an agent failure mode the agent itself cannot reliably notice.
- **Different failure mode**: mt#503 targets "declaring a task done before it's actually done." Concrete example: the agent finishes 4 of 5 success criteria and declares victory. This is an `authorization.approve` kind of failure (acting — declaring completion — without the authority to do so) AND a `quality.review` kind (the self-review was inadequate).

### Shared infrastructure proposal

Both detectors should share:

- **The `Detector` interface** defined above
- **The router-bridge** that converts signals to ask intents
- **The dismissal storage** and severity-downgrade logic
- **The hook-pipeline integration pattern** (though at different hook points)

They should NOT share:

- **Signatures.** Premature-completion signatures are a different rule set (e.g., "PR body claims completeness but task spec has unchecked success criteria," "final commit lands without running acceptance tests," "task status set to DONE without `/review-pr` run").
- **Severity calibration.** Premature completion is a higher-severity failure (it ships incorrect claims), so its default severity should skew higher than unasked-direction detection.

### Action for mt#503

When mt#503's spec is populated, adopt the `Detector` interface from this research doc. The premature-completion detector becomes Surface 5 in the same system, not a separate system. Flag as a follow-up when the spec is written — this research doc does not attempt to design mt#503's specific signatures.

## Child tasks

The implementation decomposes into three child tasks, matching the recommendation order.

1. **Policy-coverage detector (v0.1)** — Surface 1. PreToolUse hook, policy-corpus loader, coverage decision, signal emission, dismissal storage.
2. **Post-mortem detector (v0.1)** — Surface 4. post-merge hook, `UnaskedDirectionAnalyzer` using the `AuthorshipJudge` (mt#969) pattern, output log, weekly review tooling.
3. **Shared infrastructure** — the `Detector` interface, router-bridge, dismissal store, severity-downgrade logic. Can be scoped as part of child #1 or broken out; breaking out is cleaner if mt#503 is being worked in parallel.

Surfaces 2 and 3 are deliberately not made into tasks yet — they're gated on v0.1 producing data.

## Connects to

- **Parent: mt#1034** — ADR-006 attention-allocation subsystem (Ask entity, router, transport bindings)
- **mt#503** — premature-completion guardrails (adjacent detector; follow-up when spec is written)
- **mt#969** — `AuthorshipJudge` (precedent for Surface 4 implementation)
- **mt#926** — transcript storage (dependency for Surface 4)
- **mt#441** — subagent system (dependency for Surface 3 if it lands)
- **mt#953** — agent identity (`agentId` in `DetectionContext`)
- **Theory of Operation** — `docs/theory-of-operation.md` §What's Missing (System 3\* gap this work fills)

## Open questions

- **Hook ordering when multiple detectors overlap.** If surface 1 passes a tool call and surface 2 (future) flags the resulting diff, do we emit two Asks or merge into one? Proposal: dedupe on evidence overlap; merge summaries. Revisit when surface 2 ships.
- **Cross-project dismissal transfer.** Per-project is simplest; is there demand for "dismiss globally"? Defer — wait for per-project to generate data.
- **Detector-to-detector confidence combination.** If two detectors fire on the same action, the signals' severities aren't automatically combined. v0.1 doesn't need this, but surface 3 (trajectory probe) will likely want it.
- **Operator-attention budget enforcement.** If the detector fires 20 times in an hour, is that a user-experience failure worth throttling? ADR-006 leaves budgets observational at v1; if surface 1 produces too many asks, the fix is tightening policy-coverage semantics (ADR-006 §9), not budget caps.

## Success criteria (mt#1035)

| Criterion from spec                                    | Status in this doc                                |
| ------------------------------------------------------ | ------------------------------------------------- |
| Research document comparing the four detector surfaces | §The four detector surfaces + §Comparison matrix  |
| Recommendation for starting set with rationale         | §Recommendation                                   |
| Detector interface specified                           | §Detector interface (TS types + router-bridge)    |
| Hook-pipeline integration plan                         | §Hook-pipeline integration (with execution order) |
| Calibration / dismissal model                          | §Calibration and dismissal (3 mechanisms)         |
| Scoped implementation follow-up task(s) created        | Child tasks filed alongside this doc (see commit) |
| Relationship to mt#503 documented                      | §Relationship to mt#503                           |
