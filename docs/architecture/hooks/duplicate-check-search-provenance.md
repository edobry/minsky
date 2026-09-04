# duplicate-check-search-provenance

Fires when a `tasks_create` spec's duplicate-check record **claims a search that never ran in this
session**. Calibration-first (records, never denies). Override:
`MINSKY_SKIP_SEARCH_PROVENANCE=1`.

## Why it exists

Three guards now stand on the duplicate-check record, and each asks a different question:

| Guard                                      | Question                               | Tier |
| ------------------------------------------ | -------------------------------------- | ---- |
| `require-duplicate-check-record` (mt#3673) | Is the record PRESENT?                 | deny |
| `duplicate-signature-scan` (mt#3722)       | Are its VERDICTS true?                 | warn |
| this one (mt#4004)                         | Did the search it claims actually RUN? | warn |

The first is satisfiable by writing prose. The second is silent whenever the verdicts happen to be
right. So a spec could assert _"searched `tasks_search` for '<query>' across all statuses"_ with no
such call anywhere in the session and pass both.

## Originating incident (2026-08-11, mt#4003)

An `agent_spawns` investigation produced a real finding and was converted straight into a task
carrying exactly that fabricated narrative. Four tasks already owned the work — **mt#3692** (DONE)
had shipped the new task's own first criterion weeks earlier, **mt#3992** owned the 290
undiscriminated rows with a better diagnosis, **mt#3976** the ambiguous-link sweep, **mt#3978** the
reconciliation mechanism. mt#3992 was filed **84 minutes earlier by another actor on the same
table.** mt#4003 was closed as a duplicate.

`duplicate-signature-scan` caught it, correctly — because the fabricated provenance happened to
coincide with wrong verdicts. When it does not, no duplicate is filed, nothing downstream is wrong,
and a false statement about process stays in the record.

## Why this member of its family is mechanizable

The `assertion-without-verification` anchor (mt#2544) has repeatedly recorded _"no detector,
deliberately"_, because its members turn on whether a claim about the **world** is true — not
something a hook can judge.

This claim is about the **session**: the call is in the transcript or it is not. The author is the
only witness to a provenance claim, which is what makes it both uncheckable by a reader and
trivially checkable by a guard.

## The discharge compares the QUERY, not just the tool (mt#4975)

Until mt#4975 the discharge was `sessionRanASearch` — a membership test over the session's tool
NAMES. **Any search discharged any claimed search**, so a record naming queries that were never
issued cleared as long as the session had searched for something else. The guard's own header had
always argued for the stronger form (_"the CORRESPONDING call either appears in the transcript's
tool list or it does not"_); the implementation checked whether **a** call appeared.

It now branches on whether the record NAMES a query:

| The record…                         | Discharge                                                       | Calibration `reason`          |
| ----------------------------------- | --------------------------------------------------------------- | ----------------------------- |
| quotes a query after a search verb  | that query must be covered by an actual `tasks_search` argument | `named query matched a call`  |
| claims a search without quoting one | any search tool discharges it (unchanged)                       | `search claim matched a call` |

**Coverage is asymmetric and the threshold is measured.** `queryTokenCoverage` asks what fraction of
the NAMED query's discriminating tokens appear in an actual one, so refining a query by ADDING terms
still discharges at 1.0 — a missed match fires at someone who did the work, which is the dangerous
direction. Replaying the live corpus on 2026-09-04, the 25 branch records naming a query scored
23 at 1.00, one at 0.67, one at 0.33, with nothing in between; `NAMED_QUERY_COVERAGE_THRESHOLD` is
**0.75**, at the permissive end of that empty band.

Both records the new discharge flags were hand-checked and are true positives: the 19:02:20
incident mt#4975 was filed for, and a second, independently found fabrication.

**Only `tasks_search` participates.** `refs_status` takes `refs` and `tasks_similar` takes `taskId`
— neither carries a query, so neither can be compared against one. A record whose claim is a
cross-reference names no quoted query either, so it lands on the presence branch.

Replay: `bun scripts/replay-duplicate-check-search-provenance.ts`. From a session workspace it needs
`--log` and `--transcript-dir`, because `calibrationLogPath` resolves the clone's own project key
(mt#4954 / mt#4976).

## What it deliberately does not fire on

- **The sanctioned form.** `Duplicate check: no candidates found.` reports an OUTCOME, not an
  action. Firing there would punish the one form `/create-task` Step 1a prescribes.
- **Instructions.** _"run `tasks_search` for duplicates before filing"_ is a requirement being
  quoted, not a claim to have met it. Instruction phrasings are excluded explicitly and win when a
  record contains both — a missed claim is a false negative (safe), a misread instruction is a false
  positive aimed at an author who did the work.
- **Prose outside the record.** Only the duplicate-check paragraph is read, so a `## Summary` saying
  "searched the corpus for X" cannot reach the pattern.
- **`refs_status`.** Counts as a search: cross-referencing candidate ids is a search of the task
  graph by another route. It carries no query, so it discharges on presence only — see the
  named-query section above.
- **Quoted prose that no search verb introduces.** Records quote task titles, verdicts and criteria,
  and none of those is a claimed query. A quoted span counts only within 250 characters after a
  search verb; treating every quoted span as a query manufactured a false positive on exactly this
  shape while mt#4975 was being measured.

An unavailable transcript records `skipped`, never `clean` — a claim that cannot be adjudicated must
not read as a pass.

## Direction of error, and why it is not an ADR-024 arms race

A phrase the pattern misses produces a false **negative**. Recall is bounded by the record's own
sanctioned forms rather than chased across paraphrases, which is the dynamic ADR-024's ladder exists
to end. Rung 1 with an armed evidence stream is the posture that ADR prescribes for this shape
(ask#6982).

## Expected false-positive sources

1. **The search ran in an earlier session** for the same task — invisible to a per-session
   transcript. Expected to dominate early counts.
2. **A dispatching parent ran it** — a subagent filing on instruction has no such call of its own.
3. **Not** `/create-task` Step 1a: that calls `tasks_search` in-session, so a `matched` record on a
   skill-routed create is a true positive (the mt#3585 bypass).

If 1 and 2 together exceed half the `matched` records over the first window, session-scoped tool
history is too narrow a falsifier and the check should be narrowed or replaced by requiring the
record to cite its search inline. Full analysis: mt#4004's spec, `## SC3`.

## Implementation note

The registration MUST declare `needsTranscript: true`. `ctx.transcriptLines` is populated only for
registrations that do (ADR-028 D6), and the session's tool list is this guard's entire
discriminating half — without it the guard records `skipped` on every live run. It shipped that way
in PR #2886's first round and unit tests could not see it, because they construct the context
directly. `registry.test.ts` now asserts the coupling for every guard whose source reads
`transcriptLines`.

## Cross-references

mt#4004 (this guard) · mt#4003 (the incident) · **mt#4975 (the named-query discharge)** · mem#966
(the general rule: a compliance record can assert a check that never ran) · mt#2544 (family anchor)
· mt#3673 / mt#3722 (the sibling tiers) · mt#4190 (the same presence-to-subject repair on
`claim-provenance-scan`'s ownership half — the precedent this extends) · mt#4529 (the orthogonal
axis: whether the search could have REACHED the owner, as distinct from whether it ran) · ADR-024
(detection-mechanism ladder; its mt#4595 amendment scopes the ladder to the prose trigger, which
mt#4975 does not touch) · ADR-028 D6 (transcript resolution).
