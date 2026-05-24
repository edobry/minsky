# ADR-012: Generic Metadata Associations on Memories

**Status:** Proposed
**Date:** 2026-05-24
**Tracking task:** mt#2066

## Context

Memories currently associate with other Minsky entities only via free-form cross-references
in their body text ("Tracking task: mt#X", "see mt#Y", "Bridge memory `id`"). The only
structured association is `supersededBy` (memory-to-memory lineage chain). Three additional
schema fields — `sourceSessionId`, `sourceAgentId`, and `tags` — are written on create but
have **no query-side consumers**: no list filter, no search filter, no index on session ID.

Multiple structural use cases want machine-readable associations that can be queried,
indexed, and audited without text-parsing memory content.

## Use-Case Enumeration

### Current use cases (validated by codebase research)

| #   | Use case                             | Direction             | Access pattern                                           | Current mechanism                                          |
| --- | ------------------------------------ | --------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | **Bridge-memory retirement**         | memory → task         | Given task ID (DONE), find all bridge memories citing it | Body-text grep for "Tracking task: mt#X"                   |
| 2   | **Rule provenance**                  | rule → memory         | Given rule file, find originating memory                 | Prose citation in `.mdc` files (e.g., `Memory 'bd2c08be'`) |
| 3   | **Skill provenance**                 | skill → memory        | Given skill file, find originating memory                | Prose citation in SKILL.md files                           |
| 4   | **Task-memory linkage**              | memory → task         | Given task ID, find related memories                     | Content-embedded "mt#XXXX" mentions                        |
| 5   | **Session-memory linkage**           | memory → session      | Given session, find memories created in it               | `sourceSessionId` field (write-only, no reverse index)     |
| 6   | **Memory-search injection tracking** | memory → session turn | Which memory IDs were injected into a given turn?        | Not tracked — hook injects content without IDs             |
| 7   | **Supersession lineage**             | memory → memory       | Walk supersession chain                                  | `supersededBy` field + `lineage()` method (working)        |

### Near-term use cases (planned, not yet implemented)

| #   | Use case                             | Direction                | Consumer                                  | Status                                                                  |
| --- | ------------------------------------ | ------------------------ | ----------------------------------------- | ----------------------------------------------------------------------- |
| 8   | **Ask policy evidence**              | memory → ask             | `src/domain/ask/policy.ts:loadMemories()` | Stub returning `[]`; deferred to mt#1034                                |
| 9   | **Reviewer-bot evidence**            | memory → PR review       | `.claude/agents/reviewer.md`              | Blocked by Chinese-wall design; may move to pre-review enrichment       |
| 10  | **Memory-as-source on rule edits**   | memory → rule            | Rules compile pipeline                    | No mechanism; provenance is one-way (rule cites memory, not vice versa) |
| 11  | **Transcript extraction provenance** | memory → transcript turn | Transcript ingest pipeline                | `sourceSessionId` partially covers; no turn-level granularity           |

### Access pattern summary

- **Dominant pattern:** reverse lookup — given entity X (task, session, ask), find all
  memories associated with it. 6 of 11 use cases are key-on-target.
- **Write frequency:** low — associations are typically set once at memory-creation time.
- **Read frequency:** moderate — bridge-memory retirement and task-memory linkage are the
  most-queried patterns; both fire during task closeout.
- **Volume:** hundreds to low thousands of memories, not millions. Query performance is
  not the primary constraint at current scale.

## Decision

**Adopt Shape A: generic `associations` JSONB map on the `memories` table**, with a
documented escalation path to Shape B (junction table) if query performance or referential
integrity requirements exceed JSONB's reach.

### Shape A: JSONB associations map (chosen)

Add a single `associations: jsonb` column to the `memories` table:

```sql
ALTER TABLE memories ADD COLUMN associations jsonb NOT NULL DEFAULT '{}';
CREATE INDEX idx_memories_associations ON memories USING GIN (associations);
```

Structure: `Record<string, string[]>` keyed by association type, with values as opaque IDs.

```json
{
  "tracksTask": ["mt#2053"],
  "informsAsk": ["ask-123"],
  "originatesRule": ["hook-files.mdc"],
  "extractedFromSession": ["session-abc"]
}
```

## Alternatives Considered

### Shape B: Typed association table

```sql
CREATE TABLE memory_associations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_type text NOT NULL,
  target_id text NOT NULL,
  association_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

**Strengths:** cleanest reverse-lookup performance (BTree on `target_type + target_id`);
normalized joins (e.g., "all memories tracking DONE-status tasks" is a single SQL join vs
app-level join with JSONB); referential integrity on `memory_id` with CASCADE.

**Weaknesses:** higher migration cost (new table, new Drizzle schema, new repository, new
MCP tool or memory-create extension); two-step agent authoring flow (create memory → get
ID → create associations) unless the service wraps it in a transaction; more code surface
to maintain.

**Why not chosen for v1:** the dominant access pattern (reverse lookup at moderate volume)
is adequately served by GIN-indexed JSONB containment queries at Minsky's current memory
volume. The junction table's advantages — join performance, referential integrity on
targets — don't matter until either: (a) memory volume reaches tens of thousands, or (b)
cross-entity joins become a recurring query shape (e.g., a dashboard that correlates memory
associations with task status in a single SQL query).

**Escalation trigger:** adopt Shape B when any of:

- GIN index scan time on `associations` exceeds 50ms at p95 under production load
- A consumer needs `JOIN memory_associations ma ON ... JOIN tasks t ON ma.target_id = t.id`
  that can't be expressed as an app-level loop over JSONB results
- Referential integrity on target IDs becomes load-bearing (e.g., CASCADE delete when a
  task is deleted should auto-remove its memory associations)

### Shape C: Tagging convention extension

Lean on the existing `tags` field with structured prefixes:
`tags: ["tracks:mt-2053", "informs:ask-123"]`.

**Strengths:** zero schema change; simplest agent authoring.

**Weaknesses:** no query support today (`MemoryListFilter` has no `tags` filter); brittle
convention without parser/validation; conflates structural associations with free-form
tags; tag typos silently fail (`track:` vs `tracks:`); reverse lookups need array-contains
on an unindexed field.

**Why not chosen:** conflating structural associations with free-form tags makes it
impossible to distinguish "this tag is a structural entity reference" from "this tag is a
human-authored label." Adding query support for tags alone doesn't solve the
structural/free-form conflation. The `tags` field serves a different purpose (human
categorization, import provenance like `imported-from:claude-code`); overloading it with
machine-readable entity references is a category error.

### Shape D: External graph layer

Separate `entity_associations` table linking any entity to any entity.

**Strengths:** most general; future-proof for non-memory associations.

**Weaknesses:** highest architectural cost (new domain, new service, new MCP tools);
over-engineered for the current need (memory associations only); risk of becoming a
constraint-free "god table"; conceptually overlaps with the existing task-dependency graph.

**Why not chosen:** YAGNI. The current need is memory associations specifically. If a
general entity-graph need emerges (e.g., mesh signals linking sessions to PRs to tasks
to memories), Shape D can be built then — and the Shape A JSONB data is mechanically
migratable into it (each key→value pair maps to an edge).

## Rationale for Shape A

1. **Cheapest migration.** One column add + one GIN index. No new tables, no new Drizzle
   schema files, no new domain modules.

2. **Collocated with the record.** Agents pass associations inline in `memory_create` /
   `memory_update` — no two-step flow, no transaction coordination. This matters because
   memory creation is the primary write path and it's done by agents in every session.

   ```typescript
   memory_create({
     name: "Bridge: reviewer-bot CoT leakage bypass",
     content: "...",
     associations: { tracksTask: ["mt#1503"] },
   });
   ```

3. **Adequate query performance at current scale.** GIN-indexed JSONB containment
   (`associations @> '{"tracksTask": ["mt#2053"]}'`) is O(index scan) — efficient for
   hundreds to low thousands of rows. Minsky currently has ~200 memories; even at 10×
   growth the GIN index is comfortable.

4. **Convention-extensible.** New association types are just new keys — no schema
   migration for "we also want `citedInReview`." Agents and systems agree on type
   strings by convention. The convention is documented in this ADR and enforced by
   code review, not by schema constraints.

5. **Sequenceable.** The data shape is mechanically migratable to Shape B if needed:
   each `{ key: [values] }` entry in the JSONB maps to one or more rows in a junction
   table. The escalation is cheap and non-destructive.

## Convention: Association Type Strings

The following type strings are the initial vocabulary. New types can be added without
schema changes; they should be documented here (amend this ADR) before use.

| Type string               | Semantics                                                      | Direction           | Example                  |
| ------------------------- | -------------------------------------------------------------- | ------------------- | ------------------------ |
| `tracksTask`              | This memory is a bridge that retires when the named task ships | memory → task       | `["mt#2053"]`            |
| `relatedTask`             | This memory is related to (but not bridged on) the named task  | memory → task       | `["mt#1034"]`            |
| `originatesRule`          | This memory originated the named rule file                     | memory → rule       | `["hook-files.mdc"]`     |
| `originatesSkill`         | This memory originated the named skill                         | memory → skill      | `["retrospective"]`      |
| `informsAsk`              | This memory was cited as evidence for the named ask            | memory → ask        | `["ask-abc123"]`         |
| `extractedFromSession`    | This memory was extracted from the named session               | memory → session    | `["session-xyz"]`        |
| `extractedFromTranscript` | This memory was extracted from a specific transcript turn      | memory → transcript | `["session-xyz:turn-5"]` |
| `citedInReview`           | This memory was cited in a PR review                           | memory → PR         | `["PR#1243"]`            |

## Implementation Follow-Ups

### Child task 1: Schema migration + API extension

- Add `associations: jsonb NOT NULL DEFAULT '{}'` column to `memories` table
- Add GIN index on `associations`
- Extend `MemoryRecord`, `MemoryCreateInput`, `MemoryUpdateInput` types
- Extend `memory_create` and `memory_update` MCP tools to accept `associations`
- Add `associations` containment filter to `memory_list` and `memory_search`
- Add `memory_search` by association type + target ID (e.g., "all memories tracking
  task mt#2053")

### Child task 2: Backfill existing cross-references

- Parse existing memories' `content` for known patterns:
  - `Tracking task: mt#XXXX` → `{ tracksTask: ["mt#XXXX"] }`
  - `Budget: ... tracking task: mt#XXXX` → `{ tracksTask: ["mt#XXXX"] }`
  - `Bridge memory` + task reference → `{ tracksTask: ["mt#XXXX"] }`
- Run as a one-time migration script
- Validate by comparing structured associations against body-text grep

### Child task 3: Downstream consumer integration

- Update memory-search hook (`.claude/hooks/memory-search.ts`) to include memory
  `id` in the injected output (enables agents to cite memories structurally)
- Update bridge-memory audit step (mt#2065) to query `associations.tracksTask`
  instead of body-text grep
- Update `loadMemories()` stub in ask policy loader to use association-based queries
  when the ask subsystem matures

## Consequences

### Positive

- Bridge-memory retirement becomes a structured query instead of a content grep
- Memory provenance (which memory originated which rule/skill) becomes machine-readable
- Future consumers (asks, reviewer enrichment) have a clean query surface
- No new tables or domain modules — minimal maintenance overhead

### Negative

- No referential integrity on association targets — a memory can reference a
  non-existent task ID without error
- Convention enforcement is social (code review + documentation), not schema-level
- JSONB containment queries are slower than BTree lookups on a junction table for
  large datasets (acceptable at current scale; escalation path documented)

### Neutral

- The `tags` field retains its current role (free-form human categorization) and is
  not overloaded with structural associations
- The `supersededBy` field retains its current role (memory-to-memory lineage) as a
  separate first-class mechanism — it is not folded into `associations`
- The `sourceSessionId` and `sourceAgentId` fields retain their current roles; the
  `extractedFromSession` association type is the queryable equivalent (the existing
  fields may be deprecated in a future cleanup task once the `associations` field
  subsumes their write-only role)

## Cross-References

- ADR-002 — Persistence provider architecture (the Postgres-via-Supabase default this
  ADR builds on)
- mt#2066 — this ADR's tracking task
- mt#2064 — verify mt#2053 (sibling, uses status-quo body-grep approach)
- mt#2065 — `/verify-task` bridge-memory audit step (sibling, will migrate to
  association-based queries)
- mt#1034 — attention-allocation subsystem (ask entity model is a downstream consumer)
- mt#1035 — System 3\* meta-cognitive detector (post-mortem analyzer is a downstream
  consumer)
- mt#1588 — MCP middleware memory enrichment (retirement target for the hook-based
  bridge shim; association-based queries will make enrichment more targeted)
- `feedback_deferred_decision_artifact_role_taxonomy` — the rule that elevated bridge
  memories as a structural artifact class
