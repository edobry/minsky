/**
 * Memory Domain Types
 *
 * Core type definitions for the memory system (Phase 1).
 * Memories are persisted facts about the user, feedback, projects, or references.
 * They are stored with pgvector embeddings to support semantic search.
 *
 * @see mt#1012 Memory Phase 1 spec
 */

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

// --- Search types ---

/**
 * A single search result returned by MemoryService.search().
 */
export interface MemorySearchResult {
  record: MemoryRecord;
  score: number;
}

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
   * Filter by association containment. Returns only memories where
   * associations[type] contains targetId.
   * Example: { type: "tracksTask", targetId: "mt#2053" }
   */
  association?: { type: string; targetId: string };
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
