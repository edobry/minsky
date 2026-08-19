# `claim-provenance-scan`

**Trigger:** a task spec asserting a file-level COLLISION with named other work, or a NEGATIVE
OWNERSHIP claim, written with no call in the session that could have established it.

**Event:** `PreToolUse` on `mcp__minsky__tasks_create` · `tasks_spec_patch` · `tasks_edit` ·
`tasks_spec_search_replace`.

**Posture:** calibration-first, **record-only** — the guard writes a calibration record on every
path and injects nothing. Never denies. See `## Why record-only` for the measurement that decided
it; `mt#4190` owns the tune and the graduation.

**Override:** `MINSKY_SKIP_CLAIM_PROVENANCE=1`.

**Task:** mt#4168, implementing the two entries mt#3806 re-homed into mt#4044's shared
`evidence-provenance-table.ts`.

## The seam is the finding

`tasks_spec_patch`, `tasks_edit` and `tasks_spec_search_replace` carried **no PreToolUse guard of
any kind** before this one — measured against `.claude/settings.json` during mt#4168's planning
pass. Only `tasks_create` was guarded.

That is not an incidental gap, because **both originating incidents wrote their claim into an
EXISTING spec**, which cannot go through `tasks_create`:

- `/implement-task` §0a is an entry gate on an already-READY task.
- `/plan-task` operates on an already-filed one.

So the obvious reading — "this is a `tasks_create` guard, like its three siblings" — would have
bound the check to the one surface neither incident used. `tasks_create` is covered too, for a new
spec that carries the claim at birth.

ADR-042 classifies the gate battery's rows at the READY and merge seams; this guard is **not** one
of those rows and does not contradict them. Those ask whether a GATE was discharged. This asks
whether a specific CLAIM in a spec is backed.

## Ordering is the whole check, and this seam makes it free

The negative-direction incident (mt#3682, 2026-08-08) is not "the agent didn't search." The agent
DID search — `/plan-task` simply ordered the search **two minutes after** the claim was already in
the spec, and mt#3826 had covered the work for four hours. mt#3806 fixed the ordering in the skill's
prose; this is the mechanical backstop for when that discipline is not followed.

At a PreToolUse seam the claim is still in `tool_input`, so every call in `ctx.transcriptLines`
necessarily **precedes** it. "Did the search already run?" is exactly the question, with no
timestamp comparison and no clock. At any later seam — commit, PR-create, merge — the same check
would need one.

## What discharges what

| Claim                                           | Discharged by                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| File-level collision naming `PR #N`             | `pull_request_read` with `get_files`/`get_diff` **for that N**        |
| File-level collision with a merge (no PR named) | `git_log` with a `path` or `grep` filter                              |
| Negative ownership                              | `tasks_search` / `tasks_similar` / `refs_status`, preceding the write |

The PR join is **specific on purpose**. mem#892 (2026-08-05) is the positive-direction incident:
`/implement-task` §0a halted on a claimed `SessionFilmStage.tsx` collision with mt#3792, whose PR
#2692 never touched that file — the name came from the task's TITLE plus an inference about where
camera code lives. Accepting any `pull_request_read` at all would rebuild that failure one level up,
so reading a DIFFERENT PR's files does not discharge a claim about this one.

## Direction of error

Per `evidence-provenance-table.ts`'s header, the two halves fail in opposite directions and are
tuned accordingly:

- **Recognizing** a claim in prose — a missed phrase is a false NEGATIVE (an unbacked claim goes
  unflagged). Safe, so this is where the narrowness lives. Both recognizers require TWO signals: a
  collision verb **and** a file-shaped token; an absence assertion **and** not being inside a
  duplicate-check record.
- **Discharging** it — a missed call shape fires at an author who did the work. Dangerous, so the
  recognizers in the shared table are generous (either `git_log` filter counts; both PR-read methods
  count).

**Task-level adjacency is deliberately NOT a trigger.** Gate (g) explicitly permits recording
"task-level adjacency, files unknown" when the other work has no PR — a weaker and more honest
finding. Firing on it would punish exactly the behavior mt#3806 asked for.

**The duplicate-check record is out of scope**, stripped before scanning. It has its own three-tier
coverage (`require-duplicate-check-record`, `duplicate-signature-scan`,
`duplicate-check-search-provenance`), and matching it here would double-fire on one claim.

## Why record-only

Measured before shipping, not chosen out of caution. `bun scripts/replay-claim-provenance.ts
--sweep ~/.claude/projects/<project> --limit 40`, replaying each spec-write call against the
transcript PREFIX that preceded it — which is exactly what the live guard sees:

|                                               | count  |
| --------------------------------------------- | ------ |
| spec-write calls considered                   | 341    |
| carrying a collision or ownership claim       | 70     |
| **fired** (no discharging call in the prefix) | **16** |
| discharged (silent)                           | 54     |
| not adjudicable                               | 0      |

**These are the numbers that were hand-classified** (measured 2026-08-17). Two caveats a later
reader needs:

- **The window slides.** It is the 40 MOST RECENT transcripts, and the measuring session is itself
  one of them and still growing — a re-run minutes later already read 354 / 73 / 18. Compare rates,
  not counts, and re-measure before concluding anything moved.
- **A later fix changed the numbers, and it has NOT been hand-classified.** PR #3050 R1 scoped PR
  extraction to the collision paragraph (see below); a post-fix sweep reads **371 / 74 / 15, a
  20.3% rate**. That is a rate improvement on a sliding window, not a verified precision gain — the
  one-true-positive figure above belongs to the 16, and mt#4190 owns re-classifying after its own
  fix.

**All 16 were hand-classified. One was a true unbacked claim.** The rest:

1. **Prose that DISCUSSES a collision rather than asserting one — 12 of 16.** Gate-(g) verdict
   tables, duplicate-signature reconciliations, premise audits, task cross-reference lists, and
   twice mt#4168's own spec table describing what this guard checks. The paragraph is _about_
   collision as a topic and names a file because the surrounding spec names files everywhere.
2. **The author says the read happened and the join missed it — 3 of 16.** Each says in the same
   paragraph that `get_files` was used. This is the dangerous direction: firing at someone who did
   the work.

The negative-ownership half fired **zero** times across all 40 transcripts, so its precision is
unmeasured rather than good.

Two fixes were applied during implementation and are already reflected in those numbers — same-
paragraph proximity (31 → 26 fires) and negation handling, so that "No overlapping in-flight work"
no longer reads as a collision claim (26 → 16). A third vocabulary pass is the arms race ADR-024
exists to end, so the remaining gap goes to mt#4190 for a structural discriminator instead.

Injecting at this precision is the mem#719 failure mode: noise teaches the reader to discount the
true positives, and here it would fire hardest at the authors doing the most careful gate-(g) work
— the exact behavior mt#3806 shipped its prose half to produce.

## The tune (mt#4190, 2026-08-19)

The dominant false class was never a vocabulary gap, which is why three passes had each bought a
fraction and left it standing. This guard was built straight to a matcher and never got **ADR-024's
Rung 1** — the quotation/citation-aware prefilter that prescribes eliding "prose-quoted spans and
explicit discussion-framing" before matching. A gate-(g) verdict block IS explicit
discussion-framing: it is the recorded OUTPUT of the very check this guard demands. Match / extend /
deviate: **MATCH**, phase 2 of RFC 383937f0's roadmap ("propagate Rung 1 to the other existing
hooks").

### What discriminates, and what deliberately does not

- **An audit RECORD is not a claim.** A markdown table, a majority of list items opening with a
  parenthesized gate letter, or three distinct inline enumeration markers in one paragraph.
- **Counted by ITEM, not by line.** This repo wraps at 100 columns, so a gate bullet spans three or
  four lines. On lines, the real mt#4275 block scored 7 markers against 10 wrapped continuations and
  failed its own majority — the rule was correct about every line and wrong about the paragraph.
  Same wrapped-line trap mem#1067 §2 records one subsystem over.
- **`(same file, line 43)` is a citation parenthetical**, elided before the verb test. `same file`
  is the weakest member of the verb list — unlike "collides", it is not inherently relational.
- **Discharge is per-PARAGRAPH.** The union across paragraphs made a PR named in one a required read
  for a claim made in another. PR #3050 R1 fixed this one level up and stopped at the SET of
  collision paragraphs collectively.
- **NOT eliding inline code spans.** The obvious reading of Rung 1 is "run `elideMarkdownNonProse`
  and match the residual", and that pass blanks code spans — which is where this corpus keeps its
  filenames. Both recall controls name their files in backticks, so the wholesale version would
  delete the file-token half of the conjunction and drive the fire rate toward zero: a result that
  reads as a precision win and is the guard switched off. `claim-provenance-corpus-fixtures.ts`
  pins this.

### Rejected: requiring a counterparty

A collision is a relation, so "does the paragraph name a `PR #N` / `mt#N` / a branch?" looks like
the structural rule here. It is wrong, and recorded in-code so a later pass does not re-derive it: a
counterparty is routinely named DESCRIPTIVELY — "this conflicts with a merge that landed on
`src/thing.ts` yesterday" — which is the entire merge-shaped class `sessionReadMergeHistory` exists
to discharge. The existing AT2 test caught it within a minute of the rule going in.

### The join's misses, diagnosed (SC2)

Confirmed with evidence rather than left as candidates. The read was performed through a tool the
discharge table could not see. Verbatim, from two fired specs — both gate-(g) work done correctly:

> Open PRs read via `gh api .../files`: **#3070** … **#3068** … **#2945** …

> every one of the 12 open PRs checked … PR #3098 via `get_files`, the other 11 via
> `git diff --name-only origin/main...origin/task/<branch>`

**mt#3779** records the standing cause: the github MCP server dies when the Docker daemon is down
and `pull_request_read` answers "No such tool available", so the shell is what is left. The
discharge table now recognizes `gh api …/pulls/N/files`, `gh pr diff N --name-only`, and
branch-range `git diff --name-only` (the last discharges the merge-shaped claim only, since it names
no PR). This is the DISCHARGE axis, which this module's header says is deliberately generous — not
the recognition axis ADR-024 governs. The remaining candidate cause the spec named,
prior-conversation reads, was **not observed** in any fire.

### Measured before/after

Same 40-transcript window, seconds apart, the tuning session excluded via `--exclude` (it writes
collision prose into specs and would otherwise count itself — mem#1022):

|                  | before | after |
| ---------------- | ------ | ----- |
| considered       | 410    | 413   |
| carrying a claim | 70     | 57    |
| **fired**        | **12** | **7** |
| fire rate        | 17.1%  | 12.3% |

Hand-classified, both runs: **false fires 10 → 5**; the two defensible fires still fire. Precision
~17% → ~29%. **This is short of ADR-024's signed-off sufficiency bar (0 known-FP, RFC 383937f0
Phase-0 (b)), and is recorded as a result rather than presented as a pass.**

### The residual five, and why each survives

1. **A second PR named in the same long paragraph** (mt#4281). Per-paragraph scoping is as far as
   the join goes; the author read one of the two PRs the paragraph names. Sentence-level scoping is
   the next granularity and was not attempted.
2. **A bolded disposition label** (mt#4287) — "**Signature-scan candidates dispositioned** (…the
   path collides without the work colliding)". A record with no enumeration markers to count.
3. **Conditional mood** (mt#4191) — "two concurrent edits … is exactly the collision this batch
   exists to avoid". A hazard to prevent, not a collision asserted to exist. No ready mechanism.
4. **Duplicate-check reconciliation prose** (mt#4266), where the overlap claimed is conceptual.
5. **This guard's own spec**, describing its own false classes. The self-referential case RFC
   383937f0 §Threats names outright.

Classes 2 and 4 are label-shaped; answering them with a label list is the arms race, so they are
left as residue rather than patched.

### The ownership half's zero fires, explained (SC4)

Not rarity, and not a broken recognizer — the JOIN. Over the same 40 transcripts, **25 spec-writes
carried a recognized ownership claim (6.7% of 372) and all 25 discharged.** Caught examples include
"No task owns the ADR text" and "**Phase placement: Phase 7, and it is unowned**". They discharge
because `sessionRanASearch` is **subject-blind and session-wide**: any `tasks_search` /
`tasks_similar` / `refs_status` anywhere in the prefix discharges any ownership claim, and a
planning session essentially always runs one. So the spec's either/or — "genuinely rare" vs
"recognizer misses them" — was a false dichotomy.

The subject-binding primitives already exist on the shared table (`extractSubjectTokens` /
`callNamesSubject`). Binding the ownership discharge to them is left UNDONE deliberately: it would
convert a half that currently never fires into one that fires at an unmeasured rate, and this task's
budget went to the collision half. Same shape one guard over: **mt#3594** (subject-blind
same-turn-read suppression on `code-mechanism-assertion`).

### Posture (SC5)

Unchanged — RECORD-ONLY. ADR-042 labels this guard's rows `advisory`, and **ADR-032 is the standing
reason a log-only → live flip cannot be justified from outcome data alone**: "the labeled response
signal that tuning would run on does not exist." No precision number this task produces can license
the flip, so none is proposed.

## Two more defects, found at review (PR #3050 R1)

1. **PR extraction was not scoped to the collision paragraph.** `citedPrNumbers` scanned the whole
   spec, so an unrelated `PR #9999` cited in a `## Context` list became a REQUIRED read: the guard
   demanded that every PR the spec mentions anywhere have had its files read, and fired otherwise.
   That fires at authors who _did_ read the PR their claim was about — the dangerous direction, and
   a plausible cause of the three "author says `get_files` was read" misses above. Now scoped, and
   `collisionParagraphs` is the shared span so the recognizer and the join cannot drift apart.
2. **The comment described parsing the code did not do.** It claimed bare `#123` was taken when a
   collision verb was present; the regex only ever matched `PR #N`. Corrected toward the code, and
   the reason is worth keeping: `\b#(\d+)` matches INSIDE every task reference, because `mt#4168`
   carries a word boundary right before its `#`. Taking bare `#N` would turn each of a spec's task
   citations into a PR whose files must have been read — the same over-demanding join defect 1
   removes, reintroduced at a larger scale.

## A defect this guard's own tests caught

`normalizeToolName` in the shared table stripped only the `mcp__minsky__` prefix. The collision join
needs `mcp__github__pull_request_read`, which therefore never normalized and never matched — the
guard would have fired on every collision claim including correctly-researched ones, the dangerous
direction. The unit test's "silent when THAT PR's file list was read" case failed on the first run
and surfaced it. The strip is now server-agnostic (`mcp__<server>__`), which is safe for the
pre-existing callers because every name they test for is a minsky tool no other server exposes.

Worth recording because review would plausibly not have caught it: the code reads correctly, and
the failure mode is a silent non-match rather than an error.

## Not-adjudicable is not clean

Two paths record `skipped` rather than `clean`, following
`duplicate-check-search-provenance`'s discipline:

- The call carries no authored spec text (an unlisted tool, or an empty field).
- `ctx.transcriptLines` is absent or empty.

A guard whose no-transcript path returned a pass would report an outage as a run of correct
behavior. `needsTranscript: true` is declared on the registration and is LOAD-BEARING —
`ctx.transcriptLines` is populated only for a registration that declares it, so without it the
guard records `skipped` on every live run: present, tested, green, and inert.

## Cross-references

- `.minsky/hooks/evidence-provenance-table.ts` — the shared discharge table
- `.minsky/hooks/duplicate-check-search-provenance.ts` — same claim shape, `tasks_create` only
- `docs/architecture/adr-042-gate-battery-enforcement-shape.md` — why this is not a gate-battery row
- mt#3806 (the prose half, DONE) · mt#4044 (the table, DONE) · mem#892 (the positive incident)
