# ADR-042: Which `/plan-task` gate criteria get a mechanical backstop, and where each one fires

**The call: a gate criterion earns a mechanical backstop only when discharging it leaves a STRUCTURED trace — an artifact the checker can read or a tool call it can join against — and each backstop fires at the seam where that trace first exists, which for most of the battery is NOT the READY transition.**

## Status

Proposed

## Context

`/plan-task` carries fifteen gate criteria. The skill's own gate (n) states the enforcement
position plainly: _"gate (n) is exactly as strong as the `/plan-task` process that runs it."_
mt#2755 proposes mechanical backstops for three of them (gates (h), (n), (p)), and filed three
children to build them — mt#4171, mt#4173, mt#4172. Each of those children would otherwise answer
the same two questions independently: _is this gate mechanizable at all?_ and _at which lifecycle
event?_ Answered three times, they drift; a battery of fifteen prose gates acquires fifteen bespoke
enforcement shapes. This ADR answers both once.

### Two premises the battery's own text carries, both corrected here

**"No gate in this battery is mechanically enforced today"** (gate (n), verbatim) is over-stated,
and it has already been corrected once in the wrong direction. mt#2755 originally justified it with
"mt#1541 is CLOSED"; mem#1045 falsified that — mt#1541's child mt#1575 shipped a live
policy-coverage detector. The conclusion survived that correction and is still not right:

- **`validate-task-spec.ts` already DENIES** at `mcp__minsky__tasks_create` when a spec over 100
  characters lacks `## Success Criteria` or `## Acceptance Tests` — two of gate (a)'s five required
  sections, enforced at `error` tier, today.
- **Three of the four `tasks_create` guards are gate-(g)-shaped**: `require-duplicate-check-record`
  (the spec must carry a `Duplicate check:` line), `duplicate-check-search-provenance` (a claimed
  search must appear in the session's tool calls), and `duplicate-signature-scan`.

So the honest statement is not "nothing is enforced" but **"the battery is partially enforced at a
seam that is not its own."** Everything shipped fires at `tasks_create`. Nothing fires at the READY
transition the battery actually gates.

**The policy-coverage detector is not the vehicle**, despite mt#2755's title. Read directly this
session, `packages/domain/src/detectors/policy-coverage/corpus-loader.ts` loads five sources — the
task spec, `CLAUDE.md`, `.claude/rules/*` + `.minsky/rules/*`, memories, and `.minsky/policy/*`.
The skills tree, where these gates live, is in none of them; and per ADR-008 §Router the detector
answers a different question entirely (does policy name an action's category AND its authority).
mem#1045 measured it live and dormant — 6,108 invocations, zero records in seven days — and
mt#1698's audit measured its decision at 97.7% "covered" across 1,760 records, with its own
mechanism decision open as ask#8752. **This ADR therefore decides enforcement shape independent of
that detector's fate.** A "retire Surface 1" answer to ask#8752 removes mt#2755's named vehicle and
changes nothing below.

### The discriminator, and why it is not a preference

A checker that parses the agent's PROSE to decide whether a gate was discharged re-introduces the
paraphrase axis. ADR-024's Context scopes its ladder to exactly that family — `UserPromptSubmit`
hooks "that detect behavioral trigger phrases in the agent's own output" — and names the failure it
ends: _"each miss has historically been answered by adding another regex family (R1 → R5) — an arms
race."_ A checker that reads an ARTIFACT (a heading is present or it is not) or joins against TOOL
CALLS (the search ran or it did not) has no paraphrase axis and is outside that family.

So the per-gate question is not _should we mechanize it?_ but **does discharging it leave a
structured trace?** Gates whose discharge is a judgment — _is this criterion testable? does this ADR
govern? did I enumerate every consumer?_ — are discipline-tier by construction, not by preference,
and no amount of effort moves them.

### The event axis has two inputs, not one

mt#2755's Action-2 statement restated ADR-031 as "a tool-call read belongs at the latest moment
available." That is too wide. ADR-031's constraining fact is about the transcript FILE — _"`Stop`
fires EARLIER in wall-clock than the next `UserPromptSubmit` … The transcript file therefore has
strictly more flush time at prompt-submit than at Stop"_ — and its subject is the eleven-member
turn-scanning detector family, which has no other source for a turn's tool calls. **A guard that
fires AT a tool boundary is handed that tool's input by the harness and never reads the
transcript.** Flush time does not bear on it.

What does bear on it is **where the evidence first exists**, plus a second consideration ADR-031
does not address: **the battery is bypassable.** mem#416 enumerates four paths by which a task
reaches shipped code without `/plan-task` ever running — TODO → IN-PROGRESS directly via
`session_start`, shipping under a different task id, manual `tasks_status_set`, and external
advancement past PLANNING. A backstop on the READY transition fires only if someone sets READY. That
is why mt#1880 exists and why it is not redundant with mt#4171: they ask different questions at
different seams.

### One implementation constraint, priced from a live diff

mt#4115 (merged 2026-08-16) split `GUARD_REGISTRY` into per-family modules, and the array's own
comment records the organizing principle: _"Each family is the SEAM its guards fire on — the tool
boundary, the prompt, the turn's close — not one tool name."_ Seven families exist: task-create,
pr-create, command-string, delegation, prompt-injection, prompt-scan, turn-end. Adding a guard now
costs a module, a test, a `docs/architecture/hooks/<name>.md` page, a family registration, a
`hook-observers.mdc` entry, an `interceptor-catalog.json` entry, and an override var in
`environment.ts` — measured from PR #3030's changed-file list, not estimated. None of mt#4171,
mt#4172 or mt#4173 prices this; all three were specced before the split landed.

**There is no family for the battery's own seam.** `mcp__minsky__tasks_status_set` carries two
STANDALONE hooks (`tasks-status-set-guard.ts`, `check-task-spec-read.ts`) and the dispatcher is not
wired onto that matcher at all. `session_pr_merge`'s six guards are likewise standalone.

## Decision

We will classify every gate criterion by the structured-trace discriminator, and place each
mechanizable one at the seam where its evidence first exists — creating one new guard family for
the battery's own seam, and wiring the dispatcher onto `tasks_status_set` to host it.

### The table

`create` = `mcp__minsky__tasks_create` · `ready` = PreToolUse on `mcp__minsky__tasks_status_set`
where the target status is READY · `pr` = `mcp__minsky__session_pr_create` · `merge` =
`mcp__minsky__session_pr_merge`.

| Gate                         | Discharge leaves                                                    | Class                                   | Event                                                         | ADR-031                                              |
| ---------------------------- | ------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| (a) spec sections            | the five headings, in the spec                                      | **mechanize**                           | `create` — widen `validate-task-spec.ts` from 2 headings to 5 | deviate: artifact read, no transcript                |
| (b) criteria testable        | a judgment                                                          | discipline                              | —                                                             | n/a                                                  |
| (c) scope bounded            | In-scope / Out-of-scope lists, in the spec                          | **mechanize**                           | `create` — same guard as (a)                                  | deviate: as (a)                                      |
| (d) no blocking questions    | cited task ids + their statuses                                     | **mechanize** (dep half only)           | `ready` — statuses at READY are the question                  | deviate: status read, no transcript                  |
| (e) refs fresh               | `path:N` pairs the checker can stat                                 | **mechanize**                           | `ready` — refs age between create and READY                   | deviate: filesystem read                             |
| (f) subtasks filed           | a judgment (does this decompose?)                                   | discipline                              | —                                                             | n/a                                                  |
| (g) parallel work            | the three probe calls, in the transcript                            | **mechanize**                           | `ready` (scope) + `merge` (existence, mt#1880)                | **match** — transcript join; latest moment available |
| (h) contract propagation     | the sweep call's directory arguments                                | **mechanize**                           | `ready` (mt#4171) + `merge` (mt#1880)                         | **match** — as (g)                                   |
| (j) premise label            | prose applying a label                                              | discipline — paraphrase axis, ADR-024   | —                                                             | n/a                                                  |
| (k) third-party verification | four probe calls                                                    | mechanize, **not worth it** — see below | —                                                             | n/a                                                  |
| (l) authoritative source     | a judgment trigger; a search on discharge                           | discipline (trigger is judgment)        | —                                                             | n/a                                                  |
| (m) citation verification    | a judgment trigger; a read on discharge                             | mechanize, **not worth it** — see below | —                                                             | n/a                                                  |
| (n) external integration     | new `octokit.rest.*` / outbound host / webhook route, **in a diff** | **mechanize**                           | `pr` — **not `ready`; no diff exists at plan time**           | deviate: diff read                                   |
| (o) problem statement        | a causal claim in prose                                             | discipline — paraphrase axis, ADR-024   | —                                                             | n/a                                                  |
| (p) decision record          | in-scope paths ∩ ADR corpus                                         | **mechanize**                           | `ready` (mt#4172)                                             | deviate: corpus grep                                 |

Eight rows get a backstop. Of the seven that do not, five are discipline-tier by construction and
two are mechanizable but priced out below. Every "deviate" is the same deviation and it is the ADR-031
scoping correction above, not a departure from its reasoning: the read is not a transcript read, so
flush time is silent and the seam follows the evidence. The two "match" rows are transcript joins
and take ADR-031's rule as written.

### Why (k) and (m) are mechanizable and still do not ship

Both are joinable — (k) against `gh api` / registry probes, (m) against a read of the cited id — and
the per-module cost above is what decides them:

- **(k)** has a low base rate. A spec naming a NEW third-party dependency is rare, so a module plus
  its six satellite artifacts buys few fires.
- **(m)** has a precision problem, and it is instructive. The gate fires only when a citation
  _drives a structural choice_ — a judgment. A checker joining every cited `mem#N` / `ADR-NNN`
  against a session read would fire on all of them, most of which drive nothing. **The narrower
  check — "the spec cites an id and no read of it appears in the session" — is defensible on its own
  merits and should be filed as its own task if wanted. It is not gate (m)'s backstop**, and calling
  it one would let a partial cover a gate it does not answer.

### Family placement

Every seam named above already hosts a shipped guard, so no event assignment here rests on reading
the vendor hook-lifecycle docs alone — each has a working precedent to check against:
`validate-task-spec.ts` at `create`, `stale-signal-sweep` / `unrendered-result-field-scan` at `pr`,
`tasks-status-set-guard.ts` and `check-task-spec-read.ts` at `ready`, and six guards including
`require-review-before-merge.ts` at `merge`. That is the strongest available evidence that a
PreToolUse guard at each of these matchers receives the tool input it needs — stronger than the
documentation, because it is running.

**What wiring the dispatcher onto `tasks_status_set` actually commits us to** (PR #3036 R1; read
from `dispatcher.ts` rather than assumed, because three tasks will act on this paragraph):

- **The matcher is the TOOL, not the transition.** Every `tasks_status_set` call would enter the
  dispatcher — PLANNING, IN-PROGRESS, IN-REVIEW, BLOCKED, all of them — and the READY filter has to
  live inside each guard. READY is a small fraction of that traffic, so the two `ready` rows must
  return early and cheaply on the other transitions. `getGuardsForEvent` returning an empty list
  short-circuits before any context resolution, but a matched-then-discarded guard does not.
- **Guards run sequentially, each behind a dynamic `import()`**, so latency is additive, not
  parallel.
- **A registration's `timeoutMs` is declarative and unenforced.** The dispatch loop never reads it —
  `registry.test.ts` asserts each registration DECLARES one, and nothing bounds a guard by it. A
  `ready` guard that reads a spec and scans a transcript is therefore unbounded from the
  dispatcher's side; bound it yourself.
- **The advisory budget is shared, not per-guard.** `MERGED_CONTEXT_BUDGET_CHARS` (6156) covers
  every guard's `additionalContext` on the event combined; over budget, the lowest-priority
  fragments are dropped and named. The two `ready` rows compete with each other for it.
- **The seam becomes mixed.** `tasks-status-set-guard.ts` and `check-task-spec-read.ts` stay
  standalone unless separately migrated, so they sit outside the dispatcher's first-deny-wins
  ordering and outside the merged context. That is tolerable — it is how `session_pr_merge` already
  works — but it is a property to know, not to discover.

A crashing guard is caught and the loop continues, so none of the above can take the seam down; the
risk is latency and silently-dropped advisories, not failure.

Rows at `create` and `pr` join the existing `registry-task-create-guards.ts` and
`registry-pr-create-guards.ts`. The `ready` rows need a **new `registry-status-set-guards.ts`**,
plus a one-time change adding `dispatch-pretooluse.ts` to `.claude/settings.json`'s
`mcp__minsky__tasks_status_set` matcher block. That wiring is a prerequisite for mt#4171 and
mt#4172 and is not in either spec. The `merge` row (mt#1880) follows the existing standalone
convention of that seam rather than introducing a family for one guard.

### Posture is out of scope, and stays operator-reserved

This ADR decides SHAPE only. It changes no gate's text and decides for no row whether it BLOCKS.
Every new row ships calibration-first per ADR-024's ladder and carries ADR-032's shipped
`tuningOwnership` label — `advisory` for the claim-provenance rows ((d), (e), (g), (h), (n), (p)),
`invariant` for the spec-shape rows ((a), (c)), which is what the existing `validate-task-spec.ts`
already is. ADR-032 (Accepted 2026-08-03, extending ADR-028 §D2/§D4) is the standing reason a
log-only → live flip cannot be justified from outcome data alone: the labeled response signal that
tuning would run on does not exist.

The split in that paragraph is the load-bearing part. A **shape** check reads one artifact and
asks whether a heading is present — it has no join, so it has no way to be wrong about one, which
is why it can ship denying. A **provenance** check joins a claim against a tool call, and a missed
call shape is a false positive fired at an author who did the work
(`evidence-provenance-table.ts` states this asymmetry for its own recognizers). Those two do not
belong at the same posture on day one.

### Sibling reconciliation

- **mt#4171** (gate (h) enumeration-scope) — **confirmed** as the `ready` row for (h). Add the
  family-module and dispatcher-wiring cost; it is the first guard at this seam and pays for the
  wiring.
- **mt#4172** (gate (p) ADR nominator) — **confirmed** as the `ready` row for (p). Its spec already
  notes pricing an extension of `corpus-loader.ts` before writing a grep; that module belongs to
  the policy-coverage detector whose fate ask#8752 decides, so prefer a standalone corpus read.
- **mt#4173** (gate (n) integration heuristic) — **re-scoped.** Its mechanism reads a diff and its
  title promises the gap "surfaces at plan time." No diff exists at plan time. It moves to the `pr`
  seam and becomes a merge-lane backstop for a plan-time gate. Its value is unchanged; its claim
  about WHEN is not.
- **mt#1880** (merge-time venue for (g)/(h)) — **confirmed, and distinct from mt#4171.** mt#4171
  asks "the sweep ran; did it cover the prescribed directories?" at `ready`. mt#1880 asks "was this
  task ever gated at all?" at `merge`, which is the only seam that catches mem#416's four bypass
  paths. Neither subsumes the other.

## Consequences

**Easier.** A fourth detector task inherits a row instead of re-deriving two decisions. The
"nothing is enforced" premise stops propagating — the corrected statement, that the battery is
partially enforced at a seam that is not its own, is now written down with its evidence. And the
seven discipline-tier gates stop being read as unbuilt backlog: they are terminal, by a stated
criterion, and the battery's honest ceiling is visible.

**Harder.** The first `ready`-seam guard pays for a new family module and the dispatcher wiring,
which lands on mt#4171. Two more guards accrete on `tasks_create`, whose family already carries
four. And the battery now has backstops at four different seams, so "where is gate X enforced?"
becomes a table lookup rather than one answer.

**Committed.** Ten rows are mechanizable and five are not, by a criterion rather than by appetite;
of the ten, eight get a backstop and two are priced out — that gap between "could be built" and
"is worth building" is the reason the classification is three-way rather than binary, and a future
task proposing (k) or (m) should argue the cost, not the feasibility. A row's event follows its
evidence; posture stays operator-reserved and calibration-first;
and any future gate added to the battery gets classified here before a detector is specced for it.

**Open.** ask#8752 decides the policy-coverage detector's fate. Nothing above depends on the
answer — that independence is deliberate and is the correction to mt#2755's framing, not a gap.

## Cross-references

- Related ADRs: ADR-024 (mechanism ladder — scopes the prose-parsing family this avoids), ADR-031
  (lifecycle event — its flush-time reasoning, correctly scoped), ADR-032 (threshold tuning +
  `tuningOwnership`, extending ADR-028 §D2/§D4), ADR-008 §Router (policy-coverage semantics; Open
  Question 9 is live)
- Related tasks: mt#4170 (this ADR), mt#2755 (parent), mt#4171, mt#4172, mt#4173, mt#1880,
  mt#4168, mt#4169, mt#1698, mt#4044 (the evidence-provenance table the join rows build on),
  mt#4115 (the family split this prices against)
- Asks: ask#8752 (policy-coverage mechanism decision — open)
- Memory entries: mem#416 (the battery is bypassable — four paths), mem#1045 (the detector is live
  and dormant; read tool-call state, not prose), mem#776 (search the ADR corpus before proposing a
  mechanism)
- Source read for this ADR: `packages/domain/src/detectors/policy-coverage/corpus-loader.ts`,
  `.minsky/hooks/validate-task-spec.ts`, `.minsky/hooks/registry.ts` + its seven family modules,
  `.minsky/hooks/evidence-provenance-table.ts`, `.claude/settings.json`,
  `tests/domain/plan-task-gate-letters.test.ts`
