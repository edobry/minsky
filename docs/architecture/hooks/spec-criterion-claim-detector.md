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

## Measured fire rate, and why Class A is not yet injection-ready

Measured before shipping, over real spec bodies read from `task_specs`, both arms in one run:

| corpus                    | criteria | phrase-only | + corpus referent |
| ------------------------- | -------- | ----------- | ----------------- |
| 120 most-recently-updated | 1,105    | 83 (69.2%)  | **61 (50.8%)**    |
| 120 oldest by task id     | 1,254    | 39 (32.5%)  | 32 (26.7%)        |

**Correction to an earlier figure in this file.** The referent column first measured 47 (39.2%) on
the recent corpus. That was a BUG in the conjunct, not a property of the corpus: the same-sentence
window treated a newline as a sentence end, so a criterion wrapped between its trigger and its
referent was a false negative — and this repo wraps prose at 100 characters, so that is the ordinary
case rather than an edge one. Caught in review (PR #3063 R1, BLOCKING). About a quarter of the
apparent improvement was the conjunct suppressing true positives, so **the referent requirement helps
less than the first measurement claimed** — it removes roughly a quarter of the phrase-only fires,
not two thirds. The conclusions below are unchanged in direction and stronger in degree.

Three things follow, and the first two are why the conjunct exists at all.

**Sample the RECENT specs.** The two corpora differ by 2x on the same code. The dense-prose spec
style that leans on _still_ / _already_ / _remains_ is recent, and this hook fires on
`tasks_create` / `tasks_spec_patch` — so newly-written specs are the population it actually faces
and an id-ordered corpus understates its load by half. A measurement over the oldest specs would
have made the phrase-only matcher look shippable.

**The trigger vocabulary alone does not discriminate.** At 69.2% the matcher is not a detector, it
is a tax on writing a spec. The residual after the conjunct is still concentrated in two ordinary
adverbs — per-finding counts on the recent corpus: `still` 41, `already` 18, `remain` 3,
`is registered` 2, `continues to` 1. Sampled fires include `"still with you: ask#N"` (quoted
EXAMPLE text inside a criterion — `elideMarkdownNonProse` blanks code spans and blockquotes, not
double-quoted prose) and `already-filed` used as a compound adjective.

**The deeper limit is structural, not lexical.** An acceptance criterion describes the END STATE
the PR creates, and "`X` is registered in `Y`" is grammatically identical whether it asserts a
pre-existing corpus fact or specifies the deliverable. Class A's premise is that a trigger plus a
referent separates those two; at 50.8% on the operative corpus, it does not separate them well.
That is a claim about the premise, not a tuning gap, so the answer is not another phrase-list
revision — widening or re-wording the list is the ADR-024 §Context arms race, and narrowing it
further by hand on the same corpus that justified the narrowing is the same move in reverse.

So Class A ships **log-only** with `INJECTION_ENABLED = false`, and the 50.8% figure is the input
to the calibration review that decides whether it earns a Rung-2 flip, gets restricted to its
highest-precision phrases, or is retired. The evaluation stream above supplies the miss
denominator that decision needs.

## The dispatcher timeout in `.claude/settings.json`, derived

`.claude/settings.json` gives `dispatch-pretooluse.ts` a per-matcher timeout, and nothing checks it
against the registry — so the number is only as good as the derivation recorded beside it (PR #3063
R1 flagged the risk of settings↔registry drift). Sum of the declared `timeoutMs` for every registry
guard on `mcp__minsky__tasks_create`, read from `bun scripts/check-guard-posture-coverage.ts`:

| guard                               | declared      |
| ----------------------------------- | ------------- |
| `duplicate-signature-scan`          | 18,000 ms     |
| `spec-criterion-claim-detector`     | 10,000 ms     |
| `require-duplicate-check-record`    | 5,000 ms      |
| `duplicate-check-search-provenance` | 5,000 ms      |
| `duplicate-check-candidate-read`    | 5,000 ms      |
| `flakiness-control-detector`        | 5,000 ms      |
| `claim-provenance-scan`             | 5,000 ms      |
| **sum**                             | **53,000 ms** |

The setting is **58s** — the 53s sum plus the 5s headroom the file already used at its previous
values (43s against a 38s sum). Two guards landed on this matcher within hours: mt#4167's added 5s
(43 → 48 on main) and this one added 10s (43 → 53 in this branch), off a shared base. Both edits were
correct and each was blind to the other, so the merge conflict resolved to the **union**, 58 — `max()`
would have funded one guard and not the other. Re-derive with the command above rather than adjusting
this by feel; the group matcher for `tasks_spec_patch` / `tasks_edit` /
`tasks_spec_search_replace` is sized separately (20s) because only two guards reach it.

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
