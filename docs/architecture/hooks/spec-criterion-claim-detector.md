# spec-criterion-claim-detector

Calibration-first detection of two claim classes in a task spec's `## Success Criteria` and
`## Acceptance Tests`. Filed as **mt#4153**.

**Posture:** calibration-first per ADR-024 — `INJECTION_ENABLED = false`. Writes a calibration
record and an evaluation record; injects nothing. The flip follows a `/calibration-review` pass over
the evaluation stream, not a judgement in the module.

**Source:** `.minsky/hooks/spec-criterion-claim-detector.ts` (adapter) over
`packages/domain/src/detectors/spec-criterion-claim.ts` (matcher). Generated copy:
`.claude/hooks/spec-criterion-claim-detector.ts` — do not hand-edit.
**Override:** `MINSKY_SKIP_SPEC_CRITERION_CLAIM=1`.
**Calibration log:** `.minsky/spec-criterion-claim-calibration.jsonl` (dispatcher-written).
**Evaluation stream:** `.minsky/spec-criterion-claim-evaluations.jsonl` (module-written).

## Why this exists

`/plan-task`'s premise gates all fire on a claim that **drives a decision** — (j) a categorization
label, (m) a cited passage justifying a structural choice, (o) a runtime causal claim. A
`## Success Criteria` bullet is none of those. It is the claim the implementation is measured
**against**, so a wrong one does not merely mislead: it certifies the wrong thing as done, or blocks
work that was already authorized.

Both recorded instances were **self-authored** and both passed the full 16-criterion gate battery.

### R1 (2026-07-31, mt#3479) — an unverified corpus-state assertion

A criterion read: _"`OVERRIDE_ENV_VAR` remains functional and **remains documented** in `CLAUDE.md`
§Hook Files."_ The word "remains" licensed a removal. A grep for the var across `CLAUDE.md`,
`AGENTS.md`, `.minsky/rules/`, `.claude/rules/` and `docs/` returned nothing — the removal deleted
the only place it appeared. Recorded in mem#790, which named the candidate fix and closed with
"**File if this recurs.**"

### R2 (2026-08-13/14, mt#2430) — an invented precondition

A criterion invented a precondition the authorizing decision did not contain, twice in one spec.
ask#8467's chosen option read _"One decision record answering the seven open questions, **then**
implementation subtasks."_ The criteria written from it said "An **accepted** ADR" (SC1) and "filed …
**once the ADR is accepted**" (SC4/AT3). Acceptance appears nowhere in the ask. SC1 drew a BLOCKING
reviewer finding on PR #3000 and cost a review round; SC4/AT3 nearly parked three filed-and-ready
subtasks behind a decision nobody had asked for, caught only by re-reading the ask verbatim after
the merge.

## The two classes

**Class A — unverified corpus-state assertion.** A criterion carrying a present-tense existence
claim about the repo: `remains`, `still`, `already`, `continues to`, `is documented`,
`is registered`, `is wired`. **Silenced by an inline verifying command** in the same criterion — a
backticked span whose leader is `grep`, `rg`, `wc`, `find`, `jq`, `bun`, `git`, … A criterion that
ships its own falsifier is not an unverified assertion.

**Class B — invented precondition.** A criterion carrying a conditional gate whose condition is
absent from the authorizing ask:

| Form                                           | What is checked against the ask           |
| ---------------------------------------------- | ----------------------------------------- |
| `once … is accepted\|approved\|merged\|done`   | the STATE word                            |
| `after … approves\|accepts\|merges`            | the STATE word                            |
| `pending …` / `contingent on …` / `gated on …` | the condition OBJECT's significant tokens |

**Why the state and not the entity.** For the `once … is <state>` forms the load-bearing token is
the state. R2's ask _does_ contain "decision record" (≈ the ADR) and does _not_ contain "accepted",
so keying on the entity would have missed the very incident this exists for.

For the object forms, the guard fires only when **nothing** in the condition traces to the source. A
single shared token makes the gate arguably authorized, and silence is the right default for an
arguable case.

## What the authorizing source is

The most recently answered ask whose `parent_task_id` is the task being edited: its chosen option's
label plus **that option's description**. Both are the operator's own words, so anything absent from
them is the agent's addition. The description is read as well as the label because the real
constraint routinely lives there — reading the label alone would fire on authorized work.

**Read by SQL, not through `asks_list`.** The spec prescribed filtering an `asks_list`
`summary: true` listing client-side, because that tool exposes no `parentTaskId` filter. That
constraint belongs to the MCP tool surface, not the substrate: this hook already reaches the
database directly (as `duplicate-signature-scan` does), so the filter goes in a WHERE clause and one
row is read instead of every ask being listed and scanned.

Any failure — no bootstrap, no provider, no connection, no row — returns `null`, which makes Class B
**silent rather than wrong**. A detector that cannot read the authorization must not guess at it.

## Class B is only reachable on an EDIT

Registered on `tasks_create` **and** `tasks_spec_patch` / `tasks_edit`, because the two classes are
reachable at different moments:

- **Class A** works wherever a spec body is in the payload.
- **Class B** needs a task id for an ask to point at. At `tasks_create` the task does not exist yet,
  so no ask can reference it and Class B cannot fire.

That is the spec's own rule rather than a gap (SC2: "If no ask is linked, Class B does not fire: an
unlinked task has no machine-readable authorization to compare against, and guessing is worse than
silence"), and the R2 incident it exists for was an edit. On a create the lookup is not even
attempted — there is no id to look up.

## Elision runs on the WHOLE spec, before structure is read

ADR-024 §Rung 1 prescribes quotation-aware elision before matching, using
`elideMarkdownNonProse` from `.minsky/hooks/block-out-of-band-merge.ts` (fenced blocks, inline code
spans, blockquote lines, replaced with same-length whitespace).

**The ORDER is load-bearing, and getting it wrong was caught by this detector's own SC8 test.**
Eliding each criterion _after_ extracting it cannot work: a fenced block containing
`- [ ] \`FOO\` remains documented`— which is exactly how these incidents get written up — parses as
a bullet while the fence markers sit on *other* lines, so a per-criterion elide sees no fence and
the quoted example becomes a criterion. The detector would have fired hardest on the very specs
documenting it. mt#2430's own`## SC1 amended`and`## Closeout` sections, and mem#790, all quote the
offending criteria verbatim.

So the whole spec is elided first and structure is read off the elided text. That works because the
elider replaces spans with **same-length** whitespace and preserves newlines: raw and elided share
identical line numbering, so the RAW line stays recoverable by index — which is required, because a
verifying command lives in a code span the elision blanks. The two checks deliberately read
different forms of the same text.

## Why the elider is injected rather than imported

The matcher lives in `packages/domain/src/detectors/` because ADR-024's Decision clause requires the
guidance-hook ladder be built on that shared framework. `elideMarkdownNonProse` lives in the hooks
tree, and a domain module importing from there would invert the layering — hooks adapt the domain,
not the reverse. So `detectSpecCriterionClaims` takes the elider as a required parameter and the hook
supplies that exact function: reuse without inversion, and no second elision copy.

The parameter is required rather than defaulted so no caller can silently skip the elision pass.

## Rung placement

**Rung 1**, on the merits rather than by default: a phrase match, a same-criterion command check, and
an exact-substring lookup against an ask's chosen option are all deterministic. Do **not** answer a
paraphrase miss by widening `CLASS_A_PATTERNS` — that is the arms race ADR-024's `## Context` exists
to end. Rung 2 (embedding nomination) is the documented escalation and is evidence-gated on measured
recurring misses.

**No similarity metric appears here deliberately.** Per mem#819 a true duplicate measured 1.027
against an existing guard's 0.65 threshold, so similarity provably cannot discriminate at the
distances these sit at.

## The evaluation stream

One record per examined call, **fired or not** — `fired`, `criteriaExamined`,
`authorizingSourceAvailable`, `taskIdPresent`, `classACount`, `classBCount`, `specChars`, `tool`.

The calibration log records fires only, so it can measure a false-positive rate and never a MISS
rate. This stream is the denominator: how many specs carried criteria at all, how many carried an
authorizing ask, how often Class B was reachable. Without it "what is this detector not seeing?" has
no data behind it.

## Feedback shape

Built even while injection is off, so the registry's `renderProbe` measures a real ceiling (mt#4002)
rather than the empty string. **Each class gets its own directive** — a shared one would tell a
Class A author to go read an ask, which is not the remedy for an unverified corpus claim (mt#3767's
lesson, arrived at the same way).

`attentionCost.denialMessageSizeChars: 2000` against a **measured** 1954 saturated. The
finding-count axis is UNCAPPED — one block per flagged criterion — so that is a saturated
**sample**, not a proved ceiling; `guard-feedback-shape.test.ts` classifies it
`render-probe-sample`, and an `…and N more` cap is owed before injection is enabled.

## Cross-references

`packages/domain/src/detectors/negative-existence-claim.ts` (the sibling whose domain/adapter split
this follows) · `docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md` ·
`guard-feedback-authoring.mdc` · mem#790 (R1) · mt#2430 / ask#8467 (R2) · mt#2264 (adjacent: the same
tools and spec text, but relationship-to-other-tasks assertions rather than criteria — share the
plumbing, do not merge) · mt#3350 (the PR-time check for whether _executable_ criteria were RUN — a
different question at a different moment) · mt#4189 (reclaimed the `hook-observers.mdc` ceiling
headroom this entry needed).
