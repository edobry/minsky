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

export const MEMORY_TYPES = {
  user: "user",
  feedback: "feedback",
  project: "project",
  reference: "reference",
} as const;

export type MemoryType = (typeof MEMORY_TYPES)[keyof typeof MEMORY_TYPES];

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
  tags?: string[];
  /** When true, excludes memories that have been superseded (superseded_by IS NOT NULL) */
  excludeSuperseded?: boolean;
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
