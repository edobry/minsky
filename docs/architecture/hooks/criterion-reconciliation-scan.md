# `criterion-reconciliation-scan`

**Task:** mt#4213 · **Event:** `PreToolUse` · **Posture:** record-only (calibration-first per
ADR-024) · **Override:** `MINSKY_SKIP_CRITERION_RECONCILIATION=1`

## What it records

A spec write that **explains a criterion is unmet while leaving that criterion's own normative text
untouched in the same revision**.

Both halves land in the same write, and usually in the same patch:

- an assertion that a criterion is unmet — exact substrings only (`is not satisfied`,
  `cannot be satisfied`, `unsatisfiable`, `not met`, …) — naming or adjacent to a criterion id
  (`SC<n>` / `AT<n>`);
- **and** no entry for that criterion in the write's own `## Success Criteria` /
  `## Acceptance Tests` section.

## Why it exists

Four times between 2026-08-12 and 2026-08-19, an implementer who could not satisfy a criterion
wrote the reconciliation somewhere that does not GOVERN — a spec `## Outcome`, an appended
`### Acceptance Tests — amended` block — and left the criterion's own line saying the opposite.
`minsky-reviewer[bot]` read the untouched line and posted BLOCKING each time.

| R   | Date       | Task / PR          | Where the reconciliation landed      | Cost           |
| --- | ---------- | ------------------ | ------------------------------------ | -------------- |
| R1  | 2026-08-12 | mt#4038 / PR #2914 | spec `## Outcome` (non-normative)    | 1 review round |
| R2  | 2026-08-16 | mt#4076 / PR #3047 | PR body only — **out of scope here** | 1 review round |
| R3  | 2026-08-17 | mt#4162 / PR #3053 | appended spec section                | 1 review round |
| R4  | 2026-08-19 | mt#4320 / PR #3161 | `### Acceptance Tests — amended`     | 1 review round |

The prose tier (mt#2504, `/implement-task` §7 item 5) is DONE and **all four post-date it**. R3 and
R4 each failed roughly 90 minutes after the same agent applied the rule correctly in the same
session — which is what makes prose the wrong tier rather than an under-rehearsed one.

## Why this seam

ADR-042 fixes the discriminator: _"the per-gate question is not should we mechanize it? but does
discharging it leave a structured trace"_, and each backstop _"fires where that trace first
exists."_ Discharging this obligation leaves a spec revision, so the spec write is the seam. The
reviewer already catches every instance; what it cannot do is catch them before the round is
spent, and the round is the entire recurring cost.

## Mechanism, and where it sits on ADR-024's ladder

**This guard IS on the ladder, unlike its seam siblings, and the entry says so.** mt#4595's
amendment gives the test: _"the matched surface is a closed vocabulary → out of family; the matched
surface is prose → in family."_

- The **confirming** half is structural and exact — does this write carry the named criterion's own
  entry? Answerable from the authored text alone, because a marker patch leaves what it omits
  byte-identical. No database read, no transcript.
- The **nominating** half is a fixed substring set, and it has to be: the discharging ACTION
  (editing the criterion) cannot be the trigger, or every patch that does not touch a criterion
  would fire.

A guard is placed on the ladder by the surface it MATCHES. This one matches prose, so three
consequences bind:

1. **Rung 1 only** — exact substrings, no similarity metric (mem#819).
2. **The evaluation stream is not optional.** It records every evaluated call, fired or not, which
   is the only thing that makes the MISS rate measurable. A fire-only log has no denominator.
3. **If recall proves binding, the answer is Rung 2 (embedding) — never another regex family.**

### The known recall gap, stated up front

Planning measured **mt#4038 (R1) as matching none of the phrase set**: its author phrased the
reconciliation as an _amendment record_ ("the spec's `## Outcome` section records an amendment" —
the reviewer's own words on PR #2914 round 2), not as an assertion that the criterion is unmet.

That miss ships as an **asserted test**, not as a widened list. ADR-024's coverage-receipt done-gate
binds here (_"≥1 `source:"live"` true-positive within a 7-day window of ship; zero live fires in 7
days retroactively fails the gate"_), so this is a live risk rather than a formality.

## Scope

Fires on the three spec-WRITE tools: `tasks_spec_patch`, `tasks_edit`,
`tasks_spec_search_replace`.

`tasks_create` is deliberately excluded — a criterion cannot be explained as unmet in the write that
first authors it. The PR-body surface (R2's shape) is out of scope by construction: it never reaches
this seam.

## Known bounds

- **A verbatim re-emission reads as "touched".** A write that carries the criterion's line
  unchanged is treated as an amendment and stays silent. Closing this costs a prior-spec read; the
  evaluation stream will say whether the shape ever occurs.
- **The adjacency window is clamped to its enclosing section.** An assertion and the criterion it
  names are written together; a window spanning a heading measures proximity in the file rather
  than reference in the prose. This was a real defect caught by the module's own tests.
- **The mt#4531 variant is NOT covered** — criterion amended, its acceptance test not. Same
  consequence reached from the other side. Targeting the stated class only was an explicit decision
  recorded in mt#4213's planning audit, not an oversight; widening is a sibling filing with its own
  measurement.

## Related

`spec-criterion-claim-detector` (mt#4153) reads what a criterion SAYS; this reads whether it
CHANGED. The two share `extractCriteria` for that reason. `claim-provenance-scan` (mt#4168) joins a
claim against a tool call; both halves of this guard's join are sections of the same document.
`warn-unwired-task-relationship` (mt#2264) checks the task graph. mt#3587 owns the JUSTIFICATION
axis at the reviewer tier; mt#3350 owns the PR-body surface at merge time.
