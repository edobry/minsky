/**
 * Memory Domain Types
 *
 * Core type definitions for the memory system (Phase 1).
 * Memories are persisted facts about the user, feedback, projects, or references.
 * They are stored with pgvector embeddings to support semantic search.
 *
 * @see mt#1012 Memory Phase 1 spec
 */

import type { MemoryStaleness } from "./staleness";

// --- Enum-like constants ---

/**
 * Single source of truth for all valid memory_type values.
 * The pgEnum in memory-embeddings.ts and MEMORY_TYPES derive from this.
 * Adding a value here without updating the DB migration will be caught by
 * the drift-check test in enum-drift.test.ts.
 */
export const MEMORY_TYPE_VALUES = ["user", "feedback", "project", "reference"] as const;

export type MemoryType = (typeof MEMORY_TYPE_VALUES)[number];

/**
 * Object-map form retained for consumers that use MEMORY_TYPES.key notation.
 * The exhaustive-key satisfies clause forces this object to define a key for
 * every MemoryType — adding a value to MEMORY_TYPE_VALUES without updating
 * MEMORY_TYPES is a compile error.
 */
export const MEMORY_TYPES = {
  user: "user",
  feedback: "feedback",
  project: "project",
  reference: "reference",
} as const satisfies { [K in MemoryType]: K };

/**
 * Generic map of association type strings to arrays of target IDs.
 * Keys follow the ADR-012 type-string convention (camelCase, describes the relationship).
 * Examples: { tracksTask: ["mt#2053"], relatedTask: ["mt#1234"] }
 */
export type MemoryAssociations = Record<string, string[]>;

export const MEMORY_SCOPES = {
  project: "project",
  user: "user",
  cross_project: "cross_project",
} as const;

export type MemoryScope = (typeof MEMORY_SCOPES)[keyof typeof MEMORY_SCOPES];

// --- Core record shape ---

/**
 * A single memory record as stored in the database.
 */
export interface MemoryRecord {
  id: string;
  /**
   * Numeric `mem#N` short id (mt#2966, ADR-029), added alongside the
   * canonical uuid `id`. Minted sequentially on create via `nextShortId`
   * (monotonic-counter-over-tombstones pattern, generalized from tasks'
   * `mt#NNNN`). Absent (`undefined`) for legacy rows that predate the
   * backfill (`scripts/backfill-memory-short-ids.ts`) until that script
   * runs. The uuid `id` remains the canonical PK and
   * `minsky://memory/<uuid>` deeplink target — this field is a
   * human-readable display/reference alias, never a replacement.
   */
  shortId?: string;
  type: MemoryType;
  name: string;
  description: string;
  content: string;
  scope: MemoryScope;
  /** Project identifier, required when scope = "project" */
  projectId: string | null;
  tags: string[];
  /** Agent that created this memory (null for importer-created memories) */
  sourceAgentId: string | null;
  /** Session that created this memory */
  sourceSessionId: string | null;
  /** Reserved for Phase 3 derived memories */
  confidence: number | null;
  /** Points to the replacement memory (set when this memory is superseded) */
  supersededBy: string | null;
  /** Arbitrary metadata written by supersede() to record supersession reason/timestamp */
  metadata: Record<string, unknown> | null;
  /** Structured entity associations (e.g., { tracksTask: ["mt#2053"] }). See ADR-012. */
  associations: MemoryAssociations;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date | null;
  accessCount: number;
}

// --- Input types ---

/**
 * Fields required to create a new memory record.
 */
export interface MemoryCreateInput {
  type: MemoryType;
  name: string;
  description: string;
  content: string;
  scope: MemoryScope;
  projectId?: string | null;
  tags?: string[];
  sourceAgentId?: string | null;
  sourceSessionId?: string | null;
  confidence?: number | null;
  /** Optional structured entity associations. Defaults to {} if not provided. */
  associations?: MemoryAssociations;
}

/**
 * Fields that can be updated on an existing memory.
 */
export interface MemoryUpdateInput {
  type?: MemoryType;
  name?: string;
  description?: string;
  content?: string;
  scope?: MemoryScope;
  projectId?: string | null;
  tags?: string[];
  sourceAgentId?: string | null;
  sourceSessionId?: string | null;
  confidence?: number | null;
  /** Optional structured entity associations. Replaces the map; merge is caller's responsibility. */
  associations?: MemoryAssociations;
}

// --- Content-free projection (mt#4761) ---

/**
 * Compact projection of a `MemoryRecord` with no `content` body — the same
 * shape the `memory.list` command's `summary: true` param has produced since
 * mt#2817 (`src/adapters/shared/commands/memory/index.ts:886-889`). Pulled
 * out to a shared function so the cockpit's `memories-list` widget — which
 * bypasses the command layer and calls `MemoryService.list()` directly — can
 * reach the same content-free shape instead of shipping full records
 * (mt#4761's AT1: no record in the widget's HTTP payload may carry `content`).
 */
export type MemorySummaryRecord = Pick<
  MemoryRecord,
  "id" | "name" | "type" | "description" | "tags" | "createdAt" | "updatedAt"
>;

/** Project a `MemoryRecord` down to `MemorySummaryRecord` (mt#4761). */
export function toMemorySummary(record: MemoryRecord): MemorySummaryRecord {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    description: record.description,
    tags: record.tags,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// --- Search types ---

/**
 * A single search result returned by MemoryService.search().
 */
export interface MemorySearchResult {
  record: MemoryRecord;
  score: number;
  /**
   * Read-time staleness verdict (mt#1709). Present only when the record declares a
   * retirement clause ("Budget: retire when mt#X ships", "Tracking task: mt#X", …) or
   * carries a `tracksTask` association — which is the small minority of records, hence
   * optional rather than an always-present "current".
   *
   * COMPUTED PER RESPONSE, never persisted: the stored record is not mutated, so the
   * verdict cannot itself go stale.
   */
  staleness?: MemoryStaleness;
}

/**
 * A single record fetched by id, with the same read-time staleness verdict
 * {@link MemorySearchResult} carries (mt#4743).
 *
 * Separate from `MemorySearchResult` because a fetch-by-id has no `score` — there is no
 * query to be relevant to. Sharing the `staleness` field type (and, in the service, the
 * same annotation pass) is what makes the two surfaces agree by construction rather than
 * by two implementations that must be kept in step.
 */
export interface MemoryReadResult {
  record: MemoryRecord;
  /** See {@link MemorySearchResult.staleness}. Same semantics, same computation. */
  staleness?: MemoryStaleness;
}

/**
 * Sort field for `MemoryService.list()` (mt#4761), applied via SQL `ORDER BY`.
 * Ignored when `filter.stale` is true — that filter forces its own
 * `lastAccessedAt` ascending, nulls-first order (see `MemoryListFilter.stale`).
 */
export type MemoryListSortField =
  | "created"
  | "updated"
  | "lastAccessed"
  | "accessCount"
  | "shortId"
  | "name";

/** Sort direction for `MemoryService.list()` (mt#4761). */
export type MemoryListSortDirection = "asc" | "desc";

/**
 * Default threshold for {@link MemoryListFilter.cold}, in days (mt#4767).
 *
 * Grounded in the measured read distribution rather than picked as a round
 * number (`decision-defaults.mdc §Thresholds`). Of 1,093 ever-read records on
 * 2026-08-31, 805 (74%) had been read within 7 days and 152 more within 14;
 * beyond that the tail collapses — 112 in 14–30d, 18 in 30–60d, 6 older. 14
 * days is where the distribution bends, so it separates "not in the working
 * set" from the ordinary weekly rhythm. For contrast a 7-day cut flags 288
 * records (most of them simply last week's), 30 days flags 24, and
 * `stalenessDays`' own 90-day default flags 1 — the corpus has only tracked
 * `last_accessed_at` since 2026-05-27, so a 90-day cold threshold cannot
 * work here at all.
 *
 * Re-derive from the corpus if the read cadence changes; this is an observed
 * value, not a policy.
 */
export const DEFAULT_COLD_DAYS = 14;

/**
 * Options for filtering memory list results.
 */
export interface MemoryListFilter {
  type?: MemoryType;
  scope?: MemoryScope;
  projectId?: string;
  /**
   * Project scope for filtering (ADR-021, mt#2416).
   * When set to a uuid string, filters to memories belonging to that project.
   * When set to ALL_PROJECTS sentinel or omitted, returns cross-project rows.
   * Takes precedence over `projectId` when both are set.
   */
  projectScope?: import("../project/scope").ProjectScope;
  /** When true, excludes memories that have been superseded (superseded_by IS NOT NULL) */
  excludeSuperseded?: boolean;
  /**
   * When true, filter to records with last_accessed_at IS NULL OR older than stalenessDays.
   * Results are sorted by lastAccessedAt ASC NULLS FIRST (oldest/never-accessed first).
   */
  stale?: boolean;
  /**
   * Threshold in days for the stale filter. Defaults to 90.
   * Ignored unless stale is true.
   */
  stalenessDays?: number;
  /**
   * When true, filter to records carrying no tags at all
   * (`cardinality(tags) = 0`) — mt#4767's "Untagged" curation worklist.
   *
   * NOT expressible via `tags`: that filter is array CONTAINMENT
   * (`tags @> ARRAY[...]`), which can ask "does it have these tags" and can
   * never ask "does it have none".
   */
  untagged?: boolean;
  /**
   * When true, filter to records never read since creation
   * (`last_accessed_at IS NULL`) — mt#4767's "Never read" worklist.
   *
   * DELIBERATELY NOT `stale` (mt#4767). `stale` is `last_accessed_at IS NULL
   * OR older than stalenessDays` — a UNION whose first disjunct IS this
   * filter, so `stale` cannot express never-read and read-but-cold as two
   * separate populations. Measured on the live corpus 2026-08-31: `stale` at
   * its own 90-day default returned 252 rows against this filter's 251,
   * because exactly ONE record had been read but not within 90 days. Building
   * both worklists on `stale` would have shipped the same list twice.
   */
  neverAccessed?: boolean;
  /**
   * When true, filter to records that HAVE been read but not recently
   * (`last_accessed_at IS NOT NULL AND last_accessed_at < now() - coldDays`)
   * — mt#4767's "Cold" worklist. Strictly disjoint from {@link neverAccessed}
   * by construction; together they partition what {@link stale} unions.
   *
   * "Cold", not "stale": `staleness.ts` already emits `⚠️ POSSIBLY OBSOLETE`
   * for a DIFFERENT property — a memory whose tracking task shipped — so the
   * word is spoken for. {@link stale} itself is the mis-named one; renaming
   * it is a tracked follow-up, not this filter's job.
   */
  cold?: boolean;
  /**
   * Threshold in days for the cold filter. Defaults to
   * {@link DEFAULT_COLD_DAYS}. Ignored unless cold is true.
   */
  coldDays?: number;
  /**
   * When true, filter to records that HAVE been superseded
   * (`superseded_by IS NOT NULL`) — mt#4767's "Superseded" worklist.
   *
   * Not reachable via {@link excludeSuperseded}, which is one-directional:
   * `true` removes superseded rows and `false` removes nothing, so neither
   * value restricts TO them. Setting both is contradictory and yields no
   * rows, which is the honest result rather than a silent precedence rule.
   */
  onlySuperseded?: boolean;
  /**
   * Filter by association containment. Returns only memories where
   * associations[type] contains targetId.
   * Example: { type: "tracksTask", targetId: "mt#2053" }
   */
  association?: { type: string; targetId: string };
  /**
   * Lower bound (inclusive) on `createdAt` — ISO-8601 timestamp (mt#2817).
   * Memory records are largely create-once/rarely-mutated facts, so `since`/
   * `until` filter on `createdAt` (when the fact was recorded) rather than
   * `updatedAt` (unlike tasks_list, whose `since`/`until` filter on
   * `updatedAt` since tasks are actively mutated over their lifecycle).
   */
  since?: string;
  /** Upper bound (inclusive) on `createdAt` — ISO-8601 timestamp (mt#2817). */
  until?: string;
  /**
   * Sort field, applied in SQL (mt#4761). Defaults to `"created"` when omitted.
   * Ignored when `stale` is true.
   */
  sort?: MemoryListSortField;
  /**
   * Sort direction, applied in SQL (mt#4761). Defaults to `"desc"` when omitted.
   * Ignored when `stale` is true.
   */
  dir?: MemoryListSortDirection;
  /**
   * Max rows to return, applied via SQL `LIMIT` (mt#4761). Defaults to
   * `DEFAULT_LIST_CAP` (`../utils/list-pagination.ts`) when omitted.
   */
  limit?: number;
  /** Rows to skip, applied via SQL `OFFSET` (mt#4761). Defaults to 0. */
  offset?: number;
  /**
   * AND-semantics filter over the `tags` `text[]` column (mt#4761): a
   * matching record must carry EVERY listed tag, not merely one of them.
   */
  tags?: string[];
  /**
   * Case-insensitive substring filter over `name`, applied via SQL `ILIKE`
   * (mt#4761).
   */
  nameContains?: string;
}

/**
 * Options for semantic search.
 */
export interface MemorySearchOptions {
  limit?: number;
  threshold?: number;
  filter?: MemoryListFilter;
}

/**
 * Return value of MemoryService.search() — includes degradation metadata.
 */
export interface MemorySearchResponse {
  results: MemorySearchResult[];
  /** Which backend served the results */
  backend: "embeddings" | "lexical" | "none";
  /** True if a fallback was used (e.g., embedding service unavailable) */
  degraded: boolean;
}
