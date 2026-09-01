# Memory-staleness annotation

**Status:** shipped — trigger 1 (mt#1709), trigger 2 (mt#4452), trigger 3 (mt#4743) ·
**Surfaces:** `memory_search` (mt#1709) and `memory_get` (mt#4743) ·
**Source:** `packages/domain/src/memory/staleness.ts`

A memory that documents a workaround usually names the task that will retire it — _"Budget:
retire when mt#1700 ships"_, _"Tracking task: mt#1700"_, _"this bridge holds until mt#1700
lands"_. Until this shipped, that clause was inert prose. Nothing fired when the task landed,
so the record kept surfacing in `memory_search` with a prescription that had already been
superseded, and readers applied it.

This annotates the record at read time with the observed delta: the tracking task the
memory itself names has reached a completed status. It does not edit, retire, or rank the
record.

## Which reads are annotated (mt#4743)

**Both `memory_search` and `memory_get`.** mt#1709 shipped with one call site, inside
`search()`, and `get()` returned the row unannotated for its whole life. That was the wrong
half: an agent reaches a memory **by id** when something already told it which memory matters —
a handoff naming `mem#367`, a spec cross-reference, a family root cited by a prior task — so the
fetch-by-id reads are the load-bearing ones, and the speculative search reads were the only ones
getting the banner.

`MemoryService.getWithStaleness` routes through the **same** `annotateStaleness` pass, on a
one-element result list, rather than reimplementing it. Parity is therefore structural: a fourth
trigger added later lands on both surfaces at once, with no second implementation to keep in
step. `get()` itself is deliberately left un-annotated — it is the internal read for callers
that want the row, not a verdict about it.

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

### The quotation prefilter, and the second defect it closed (mt#4454)

The anchor requirement fixed the first precision defect and left a second one it could not see: a
clause the record **quotes** rather than declares. The grammar is identical, so — exactly as with
mem#96 — no reading of the pattern list could have surfaced it. Two live instances:

| Record       | Matched text                       | Context                                                                            |
| ------------ | ---------------------------------- | ---------------------------------------------------------------------------------- |
| **mem#484**  | `retire when mt#2056 ships`        | a **prose quotation** of a DIFFERENT memory's budget, inside an incident narrative |
| **mem#1340** | `` `Retire when mt#1541 ships.` `` | a **code span** — the record's own documented discrimination-control fixture       |

So the text scan now matches the **residual** after ADR-024 Rung 1 elision
(`packages/domain/src/text/prose-elision.ts`): markdown code spans / fenced blocks / blockquote
lines, then prose-quoted spans. Both halves are load-bearing — mem#484 survives markdown elision
untouched, mem#1340 needs it.

Measured over the live corpus (1343 memories, 2026-08-30), comparing the text path before and
after: **10 records stopped producing a ref, 0 gained one.** All 10 were producing a _stale_
banner, and the three `Temporary mechanism budget` records kept their genuine `mt#1034` clause
while losing only the backticked `tracking task: mt#1503` **example** — which is what a
one-sided fix would have destroyed.

**The corpus-wide fire rate did not move (149 of 1343, 11.09%), and that is not the fix failing.**
Since mt#4448 the write path derives `associations.tracksTask` from the same extractor, and
`extractTrackingTaskRefs` checks the association FIRST — so all 10 records already carry a minted
association and keep rendering stale from it. This fix stops NEW false associations at the source;
repairing the already-minted ones is **mt#4765**.

**Known false negative, accepted deliberately.** ADR-024's half (b) is _"prose-quoted spans **and
explicit discussion-framing**"_, and only the first ships. A record quoting its OWN budget —
mem#1237's _`("retires when mt#4525 and mt#4295 land …")`_ — is elided too, because nothing yet
distinguishes whose clause is being quoted. Two of the ten (mem#1237, mem#361) are this shape. The
trade is a record that goes un-annotated against records that were being annotated wrongly; if
self-quotation proves commoner than 2-in-10, that is the evidence for building the framing half,
not for widening the patterns.

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

A record declaring no retirement clause at all gets **no `staleness` field**, which is still the
common case. The **87%** figure this sentence carried was measured before triggers 2 and 3
existed and is superseded: re-measured 2026-08-30 over 1,339 live records, **333 (24.9%)** now
declare something any trigger can key on — an association, a retirement clause, or a task-state
assertion — and **75.1%** still declare nothing and cost no lookup.

## Trigger 3 — task-state assertions (mt#4743)

Triggers 1 and 2 both detect a memory declaring **its own** expiry. The most common thing a
long-lived family root actually contains is neither: a statement about **another task's** state.
Lineage sections are made of them, and they rot silently — the sentence was true when written and
nothing re-derives it.

Originating incident: `/plan-task mt#1873` fetched mem#367 by id, carried its description of
Surface 4 as _"still blind"_ into a spec as current fact, and the analyzer had shipped twelve days
earlier. Neither shipped trigger could see it.

### The pattern set is one form, and the reason is checkability

Measured over the live corpus (1,339 records):

| Candidate form                              | Records    | Shipped? |
| ------------------------------------------- | ---------- | -------- |
| `mt#N (STATUS)` — parenthetical             | 120 (9.0%) | **yes**  |
| `mt#N is/was still\|now\|scoped\|already …` | 53 (4.0%)  | no       |
| `mt#N remains …`                            | 9 (0.7%)   | no       |

The split is **not** by frequency. The parenthetical names a status TOKEN, so the claim can be
compared against the task record and a mismatch is a fact. _"mt#4196 is still blind"_ names no
status; deciding whether it is now false means reading what "blind" meant, which is a judgment no
comparison can make. Shipping only the checkable form keeps this trigger's precision a property of
the mechanism rather than of a heuristic needing calibration.

The closing paren is deliberately **not** required, because the corpus routinely qualifies the
status inside the same parenthetical — `mt#4141 (DONE 2026-08-14, PR #2998)`,
`mt#2052 (PLANNING, stalled ~83 days)`. Anchoring on `)` would miss both, and an annotated status
is if anything more likely to be stale than a bare one.

### What it is worth

Of **174** claims across those 120 records: **121 accurate, 53 (30.5%) now wrong**, of which
**47** assert a non-terminal status for a task that has since reached DONE or CLOSED. Zero refs
failed to resolve. Roughly a third of the explicit status claims in this corpus are false.

### Two deliberate non-behaviors

1. **It never touches `extractTrackingTaskRefs`.** That function has a second consumer:
   `memory.create` derives `associations.tracksTask` from it (mt#4448), and the read path then
   takes the association fast path without re-scanning text — so a false match there is minted
   once into structured data and is immune to every later fix (mt#4765). Trigger 3 is a sibling of
   trigger 2's `annotateMeasurementDecay`: read-path only, so its worst case is a transient
   advisory a reader dismisses.
2. **Promotion to `stale` requires the terminal subset.** A lineage bullet reading `mt#X (TODO)`
   when mt#X is now IN-PROGRESS is dated and says nothing about whether the record's prescription
   holds; promoting on it would flag a third of the corpus's family roots as obsolete. So
   promotion needs a drifted assertion whose task went terminal — 47 of the 53, nearly all the
   signal without the tail carrying almost none. Non-promoting drift is recorded in
   `taskStateDrift` and renders nothing, preserving `note`'s "present only when stale" invariant.

Trigger 3's refs union into trigger 1's existing lookup, so it adds **no** query.

**No quotation prefilter yet — but the primitive now exists (mt#4454).** A status claim inside a
code fence or blockquote will still match here: trigger 3 reads the raw body, and only trigger 1's
`extractTrackingTaskRefs` was wired to the elider. It is tolerable meanwhile for the reason in (1)
above. What changed is that adopting it is now a one-line composition rather than a dependency —
`elideQuotedAndMarkdown` from `packages/domain/src/text/prose-elision.ts`. It was deliberately NOT
applied to triggers 2 and 3 in the same change: their own false-positive profiles are unmeasured,
and wiring an elider into three detectors on one detector's evidence is the opposite of ADR-024's
evidence gate. Same applies to trigger 2's `CITED_PATH_PATTERN` / `CITED_TABLE_PATTERN`.

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
    measurement?: MeasurementDecay,   // trigger 2 (mt#4452)
    taskStateDrift?: TaskStateDrift,  // trigger 3 (mt#4743)
  }
}
```

### `memory_get`'s shape is ADDITIVE (mt#4743)

The domain method returns `MemoryReadResult` — `{ record, staleness? }`, the same `staleness`
type with no `score`, because a fetch-by-id has no query to be relevant to.

The **MCP/CLI response deliberately does not adopt that wrapper.** `memory.get` has always
returned the record's fields at the top level, so the command spreads the record and puts
`staleness` alongside:

```ts
// memory.get response — every pre-existing field stays at its existing path
{ id, shortId, type, name, description, content, /* … */, staleness?: { … } }
```

Nothing that consumed `memory.get` before sees a shape change, and the key is **absent
entirely** — not `null` — for a record declaring no retirement relationship, matching
`MemorySearchResult`'s optional-not-`"current"` convention. When probing for it, test
`has("staleness")` rather than reading the value: a `jq '{staleness}'` projection over a
record that lacks the key prints `null`, which is indistinguishable from a present-and-null
field.

Computed per response and **never persisted** — the stored record is untouched, so the verdict
itself cannot go stale.

## Where it is wired

| Site                                                 | Role                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/domain/src/memory/staleness.ts`            | pure detection core (no I/O)                                         |
| `packages/domain/src/memory/task-status-lookup.ts`   | batched status query — the only piece touching a DB                  |
| `packages/domain/src/memory/task-state-assertion.ts` | trigger 3's pure detection core (mt#4743)                            |
| `MemoryService.search()`                             | annotation pass; unions refs across the page, one lookup per search  |
| `MemoryService.getWithStaleness()`                   | the fetch-by-id surface (mt#4743); same pass, one-element list       |
| `src/adapters/shared/commands/memory/index.ts`       | injects the production lookup; spreads `staleness` into `memory.get` |
| `.minsky/hooks/memory-search.ts`                     | **carries the note into injected agent context**                     |

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
