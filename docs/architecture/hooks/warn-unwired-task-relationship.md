# `warn-unwired-task-relationship`

A task spec states a relationship to another task in prose — _"hard prerequisite for mt#4556"_,
_"feeds mt#2258"_, _"is part of mt#2230"_ — and the matching structural edge is never wired.

Task **mt#2264**. Family root **mem#530** (imprecise-structure-encoding). Record-only at ship.

## The failure is a confident wrong answer, not silence

This is the part worth internalising, because it decides both the priority and the seam.

The obvious reading of an unwired edge is that the graph stays _quiet_ about a relationship — the
related task simply never surfaces as next-work. That reading is wrong, and it understates the cost
by a lot. Two shipped consumers derive their answers from graph edges alone:

- **`tasks_orchestrate`** computes `blockedBy` purely from `listDependencies`
  (`src/adapters/shared/commands/tasks/orchestrate-command.ts:96-114`). A child with no edges is
  therefore reported as `ready: true, blockedBy: []`.
- **`tasks_available`** scores readiness as
  `totalDeps === 0 ? 1.0 : completedDeps / totalDeps`
  (`packages/domain/src/tasks/task-routing-service.ts:130`), so a task with no edges ties at a
  perfect 1.0 with one whose dependencies have all completed.

So an unwired prerequisite does not produce a gap. It produces a **positive assertion that blocked
work is dispatchable**, from the primitive whose entire job is to answer that question.

The measured instance (mem#530 R4, 2026-08-25): filing umbrella mt#4553 and four children, the
dependency ordering was written in prose in three separate places and `tasks_deps_add` was never
called. `tasks_orchestrate mt#4553` reported:

```
2 of 2 subtask(s) ready for dispatch
  mt#4554  ready: true,  blockedBy: []
  mt#4557  ready: true,  blockedBy: []
```

Both were blocked. After wiring four edges the same call returned `0 of 2`.

**The agent this targets is the one following the correct procedure** — consulting the graph rather
than reading specs — and the cost rises precisely as orchestration is trusted more. mt#4571 (an
unattended supervisor walking a task DAG) is the direction that makes it expensive, which is why it
carries a hard dependency on this task.

## Why a guard, after four recurrences of discipline

R1–R4 span 84 days. mem#530's own access log shows it was read at 15:37Z on 2026-08-25 and the
children were filed at 15:52–15:55Z — the memory tier had its chance inside the same quarter-hour
and the class recurred anyway. Whether it rendered into the filing agent's context cannot be
established from an access timestamp, so treat that as suggestive rather than proven; the argument
does not depend on it. Four recurrences of a memory-tier fix is the argument.

## Mechanism

### Seam

PreToolUse on the whole spec-authoring seam:
`tasks_create | tasks_spec_patch | tasks_edit | tasks_spec_search_replace` — the same four tools
`claim-provenance-scan` covers, and for the same reason: R4 was four `tasks_create` calls, but
mem#530's R2 wrote its prose into an **existing** spec, which cannot go through create.

The spec body is resolved through `readAuthoredSpecText` (mt#4525), so a `tasks_edit --spec-file`
write is scanned rather than silently missed.

### The two halves are asymmetric on purpose

Following `evidence-provenance-table.ts`'s framing:

| Half                                  | A miss here is                                                                 | So it is               |
| ------------------------------------- | ------------------------------------------------------------------------------ | ---------------------- |
| **Recognizing** an assertion in prose | a false NEGATIVE — an unwired edge goes unflagged, which is today's status quo | narrow, deliberately   |
| **Discharging** it                    | a false POSITIVE at an author who wired the edge correctly                     | exact, never heuristic |

Because the discharge half is exact at every seam, **precision is bounded by the recognition half
alone.** That is what keeps this guard off ADR-024's ladder: there is no paraphrase axis on the
discharge side to climb it for.

### Recognition (ADR-024 Rung 1)

`elideQuotedAndCodeContexts` blanks fenced blocks, inline code spans, blockquotes and
double-quoted prose with same-length whitespace, so offsets survive and a spec _discussing_ a
relationship — a gate report, a quoted incident narrative, this page — does not read as asserting
one.

On the residual, a phrase and a task id pair when they sit within `ASSERTION_WINDOW_CHARS` (80) of
each other, in **either** direction. Both directions are real: R4's own text is
`(mt#4556, hard prerequisite for SC2)` with the id first, while mem#530's worked example is
`mt#2257 feeds mt#2258` with one on each side. A single-direction window would have missed the
incident that motivated the guard.

**The phrase set is sampled from real specs, never invented.** Every entry in
`RELATIONSHIP_PHRASES` appears verbatim in mem#530 or its R4 entry. A guessed vocabulary has high
recall against text nobody writes and none against the text that produced the incident (mem#530 R4
design note 2).

Two suppressions beyond elision, both bounded:

- **Leading negation** — `NEGATION_LEAD_RE`. Adapted from
  `operator-deferral-detector.ts`'s `NEGATION_LEAD_PATTERN` rather than imported: that constant
  deliberately omits a bare `no`/`not`, which is right for its subject matter and wrong here.
  mt#2264's own spec contains _"**No dependency edge to mt#2258**"_ — a deliberate non-edge stated
  as a bare determiner, and exactly the case that must not fire.
- **Negating complement** — `NEGATING_COMPLEMENT_RE`, the direction a lookback cannot see
  (_"waits on nothing in mt#N"_). Precedent: mt#4483 fixed the same blind spot in
  `ask-routing-deferral-detector.ts`, whose own constant is module-private and tuned to that
  detector's verbs, so this one is re-derived rather than imported.

A spec naming **its own** id in a relationship phrase is describing itself; there is no self-edge to
wire, so it is excluded.

### Discharge

| Seam                 | Source of truth                                                                                            | Cost                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `tasks_create`       | the call's own `dependsOn` (string or array) and `parent`                                                  | none — the task does not exist yet, so the payload IS the complete edge set |
| the three edit seams | one query against `task_relationships` for `from_task_id`, which carries both axes discriminated by `type` | one indexed lookup behind `GRAPH_READ_TIMEOUT_MS`                           |

**A graph-read failure is `skipped`, never `clean`.** An unreachable database that returned "no
edges" would make every assertion look unwired — an outage would render as a burst of confident
false positives at exactly the moment nobody can check them.

The graph is only consulted when the spec actually states a relationship; a spec with no assertion
returns before any IO. That is why the guard's 12s budget dominates its dispatcher entry's derived
sum while costing nothing on the common path.

### The axis matters, and the advisory says which

mem#530's two axes are orthogonal, and conflating them is R3 of the family:

- **dependency** (data-flow / blocking) — "do A before B". `tasks_deps_add`.
- **parent/child** (decomposition) — "B is one component of A". `parent:` at create, or
  `tasks_reparent`.

A phrase is tagged with the axis it implies, and discharged only by the matching edge — except
`unclear` (`follow-up to mt#N`), which is discharged by **either**. The guard cannot tell which axis
that author meant, so demanding the one it guessed would fire at someone who wired the other, which
is exactly what mem#530 asks for.

## Posture

Record-only (`recorderEffect()` alone, `denyCapable: false`, `tuningOwnership: "advisory"`),
calibration log `unwired-task-relationship`.

`INJECTION_ENABLED` is `false` at ship, and `buildAdvisory` is wired to that flag rather than left
unreferenced — so the copy is exercised by tests today and cannot rot into the
"present, tested, green, and inert" shape. Graduation is gated on a replay measuring the recognition
half against ADR-024 sign-off (b)'s 0-known-false-positive bar. The precedent is
`claim-provenance-scan`, held recorder-only on a measured ~6% precision: injecting below that bar is
mem#719's failure mode, and it would fire hardest at the most careful authors.

Attention cost is **measured at 958 chars** via `renderProbe`, with all three rendered dimensions
saturated at once — the capped list, the overflow suffix, and one remedy line per axis present. It
is a proved ceiling rather than a sample because every dimension is bounded, and the module's own
test asserts `renderWorstCase().length` against the registration's declared `attentionCost`, so the
two cannot drift the way `turn-end-unwalked-task-scan`'s comment did (470 claimed, 519 actual).

## Override

`MINSKY_HOOK_OVERRIDE=warn-unwired-task-relationship`.

**No bespoke `MINSKY_SKIP_*` var, deliberately.** ADR-028 D3's consolidation was re-confirmed by the
operator on 2026-08-20 (ask#9323, _"Consolidate to one variable"_), with execution owned by mt#4428;
the `operator-override` population has gone 34 → 99 since D3 was accepted. The module contains no
override check at all — `dispatcher.ts:1062` calls `checkOverride(reg.name, …)` for every registered
guard before invoking it.

mt#2264's spec originally required a new `HOOK_ONLY_ENV_VARS` entry; it was filed 2026-06-02, before
that policy, and the planning pass corrected it.

## What this guard does NOT do

- **Auto-wire the edge.** Warn only — the author picks the axis and the direction. Guessing would
  reintroduce the axis confusion the advisory exists to prevent.
- **Deny.** Never, on any path.
- **Make the task graph well-formed in general.** The draft RFC _backlog prioritization_
  (Notion `3ae937f0`, 2026-07-31) measured 407 of 725 open tasks with no edge in either direction,
  and records that the graph-reorganization track was CLOSED rather than completed. This guard
  targets the far narrower subset where the author has already NAMED the relationship — which is
  where the edge is most likely to be correct.
- **Catch a write that never reaches a PreToolUse guard.** A spec written through the CLI reaches
  the DB via a subprocess; that hole is mt#4536's.

## Cross-references

`mem#530` (family root, R1–R4) · `.minsky/hooks/claim-provenance-scan.ts` (same seam, same shape) ·
`docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md` (Rung 1 and the
calibration-first posture) · `docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md` D3
(the override) · `docs/architecture/adr-042-gate-battery-enforcement-shape.md` (why the write seam) ·
**mt#4571** (the unattended DAG supervisor, which depends on this) · **mt#4536** (the CLI-write hole).
