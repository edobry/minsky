# duplicate-check-candidate-read

Index entry: `hook-observers.mdc`

A `PreToolUse` observer on `mcp__minsky__tasks_create`. It reads the spec's `Duplicate check:`
record, extracts the task ids the record NAMES, and asks — of each — whether a spec-surfacing call
for that id appears in this session's tool-call state. Never denies. Calibration-first per ADR-024
(Rung 1: a deterministic read of session state, no embedding and no corpus).

Override: `MINSKY_SKIP_CANDIDATE_READ_PROVENANCE`.

## The gap it closes

Three guards already stand on this one paragraph, and each answers a different question:

| Guard                                         | Tier        | Question                                     |
| --------------------------------------------- | ----------- | -------------------------------------------- |
| `require-duplicate-check-record` (mt#3673)    | deny        | Is the record PRESENT?                       |
| `duplicate-signature-scan` (mt#3722)          | calibration | Are its verdicts CONTRADICTED by the corpus? |
| `duplicate-check-search-provenance` (mt#4004) | calibration | Did the search it claims actually RUN?       |

None asks whether the candidate was READ. A record can name the right task, distinguish it on a
property of that task, and satisfy all three while the property is invented.

## Originating incident — mt#4158 (2026-08-14)

The record named mt#3053 as nearest and distinguished it:

> Same test family, different phenomenon: mt#3053 is flakiness under CI parallelism, whereas this
> is deterministic (12/12, twice, standalone, idle machine).

mt#3053's spec, under a heading reading `ROOT CAUSE FOUND`, says:

> **Multiple concurrent agent sessions on one machine** make this dramatically more likely than CI
> alone would suggest.

That was the condition that actually held — the machine was running a 900-second suite plus several
concurrent agent sessions. The distinguishing ground was false, the task was a duplicate, and it was
CLOSED as subsumed the same session. All three tiers passed: the record was present, it conceded no
signature token it needed to, and the search genuinely ran.

The rule this mechanizes was already in the corpus as prose, from a recurrence four months earlier
(mem#819 R4): _"a `confirm-orthogonal` verdict written without opening the candidate's spec is not a
reconciliation, it is a guess with a checkbox. Open every named candidate."_

## Why this member is mechanizable where its family is not

The `assertion-without-verification` anchor (mt#2544) has repeatedly and correctly declined to build
detectors for its members, because they turn on whether a claim about the WORLD is true. This one
does not. Whether the distinguishing CLAIM is true remains undecidable and is explicitly out of
scope; whether the author OPENED the candidate is a question about the SESSION, and the call either
appears in the transcript or it does not. Same shape as mt#4004's, one step further along: that one
asks whether ANY search ran (a membership test over tool NAMES), this asks whether a SPECIFIC id was
surfaced (tool ARGUMENTS).

## What counts as having read a candidate

The predicate is `specWasSurfaced` from `check-task-spec-read.ts`, COMPOSED rather than
reimplemented. That function is the bind/advance guard's (mt#2515, extended by mt#2558 and mt#2814)
and credits a `tasks_spec_get` for the id, or a `tasks_get` with `includeSpec: true` for it.

Writing a second read-detector would fork the equivalence set: two guards would then disagree about
what counts as having read a spec, silently. If the set should grow, it grows THERE and both guards
gain it together.

Two surfaces are deliberately NOT credited, and both were credited in this task's first draft:

- **A bare `tasks_get`** (no `includeSpec`) returns title, status and metadata — not spec text. The
  mt#4158 claim was about mt#3053's `ROOT CAUSE FOUND` section, which a bare `tasks_get` never
  surfaces. Crediting it would silence the guard in exactly the case it exists for.
- **`tasks_search` at any `details` setting.** The spec asserted `details: true` "returns spec
  text". Measured 2026-08-16, a live call returned `{id, score, title, status}` and no `spec` key.
  The command's implementation (`similarity-commands.ts:115`) does set
  `spec: includeDetails ? task.spec : undefined`, so the intent exists, but the `getTask` it reads
  from returns no populated `spec`. Whether that is a defect or intended is unresolved and belongs
  elsewhere; either way the surface cannot be credited, because crediting a surface that does not
  surface the spec manufactures false silence.

## What it cannot see — stated because the design depends on it

**It is scoped to candidates the record NAMES, and that scoping is defeasible by omission.**
mem#819 R4: mt#3719's record named five candidates and reconciled all five correctly, and simply
never named mt#3575 — the task it duplicated. This guard passes that record.

That axis belongs to `duplicate-signature-scan`, which derives signature tokens from the NEW spec
and scans ACTIVE task specs independent of the record's candidate list, precisely because
named-candidate scoping cannot survive omission. Its own header says so. The two are complementary
layers and this is the weaker of the pair; a reader who takes the record's candidate list for the
whole population has misread both.

The general form, from the same R4: **a check scoped to what the agent chose to write down is
defeated by omission** — and omission, not misstatement, is this family's actual failure mode.

## Id extraction, and its direction of error

`CANDIDATE_ID_RE` matches a two-letter backend prefix, a `#` or `-` separator, and digits:
`mt#4158`, `md#12`, `gh#5`, `mt-4158`. `normalizeTaskId` then collapses separator variants so a
record's `mt-4158` matches a read of `mt#4158`.

The separator is REQUIRED, and `pr` is excluded:

- A bare `#4158` is indistinguishable from a PR reference in prose.
- A bare `mt4158` is admissible in principle but buys little and widens the surface.
- `PR#3034` would otherwise extract as task `pr3034` — a candidate nobody could ever have opened,
  so the guard would fire on it forever.

A form the pattern misses is a false NEGATIVE — an unread candidate goes unflagged — never a false
positive fired at an author who did read one. Recall is bounded by the record's own sanctioned id
forms rather than chased across paraphrases, which is what keeps this off ADR-024's regex arms race.

## Outcomes

- `clean` — no record, no candidate ids named, the sanctioned `Duplicate check: no candidates
found.` form, or every named candidate surfaced.
- `skipped` — a record naming candidates with NO transcript lines available. Deliberately not
  `clean`: a guard whose no-transcript path returned a pass would report an outage as a run of
  correct behavior.
- `matched` — at least one named candidate unread. Records `candidateCount` and `unreadIds`
  alongside the record excerpt, so a false-positive review can tell "named one, read none" from
  "named eight, read seven" without re-deriving them.

## Registration notes

`needsTranscript: true` is load-bearing: `ctx.transcriptLines` is populated ONLY for a registration
declaring it (ADR-028 D6), and it is this guard's entire discriminating half. Without it the guard
would record `skipped` on every live run — present, tested, green, and inert.

The ceiling is measured from the PRIMARY canary, which supplies `transcriptLines` so it reaches the
INJECTING path rather than the no-transcript `skipped` branch, posed saturated on both axes at once
(the id list at `MAX_RENDERED_IDS` and the `…and N more` suffix present). There is deliberately no
`renderProbe`: that declares a guard renders but never injects, and therefore contributes no chars
to a real turn — neither holds here, so a probe would wrongly exclude this guard from the
`MERGED_CONTEXT_BUDGET_CHARS` bucket it genuinely spends against (mt#4002).

## Cross-references

mt#4167 (this guard) · mt#4158 (the originating incident) · mem#819 R4 (the prose rule it
mechanizes, and the omission bound) · mem#1048 (the retrospective that filed it) · mt#3673 /
mt#3722 / mt#4004 (the three tiers it joins) · mt#2515 / mt#2558 / mt#2814 (`specWasSurfaced`) ·
mt#450 (the similarity-metric question, explicitly not this guard's) · mt#3750 (the standalone
probe's health) · ADR-024 · ADR-028 D1/D2/D6
