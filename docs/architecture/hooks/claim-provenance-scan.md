# `claim-provenance-scan`

**Trigger:** a task spec asserting a file-level COLLISION with named other work, a NEGATIVE
OWNERSHIP claim, or a REMAINING-WORK assertion about another task, written with no call in the
session that could have established it.

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

| Claim                                           | Discharged by                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| File-level collision naming `PR #N`             | `pull_request_read` with `get_files`/`get_diff` **for that N**                     |
| File-level collision with a merge (no PR named) | `git_log` with a `path` or `grep` filter                                           |
| Negative ownership                              | `tasks_search` / `tasks_similar` / `refs_status`, preceding the write              |
| Remaining work on a named task                  | `tasks_status_get` / `tasks_get` / `tasks_spec_get` / `refs_status` **on that id** |

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

## The third class: a remaining-work assertion (mt#4299)

**The claim:** a spec says some task still has work outstanding — "whoever takes this task should
X", "mt#N still needs Y", "the remaining work is Z" — when nothing in the session read that task's
state.

### The incident, and why it needed a write-seam guard

2026-08-19 (mem#1114). A genuinely verified root-cause section was patched into **mt#2307**'s spec
and closed with _"Whoever takes this task should confirm that trade still holds and then update the
test plus a doc note."_ mt#2307's work had been complete for **ten weeks** — mt#2664 renamed the
test, asserted the intended behavior, and wrote the rationale in-code with the shipping commit. All
three of its success criteria were already satisfied. It was caught one turn later and only
incidentally, when `/plan-task` gate (o) reproduced the stated failure and got `matched 0 tests`.

**The tell is grammatical.** The verified half is past-tense and cites sources; the rider is
future-tense and cites nothing. Two epistemic acts in one edit, and only one got evidence — the
verified paragraph supplies the rider's felt credibility, so the rider is never evaluated as a
proposition at all.

That is why the two prior tiers both passed while the rule was in context. **mem#249** (memory tier)
states the rule for the adjacent `tasks_deps_add` surface, which was called in the same turn.
**mt#2534** (skill tier, DONE) shipped `/check-premise` §"Artifact-content and identity claims",
which describes this failure verbatim — nothing invoked it. A trigger keyed on self-recognition
("am I making a claim?") cannot fire here, because at compose time the rider does not present as a
claim; it reads as a helpful handoff note. **A guard that reads the TEXT is immune to how confident
the surrounding paragraph felt.** Third tier for one failure class, which is the escalation ladder
`/retrospective` prescribes rather than a repeated tactical patch.

### Resolving the subject

Two forms, and the second is what makes the class reach its own originating incident:

- **Explicit** — the paragraph names `mt#N`. Those are the subjects. (`md#N` is a documented task-id
  form and is deliberately NOT one — see "Subject id form narrowed at review" below for the
  measurement.)
- **Deictic** — the paragraph says "this task" and names no id. The referent is the `taskId`
  argument of the write itself, which is on the call.

Shipping only the explicit form would have produced a class that **cannot catch the incident it was
designed against**: the mt#2307 rider names no id. Present, tested, green, and inert (mem#704).

`mem#N` / `ask#N` / `ws#N` are deliberately not subjects — a memory has no status to read, so
treating one as a subject would demand a call that cannot exist. A paragraph with no resolvable
subject is **not adjudicable** and does not fire: a claim the author could not discharge by any
action is the shape that teaches a reader to discount the guard (mem#719).

### The join is ID-scoped, unlike the ownership half

`sessionRanASearch` is presence-only — any search anywhere discharges any ownership claim — and
mt#4190 measured the cost: **25 ownership claims, 25 discharged, zero fires.** This class cannot
work that way, so `taskIdsWithStatusRead` returns the SET of ids actually read and every subject a
paragraph names must be in it. `refs_status` takes an array, so the match looks inside it.

The discharge set is deliberately **generous** (all four read tools) per the module's
direction-of-error rule: a spelling missed there fires at an author who looked the task up.
`tasks_list` is excluded as presence-only-by-another-route.

### Measured before shipping (AT4)

`bun scripts/replay-claim-provenance.ts --sweep <project> --limit 40 --detail`, replaying each
spec-write against the transcript PREFIX that preceded it. The tuning session is excluded per
mem#1022 — it writes remaining-work prose into specs and would otherwise count itself. Both numbers,
per the script's header:

|                        | all 40 | this session excluded (39) |
| ---------------------- | ------ | -------------------------- |
| spec-write calls       | 340    | 339                        |
| carrying a claim       | 62     | 61                         |
| **fired**              | **18** | **17**                     |
| — file-level collision | 9      | 9                          |
| — remaining work       | 9      | **8**                      |
| fire rate over claims  | 29.0%  | 27.9%                      |

**All 8 hand-classified. One true positive, one defensible, six false:**

1. **TRUE** — `be47b60b:1497`, the originating mt#2307 rider verbatim. The class catches the
   incident it was built for, on real recorded data rather than a fixture.
2. **Defensible** — mt#4078's spec asserting mt#4313 is an unmet precondition, with no status read
   on it.
3. **Subject mis-resolution — 3 of 8.** The dominant false class. An explicit id in the paragraph is
   taken as the subject when the claim is actually deictic about the task being written: mt#4012's
   _"the remaining work is to make the call SUCCEED"_ is about mt#4012, while the paragraph also
   names mt#2782. Explicit-wins is the wrong precedence when a deictic self-reference is present —
   and note it mis-resolved the TRUE positive too (picking mt#2161/mt#1785/mt#1994 over mt#2307),
   which fired correctly for a partly wrong reason.
4. **Self-referential — 2 of 8.** mt#4299's own spec, once discussing the class as a term of art and
   once quoting `"whoever takes this task should…"` as an example of the shape. The second is a
   Rung-1 quotation-elision miss; RFC 383937f0 §Threats names the self-referential case outright.
5. **A discharge the join cannot see — 1 of 8.** The author enumerated five neighbours WITH their
   statuses ("— TODO.") and had plainly looked them up; the reads went through `tasks_search`, whose
   results carry a `status` per task but which is not in the status-read set. This is the dangerous
   direction — firing at an author who did the work.

**Subject id form narrowed at review (PR #3173 R1).** `TASK_ID_RE` matched `md#N` as well as `mt#N`,
since `md#` is a documented task-id form. Measured wrong: `md#N` in this corpus is overwhelmingly
placeholder text — 64 distinct tokens repo-wide, led by `md#123` (110 occurrences), `md#999` (66) and
`md#456` (16), which are the tool description's own examples and test fixtures — and `refs_status`
reports `md#1` / `md#100` / `md#456` all `absent`. Matching it manufactures subjects no status read
can discharge, which is the one failure this class must not have. **Re-running the sweep after the
narrowing left the class at 8 fires**, so this removed no measured fire; it is a forward-looking
correctness fix, not a precision gain, and is recorded as such.

**Not tuned in this diff, by scope.** mt#4299 `## Scope` puts false-positive tuning of the guard out
of scope explicitly, and the guard is record-only so the cost is a calibration record rather than a
denial. This is the same posture mt#4168 shipped the collision class at (1 true in 16) with mt#4190
as its tune sibling. Findings 3 and 5 are the actionable ones and are filed as **mt#4341**.

### A discharge set that deliberately disagrees with a sibling's

mt#3775 (TODO) will cover **citation-provenance** claims — what a named artifact SAYS — and its SC1
states the opposite rule about the same tools: a read must return the ref's own content
(`tasks_spec_get`, `memory_get`), and _"not a status read (`tasks_status_get`, `refs_status`), which
returns no prose and therefore cannot support a claim about what the artifact SAYS."_

That is not a contradiction to reconcile. The two classes ask different questions, so different
evidence suffices: "what does mt#N say" needs prose, "does mt#N still have work" is answered by its
state. A reader comparing the two tables should expect the divergence rather than treat one as a bug.

**The honest limitation, stated rather than glossed:** mem#1114's own corollary is _"a task being
TODO is not evidence its work is undone — check the criteria, not the status field"_, and mt#2307 sat
TODO for ten weeks after being fully resolved. So a `tasks_status_get` discharges this guard while
being weak evidence for the underlying claim. That is deliberate and matches how the family draws
the line: this is a PROVENANCE check — did you look — and correctness is the reviewer's
spec-verification, exactly as mt#4301's scope puts it ("this checks presence… the reviewer's
spec-verification owns correctness"). A guard that tried to judge whether the author looked at the
RIGHT field would need the paraphrase axis ADR-024 exists to keep it off.

### Posture

**Unchanged — RECORD-ONLY.** This task does not change the guard's posture, and per ADR-032 no
precision number it produces could license a flip: "the labeled response signal that tuning would
run on does not exist."

### The inherited blind spot (mt#4295)

Per mt#4295, a spec written through `tasks_edit --spec-file` carries no inline text on the call, so
`extractAuthoredSpecText` returns null and the guard records `skipped` — **for every class, this one
included.** A remaining-work claim written that way is invisible until mt#4295 lands. Named here
rather than solved: fixing it would be solving mt#4295's problem in mt#4299's diff.

## The fourth class: a causal attribution to another task (mt#4876)

### The incident

2026-09-01. An agent reported the reviewer bot's silence on a PR as _"consistent with mt#4753 being
BLOCKED"_ — to the principal in chat, AND durably into mt#4864's spec via `tasks_spec_patch`.
mt#4753's spec says close to the opposite: its premise was falsified 2026-08-29, the operator added
the repo to the App installation on 2026-08-30, and its §Experiment concludes _"No code change is
needed for a same-account repo."_ It is BLOCKED on a **cross-account** repo existing — a case that
PR was not.

The claim was sourced from the task's TITLE, which even carries the disclaimer _"(not the
same-account case this was filed for)"_. The principal caught it by asking.

### Why the three existing classes did not catch it

Not a recall gap in a matcher — a **discharge** gap, and the sharpest one this guard has had.

`check-task-spec-read.ts` grants read credit for the task a spec write TARGETS (mt#2814: _"writing
the spec is at least as strong a signal"_), which is correct. But it resolves ONE id per call —
`resolveTargetTaskId` reads the tool's own `taskId` — so refs cited inside the spec BODY are never
examined. The write came back clean AND credited a read of the task it had just written.

This guard DID run at that seam, and none of its three classes fits: the claim asserts no file
collision, no absence of an owner, and no outstanding work. The nearest is the remaining-work class,
and it is the instructive one — **its discharge is `taskIdsWithStatusRead`, whose tool set includes
`tasks_get`.** A bare `tasks_get` returns title, status, kind and tags, which is exactly the surface
this claim was built from. Had the causal claim been routed through that join, **the wider set would
have discharged the very claim it exists to catch.**

### What discharges it

`taskIdsWithSpecRead` — deliberately a STRICT SUBSET of `taskIdsWithStatusRead`:

| Call                                                                                  | Status set | Content set              |
| ------------------------------------------------------------------------------------- | ---------- | ------------------------ |
| `tasks_spec_get`                                                                      | ✅         | ✅                       |
| `tasks_get` **with** `includeSpec`                                                    | ✅         | ✅                       |
| `tasks_get` (bare)                                                                    | ✅         | ❌ — returns a TITLE     |
| `tasks_status_get`                                                                    | ✅         | ❌                       |
| `refs_status`                                                                         | ✅         | ❌                       |
| `tasks_spec_patch` / `tasks_spec_search_replace` / `tasks_edit` **with a spec field** | —          | ✅ (authorship, mt#2814) |
| `tasks_edit` metadata-only (`--kind`, `--title`)                                      | —          | ❌                       |

The principle is `check-task-spec-read.ts`'s own, applied to a join: _"A status field says where a
task sits in the lifecycle. Only its BODY says whether it is still worth doing."_

**The two sets must NOT be merged.** The remaining-work class is right to accept a status read — "is
mt#X still outstanding?" is a status question. This class is right to refuse one. Two questions, two
joins; a shared one would be wrong for whichever it was not tuned for.

### What triggers it, and what deliberately does not

A causal/explanatory connective and an `mt#N` ref **in one SENTENCE**. The siblings use the
paragraph; this is stricter, because these connectives are far commoner in ordinary spec prose than
a collision verb, so a paragraph-wide conjunction would measure co-occurrence rather than
attribution — the failure that cost the collision class 8 of 8 sampled fires before it narrowed.

**The vocabulary is SAMPLED, not invented**, per the discipline `warn-unwired-task-relationship.ts`
states for its own. Counted over `docs/` + `.minsky/rules/`, as sentences carrying both the
connective and an `mt#` ref: `because` 45 · `which is why` 7 · `the reason` 5 · `explains` 2 ·
`consistent with` 2 · `due to` 1. `caused by` measured zero here and is kept on separate evidence —
it is one of `/create-task` §2c's five named causal triggers. **Seven candidates measured zero and
were dropped rather than carried on plausibility**: `accounts for`, `on account of`, `stems from`,
`attributable to`, `that is why`, `explained by`.

Three suppressions, each answering one of the negative controls the task specified:

- **A relationship phrase yields to mt#2264.** `blocked on` was in the proposed connective list and
  is removed: `warn-unwired-task-relationship` runs on this same seam and carries `blocked by` /
  `gated on` literally. Two guards firing on one claim at one seam is the collision
  `stripDuplicateCheckRecords` already prevents for the mt#4004 sibling.
- **A gate-report paragraph is a record, not a claim** — reusing `isAuditRecordParagraph`, the
  largest measured false class on the sibling classes and the one that fires hardest at the most
  careful authors (mem#719).
- **Fenced blocks and blockquotes are elided; INLINE CODE SPANS ARE NOT.** ADR-024's Rung 1
  prescribes eliding markdown non-prose, but `elideMarkdownNonProse`'s second pass blanks code
  spans, and this corpus writes real refs inside backticks routinely. `check-task-spec-read.ts`
  records the same reason for its ask regex: _a backticked `mt#4753` is a real reference, not a
  quotation of one._ Blanking them would delete the ref half of the conjunction and drive the fire
  rate toward zero — a result that reads as a precision win and is the guard switched off.

A `## Members` list, a cross-reference list and a duplicate-check candidate list all name refs
without explaining anything, and none fires.

### Known recall gap, named rather than guessed at

The CLI spellings (`minsky tasks spec get …`, `minsky tasks get --include-spec` through `Bash` or
`session_exec`) are NOT matched. This follows `evidence-provenance-table.ts`'s own standing
discipline for the same omission on `STATUS_READ_TOOL_NAMES`: the CLI channel is left out because it
is UNMEASURED, and should be added _"on measured fires, not on anticipation."_

The direction of error is a FALSE FIRE at an author who read the spec through the CLI — the
dangerous direction — so this is the first thing to check when classifying calibration records.
Recovering it needs the command-manifest resolution `check-task-spec-read.ts` performs
(`cliSpecEngagements`), which is why it is not a one-line addition.

### Posture

RECORD-ONLY, like its three siblings, and for their measured reason rather than caution: the
40-transcript replay put this guard at 16 fires over 70 claims with ONE true positive, and 12 of the
16 were prose DISCUSSING a claim rather than asserting one — gate reports and duplicate-signature
reconciliations. That is precisely this class's negative-control population. The task's own spec
asked for advisory; the measurement on the host guard argues for one notch lower, graduating on this
class's own calibration data per ADR-032.

## Cross-references

- `.minsky/hooks/evidence-provenance-table.ts` — the shared discharge table
- `.minsky/hooks/duplicate-check-search-provenance.ts` — same claim shape, `tasks_create` only
- `.minsky/hooks/check-task-spec-read.ts` — the target-task read credit whose one-id scope leaves
  this seam open, and the source of the status-vs-body principle
- `.minsky/hooks/warn-unwired-task-relationship.ts` — the relationship axis this class yields to
- `docs/architecture/adr-042-gate-battery-enforcement-shape.md` — why this is not a gate-battery row
- mt#3806 (the prose half, DONE) · mt#4044 (the table, DONE) · mem#892 (the positive incident)
- mt#4876 (the fourth class) · mt#4864 (the originating write) · mt#3775 (the wider citation class,
  TODO — this delivers its spec-write-seam slice) · mt#4301 (the mechanism-causal sibling, TODO)
