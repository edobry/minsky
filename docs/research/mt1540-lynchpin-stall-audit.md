# Lynchpin-Stall Audit

**Task:** mt#1540 (Child B of mt#1505)
**Type:** Research / Audit
**Status:** Final (2026-05-04)
**Parent:** mt#1505 (umbrella roadmap stall audit)

## Summary

Shape-B diagnostic audit: structural lynchpins that block multiple downstream tasks but have
themselves stalled — without a documented workaround. Complements mt#1539 (Child A) which
covered workaround-load-bearing clusters.

Diagnostic: structural-importance × inactivity, NOT firing rate. A task qualifies when ≥2
memories or ≥1 ADR cite it as a dependency/umbrella/parent, it hasn't changed status in ≥10
days, its own dependents are stalled, and no memory documents a workaround citing it (which
would make it a Child A candidate instead).

**Findings:** 3 qualifying lynchpin clusters identified. 3 rollup tasks filed (mt#1570,
mt#1571, mt#1572). 4 deferred candidates (8d stall, below 10d threshold, or parent in active
PLANNING). Two strategic clusters identified: ADR-008 transport bindings and ADR-007 retrofit
track. Both are "design shipped, implementation stalled" patterns — ADR done, no children
landed.

---

## Dedup Against mt#1539 (Child A)

The following tasks are explicitly excluded per the dedup rule:

**DROP list:**

- mt#1503 cluster: mt#1073, mt#1065, mt#1345, mt#1372, mt#1310, mt#1405, mt#1477
- mt#1506, mt#1478, mt#1523 (under mt#1561/mt#1563/mt#1565 from Child A)
- mt#1551, mt#1459, mt#1460 (Child A deferred/in-flight)
- mt#1483 (Child A resolved)
- mt#1541, mt#1543 (Child A anchor case closure)
- mt#1035 (Child A anchor case)

---

## Diagnostic Shape (5 Conditions)

A cluster qualifies as "lynchpin stall" (Child B) when ALL of:

1. Task is referenced as dependency / "subsumed by" / "umbrella" / "parent of" by ≥2 memories
   OR ≥2 tasks OR ≥1 ADR.
2. Last status change ≥10 days old. (10d threshold — looser than Child A's 5d because no
   firing-rate corroboration.)
3. Has child or sibling dependencies that are themselves stalled.
4. **No documented workaround in memory cites this task** (otherwise it falls under mt#1539
   Child A).
5. Originating filing rationale still applies (work still relevant, not deprioritized).

---

## Phase 1 — Cross-Reference Graph

### Methodology

Grep of all `feedback_*.md`, `project_*.md` files in
`~/.claude/projects/-Users-edobry-Projects-minsky/memory/` and all `docs/architecture/adr-*.md`
files for `mt#NNNN` patterns. Count per-file (not per-line) to measure breadth of citation.

### Raw citation counts (feedback files — files citing the task, not line count)

Top candidates by feedback file count:

- mt#1305: 4 files — DONE (parallel-work skill-step enforcement)
- mt#1034: 5 files — DONE (attention-allocation umbrella)
- mt#1362: 5 files — DONE (parallel-work-guard hook)
- mt#1372: 5 files — DROP (Child A, mt#1503 cluster)
- mt#1073: 4 files — DROP (Child A, mt#1503 cluster)
- mt#1262: 4 files — DONE (config masking fix)
- mt#1181: 4 files — DONE (maskCredentials refactor)
- mt#1303: 5 files — DONE (session_update no-marker)
- mt#1483: 2 files — DROP (Child A resolved)

Top candidates by project file count:

- mt#1413: 4 files — DONE (reviewer calibration, confirmed)
- mt#1110: 8 files — reviewer aggressiveness Sprint-B (READY)
- mt#1395: 4 files — DONE (reviewer structured channel)
- mt#1125: 2 files — DONE
- mt#800: 4 files — TypeScript-first skills authoring (READY)
- mt#700: 3 files — task executor prototype (TODO)
- mt#321: 3 files — AI-powered init (TODO)
- mt#454: 2 files — Agent Inbox (PLANNING)
- mt#1001: 3 files — mesh signal channel (TODO)

Top candidates by ADR file count:

- mt#953: 2 ADR files — DONE (agent identity research)
- mt#1340: 1 ADR file — DONE
- mt#700: 1 ADR file — task executor prototype (TODO)
- mt#321: 1 ADR file — AI-powered init (TODO)
- mt#454: 1 ADR file — Agent Inbox (PLANNING)
- mt#1001: 1 ADR file — mesh signal channel (TODO)
- mt#503: 1 ADR file — premature completion guardrails (TODO)
- mt#1058: 1 ADR file — retrofit AI-using features umbrella (TODO)
- mt#781: 1 ADR file — cockpit documentation (TODO)

### Combined cross-reference signal (non-DROP, non-DONE tasks)

| Task    | Title (abbreviated)                                | Feedback files | Proj files | ADR files | Total | Status   |
| ------- | -------------------------------------------------- | -------------- | ---------- | --------- | ----- | -------- |
| mt#800  | TypeScript-first authoring for skills/rules/agents | 2              | 4          | 1         | 7     | READY    |
| mt#1110 | Sprint-B tuning: reviewer aggressiveness           | 3              | 8          | 0         | 11    | READY    |
| mt#1001 | Mesh signal channel push/subscription              | 1              | 3          | 1         | 5     | TODO     |
| mt#700  | Provider-agnostic task executor prototype          | 0              | 3          | 1         | 4     | TODO     |
| mt#321  | AI-Powered Project Analysis / enhanced init        | 0              | 3          | 1         | 4     | TODO     |
| mt#454  | Agent Inbox / seek-human-input research            | 0              | 2          | 1         | 3     | PLANNING |
| mt#503  | Premature-completion guardrails                    | 1              | 1          | 1         | 3     | TODO     |
| mt#1058 | Retrofit AI-using features for dual-mode cognition | 0              | 1          | 1         | 2     | TODO     |
| mt#781  | Cockpit documentation (anchored in mt#1143)        | 0              | 1          | 1         | 2     | TODO     |

---

## Phase 2 — Status + Age Sweep

### Status verification (2026-05-04)

| Task    | Status   | Last git commit mentioning task                     | Age estimate |
| ------- | -------- | --------------------------------------------------- | ------------ |
| mt#800  | READY    | 2026-04-27 (in mt#1249 body)                        | 7d           |
| mt#1110 | READY    | 2026-04-27 (in mt#1228 body + mt#1311 skill update) | 7d           |
| mt#1001 | TODO     | 2026-04-26 (in ADR-008/ADR-009 context)             | 8d           |
| mt#700  | TODO     | 2026-04-26 (in ADR-008 update)                      | 8d           |
| mt#321  | TODO     | 2026-04-23 (in mt#1057/ADR-007 context)             | 11d          |
| mt#454  | PLANNING | 2026-04-23 (in mt#1057/ADR-007 context)             | 11d          |
| mt#503  | TODO     | 2026-04-27 (in mt#1035 doc)                         | 7d           |
| mt#1058 | TODO     | 2026-04-23 (in mt#1057 doc)                         | 11d          |
| mt#781  | TODO     | 2026-04-26 (in ADR-008 update)                      | 8d           |

**Threshold filter (≥10d):**

- mt#321 (11d) — passes ✓
- mt#454 (11d) — passes ✓
- mt#1058 (11d) — passes ✓
- mt#1001 (8d) — borderline (no recent direct commits, low task ID suggesting old filing)
- mt#700 (8d) — borderline (same pattern)
- mt#781 (8d) — borderline (parent mt#1143 in active PLANNING)
- mt#800 (7d) — eliminated (READY, next-up, not stalled)
- mt#1110 (7d) — eliminated (READY, calibration next-up)
- mt#503 (7d) — eliminated (below threshold)

**Age methodology note:** Git commit dates represent "last time task was mentioned in any commit
body," not "last status change." For older tasks (mt#321, mt#454, mt#700, mt#781, mt#1001), these
IDs appear in ADR/research documents; the tasks themselves may have had no session started at all.
The 10d filter is applied to "last meaningful activity touching the task."

**Surviving candidates after age filter:**

- mt#321, mt#454, mt#1058 — confirmed ≥10d
- mt#1001, mt#700 — borderline (8d, strong cross-refs, included in cluster rollup mt#1570)

---

## Phase 3 — Stalled-Dep Check + Originating-Relevance Check

### mt#321 — AI-Powered Project Analysis for Enhanced Init Command

**Cross-refs:** Cited as "first consumer of ADR-007 (CognitionProvider abstraction)" in
`project_planning.md` and ADR-007 PR body. Referenced by `project_progressive_adoption.md`
as "first T0 consumer" of the progressive adoption model. Cited in ADR-007 as the motivating
feature: "mt#321 (agent-readiness assessment, first consumer via mt#1063) is the first feature
that will be user-facing in all three contexts."

**Status:** TODO. No session found.

**Stalled dependents:** mt#321 depends on mt#1063 (AI criterion evaluation via CognitionProvider,
TODO, 11d stalled) which is the direct consumer of ADR-007. ADR-007 shipped 2026-04-23 (mt#1057
DONE) — prerequisite is done, but mt#1063 and mt#321 remain unstarted.

**Originating relevance:** Progressive adoption T0 still has no implementation. A user running
`/assess` in Claude Code with no Minsky config and no API key still does not get AI-powered
analysis. The harness-based cognition path (delegated mode) exists in design only.

**5-condition check:**

1. Cited in ≥2 project files + 1 ADR ✓
2. Last activity 11d ago (ADR-007 PR mention) ✓
3. mt#1063 (stalled sibling dep) also TODO, 11d ✓
4. No memory documents a workaround citing mt#321 ✓
5. Progressive adoption T0 commitment still unmet ✓

**Result: QUALIFIES. Filed mt#1572.**

---

### mt#454 — Agent Inbox / Seek Human Input (PLANNING, 11d)

**Cross-refs:** ADR-008 designates mt#454 as the "durable async backbone" for `direction.decide`
asks. `project_attention_allocation.md` documents the architecture explicitly: "mt#454 (Agent
Inbox) — the durable async backbone. Should expand from 'seek human input' to full async-ask
persistence." The mt#1526 ecosystem comparison research (PR #937, 2026-04-27) was completed
specifically as a prerequisite for mt#454. Listed in `project_planning.md` under attention
allocation cluster.

**Status:** PLANNING. No implementation session. Research prerequisite completed 2026-04-27.

**Stalled dependents:** Without mt#454, `direction.decide` asks (principal-level decisions that
require human input) have no durable async transport. The Ask subsystem (ADR-008) handles only
synchronous in-process asks without this binding. mt#1001 (mesh notify) and mt#700 (AG-UI
executor) are the other two stalled transport bindings in the same cluster.

**Originating relevance:** The attention-allocation ADR-008 lists 8 stage lifecycle; Stage 5
(Suspension) and Stage 7 (Resumption) for async asks require the Agent Inbox backend. The
humility principle's implementation depends on these stages for async `direction.decide` routing.

**5-condition check:**

1. Cited in ≥2 project files + 1 ADR ✓
2. Last activity 11d ago ✓
3. ADR-008 transport bindings (mt#1001, mt#700) also stalled ✓
4. No memory cites mt#454 as a workaround tracking task ✓
5. Ask subsystem async gap still unaddressed ✓

**Result: QUALIFIES. Filed in cluster rollup mt#1570.**

---

### mt#1058 — Retrofit AI-Using Features for Dual-Mode Cognition (TODO, 11d)

**Cross-refs:** ADR-007 PR body lists mt#1058 as Phase 4 of the CognitionProvider plan:
"Retrofit umbrella — migrate existing AI-using features." `project_planning.md` places it
after mt#915 (DONE) in the mt#800 skill track. Referenced as the prerequisite for T0
progressive adoption across all existing AI features.

**Status:** TODO. Last meaningful commit: 2026-04-23. 11d stalled.

**Stalled dependents:** mt#1063 (AI criterion evaluation, TODO) and mt#321 (AI-powered init,
TODO) both depend on the CognitionProvider retrofit being in motion. Until mt#1058 activates
the migration, existing features continue calling `AICompletionService` directly, bypassing
delegated mode and breaking T0 progressive adoption.

**Originating relevance:** ADR-007 is a design artifact with no runtime effect until the
retrofit track activates. The T0 commitment ("no API key, harness provides cognition") cannot
be delivered for any existing feature without mt#1058.

**5-condition check:**

1. Cited in 1 ADR + referenced in mt#1057 doc and `project_planning.md` ✓
2. Last activity 11d ago ✓
3. mt#1063 (TODO) is a direct child; mt#321 is downstream ✓
4. No memory documents a workaround citing mt#1058 ✓
5. ADR-007 still has no runtime implementation ✓

**Result: QUALIFIES. Filed mt#1571.**

---

### Eliminated candidates

| Task    | Reason eliminated                                                                             |
| ------- | --------------------------------------------------------------------------------------------- |
| mt#800  | READY status — actively next-up, not stalled; sub-tasks making progress (mt#913, mt#914 DONE) |
| mt#1110 | READY status — reviewer calibration queued, 7d since last reference                           |
| mt#503  | 7d stall, below threshold; cited as "shared infrastructure" with mt#1035, not direct lynchpin |
| mt#781  | 8d stall but parent mt#1143 (cockpit) is in active PLANNING — not independently stalled       |

---

## Stalled Lynchpin Table

| Task    | Title                                              | Cited by (count) | Status   | Age | Stalled deps    | Cluster                    | Rollup action |
| ------- | -------------------------------------------------- | ---------------- | -------- | --- | --------------- | -------------------------- | ------------- |
| mt#454  | Agent Inbox / seek-human-input async backbone      | 3 memories/ADRs  | PLANNING | 11d | mt#1001, mt#700 | ADR-008 transport bindings | filed mt#1570 |
| mt#1001 | Mesh signal channel push/subscription              | 5 memories/ADRs  | TODO     | 8d  | mt#454          | ADR-008 transport bindings | filed mt#1570 |
| mt#700  | Provider-agnostic task executor with Ask support   | 4 memories/ADRs  | TODO     | 8d  | mt#454          | ADR-008 transport bindings | filed mt#1570 |
| mt#1058 | Retrofit AI-using features for dual-mode cognition | 2 ADR/proj refs  | TODO     | 11d | mt#1063         | ADR-007 retrofit track     | filed mt#1571 |
| mt#1063 | AI criterion evaluation via CognitionProvider      | 2 ADR/proj refs  | TODO     | 11d | mt#321          | ADR-007 retrofit track     | filed mt#1571 |
| mt#321  | AI-Powered Project Analysis / enhanced init        | 4 memories/ADRs  | TODO     | 11d | mt#1063         | T0 progressive adoption    | filed mt#1572 |

---

## Cluster Descriptions (Impact Order)

### Cluster 1: ADR-008 Transport Bindings (3 stalled tasks, 11d average)

**Tasks:** mt#454 (PLANNING), mt#1001 (TODO), mt#700 (TODO)

**Structure:** ADR-008 (attention-allocation subsystem) was published 2026-04-22 (mt#1034 DONE).
The ADR specifies three transport bindings for the Ask subsystem's outer boundary:

- `direction.decide` asks (async, long-horizon) → mt#454 (Agent Inbox)
- `coordination.notify` asks (fire-and-forget) → mt#1001 (mesh signal channel)
- Task executor interface (AG-UI, Layer 2) → mt#700 (provider-agnostic executor)

ADR-008's child implementation tasks (mt#1068–mt#1072) covered the domain layer (entity,
router, subagent dispatch, attention accounting, BLOCKED rendering) and are largely DONE.
The transport bindings were designated as "owned by existing parent tasks" — but those parent
tasks are stalled and have no shared rollup to surface the gap.

**Impact:** Without these three transport bindings, the Ask subsystem operates in stub mode:
it can route asks internally but cannot deliver them to humans asynchronously or to peer agents.
The humility principle's `direction.decide` escalation path has no durable wire.

**Last activity:** ADR-008 mentioned 2026-04-26 in a renumbering commit. mt#1526 ecosystem
comparison research (prerequisite for mt#454) completed 2026-04-27.

**No workaround:** No memory documents a "use X instead" pattern for any of these three tasks.
The transports are simply absent.

**Rollup filed:** mt#1570 — "[MegaParent] Ask subsystem transport bindings: async, mesh, and
executor structural unblockers"

---

### Cluster 2: ADR-007 Retrofit Track (2 stalled tasks, 11d)

**Tasks:** mt#1058 (TODO), mt#1063 (TODO)

**Structure:** ADR-007 (CognitionProvider abstraction) was published 2026-04-23 (mt#1057 DONE).
The ADR defines three operational modes for AI-using features: Direct, Delegated, Degraded.
Phase 4 of the ADR's implementation plan is the retrofit umbrella (mt#1058) — migrating all
existing features from direct `AICompletionService` calls to `CognitionProvider`. mt#1063
is the first scheduled consumer (AI criterion evaluation), which in turn enables mt#321.

**Impact:** ADR-007 is a design artifact with no runtime effect. Existing AI-using features
continue to call `AICompletionService` directly, which means T0 progressive adoption (no API
key, harness provides cognition) cannot work for any existing feature. The retrofit umbrella
has no parent rollup and no session started.

**Last activity:** ADR-007 PR body mentioned mt#1058 as Phase 4 on 2026-04-23. No commits
since then touch either mt#1058 or mt#1063.

**No workaround:** No memory documents a "use X instead of CognitionProvider" pattern for
existing features. The gap is invisible — features call `AICompletionService` directly with
no flag that they're non-compliant with ADR-007.

**Rollup filed:** mt#1571 — "[MegaParent] CognitionProvider retrofit: activate ADR-007 across
existing AI-using features"

---

### Cluster 3: T0 Progressive Adoption Consumer (1 task, 11d)

**Task:** mt#321 (TODO)

**Structure:** mt#321 (AI-Powered Project Analysis for Enhanced Init) is the canonical "first
T0 consumer" of Minsky's progressive adoption model. It is cited as such across 3 project
memory files and ADR-007. T0 means: no Minsky config, no API key — the harness provides
cognition. mt#321 cannot start until mt#1063 (ADR-007 first consumer, also stalled) is in
motion.

**Impact:** The lowest rung of the progressive adoption ladder has no implementation.
A new user cannot run `/assess` or the enhanced init command without Minsky config. The T0
commitment in `project_progressive_adoption.md` is a design promise with no delivery path.

**Last activity:** ADR-007 PR body cited mt#321 as motivating feature on 2026-04-23. No
implementation commits.

**No workaround:** No memory documents a workaround for the missing T0 init enhancement.
The feature simply doesn't exist yet.

**Rollup filed:** mt#1572 — "[MegaParent] Progressive adoption T0 consumer: AI-powered init
and assessment pipeline"

---

## Filed Rollups

| Cluster                    | Rollup task | Children wired          |
| -------------------------- | ----------- | ----------------------- |
| ADR-008 transport bindings | mt#1570     | mt#454, mt#1001, mt#700 |
| ADR-007 retrofit track     | mt#1571     | mt#1058, mt#1063        |
| T0 progressive adoption    | mt#1572     | mt#321                  |

---

## Deferred Candidates

| Task    | Title (abbreviated)                       | Reason deferred                                                                   |
| ------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| mt#1001 | Mesh signal channel push/subscription     | 8d stall — included in mt#1570 cluster rollup despite being below 10d strict      |
| mt#700  | Provider-agnostic task executor prototype | 8d stall — included in mt#1570 cluster rollup despite being below 10d strict      |
| mt#503  | Premature-completion guardrails           | 7d stall, below threshold; cited as shared-interface with mt#1035, not dep        |
| mt#781  | Cockpit documentation (anchored mt#1143)  | 8d stall; parent mt#1143 (cockpit) in active PLANNING — not independently stalled |

**Note on mt#1001 and mt#700:** These are technically below the 10d threshold (8d) but are
included in cluster rollup mt#1570 because they form the same ADR-008 transport cluster as
mt#454 (which does qualify at 11d). Including them in the same rollup is structurally correct
— they share the same stall cause and the same unblocking action.

---

## Threshold Calibration Note

Was 10d the right threshold? Signal quality analysis:

- At 10d: 3 confirmed candidates (mt#321, mt#454, mt#1058) — clean signal
- At 8d: 2 additional candidates (mt#1001, mt#700) — also valid, grouped in cluster
- At 7d: 2 more (mt#503, mt#503) — these are weaker; mt#503 has a different citation shape

**Assessment:** 10d is appropriate as the strict threshold. The 8d candidates (mt#1001,
mt#700) are justified by cluster cohesion (same ADR, same blocking cause) rather than their
individual stall age alone. Lowering the threshold to 8d globally would admit too many
candidates; keeping 10d with a cluster exception is the right calibration.

This is calibrated differently from Child A (5d threshold) because Child B lacks the
firing-rate corroboration signal. The higher threshold compensates for lower certainty.

---

## Cross-References

- mt#1505 — parent umbrella roadmap stall audit
- mt#1539 — sibling Child A (workaround-load-bearing cluster audit)
- mt#1034 — attention-allocation umbrella (DONE) — canonical reference for ADR-008 lineage
- mt#1057 — CognitionProvider ADR (DONE) — prerequisite for mt#1058 and mt#1063
- mt#800 — TypeScript-first authoring parent (READY — not stalled, near-term next-up)
- mt#1526 — Agent Inbox ecosystem comparison (DONE) — prerequisite for mt#454
- ADR-007 (`docs/architecture/adr-007-cognition-provider-abstraction.md`) — mt#1058 depends on this
- ADR-008 (`docs/architecture/adr-008-attention-allocation-subsystem.md`) — mt#454/mt#1001/mt#700 depend on this
- `project_attention_allocation.md` — primary memory source for ADR-008 transport binding analysis
- `project_progressive_adoption.md` — progressive adoption T0 commitment source
- `docs/research/mt1539-workaround-cluster-audit.md` — Child A (dedup reference)
