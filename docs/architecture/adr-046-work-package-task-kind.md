# ADR-046: The work package is a task kind; a handoff is the act that transfers one

## Status

**Accepted** — 2026-08-30. Decided by the principal after a week of adversarial naming and design
rounds (2026-08-24 → 2026-08-30), closing the conversation-succession RFC's open forks
(Notion `3a0937f0-3cb4-81ac-8979-ef3c902f5d49`, §DECIDED; consequence analysis on the decision
page, Artifact `2e956bfd-38a2-455e-9534-65c19c54a5ae`). Carried out by mt#2911 (Phase 1).

## Decision (read this first)

**Minsky reifies the claimable bundle of work as a `work-package` task kind — one persistent row
per engagement, ownership changes recorded in an append-only transfer log — and reserves `handoff`
for the ACT by which a package enters or re-enters the pool carrying state.**

Four calls, decided together:

1. **The entity is named `work package`.** Never bare "package" (collides with `packages/` and npm
   vocabulary); `wp#` is not minted — packages ride ordinary `mt#N` ids.
2. **It ships as a task KIND**, an entry in the `WORKFLOWS` registry (mt#1812/mt#3010), not as a
   sibling substrate entity on the Ask pattern.
3. **Lifecycle is mutate-plus-log**: the row persists across claims, releases and successions;
   `origin` (`groomed` | `succession` | `release`) is a per-transfer fact in
   `work_package_transfers`, not a per-row column. Supersede-on-write and mint-per-succession are
   rejected.
4. **Collision prevention stays at task entry**, not on the entity: `warn-peer-task-activity`
   flips from advisory to deny (mt#4788, substrate open question 4 answered "prevent" for this
   surface). A package create that queues a task another open package already queues is
   ANNOTATED, never refused — reference is not reservation.

## Context

Handoffs between conversations were memory records. Three measured failures drove reification:
the principal hand-carrying (and once corrupting) handoff text between chat windows (2026-07-17);
two handoff memories independently nominating the same task to two tabs while a third owned it —
a real double-preemption that took a task to DONE out from under its owner (2026-08-24, mem#1231);
and a handoff asserting it had created a memory that does not exist, relayed through three surfaces
unverified (mem#676 R5). A grooming use-case was added by the principal: a curator bundles open
backlog tasks with a briefing for any agent to claim — same entity, no predecessor.

The naming survived unusual scrutiny: two blind cold reads (a fresh model given the design
generated "work package" spontaneously, twice, and balked at "handoff" for the no-predecessor
origin — a pre-registered falsifier that fired), a compression analysis (spoken "WP" is four
syllables — longer than the name; the natural compression "package" is unsafe here, and
"whip"/WIP is a silent near-miss), and a field survey (nobody in the agentic-engineering field
names this entity; Yegge's Gas Town minted "convoys" for the same thing at fleet scale, one layer
above his tracker).

## Alternatives considered

- **Sibling substrate entity (the RFC's original Phase 1; ADR-008's Ask pattern).** Rejected by
  the principal on integration economics: the kind route inherits the per-kind state machine
  (registry data, no schema changes — the registry's own extension contract), the task event
  ledger and entry-guard arbitration, spec storage for the briefing, embeddings search, deeplinks
  and cockpit rendering. The sibling route rebuilds each in parallel and drifts. This is a
  deliberate, recorded DEVIATION from ADR-008's pattern for this entity; the Ask remains a sibling
  entity because its lifecycle vocabulary genuinely does not map — the package's does
  (open=READY, claimed=IN-PROGRESS, completed=DONE, superseded=CLOSED).
- **Reconstruct-on-demand (no entity).** Rejected on measurement: 56% of open tasks carry no graph
  edge, the graph retrofit was tried and closed, and the payload (grouping rationale, ordering,
  judgment) is authored, not derivable. Retrieval-based succession is the status quo and produced
  the incidents above.
- **Non-overlap invariant (no two open packages share a task).** Rejected: the 2026-08-24 overlap
  was two TRUE statements about one task — the failure was two sessions ACTING, not two artifacts
  REFERRING. Locking at intent grain re-imports TTL/liveness/deadlock machinery and is blind to
  actors holding work through no entity at all.
- **Names `handoff`, `docket`, `session plan`, `briefing`, `checkpoint`, `thread`, `traveler`.**
  Each killed on a specific test — respectively: implies a prior executor (cold-read falsifier);
  population prior is the singular per-actor agenda (reserved for a future "my docket" view);
  "session" is ADR-022-reserved and "plan" triple-collides; imports an unused frame; names a
  mid-execution snapshot (the dispatch tier); collides with cockpit entity-threads and CS threads;
  relocated to task grain (the spec-as-worklog finding, mt#4589).

## Consequences

- mt#2911 builds Phase 1: registry entry, `claimed_by`/`claimed_at`, `work_package_members`
  (ordered refs with `status_at_write`), `work_package_transfers`, claim/release commands
  (claim = single conditional UPDATE from READY), per-origin briefing validation with
  **create-time resolution of every cited entity ref**, `/handoff` writing a succession-origin
  package, and a cockpit list with claim + copy-launch-command.
- `TASK_KIND_VALUES` is derived from `Object.keys(WORKFLOWS)`, so the MCP kind enums and the
  completion manifest widen automatically with the registry entry.
- `tasks_available`, routing, backlog counts and the workstream widget EXCLUDE the kind by
  default (consumer-side default-deny); explicit kind filters include it.
- The vocabulary boundary, for docs and UI copy: _a task says what to do; a work package says what
  to pick up; a handoff says what changed hands; a docket says what's mine._ The `/handoff` skill
  keeps its name; the dispatch-tier `handoff.md` keeps its tier.
- Phase 2 (session-start claim hook, crash backstop) and Phase 3 (scope addressing, blocked on
  mt#2885) inherit this schema; the deferred self-staling claim machinery returns only with
  unattended claiming.
