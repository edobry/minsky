# Evaluation-loop Phase 2 (recurrence-after-done + the rationalization review)

Architecture reference for mt#2901, Phase 2 of the evaluation-loop RFC (Notion
`392937f0-3cb4-8188-aad6-d7d041de814b`, Accepted 2026-07-08). Companion to
`docs/architecture/evaluation-loop-fire-log.md` (Phase 1: fire-log instrumentation,
canaries, the legacy-calibration adapter — all data sources this document's
mechanisms consume).

Phase 2 ships two things per the RFC's Part 2 and Part 3:

1. The `/retrospective` skill's **recurrence-after-DONE contradiction check** —
   `.minsky/skills/retrospective/SKILL.md`.
2. The **rationalization review** — `scripts/rationalization-review.ts` +
   `src/domain/calibration/rationalization-review.ts`.

Both depend on a new substrate decision: the **family-membership metadata
convention**, described first below since both mechanisms consume it.

## Family-membership metadata convention

**Open question the RFC left for this task:** "The exact shape of the
family-to-fix-task registry field (task metadata is the substrate; the schema
needs a design pass in Phase 2)."

**Decision: the task `tags` field, convention `family:<slug>`.**

### Why tags

`tags?: string[]` (`packages/domain/src/tasks/types.ts`) is already:

- **General-purpose** — not repurposed from something else; a plain string-array
  field every task carries, already used for thematic batching (e.g. `process`,
  `gap-analysis-2026-07`).
- **Editable today** — `mcp__minsky__tasks_edit --tag <tags...> --execute` (dry-run
  by default per `operational-safety-dry-run-first.mdc`), backed by
  `TaskServiceInterface.updateTask` / the minsky-backend's `updateTags`.
- **Queryable today** — `TaskListOptions.tags` (`listTasks({ tags: [...] })`) on the
  minsky backend (`minskyTaskBackend.ts`'s `like(tasksTable.tags, ...)` filter) and
  the GitHub-issues backend (label-based).
- **Versioned and structured relative to memory tags** — this is the RFC's explicit
  instruction: "Family membership lives in the structural-fix task's metadata (a
  versioned, structured substrate), not in memory tags." A task row is a durable,
  status-machine-governed record; a memory-entry free-text tag is not.

No new schema, migration, or backend capability was needed — this is a **convention
on an existing field**, not new infrastructure (per the RFC's Position #2: "build
almost nothing new").

### The convention

- A structural-fix task that closes out (or partially addresses) a **failure
  family** carries a tag of the form `family:<slug>`.
- **Slug derivation:**
  - **Single-guard families** (the common case — a family IS "this guard's target
    failure class"): the slug is the **guard's own name**, exactly as it appears in
    `GUARD_REGISTRY`/`CALIBRATION_LOG_REGISTRY`/the fire-log's `guardName` field
    (e.g. `family:causal-premise-detector`). This is a deliberate design choice: it
    lets the rationalization review join family data directly onto a panel row by
    `guardName === familySlug`, with no separate name-mapping table to keep in sync
    (avoiding a repeat of `calibration-sweep.ts`'s `CALIBRATION_NAME_TO_GUARD_NAME`
    staleness class — see that module's own doc comment on the mt#2889 PR #2012 R1
    incident where a registry addition landed after the map was written).
  - **Multi-guard or non-guard families** (a rule, a process step, a pattern
    spanning several enforcement points): a short kebab-case description of the
    pattern, matching the naming already used in `/retrospective`'s Step 3
    family-level recurrence check (e.g. `confabulated-strategic-frame`) — keeping
    the memory-side family name and the task-side family slug in lockstep under one
    naming source, per the skill's own cross-reference discipline.
- **Multiple tasks may share a family tag.** The convention does not require
  exactly one task per family — a family may accumulate an original fix task, a
  later incident/discovery task, a subsequent tightening task, etc. For the
  rationalization review's `recurrencesSinceDone` computation, the **anchor** is the
  **earliest DONE-status task** carrying the family tag (see "Known limitation"
  below for why `updatedAt` is an imperfect proxy for "when did this task's fix
  actually ship").

### Migration path

**Lazy backfill, not a bulk migration.** Per `operational-safety-dry-run-first.mdc`
§Bulk shared-state mutations: retroactively tagging the entire historical task
corpus for family membership would be an unbounded, low-value bulk edit (most
historical tasks were never structural-fix citations in a retrospective, and
guessing family membership after the fact from title text alone risks the exact
premise-verification failure `decision-defaults.mdc §Subsystem-assignment
verification` warns against). Instead:

- **Going forward:** when `/retrospective`'s Step 5 (see below) cites a structural-
  fix task and that task lacks a family tag, the retrospective is the natural place
  to add one — the incident is freshly classified, the family name (if any) is
  already known from Step 3's family-level recurrence check, and the citation is
  already being verified for liveness.
- **This task's worked example is the corpus's first two entries.** `mt#2216`
  (`family:causal-premise-detector`, the original fix, DONE 2026-06-08) and
  `mt#2832` (`family:causal-premise-detector`, the recurrence-discovery task, DONE
  2026-07-16) were tagged during this task's implementation — see the worked
  example in the skill file and the rationalization review's real output.
- **No task is required to carry a family tag.** The rationalization review's
  `recurrencesSinceDone` panel column is `"n/a"` for every guard with no
  family-tagged task on file — an honest "no data yet," never a silent zero.

### Known limitation: `updatedAt` as a DONE-transition proxy

The task substrate does not carry a distinct "status transitioned to DONE at time
T" timestamp — `Task.updatedAt` is a generic last-modification timestamp, bumped by
**any** field edit, including the family-tag edit itself. This means:

- Tagging a task for family membership **after** it reaches DONE resets the anchor
  used for `recurrencesSinceDone` to "the tagging time," not the true DONE
  transition time — this happened to this task's own worked example (`mt#2216`'s
  `updatedAt` moved from 2026-06-08 to the moment it was tagged during mt#2901's
  implementation).
- The practical effect is a **conservative undercount**, never an inflated one: the
  review only counts fires strictly after the (later, artificial) anchor, so it
  reports fewer recurrences than a true DONE-date anchor would — it cannot show
  phantom recurrences that didn't happen.
- **Does NOT cover:** recovering the true historical DONE-transition timestamp for
  a task tagged well after the fact. **Owner:** no task filed yet for a distinct
  `doneAt`/status-history column — this is a gap, not a resolved concern; a future
  task should add one if `recurrencesSinceDone` precision becomes load-bearing for
  a disposition decision (today it is one column among several judgment-free
  signals, not the sole trigger — the retrospective-skill check below does not
  depend on this timestamp at all, only on the DONE/not-DONE state).

## Recurrence-after-DONE detection (`/retrospective` Step 5 extension)

RFC Part 2, Position #5: "Recurrence-after-done should be detected mechanically...
the primary trigger is the retrospective skill itself. It already verifies that
cited structural-fix tasks are alive; the extension tests the complementary case:
the fix task is DONE and the incident pattern just recurred."

### Mechanism

`.minsky/skills/retrospective/SKILL.md` Step 5 already ran a liveness check on
every cited structural-fix task (`{TODO,PLANNING,READY,IN-PROGRESS,IN-REVIEW}` =
alive; `{CLOSED,DONE,BLOCKED}` = dead-as-target) — and already NOTED, in prose,
that a DONE citation whose pattern recurred is stale. Phase 2 promotes that note
into a **first-class, mandatory output section** ("Recurrence-after-DONE") with a
structural test: the cited task's status is DONE, **and** it carries a
`family:<slug>` tag matching the current incident's family. When both hold, the
retrospective's **primary recommendation must address containment failure** — why
the shipped mechanism didn't hold the class, not another isolated per-surface
patch — rather than treating the per-surface fix as sufficient on its own.

### Covers

- A `/retrospective` invocation that cites a structural-fix task whose status is
  DONE, where that task (or another task in the same family) carries a
  `family:<slug>` tag matching the slug the current incident's failure pattern
  resolves to.
- The worked example below (mt#2216 → mt#2832) is exactly this case, walked
  through step by step.

### Does NOT cover

- **Recurrences that never trigger a `/retrospective` invocation.** The RFC names
  a backstop for this: "a periodic sweep over family-linked memories... for
  recurrences that never pass through a retrospective." That sweep is **NOT
  implemented by this task** — it is explicitly out of scope (this task's Scope
  section: the skill extension, the metadata convention, the first review run, the
  cadence recommendation; not a new standing sweep mechanism). **No owner task is
  filed yet for the periodic-sweep backstop** — this is a real gap, not a
  resolved concern, and per `CLAUDE.md §Recovery layer spec discipline` it is
  named here explicitly rather than left implicit. The rationalization review
  (below) is a PARTIAL substitute in the interim: its `recurrencesSinceDone`
  column surfaces continued fires for family-tagged guards regardless of whether a
  retrospective ever ran — but only for guards with a family tag already on file,
  and on the review's cadence (quarterly), not in near-real-time.
- **A cited DONE task with no family tag yet.** The pre-existing Step 5 prose note
  ("the citation is stale... perpetuates the false-cover") still fires — the
  retrospective still flags the DONE-but-recurred situation in prose — but the
  new **structured** "Recurrence-after-DONE" section, with its containment-failure
  recommendation requirement, needs the family-tag match to fire. This degrades
  gracefully (the old behavior is a strict subset of the new), not silently: the
  retrospective's Step 5 output should still name the gap even without a tag
  match, and per the migration path above, this is the moment to add the tag.
- **A family whose current incident's slug cannot be determined** (Step 3's
  family-level recurrence check found no established family name/pattern yet —
  e.g. a genuinely first-time failure with an as-yet-unnamed root). No structural
  check fires; ordinary Step 5 liveness handling applies.

## The rationalization review

RFC Part 3. Full design already covered in the pure-logic module's doc comments
(`src/domain/calibration/rationalization-review.ts`) and the CLI adapter's
(`scripts/rationalization-review.ts`) — this section is the index, not a
duplicate.

### Integration choice

**A standalone script** (`scripts/rationalization-review.ts`), not a new
`observability.*`/`calibration.*` shared command. Per this task's spec ("pick the
cheaper integration and note it"): the review needs three real-world read
surfaces — the fire-log, the full guard-canary suite, and `GUARD_REGISTRY` — that
`scripts/run-guard-canaries.ts` (mt#2889) already proves the wiring pattern for,
and it runs on a periodic/manual cadence (quarterly per the RFC), not as an
interactive CLI/MCP command a user invokes ad hoc. Registering a new shared
command would add Zod-schema-and-registry boilerplate for a mechanism whose
natural callers are a human operator or a future `/schedule` routine — the same
shape that already led the canary runner itself to be a script, not a command.

### Panel columns (judgment-free — RFC Part 3, no TP/FP labeling)

fire count; override count and rate by classification
(`authorized_exception`/`unclassified`/`contested`); latency percentiles
(p50/p95/p99, real fire-log records only — legacy-calibration records carry no
per-fire timing); the static attention-cost annotation
(`GUARD_REGISTRY.attentionCost`); canary status (`PASS`/`FAIL`/`MISSING`); days
since last fire; recurrences-since-done (family metadata, `"n/a"` where absent).
**No composite score is ever computed** — the RFC's Goodhart threat
("no composite per-guard score is computed, ever") is enforced structurally: every
panel row exposes only named raw fields, verified by a dedicated unit test.

### Auto-affirm threshold

A guard auto-affirms when **all** of: override rate ≤ 20% (reusing the exact
threshold `/calibration-review`'s Step 3 already applies to per-log FP rates — the
two review mechanisms are siblings over the same corpus); canary status `PASS`;
fire count > 0 (no zero-fire anomaly); and `recurrencesSinceDone` is `0` or
`"n/a"` (never a positive count). Any one failing condition routes the guard to
**outlier**, with the specific reason(s) named — never silently. This satisfies
the RFC's Threats-section requirement verbatim: "the override-budget rule
(exceeding the budget requires a disposition, affirm-by-default not among the
allowed responses)" — a guard over budget can only ever be an outlier, structurally,
because the same 20% threshold is the sole override-rate gate in the classifier.

**Retirement is never automatic.** Nothing in this review computes or suggests
"retire" — per the RFC, retirement requires "the conjunction: zero fires,
near-zero overrides, canary passing, AND a manual judgment that the incident class
is genuinely extinct." The outlier list is decision-support; the operator's
disposition (via the routed ask) is where flip/tune/retire/affirm actually gets
decided.

### Cadence recommendation

Per the RFC's explicit policy ("Initial cadence quarterly; an all-quiet review
doubles the interval; hard maximum twelve months"): `computeCadenceRecommendation`
holds the 90-day default for a first review (there is no prior review to compare
an "all-quiet" signal against) and cites the actual observed volume from the panel
— see the real run's output below. A later review with a captured prior result can
double the interval on an all-quiet pass, capped at 365 days.

### Self-review fire-logging

RFC Threats: "the review must... end in decisions (enforced), and its own execution
is fire-logged." This script's own execution is recorded as
`{ guardName: "rationalization-review", event: "Review", decision }` — the closest
fit in the existing tri-state schema (no schema extension needed): `"allow"` when
the review ended in a real ask (the common, intended path — `--execute` is meant
to be invoked once, after the ask is filed), `"deny"` when a pass produced only a
report with no ask (`--execute --report-only`), matching the RFC's "a review that
produces only a report is recorded as a **failed** review in its own fire-log."

## First real review — execution evidence

Run against the real corpus (`~/.local/state/minsky/fire-log.jsonl` + the six
legacy calibration logs) on 2026-07-18, after tagging `mt#2216`/`mt#2832` with
`family:causal-premise-detector`:

- **10,256 records** across **43 guards** (37 `GUARD_REGISTRY`/standalone-hook
  guards plus 6 pre-commit pipeline steps not covered by the canary mechanism —
  see "Caveat" below), spanning a 1.6-day corpus window (~6,300 fires/day — this
  environment runs many concurrent sessions).
- **23 guards auto-affirmed**; **20 outliers** — of which 19 are `canary-missing`
  (every one of them is a pre-commit pipeline step: `code-formatting`,
  `compile-check`, `type-check`, `unit-tests`, `eslint-validation`, etc. — these
  were never in scope for the mt#2889 canary mechanism, which covers
  `GUARD_REGISTRY` + standalone dispatcher guards, not the pre-commit pipeline) and
  **one** (`causal-premise-detector`) is `recurrence-since-done` — the worked
  example, confirmed live: `fires=117, recurrencesSinceDone=1`.
- **Cadence recommendation: 90 days** (RFC default; first review, no prior
  baseline).

**Caveat surfaced by this first run, carried into the routed ask:** the
canary-missing outliers are overwhelmingly a coverage-scope artifact (pre-commit
steps were out of scope for mt#2889's canary declarations), not a signal that 19
guards are actually broken. The routed ask treats this as ONE grouped outlier
rather than 19 individually-argued ones, per the RFC's "guards packaged... reduces
notification overhead" intent — flagging it explicitly rather than letting a large
outlier count read as 19 independent problems.

**The ONE routed ask:** `direction.decide` ask `c8fc1f97-f062-4da0-8b51-f367504738c2`
(filed 2026-07-18) — the 22 auto-affirmed guards in one summary line, plus two
outlier groups (the canary-missing pre-commit-scope gap; `causal-premise-detector`'s
recurrence-since-done) each with flip/tune/retire/affirm options. Corpus numbers in
this document and in the ask are a snapshot from the run that produced it — this
environment runs many concurrent sessions, so the live fire-log grows continuously
and a re-run minutes later will show slightly higher counts; the disposition
signals (auto-affirm vs. outlier, and why) are stable across that drift. The
review's own execution is fire-logged: `{guardName: "rationalization-review",
event: "Review", decision: "allow"}`, written after the ask was filed.

## Cross-references

- RFC: Notion `392937f0-3cb4-8188-aad6-d7d041de814b` (Part 2, Part 3, Threats —
  the binding constraints for this document).
- `docs/architecture/evaluation-loop-fire-log.md` — Phase 1 (data sources this
  document's mechanisms consume).
- `.minsky/skills/retrospective/SKILL.md` — Step 5 recurrence-after-DONE
  extension + worked example.
- `src/domain/calibration/rationalization-review.ts`,
  `scripts/rationalization-review.ts` — implementation.
- `src/domain/calibration/calibration-sweep.ts` — the mt#2889 legacy-calibration
  adapter this review's corpus depends on; the naming-map staleness precedent this
  document's slug-derivation choice avoids repeating.
- `.claude/skills/calibration-review/SKILL.md` — the sibling per-log FP-rate
  review this review's auto-affirm/outlier packaging and `direction.decide` Ask
  kind generalize corpus-wide.
- mt#2589 — RFC tracking task; mt#2597 / mt#2889 — Phase 1; mt#2901 — this task.
- mt#2896 — the never-reviewed cadence-trigger task (complementary, cross-reference
  only — out of scope for this task; makes the review loop itself see low-volume
  logs, which is a different concern from this review's own cadence).
