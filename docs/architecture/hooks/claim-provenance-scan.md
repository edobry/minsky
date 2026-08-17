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

**These are the numbers that were hand-classified** (measured 2026-08-17). The window is the 40
MOST RECENT transcripts, so it slides: a re-run minutes later already read 354 / 73 / 18, because
the measuring session is itself one of the 40 and still growing. Re-measure before comparing, and
compare rates rather than counts.

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
