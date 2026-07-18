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

## First review record (2026-07-18)

Run against the real corpus (`~/.local/state/minsky/fire-log.jsonl` + the six
legacy calibration logs) on 2026-07-18, after tagging `mt#2216`/`mt#2832` with
`family:causal-premise-detector`. This section is the durable, in-repo record
the RFC calls for ("its own execution is fire-logged... must end in explicit
decisions") — the three artifacts below (panel output, ask id, fire-log line)
are independently verifiable, not just PR-body prose.

### Summary

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
  example, confirmed live.
- **Cadence recommendation: 90 days** (RFC default; first review, no prior
  baseline).

**Caveat surfaced by this first run, carried into the routed ask:** the
canary-missing outliers are overwhelmingly a coverage-scope artifact (pre-commit
steps were out of scope for mt#2889's canary declarations), not a signal that 19
guards are actually broken. The routed ask treats this as ONE grouped outlier
rather than 19 individually-argued ones, per the RFC's "guards packaged... reduces
notification overhead" intent — flagging it explicitly rather than letting a large
outlier count read as 19 independent problems.

Corpus numbers below are a snapshot from the run that produced them — this
environment runs many concurrent sessions, so the live fire-log grows
continuously and a re-run minutes later shows higher counts; the disposition
signals (auto-affirm vs. outlier, and why) are stable across that drift.

### The routed ask (durable id)

`direction.decide` ask **`c8fc1f97-f062-4da0-8b51-f367504738c2`** (filed
2026-07-18) — the 22 auto-affirmed guards in one summary line, plus two
outlier groups (the canary-missing pre-commit-scope gap; `causal-premise-detector`'s
recurrence-since-done) each with flip/tune/retire/affirm options. Independently
queryable: `mcp__minsky__asks_list` / `asks_respond` with this id.

### The self-review fire-log record

Written via `bun scripts/rationalization-review.ts --execute` after the ask
above was filed, and independently verifiable in the real log:

```
$ grep "rationalization-review" ~/.local/state/minsky/fire-log.jsonl | tail -1
{"timestamp":"2026-07-18T13:46:39.613Z","guardName":"rationalization-review","event":"Review","decision":"allow","durationMs":2893}
```

### Panel output (verbatim, `bun scripts/rationalization-review.ts`, post-R1-fixes re-run)

```
Rationalization review — 2026-07-18T14:20:44.635Z
Corpus: 10813 records after de-duplication (10813 raw = 10813 real fire-log + 0 legacy-calibration; 0 dropped as fire-log/calibration overlap), 44 guards.

[AUTO-AFFIRM] ask-routing-deferral-detector — fires=120 overrides=0 (0.0%) canary=PASS attentionCost=500ch/1opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=1ms p95=2ms p99=5ms
[AUTO-AFFIRM] auto-session-title — fires=121 overrides=0 (0.0%) canary=PASS attentionCost=0ch/0opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=1ms p95=3ms p99=7ms
[AUTO-AFFIRM] block-git-gh-cli — fires=2171 overrides=0 (0.0%) canary=PASS attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=1ms p95=2ms p99=5ms
[AUTO-AFFIRM] calibration-review-cadence-detector — fires=120 overrides=0 (0.0%) canary=PASS attentionCost=300ch/1opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=10ms p95=13ms p99=20ms
[OUTLIER] causal-premise-detector — fires=120 overrides=0 (0.0%) canary=PASS attentionCost=550ch/2opt daysSinceLastFire=0 recurrencesSinceDone=4 latency=p50=2ms p95=2ms p99=4ms reasons=[recurrence-since-done]
[OUTLIER] check-branch-fresh — fires=149 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=296ms p95=519ms p99=1866ms reasons=[canary-missing]
[AUTO-AFFIRM] check-generated-file-edit — fires=584 overrides=0 (0.0%) canary=PASS attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=2ms p95=3ms p99=11ms
[AUTO-AFFIRM] check-guessed-session-path — fires=2171 overrides=0 (0.0%) canary=PASS attentionCost=398ch/1opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=1ms p95=2ms p99=8ms
[AUTO-AFFIRM] check-task-spec-read — fires=78 overrides=0 (0.0%) canary=PASS attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=8ms p95=20ms p99=41ms
[OUTLIER] code-formatting — fires=170 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=3143ms p95=4598ms p99=5269ms reasons=[canary-missing]
[AUTO-AFFIRM] code-mechanism-assertion-detector — fires=120 overrides=0 (0.0%) canary=PASS attentionCost=500ch/1opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=2ms p95=4ms p99=5ms
[OUTLIER] compile-check — fires=141 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=9350ms p95=12760ms p99=16510ms reasons=[canary-missing]
[OUTLIER] completion-manifest-regen — fires=170 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=950ms p95=1255ms p99=9485ms reasons=[canary-missing]
[OUTLIER] deploy-domain-check — fires=170 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=3ms p95=4ms p99=6ms reasons=[canary-missing]
[OUTLIER] dockerfile-workspace-copy-regen — fires=170 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=39ms p95=48ms p99=70ms reasons=[canary-missing]
[OUTLIER] eslint-rule-tests — fires=156 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=77ms p95=106ms p99=267ms reasons=[canary-missing]
[OUTLIER] eslint-validation — fires=169 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=27393ms p95=33028ms p99=42816ms reasons=[canary-missing]
[AUTO-AFFIRM] guard-health-escalation-detector — fires=120 overrides=0 (0.0%) canary=PASS attentionCost=300ch/0opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=1ms p95=2ms p99=3ms
[OUTLIER] hook-permission-check — fires=170 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=14ms p95=21ms p99=30ms reasons=[canary-missing]
[OUTLIER] immutable-migration-check — fires=170 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=11ms p95=15ms p99=34ms reasons=[canary-missing]
[AUTO-AFFIRM] inject-current-time — fires=121 overrides=0 (0.0%) canary=PASS attentionCost=90ch/0opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=10ms p95=14ms p99=25ms
[AUTO-AFFIRM] inject-dispatch-watchdog — fires=121 overrides=0 (0.0%) canary=PASS attentionCost=450ch/3opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=1ms p95=2ms p99=3ms
[AUTO-AFFIRM] inject-git-state — fires=121 overrides=0 (0.0%) canary=PASS attentionCost=200ch/0opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=95ms p95=174ms p99=513ms
[AUTO-AFFIRM] inject-prod-state — fires=121 overrides=0 (0.0%) canary=PASS attentionCost=250ch/0opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=1ms p95=2ms p99=5ms
[OUTLIER] mcp-daemon-staleness-detector — fires=120 overrides=0 (0.0%) canary=MISSING attentionCost=400ch/1opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=10ms p95=29ms p99=37ms reasons=[canary-missing]
[OUTLIER] memory-search — fires=120 overrides=0 (0.0%) canary=MISSING attentionCost=280ch/1opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=4802ms p95=6513ms p99=9163ms reasons=[canary-missing]
[OUTLIER] migration-journal-check — fires=170 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=1ms p95=2ms p99=2ms reasons=[canary-missing]
[OUTLIER] node-shim-check — fires=170 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=34ms p95=78ms p99=130ms reasons=[canary-missing]
[OUTLIER] nul-byte-check — fires=170 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=17ms p95=28ms p99=54ms reasons=[canary-missing]
[AUTO-AFFIRM] pre-narration-detector — fires=120 overrides=0 (0.0%) canary=PASS attentionCost=500ch/1opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=2ms p95=2ms p99=5ms
[OUTLIER] rationalization-review — fires=1 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=2893ms p95=2893ms p99=2893ms reasons=[canary-missing]
[AUTO-AFFIRM] require-session-for-main-workspace-edits — fires=717 overrides=0 (0.0%) canary=PASS attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=1ms p95=1ms p99=3ms
[AUTO-AFFIRM] retrospective-trigger-scanner — fires=120 overrides=0 (0.0%) canary=PASS attentionCost=400ch/1opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=3ms p95=4ms p99=8ms
[OUTLIER] rules-compile-check — fires=156 overrides=21 (13.5%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=9297ms p95=13246ms p99=14378ms reasons=[canary-missing]
[OUTLIER] secret-scanning — fires=156 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=81ms p95=122ms p99=240ms reasons=[canary-missing]
[AUTO-AFFIRM] silent-stretch-detector — fires=120 overrides=0 (0.0%) canary=PASS attentionCost=400ch/1opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=1ms p95=2ms p99=3ms
[AUTO-AFFIRM] skill-staleness-detector — fires=120 overrides=0 (0.0%) canary=PASS attentionCost=350ch/2opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=8ms p95=17ms p99=19ms
[AUTO-AFFIRM] substrate-bypass-detector — fires=120 overrides=0 (0.0%) canary=PASS attentionCost=1000ch/4opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=3ms p95=5ms p99=10ms
[AUTO-AFFIRM] tasks-status-set-guard — fires=52 overrides=0 (0.0%) canary=PASS attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=2558ms p95=3062ms p99=7904ms
[OUTLIER] type-check — fires=170 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=1646ms p95=2279ms p99=3226ms reasons=[canary-missing]
[OUTLIER] unit-tests — fires=156 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=2624ms p95=3449ms p99=5304ms reasons=[canary-missing]
[AUTO-AFFIRM] validate-task-spec — fires=31 overrides=0 (0.0%) canary=PASS attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=1ms p95=4ms p99=6ms
[OUTLIER] variable-naming-check — fires=170 overrides=0 (0.0%) canary=MISSING attentionCost=unannotated daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=126ms p95=183ms p99=276ms reasons=[canary-missing]
[AUTO-AFFIRM] wall-of-text-detector — fires=10 overrides=0 (0.0%) canary=PASS attentionCost=400ch/1opt daysSinceLastFire=0 recurrencesSinceDone=n/a latency=p50=1ms p95=2ms p99=2ms

Auto-affirmed (22): ask-routing-deferral-detector, auto-session-title, block-git-gh-cli, calibration-review-cadence-detector, check-generated-file-edit, check-guessed-session-path, check-task-spec-read, code-mechanism-assertion-detector, guard-health-escalation-detector, inject-current-time, inject-dispatch-watchdog, inject-git-state, inject-prod-state, pre-narration-detector, require-session-for-main-workspace-edits, retrospective-trigger-scanner, silent-stretch-detector, skill-staleness-detector, substrate-bypass-detector, tasks-status-set-guard, validate-task-spec, wall-of-text-detector — low override rate (<=20%), canary passing, no zero-fire anomaly, no recorded recurrence-since-done.
Outliers requiring disposition (22):
  - causal-premise-detector: recurrence-since-done
  - check-branch-fresh: canary-missing
  - code-formatting: canary-missing
  - compile-check: canary-missing
  - completion-manifest-regen: canary-missing
  - deploy-domain-check: canary-missing
  - dockerfile-workspace-copy-regen: canary-missing
  - eslint-rule-tests: canary-missing
  - eslint-validation: canary-missing
  - hook-permission-check: canary-missing
  - immutable-migration-check: canary-missing
  - mcp-daemon-staleness-detector: canary-missing
  - memory-search: canary-missing
  - migration-journal-check: canary-missing
  - node-shim-check: canary-missing
  - nul-byte-check: canary-missing
  - rationalization-review: canary-missing
  - rules-compile-check: canary-missing
  - secret-scanning: canary-missing
  - type-check: canary-missing
  - unit-tests: canary-missing
  - variable-naming-check: canary-missing

Cadence recommendation: 90 days
First review: holding the RFC's quarterly (90-day) initial cadence. Observed volume this pass: 10813 fires across 44 guards over a 1.7-day corpus window (~6520.7 fires/day) — no prior review exists yet to compare an "all-quiet" signal against, so there is no basis to deviate from the RFC default this pass.

CAVEAT (recurrencesSinceDone): the anchor timestamp is the family-tagged fix task's `updatedAt` — ANY subsequent edit to that task (including the family-tag edit itself) bumps it, so this count is a CONSERVATIVE UNDERCOUNT relative to the true DONE-transition time, never inflated. Affects: causal-premise-detector. Full explanation: docs/architecture/evaluation-loop-phase2.md "Known limitation."
```

Note this re-run (post-R1-fixes, after `--execute` had already appended one
`rationalization-review` self-record) shows a 45th "guard" —
`rationalization-review` itself, canary-missing (it is a review tool, not a
guard; no canary is expected) — and `causal-premise-detector`'s
`recurrencesSinceDone` is now `4`, not `1`: both are the fire-log growing
between the two runs (this environment's continuous concurrent-session
volume), not a regression — the disposition logic and its reasons are
unchanged and stable.

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
