# ADR-029: Numeric `entity#NNNN` short ids for UUID-PK entities, added alongside the UUID

## Status

Accepted

## Context

`ask`, `memory`, and `session` (workspace) records are keyed by a raw 36-character Postgres
`uuid` primary key (`uuid.defaultRandom()`). Unlike tasks (`mt#NNNN`, a text PK) and changesets
(a GitHub PR number), these ids are not human-readable, not memorable, and not speakable —
there is no way to reference an ask/memory/session by a short token in conversation, chat, or a
command line the way `mt#2963` or "PR #1234" already work.

mt#2943 (DONE) made these uuids _copyable_ in the cockpit (a copy-id affordance) but not
_readable_. This ADR is the Tier-2 follow-up: give these three entity types a numeric short id
that reads and types like the existing `mt#NNNN` convention, without disturbing anything that
already depends on the uuid.

This decision was reached in-conversation with the principal on 2026-07-20 (recorded in memory
`8beb2ed2`, "Decision: numeric #NNNN short ids for ask/memory/session") following a 2026-07-20
investigation (umbrella mt#2946) into the actual blast radius of each alternative. That
investigation is this ADR's evidentiary basis.

### Why not replace the UUID primary key?

The investigation found the FK blast radius of switching the PK type is small — for example,
only one column anywhere references an ask id (`wake_pending.ask_id`, a plain unconstrained
`text` column; this project's convention is "no FK constraints, plain text refs" for
cross-table entity references), so there is no `REFERENCES "asks"` cascade to rewrite for the
`asks` table, and memory/session are similar.

The real driver against replacement is the **`minsky://` deeplink blast radius**. Per
`cockpit-deeplinks.mdc`, `minsky://<type>/<uuid>` links are agent-hand-typed plain text (Surface
A) that are already embedded, unindexed, across at least four durable stores:
`agent_transcript_turns.assistant_text` / `.user_text` (full-text-search + embedded),
`memories.content`, `asks.question` / `asks.response`, and `task_specs.content` — findable only
by a `LIKE`/regex scan, with the raw upstream JSONL transcript files on disk being effectively
unreachable/immutable. Replacing the UUID PK with a new id scheme would strand every
already-emitted deeplink with no row left to resolve to. Keeping the UUID canonical and adding
a short id alongside it means every historical deeplink keeps resolving forever, with zero
migration risk to the deeplink corpus.

### Alternatives considered and rejected

- **Replace the UUID PK with the new short id.** Rejected — see the deeplink blast-radius
  argument above. This is a data-loss risk (in the sense of un-resolvable historical references)
  for a readability improvement that doesn't require it.
- **Random base58/base62 id (e.g. `ask_a1b2c3`, Stripe/Twitter-Snowflake-style).** Rejected —
  this project has zero existing base58/62 encoding dependency; adopting one for this alone
  would be a new runtime dependency for a smaller readability win than a plain monotonic
  integer, and it reads less cleanly than the `mt#NNNN` convention users already know. The
  numeric scheme needs no new dependency at all — see "Consequences" below.
- **Per-project short-id sequence.** Rejected for now — see "Scoping: global, not per-project"
  below. Global is the no-regret default; a per-project switch remains possible later at a single
  contained choice-point if ever adopted.
- **A DB advisory lock for mint-time uniqueness.** Rejected as the concurrency mechanism — see
  "Concurrency" below; the existing unique-index-plus-retry pattern already proven for `mt#NNNN`
  is reused instead of introducing new locking infrastructure.

## Decision

We add a **numeric `entity#NNNN` short id** to `ask`, `memory`, and `session` (workspace)
records, **added alongside the existing UUID primary key — never replacing it.** The UUID
remains the canonical primary key and the canonical `minsky://<type>/<uuid>` deeplink target
(per `cockpit-deeplinks.mdc`, unaffected by this ADR — see "What this ADR does NOT change"
below). The short id is a new, independently indexed column used for display, human reference,
and lookup.

### Format

`<prefix>#<n>`, mirroring the existing `mt#NNNN` task-id convention exactly. Recommended
per-entity prefixes (final selection is each per-entity task's own small naming decision, not
fixed irrevocably by this ADR):

| Entity              | Prefix             | Example  |
| ------------------- | ------------------ | -------- |
| ask                 | `ask#`             | `ask#7`  |
| memory              | `mem#`             | `mem#42` |
| session (workspace) | `ws#` (or `sess#`) | `ws#3`   |

### Scoping: global, not per-project

The counter for each entity-type prefix is a **global sequence** — global `ask#N`, global
`mem#N`, global `ws#N` — mirroring the existing global `mt#N` task counter, **not** scoped per
project. This follows the settled working decisions in mt#2391 (Phase 1 project scoping keeps
`mt#N` global, using `project_id` purely for filtering/scoping reads — not for numbering) and
mt#2390 (which deliberately defers the global-vs-per-project _numbering_ question; global is
that task's own no-regret, no-migration default). This ADR does not reopen mt#2390's deferral —
it inherits it, and widens its blast radius: mt#2390's eventual decision, if it ever moves away
from global numbering, now governs `ask#`/`mem#`/`ws#` short ids too, not just `mt#`.

The minting util (`nextShortId`, `packages/domain/src/utils/short-id.ts`) is written so this
scoping is a **single localized choice-point**: it accepts flat `liveIds`/`tombstoneIds` arrays
with no project dimension, and the caller decides which rows to pass in. A future per-project
switch would only change what each per-entity backend queries before calling `nextShortId` — the
function's contract, and every callsite that already goes through it, is unaffected.

### Tombstone-awareness

Per-entity minting must never reissue a deleted entity's short id, mirroring `mt#NNNN`'s
existing `deleted_task_ids` tombstone behavior (mt#2205): the next id is
`<prefix>#<max(live ∪ tombstones) + 1>`. Each per-entity task (mt#2965 ask, mt#2966 memory,
mt#2967 session) is responsible for adding its own tombstone mechanism analogous to
`deleted_task_ids` before wiring minting-on-create.

### Concurrency

Minting (`nextShortId`) is a pure function — it reads the current max and proposes the next
integer, with no I/O and no locking of its own. Uniqueness under concurrent writers is enforced
the same way it already is for `mt#NNNN`: a **UNIQUE INDEX on the `short_id` column** (see the
schema helper, below) plus an `onConflictDoNothing()` + bounded-retry loop at insert time,
exactly mirroring `MinskyTaskBackend.createTaskFromTitleAndSpec` / `tryInsertTask`'s existing
TOCTOU handling for task ids. A DB advisory lock was considered and rejected: entity creation is
not a hot-contention path, and an advisory lock would be new infrastructure duplicating a
pattern this codebase already runs correctly in production for `mt#NNNN`.

### Resolution

The existing uuid/hex-prefix resolver (`id-prefix-resolver.ts`, mt#2696 —
`classifyIdInput`/`resolveIdPrefix`/`resolveIdPrefixOrThrow`) is extended **additively**: new
functions `classifyEntityIdInput`/`resolveEntityIdPrefix`/`resolveEntityIdPrefixOrThrow` accept
either a `<prefix>#<n>` short id (resolved via an exact-match lookup on the entity's `short_id`
column) or a full uuid / hex prefix (delegating unchanged to the existing functions). No
existing function's signature or behavior changes — this is verified by regression tests
asserting the existing `resolveAskIdInput` (`src/adapters/shared/commands/asks.ts`) and
`memory.get`'s `resolveMemoryIdInput` (`src/adapters/shared/commands/memory/index.ts`) call
paths are unaffected.

### Schema pattern

A reusable helper (`packages/domain/src/storage/schemas/short-id-column.ts`) documents the
exact column + unique-index shape every per-entity table applies identically: a **nullable**
`short_id text` column (no default, no `NOT NULL`) plus a named unique index
(`idx_<table>_short_id_unique`). Nullable-not-backfilled-here is deliberate: it decouples the
(instant, lock-free) `ADD COLUMN` migration from each entity's own backfill strategy, which is
each per-entity task's concern — this ADR and mt#2963 apply the pattern to **no** table.

## What this ADR does NOT change

- The UUID primary key of any entity — it remains canonical, unchanged, and the sole
  `minsky://<type>/<uuid>` deeplink target.
- `packages/domain/src/ids.ts`'s `Brand<>` compile-time nominal typing (mt#2524) — unrelated;
  that is compile-time-only typing, not a display/short-id concern.
- Task ids (`mt#NNNN`) or changeset ids (PR numbers) — both already have adequate short forms.
- Any entity table's actual schema, migration, or data — mt#2963 (this ADR's originating task)
  ships the shared foundation only. The per-entity column additions, backfills, minting wiring,
  and cockpit display are the sibling tasks mt#2965 (ask), mt#2966 (memory), and mt#2967
  (session).

## Consequences

Easier:

- Ask/memory/session ids become speakable and typeable in conversation and CLI commands,
  matching the ergonomics `mt#NNNN` already provides for tasks.
- Zero new runtime dependency — the numeric scheme reuses the existing monotonic-counter
  pattern; no base58/62/nanoid encoding library is introduced.
- Every already-emitted `minsky://<type>/<uuid>` deeplink, across every durable store it's
  embedded in, keeps resolving with no migration risk — the UUID never moves or changes meaning.
- The resolver extension and minting util are additive, so the existing uuid-prefix resolution
  paths (`resolveAskIdInput`, `memory.get`) needed zero changes and carry zero regression risk
  from this work.
- A future per-project short-id switch (if mt#2390 ever adopts one) is contained to what each
  per-entity backend queries before calling `nextShortId` — not a change to this ADR's contracts.

Harder / committed:

- Each per-entity table now carries two ids (uuid PK + short id) that must be kept in sync at
  creation time and never allowed to drift — minting must happen atomically with row insertion
  (mirroring `tryInsertTask`'s single-transaction task+spec write).
- Each per-entity task owns a real backfill decision for existing rows (a `state-ops`-kind task,
  since backfilling is a bulk shared-state mutation over the 10-row threshold per
  `operational-safety-dry-run-first.mdc`) — this ADR does not resolve backfill ordering or
  timing, only the column shape it lands on.
- `entity-codec.ts` (`src/cockpit/web/lib/entity-codec.ts`) and any other consumer that
  round-trips a `minsky://` URI must be taught to accept a short id as an alternate input form
  where relevant — tracked in the per-entity sibling tasks, not resolved here.
- mt#2391 (project-scoping columns) and this ADR's per-entity siblings both author migrations
  against `asks`/`memories`/`sessions` — both are additive columns with no logical conflict, but
  migration slot ordering must be coordinated to avoid a collision when both land close together.

## Cross-references

- mt#2946 — umbrella task (numeric short ids for ask/memory/session).
- mt#2963 — this ADR's originating task (shared foundation: minting util, resolver extension,
  schema helper, this ADR).
- mt#2965 / mt#2966 / mt#2967 — per-entity siblings (ask / memory / session): column, backfill,
  minting wiring, resolution wiring, cockpit display.
- mt#2943 — cockpit copy-id affordance (DONE, originating signal for this decision).
- mt#2696 — `id-prefix-resolver.ts` (the uuid/hex-prefix resolver this ADR extends).
- mt#2205 — `mt#NNNN` tombstone-aware monotonic allocation (`computeNextTaskId`), the pattern
  this ADR's minting util generalizes.
- mt#2391 / mt#2390 — project-scoping Phase 1 (global `mt#N` + `project_id` for filtering) and
  the deferred global-vs-per-project numbering question this ADR inherits rather than reopens.
- mt#2524 — branded id compile-time typing (`ids.ts`) — explicitly unrelated to this ADR.
- Memory `8beb2ed2` — "Decision: numeric #NNNN short ids for ask/memory/session (mt#2946), added
  alongside UUID PK" — the principal-approved decision record this ADR formalizes.
- `cockpit-deeplinks.mdc` — the `minsky://` deeplink format whose uuid target is unaffected by
  this ADR.
- `packages/domain/src/utils/short-id.ts` — the minting util.
- `packages/domain/src/utils/id-prefix-resolver.ts` — the resolver extension.
- `packages/domain/src/storage/schemas/short-id-column.ts` — the reusable schema pattern.
