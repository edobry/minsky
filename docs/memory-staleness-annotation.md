# Memory-staleness annotation

**Status:** shipped (mt#1709, trigger 1) · **Source:** `packages/domain/src/memory/staleness.ts`

A memory that documents a workaround usually names the task that will retire it — _"Budget:
retire when mt#1700 ships"_, _"Tracking task: mt#1700"_, _"this bridge holds until mt#1700
lands"_. Until this shipped, that clause was inert prose. Nothing fired when the task landed,
so the record kept surfacing in `memory_search` with a prescription that had already been
superseded, and readers applied it.

This annotates the search result at read time with the observed delta: the tracking task the
memory itself names has reached a completed status. It does not edit, retire, or rank the
record.

## What a reader sees

Only an affirmative finding renders anything:

```
⚠️ POSSIBLY OBSOLETE — this memory's tracking task completed (mt#1700 is DONE). The
structural fix it was written to bridge may already have shipped; verify before acting on
its prescription.
```

Note what it does **not** say. It does not assert the memory is wrong — the detector has no
standing to reach that verdict. It reports that the memory's own stated retirement condition
has been met and leaves the judgment to the reader.

## Detection

Two sources, in priority order.

**1. `associations.tracksTask`** (ADR-012 Shape A) — exact and indexed, no false positives.

**2. Retirement-clause patterns over the body**, used when the association is absent.

The association is **empty across the live corpus today**: the backfill
(`scripts/backfill-memory-associations.ts`, mt#2071, closed DONE 2026-05-24) was one of the two
dead scripts mt#3178 repaired in July — it crashed before its first query for its whole
post-closeout life, and has not been re-run. mt#4448 owns fixing that. Until it lands the text
scan carries everything, and source (1) takes over for free afterwards.

Consequence worth stating plainly: **an absent `tracksTask` key means "not backfilled", never
"no tracking task exists"**, so a record whose association map lacks the key falls THROUGH to
the text scan rather than short-circuiting to "current".

### The pattern set, and why it is narrow

Patterns come in two families.

**Self-anchoring** — the phrasing itself states a retirement relationship:

| Form                                   | Example                             |
| -------------------------------------- | ----------------------------------- |
| `retire when/once/after mt#N`          | `Budget: retire when mt#1700 ships` |
| `tracking task[:] mt#N`                | `Tracking task: mt#1700`            |
| `tracking: mt#N` (colon required)      | `Tracking: mt#1700`                 |
| `bridge … until mt#N`                  | `bridge until mt#1700 ships`        |
| `superseded/subsumed/replaced by mt#N` | `Superseded by mt#1700`             |

**Conditional** — `until` / `once` / `when mt#N ships|lands|completes|merges|is done`. These
require a **retirement anchor** (`retire`, `budget`, `bridge`, `interim`, `temporary`,
`stopgap`, `workaround`, `holds`, `obsolete`, `delete this`, `this memory`, …) on the **same
line**, within 140 characters either side of the match.

The anchor is checked on **both** sides because the canonical phrasings put it on different
ones: _"bridge until mt#X ships"_ before, _"Once mt#X ships, delete this"_ after. It is bounded
to the line so a stray anchor in a neighbouring bullet cannot vouch for an unrelated clause.

**The line bound has a known cost, accepted deliberately.** A clause hard-wrapped away from its
anchor does not fire:

```
This entry is a bridge, and it
remains in force until mt#1001 lands.     <- no anchor on this line -> silent
```

Widening across lines would re-admit exactly mem#96's shape, where a neighbouring bullet
supplies the anchor:

```
- This entry is a bridge for something else entirely.
- Subtask E: push transport, scheduled for when mt#1001 lands
```

Both directions are pinned by tests (`anchor scanning is line-bounded`), so a future widening
has to change a test rather than silently move the trade-off. The asymmetry that makes this the
right default: a miss costs one un-annotated memory, while a false positive costs a banner on a
current memory, on a surface read dozens of times a session. Only the conditional family
consults the anchor — self-anchoring forms like `Tracking task: mt#N` are unaffected by line
position.

A **bare `mt#NNNN` mention never fires.** Memories cite tasks constantly for ordinary
cross-reference, and 500+ tasks reached DONE in the 22 days to 2026-08-22 — a general task-id
match would flag most of the corpus.

### Why the anchor requirement exists

It was not designed in; it was measured. The first cut treated the conditional forms as
self-anchoring and fired on **194 of 1206** live memories (16.09%). Spot-checking the output
found **mem#96** ("Cockpit v0 task cluster") flagged because a subtask bullet read:

> `**mt#1148** — Subtask E: push transport (polling v0 → SSE migration when mt#1001 lands)`

That sentence schedules other work. It says nothing about whether the memory containing it is
still true — and no amount of care reading the pattern list would have surfaced that, because
the grammar is identical to the genuine form.

After the anchor requirement: **131 of 1206 (10.86%)**. mem#96, mem#19 and mem#102 all stopped
firing.

### Why it does not reuse `bridge-memory-retirement.ts`'s patterns

`.minsky/hooks/bridge-memory-retirement.ts` (mt#2062) solves what looks like the same problem
and its `isBridgeCandidate()` is deliberately **loose** — the bare word "bridge" anywhere, or
any mention of the task id. Copying it here would be wrong, because the two run in opposite
directions with opposite error budgets:

|                            | Direction       | Runs                | Optimizes for | A false positive costs                      |
| -------------------------- | --------------- | ------------------- | ------------- | ------------------------------------------- |
| `bridge-memory-retirement` | task → memories | once, at DONE       | **recall**    | one line a human skims                      |
| this module                | memory → tasks  | every search result | **precision** | a banner on a current memory, every session |

## The three-way verdict

`computeStaleness` returns one of three outcomes, and the distinction is load-bearing:

| Outcome      | Meaning                                      | Renders? |
| ------------ | -------------------------------------------- | -------- |
| `stale`      | ≥1 tracking task is DONE or CLOSED           | **yes**  |
| `current`    | every tracking task resolved, none completed | no       |
| `unresolved` | ≥1 tracking task could not be resolved       | no       |

`unresolved` exists so that _"we could not answer"_ never collapses into _"we answered,
nothing is stale"_ — the same discipline `packages/domain/src/tasks/spec-freshness.ts` adopted
with `checked: false`. A check that could not run must not read as a check that passed.

Both `current` and `unresolved` render **nothing**. That is the silence contract: a detector
that emits on every result trains readers to skip it. `unresolved` stays distinguishable in the
structured field for anyone who asks; it just does not shout.

A record declaring no retirement clause at all gets **no `staleness` field**, which is the
overwhelmingly common case (about 87% of the corpus).

**`unresolved` also emits a structured warning.** A memory naming a task id the task graph
cannot account for is worth knowing about even though it must never block or annotate the
search, so `annotateStaleness` logs the memory id and the unresolved ids together. The decision
of what to warn about is a pure function (`collectUnresolvedRefs`) rather than an inline
condition, so it can be tested directly — `tests/setup.ts` silences winston's Console under the
in-process harness, which would make an "assert the log line appeared" test assert nothing. A
`stale` verdict with an unresolved sibling does **not** warn: it resolved what it needed to, and
the annotation already fired.

## Response shape

`MemorySearchResult` gains an optional `staleness`:

```ts
{
  record: MemoryRecord,
  score: number,
  staleness?: {
    outcome: "stale" | "current" | "unresolved",
    source: "associations" | "text",
    completedTasks: { taskId: string; status: string }[],
    unresolvedTasks: string[],
    note?: string,   // present only when outcome === "stale"
  }
}
```

Computed per response and **never persisted** — the stored record is untouched, so the verdict
itself cannot go stale.

## Where it is wired

| Site                                               | Role                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `packages/domain/src/memory/staleness.ts`          | pure detection core (no I/O)                                        |
| `packages/domain/src/memory/task-status-lookup.ts` | batched status query — the only piece touching a DB                 |
| `MemoryService.search()`                           | annotation pass; unions refs across the page, one lookup per search |
| `src/adapters/shared/commands/memory/index.ts`     | injects the production lookup                                       |
| `.minsky/hooks/memory-search.ts`                   | **carries the note into injected agent context**                    |

That last row is the one that makes the feature real. The injector's parser rebuilds each
result field-by-field, so a new response field is dropped unless explicitly carried — server-side
detection alone would have shipped a feature that runs, passes its tests, and produces nothing
(`work-completion.mdc §Invocation path`). The note renders **above** the description, because
budget truncation cuts from the end and would otherwise drop the warning on exactly the long
records most likely to have gone stale.

## Consumers that deliberately do NOT render it

- **Cockpit memory widgets** (`src/cockpit/web/widgets/MemorySearch.tsx`, `MemoryDetail.tsx`,
  `src/cockpit/widgets/memories-*.ts`) — unaffected; the field is optional and additive. Not
  rendered in v1: the annotation is written for an agent about to apply a prescription, and
  surfacing it in the browsing UI is its own design question. A natural follow-on, not a gap.
- **`src/mcp/middleware/memory-enrichment.ts`** — the mt#1588 spike, opt-in and default-off.
  Unaffected.

## Verifying it

```
bun scripts/verify-memory-staleness.ts            # fire-rate summary
bun scripts/verify-memory-staleness.ts --verbose  # list each firing record
bun scripts/verify-memory-staleness.ts --json     # structured output
```

Skips cleanly (exit 0) with no SQL-capable persistence configured. Fails above a **25%**
fire-rate ceiling — a detector that fires on most results is noise regardless of per-case
correctness. Re-run it after any pattern change; the ceiling is the regression guard, and the
`--verbose` list is how a suspected false positive gets found.

## Not covered

- **Dated-measurement staleness** — **now covered, as trigger 2 (mt#4452)**. See
  `## Trigger 2 — measurement decay` below.
- **Figure-level attribution.** v1 annotates the RECORD. mem#773 is the counter-example: its
  turn-table numbers were invalidated by mt#4345 while its blob numbers were untouched, so
  decaying the whole record would have been as wrong as decaying none of it. Attributing decay
  to individual figures needs a per-claim provenance the schema does not carry — a stated
  narrowing, not an oversight.
- **Cross-project task references.** `mt#NNNN` only.
- **Auto-retirement.** This annotates; it never deletes, edits, or supersedes. The write-side
  counterpart is `.minsky/hooks/bridge-memory-retirement.ts` (mt#2062), which prompts at
  task-DONE time; offline bulk consolidation is memory Phase 2 (mt#279).

## Trigger 2 — measurement decay (mt#4452)

Trigger 1 keys on a clause the author WROTE. Trigger 2 keys on what they could not have
written, because they could not know which future task would invalidate their numbers: a
**dated measurement** whose cited subsystem has changed since it was taken.

`packages/domain/src/memory/measurement-decay.ts`. A record needs all three to fire:

1. **A measurement-bound date** — `measured 2026-07-30`, `Baseline 2026-05-12`,
   `the 2026-06-30 measurement`. NOT `as of <date>` or `verified <date>`: those match session
   boundaries and status checks, and the loose first cut was dominated by `handoff_*` records
   because every handoff carries a "Statuses verified in-turn at …" line.
2. **A figure with a magnitude unit** — `%`, `MB`, `rows`, `updates`, optionally with an SI
   prefix (`14.2 M updates`). A bare integer is a task id or a year; neither decays.
3. **Something that landed on a cited subsystem since** — a completed task whose spec cites one
   of the memory's own backticked paths or table names.

Age alone is never staleness. A ten-month-old measurement of something nobody has touched is
still accurate, and stays silent.

### Two bounds, both added because the live run demanded them

**A 5-day age floor.** Grounded in observed cadence per `decision-defaults.mdc §Thresholds`:
that is this project's budget window, and roughly 23 tasks complete per day here, so below it
"something touched that subsystem" carries no information.

**A specificity requirement on non-path subsystem tokens** (14 chars). `task_specs` appears in
a large share of specs; matching on it means the subsystem is not what selected the tasks.

Without them the first live run fired on **38 of 39** candidates — including a baseline
recorded ONE DAY before the run — with the same few task ids recurring as "intervening" across
unrelated memories. With them: **27 of 37, 2.22% of the corpus.** mem#773 still fires at 54
days; the day-old baselines do not.

### The known weakness, stated plainly

The intervening-task signal rests on `tasks.updatedAt`, which the schema bumps on **any** row
mutation rather than on completion. A task finished in June but reparented last week satisfies
`updatedAt >= since` for a measurement taken in August. The two bounds above limit how wrong
that can look; they do not fix it. A real fix needs a completion timestamp the `tasks` table
does not carry. This is the same defect mt#4420 documents for `task_specs.updated_at`.

### Reading the annotation

A measurement-decay verdict is `stale` with EMPTY tracking-task fields — mem#773's shape. It
can also **promote** a trigger-1 `current` verdict: an open tracking task says nothing about
whether the record's numbers still hold. When both fire, both notes render.

### Handoffs are not excluded by genre

`handoff_*` records are ~44% of firings. Not filtered out in v1, deliberately: a handoff whose
figures describe a changed subsystem is arguably a TRUE positive, and the only argument against
annotating it is that a handoff is self-evidently historical. That is a usefulness judgment, to
be made on measured data rather than pre-empted — `scripts/verify-memory-staleness.ts` reports
the handoff share separately so the revisit has evidence. Read
`RFC: Conversation succession — handoffs as first-class substrate entities` first if handoffs
gain their own lifecycle.

## See also

- ADR-012 — the `associations` design this extends · mt#4448 — populating it
- mt#2062 / `.minsky/hooks/bridge-memory-retirement.ts` — the write-side half
- mt#2826 / `spec-freshness.ts` — the sibling drift check this borrows its three-valued contract from
- mt#3170 — the same detection shape applied to task specs
- mem#484 — the retirement decision rule a reader should apply once this fires
