/**
 * Memory Service
 *
 * Provides CRUD + semantic search over the memories domain.
 *
 * Design notes:
 * - Two-table separation: memories (domain) + memories_embeddings (vectors).
 * - Embedding failures are non-fatal: create/update still succeed; search
 *   degrades gracefully to {backend:"none", degraded:true}.
 * - supersede() is transactional: inserts new memory and sets old.superseded_by
 *   atomically using a SQL transaction.
 * - Follows the MinskyBackendDb narrow-interface pattern to avoid
 *   `as unknown as PostgresJsDatabase` casts in tests.
 *
 * @see mt#1012 Memory Phase 1 spec
 */

import { injectable } from "tsyringe";
import { eq, and, isNull, inArray, or, lt, gte, lte, sql } from "drizzle-orm";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { VectorStorage } from "../storage/vector/types";
import { memoriesTable } from "../storage/schemas/memory-embeddings";
import { log } from "@minsky/shared/logger";
import { isAllProjects } from "../project/scope";
import { MEMORY_SCOPES } from "./types";
import { nextShortId } from "../utils/short-id";
import type {
  MemoryRecord,
  MemoryCreateInput,
  MemoryUpdateInput,
  MemoryListFilter,
  MemorySearchOptions,
  MemorySearchResponse,
  MemorySearchResult,
} from "./types";

// ---------------------------------------------------------------------------
// Narrow DB interface (avoids `as unknown as PostgresJsDatabase` in tests)
// ---------------------------------------------------------------------------

/**
 * Narrow interface covering only the Drizzle methods used by MemoryService.
 * `any` return types let test fakes satisfy this without unsafe casts,
 * while the real PostgresJsDatabase satisfies it structurally.
 */
export interface MemoryServiceDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields?: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(table: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(table: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Public API surface interface
// ---------------------------------------------------------------------------

/**
 * Narrow public-API interface for MemoryService.
 * Use this in tests and dependency injection instead of the concrete class
 * to avoid `as unknown as MemoryService` casts.
 */
export interface MemoryServiceSurface {
  search(query: string, opts?: MemorySearchOptions): Promise<MemorySearchResponse>;
  get(id: string): Promise<MemoryRecord | null>;
  list(filter?: MemoryListFilter): Promise<MemoryRecord[]>;
  create(input: MemoryCreateInput): Promise<MemoryRecord>;
  update(id: string, input: MemoryUpdateInput): Promise<MemoryRecord | null>;
  delete(id: string): Promise<void>;
  similar(
    id: string,
    opts?: Pick<MemorySearchOptions, "limit" | "threshold"> & {
      /**
       * Project scope for filtering (ADR-021, mt#2939). When set to a uuid
       * string, filters results to memories belonging to that project. When
       * set to ALL_PROJECTS or omitted, returns cross-project neighbors.
       */
      projectScope?: import("../project/scope").ProjectScope;
    }
  ): Promise<MemorySearchResult[]>;
  supersede(
    oldId: string,
    newInput: MemoryCreateInput,
    reason?: string
  ): Promise<{ old: MemoryRecord; replacement: MemoryRecord }>;
  /**
   * Walk the supersession chain for a given memory ID and return the ordered chain
   * from oldest ancestor to newest descendant.
   */
  lineage(id: string): Promise<{ chain: MemoryRecord[]; truncated: boolean }>;
}

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface MemoryServiceDeps {
  db: MemoryServiceDb;
  vectorStorage: VectorStorage;
  embeddingService: EmbeddingService;
}

// ---------------------------------------------------------------------------
// Row → domain mapper
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRecord(row: Record<string, any>): MemoryRecord {
  return {
    id: String(row["id"]),
    // mem#N short id (mt#2966) — undefined for legacy rows pre-backfill.
    shortId: (row["short_id"] ?? row["shortId"] ?? undefined) as string | undefined,
    type: row["type"],
    name: String(row["name"]),
    description: String(row["description"]),
    content: String(row["content"]),
    scope: row["scope"],
    projectId: row["project_id"] ?? row["projectId"] ?? null,
    tags: Array.isArray(row["tags"]) ? row["tags"] : [],
    sourceAgentId: row["source_agent_id"] ?? row["sourceAgentId"] ?? null,
    sourceSessionId: row["source_session_id"] ?? row["sourceSessionId"] ?? null,
    confidence: row["confidence"] ?? null,
    supersededBy: row["superseded_by"] ?? row["supersededBy"] ?? null,
    metadata: (row["metadata"] as Record<string, unknown> | null | undefined) ?? null,
    associations: (row["associations"] as Record<string, string[]> | null | undefined) ?? {},
    createdAt: row["created_at"] ?? row["createdAt"] ?? new Date(),
    updatedAt: row["updated_at"] ?? row["updatedAt"] ?? new Date(),
    lastAccessedAt: row["last_accessed_at"] ?? row["lastAccessedAt"] ?? null,
    accessCount: row["access_count"] ?? row["accessCount"] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@injectable()
export class MemoryService implements MemoryServiceSurface {
  constructor(private readonly deps: MemoryServiceDeps) {}

  // -------------------------------------------------------------------------
  // Short-id minting (mt#2966, generalizing mt#2205's `computeNextTaskId`
  // pattern via the shared `nextShortId` util — mirrors
  // `DrizzleAskRepository.nextAskShortId`, mt#2965).
  // -------------------------------------------------------------------------

  /**
   * Compute the next `mem#N` short id via a targeted query: select ONLY the
   * `short_id` column — never the full row — rather than a `SELECT *` over
   * the whole `memories` table. `nextShortId` (the shared mt#2963
   * foundation util) folds over whatever candidate ids come back to
   * compute the max — it internally filters to `mem#<n>`-shaped values via
   * `parseShortId`, so a server-side WHERE filter is not required for
   * correctness (nulls and non-`mem#`-shaped values are simply ignored by
   * the fold).
   *
   * Deliberately no `WHERE`/`ORDER BY`/`LIMIT` beyond the column
   * projection: `MemoryServiceDb` is the narrow interface
   * (`select`/`insert`/`update`/`delete`/`transaction`) this service uses
   * specifically so it stays testable against simple fakes without a real
   * Drizzle client, and this codebase's several ad-hoc `MemoryServiceDb`
   * test fakes vary in which raw-SQL WHERE shapes they can evaluate — one
   * throws on any pattern it doesn't recognize. A single-column, unfiltered
   * select is the query shape every existing fake already supports
   * unconditionally. Unlike `DrizzleAskRepository.nextAskShortId` (mt#2965
   * PR #2110 R1), this does not add the `ORDER BY ... LIMIT 1`
   * single-row-fetch optimization on top — a future perf pass can add a
   * WHERE-filtered + LIMIT 1 variant (behind a real-Drizzle-only code path,
   * or after updating every fake in lockstep) without changing this
   * method's contract.
   *
   * `db` defaults to `this.deps.db` but accepts an explicit `tx` so
   * `supersede()` can mint within its own transaction for read/write
   * consistency.
   *
   * Memories have no tombstone table analogous to tasks' `deleted_task_ids`
   * (mt#2205) — the max is computed over live short ids only, so a deleted
   * memory's short id MAY be reissued to a new memory. Acceptable for v1
   * per the mt#2966 spec; a future task can add a `deleted_memory_short_ids`
   * tombstone table mirroring the tasks pattern if reuse proves undesirable.
   */
  private async nextMemoryShortId(db: MemoryServiceDb = this.deps.db): Promise<string> {
    const rows = (await db
      .select({ shortId: memoriesTable.shortId })
      .from(memoriesTable)) as Array<{
      shortId: string | null;
    }>;
    const liveIds = (Array.isArray(rows) ? rows : [])
      .map((r) => r.shortId)
      .filter((s): s is string => typeof s === "string");
    return nextShortId("mem", liveIds, []);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  /**
   * Insert a new memory row and compute + store its embedding.
   * Embedding failure is non-fatal: the row is still inserted and returned.
   *
   * Mints the next `mem#N` short id (mt#2966) and retries on a short_id
   * collision — the short-id proposal (SELECT max) and the INSERT are not
   * atomic, so a concurrent writer may claim the proposed id between the
   * two. The unique index on `short_id` turns that race into a clean
   * onConflictDoNothing no-op we detect and retry against, mirroring
   * `DrizzleAskRepository.create` (mt#2965) and
   * `MinskyTaskBackend.tryInsertTask` (mt#2205).
   */
  async create(input: MemoryCreateInput): Promise<MemoryRecord> {
    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const shortId = await this.nextMemoryShortId();
      const rows = await this.deps.db
        .insert(memoriesTable)
        .values({
          shortId,
          type: input.type,
          name: input.name,
          description: input.description,
          content: input.content,
          // mt#2663: last-line-of-defense default. `MemoryCreateInput.scope` is
          // typed as required, but callers that bypass TypeScript (raw MCP/CLI
          // args, `as any` casts) could still hand us `undefined`, which would
          // otherwise hit the `memories.scope` NOT NULL constraint at the DB.
          scope: input.scope ?? MEMORY_SCOPES.project,
          projectId: input.projectId ?? null,
          tags: input.tags ?? [],
          sourceAgentId: input.sourceAgentId ?? null,
          sourceSessionId: input.sourceSessionId ?? null,
          confidence: input.confidence ?? null,
          supersededBy: null,
          associations: input.associations ?? {},
        })
        .onConflictDoNothing({ target: memoriesTable.shortId })
        .returning();

      const row = rows?.[0] as Record<string, unknown> | undefined;
      if (row) {
        const record = rowToRecord(row);
        // Attempt to store embedding; degrade gracefully on failure.
        await this.tryStoreEmbedding(record.id, input.content);
        return record;
      }
      // short_id collision — another writer took it; loop and re-propose.
    }
    throw new Error(
      `Failed to allocate a unique memory short id after ${MAX_RETRIES} attempts. ` +
        "This indicates extremely high concurrent memory creation — please retry."
    );
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /**
   * Fetch a single memory record by ID.
   * Access tracking: bumps last_accessed_at and access_count non-blocking (fire-and-forget).
   */
  async get(id: string): Promise<MemoryRecord | null> {
    const rows = await this.deps.db.select().from(memoriesTable).where(eq(memoriesTable.id, id));

    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const record = rowToRecord(row);
    this.bumpAccessCount([record.id]);
    return record;
  }

  async list(filter?: MemoryListFilter): Promise<MemoryRecord[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conditions: any[] = [];

    if (filter?.type) {
      conditions.push(eq(memoriesTable.type, filter.type));
    }
    if (filter?.scope) {
      conditions.push(eq(memoriesTable.scope, filter.scope));
    }
    // projectScope takes precedence over projectId when both are set (ADR-021, mt#2416)
    if (filter?.projectScope && !isAllProjects(filter.projectScope)) {
      conditions.push(eq(memoriesTable.projectId, filter.projectScope));
    } else if (filter?.projectId) {
      conditions.push(eq(memoriesTable.projectId, filter.projectId));
    }
    if (filter?.excludeSuperseded) {
      conditions.push(isNull(memoriesTable.supersededBy));
    }
    if (filter?.stale) {
      const days = filter.stalenessDays ?? 90;
      const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      conditions.push(
        or(isNull(memoriesTable.lastAccessedAt), lt(memoriesTable.lastAccessedAt, threshold))
      );
    }
    if (filter?.association) {
      const { type: assocType, targetId } = filter.association;
      const containsObj = { [assocType]: [targetId] };
      conditions.push(sql`${memoriesTable.associations} @> ${JSON.stringify(containsObj)}::jsonb`);
    }
    // mt#2817: since/until filter on createdAt (see MemoryListFilter doc comment
    // for why createdAt rather than updatedAt). Invalid date strings are
    // dropped rather than throwing — same defensive posture as the rest of
    // this filter set (a bad filter degrades to "no filter", not a 500).
    if (filter?.since) {
      const since = new Date(filter.since);
      if (!Number.isNaN(since.getTime())) {
        conditions.push(gte(memoriesTable.createdAt, since));
      }
    }
    if (filter?.until) {
      const until = new Date(filter.until);
      if (!Number.isNaN(until.getTime())) {
        conditions.push(lte(memoriesTable.createdAt, until));
      }
    }

    const baseQuery = this.deps.db.select().from(memoriesTable);
    const filteredQuery = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;

    // When stale filter is active, sort by lastAccessedAt ASC NULLS FIRST so the
    // oldest/never-accessed records appear first.
    const rows = filter?.stale
      ? await filteredQuery.orderBy(sql`${memoriesTable.lastAccessedAt} ASC NULLS FIRST`)
      : await filteredQuery;

    return (rows as Record<string, unknown>[]).map(rowToRecord);
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async update(id: string, input: MemoryUpdateInput): Promise<MemoryRecord | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: Record<string, any> = { updatedAt: new Date() };

    if (input.type !== undefined) updateData["type"] = input.type;
    if (input.name !== undefined) updateData["name"] = input.name;
    if (input.description !== undefined) updateData["description"] = input.description;
    if (input.content !== undefined) updateData["content"] = input.content;
    if (input.scope !== undefined) updateData["scope"] = input.scope;
    if ("projectId" in input) updateData["projectId"] = input.projectId ?? null;
    if (input.tags !== undefined) updateData["tags"] = input.tags;
    if ("sourceAgentId" in input) updateData["sourceAgentId"] = input.sourceAgentId ?? null;
    if ("sourceSessionId" in input) updateData["sourceSessionId"] = input.sourceSessionId ?? null;
    if ("confidence" in input) updateData["confidence"] = input.confidence ?? null;

    if (input.associations !== undefined) {
      const entries = Object.entries(input.associations);
      const toMerge = Object.fromEntries(entries.filter(([, v]) => v.length > 0));
      const toRemove = entries.filter(([, v]) => v.length === 0).map(([k]) => k);

      let expr = sql`${memoriesTable.associations} || ${JSON.stringify(toMerge)}::jsonb`;
      for (const key of toRemove) {
        expr = sql`(${expr}) - ${key}`;
      }
      updateData["associations"] = expr;
    }

    const rows = await this.deps.db
      .update(memoriesTable)
      .set(updateData)
      .where(eq(memoriesTable.id, id))
      .returning();

    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;

    const record = rowToRecord(row);

    // Re-embed if content changed.
    if (input.content !== undefined) {
      await this.tryStoreEmbedding(record.id, input.content);
    }

    return record;
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  async delete(id: string): Promise<void> {
    await this.deps.db.delete(memoriesTable).where(eq(memoriesTable.id, id));
    await this.deps.vectorStorage.delete(id).catch((err: unknown) => {
      log.warn("[memory.delete] Failed to delete embedding", { id, err });
    });
  }

  // -------------------------------------------------------------------------
  // Search (semantic)
  // -------------------------------------------------------------------------

  /**
   * Compute a query embedding, then search the vector store.
   * Returns degraded={true} when the embedding service is unavailable.
   */
  async search(query: string, opts?: MemorySearchOptions): Promise<MemorySearchResponse> {
    let queryVector: number[];

    try {
      queryVector = await this.deps.embeddingService.generateEmbedding(query);
    } catch (err) {
      log.warn("[memory.search] Embedding service unavailable; returning empty results", { err });
      return { results: [], backend: "none", degraded: true };
    }

    const searchResults = await this.deps.vectorStorage.search(queryVector, {
      limit: opts?.limit ?? 10,
      threshold: opts?.threshold,
    });

    if (searchResults.length === 0) {
      return { results: [], backend: "embeddings", degraded: false };
    }

    // Fetch the actual memory records for the returned IDs.
    const ids = searchResults.map((r) => r.id);

    // Build a filter query for the IDs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conditions: any[] = [inArray(memoriesTable.id, ids)];

    // Apply optional domain filters post-hoc.
    if (opts?.filter?.type) {
      conditions.push(eq(memoriesTable.type, opts.filter.type));
    }
    if (opts?.filter?.scope) {
      conditions.push(eq(memoriesTable.scope, opts.filter.scope));
    }
    // projectScope takes precedence over projectId when both are set (ADR-021, mt#2416)
    if (opts?.filter?.projectScope && !isAllProjects(opts.filter.projectScope)) {
      conditions.push(eq(memoriesTable.projectId, opts.filter.projectScope));
    } else if (opts?.filter?.projectId) {
      conditions.push(eq(memoriesTable.projectId, opts.filter.projectId));
    }
    if (opts?.filter?.excludeSuperseded) {
      conditions.push(isNull(memoriesTable.supersededBy));
    }

    const rows = (await this.deps.db
      .select()
      .from(memoriesTable)
      .where(and(...conditions))) as Record<string, unknown>[];

    // Map rows by ID for O(1) lookup, preserving vector-score ordering.
    const rowById = new Map(rows.map((r) => [String(r["id"]), r]));

    const results: MemorySearchResult[] = [];
    for (const sr of searchResults) {
      const row = rowById.get(sr.id);
      if (row) {
        results.push({ record: rowToRecord(row), score: sr.score });
      }
    }

    // Access tracking: bump non-blocking (fire-and-forget).
    this.bumpAccessCount(results.map((r) => r.record.id));

    return { results, backend: "embeddings", degraded: false };
  }

  // -------------------------------------------------------------------------
  // Similar (find neighbors of an existing memory)
  // -------------------------------------------------------------------------

  async similar(
    id: string,
    opts?: Pick<MemorySearchOptions, "limit" | "threshold"> & {
      projectScope?: import("../project/scope").ProjectScope;
    }
  ): Promise<MemorySearchResult[]> {
    // Note: this.get(id) below bumps the source record's access_count via
    // bumpAccessCount. That is intentional — a similar(id) call counts as an
    // access of the source as well as the neighbors. If this turns out to be
    // wrong, revisit the bump semantics at that point.
    const embeddingMeta = await this.deps.vectorStorage.getMetadata?.(id);
    if (!embeddingMeta) {
      return [];
    }

    // Re-fetch the record's own content to get its vector.
    const record = await this.get(id);
    if (!record) return [];

    let vector: number[];
    try {
      vector = await this.deps.embeddingService.generateEmbedding(record.content);
    } catch {
      return [];
    }

    const searchResults = await this.deps.vectorStorage.search(vector, {
      limit: (opts?.limit ?? 10) + 1, // +1 to account for self
      threshold: opts?.threshold,
    });

    // Exclude self from results.
    const filtered = searchResults.filter((r) => r.id !== id).slice(0, opts?.limit ?? 10);

    if (filtered.length === 0) return [];

    const ids = filtered.map((r) => r.id);

    // mt#2939: cross-check against the live `memories` table's project_id, the same
    // way search()/list() already do (ADR-021, mt#2416). A uuid projectScope adds an
    // equality predicate; ALL_PROJECTS (or omitted) adds none — any candidate whose
    // row falls outside the scope simply isn't in `rows`, so it's dropped below by
    // rowById.get(sr.id) returning undefined (same "missing row => drop" pattern
    // search() already relies on for excludeSuperseded/type/scope filters).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conditions: any[] = [inArray(memoriesTable.id, ids)];
    if (opts?.projectScope && !isAllProjects(opts.projectScope)) {
      conditions.push(eq(memoriesTable.projectId, opts.projectScope));
    }

    const rows = (await this.deps.db
      .select()
      .from(memoriesTable)
      .where(and(...conditions))) as Record<string, unknown>[];

    const rowById = new Map(rows.map((r) => [String(r["id"]), r]));

    const similarResults = filtered
      .map((sr) => {
        const row = rowById.get(sr.id);
        return row ? { record: rowToRecord(row), score: sr.score } : null;
      })
      .filter((r): r is MemorySearchResult => r !== null);

    // Access tracking: bump non-blocking (fire-and-forget).
    this.bumpAccessCount(similarResults.map((r) => r.record.id));

    return similarResults;
  }

  // -------------------------------------------------------------------------
  // Supersede
  // -------------------------------------------------------------------------

  /**
   * Atomically create a replacement memory and mark the old one as superseded.
   * The old memory remains in the database but is excluded from
   * `list({ excludeSuperseded: true })`.
   *
   * Mints a `mem#N` short id (mt#2966) for the replacement row, computed
   * within the same transaction (`tx`, not `this.deps.db`) for read/write
   * consistency. Unlike `create()`, this is a single-attempt mint with no
   * onConflictDoNothing/retry loop — supersede is a much lower-frequency
   * path than create, so the same collision-retry ceremony was judged not
   * worth the added transaction complexity for v1; a genuine collision here
   * (extremely rare) surfaces as a raw unique-constraint error, matching
   * pre-mt#2966 behavior for any other constraint violation on this insert.
   */
  async supersede(
    oldId: string,
    newInput: MemoryCreateInput,
    reason?: string
  ): Promise<{ old: MemoryRecord; replacement: MemoryRecord }> {
    const { oldRecord, newRecord } = await this.deps.db.transaction(async (tx: MemoryServiceDb) => {
      const shortId = await this.nextMemoryShortId(tx);
      // Insert new memory inside the transaction.
      const newRows = await tx
        .insert(memoriesTable)
        .values({
          shortId,
          type: newInput.type,
          name: newInput.name,
          description: newInput.description,
          content: newInput.content,
          // mt#2663: same last-line-of-defense default as create() — an
          // untyped caller passing undefined would otherwise hit the
          // `memories.scope` NOT NULL constraint at the DB.
          scope: newInput.scope ?? MEMORY_SCOPES.project,
          projectId: newInput.projectId ?? null,
          tags: newInput.tags ?? [],
          sourceAgentId: newInput.sourceAgentId ?? null,
          sourceSessionId: newInput.sourceSessionId ?? null,
          confidence: newInput.confidence ?? null,
          supersededBy: null,
        })
        .returning();

      const replacement = rowToRecord(newRows[0] as Record<string, unknown>);

      // Read the old memory's current metadata so we can append rather than overwrite.
      const oldRowsBefore = await tx
        .select()
        .from(memoriesTable)
        .where(eq(memoriesTable.id, oldId));
      const oldBefore = oldRowsBefore[0] as Record<string, unknown> | undefined;
      const existingMetadata =
        (oldBefore?.["metadata"] as Record<string, unknown> | null | undefined) ?? {};
      const mergedMetadata = {
        ...existingMetadata,
        supersession_reason: reason ?? null,
        superseded_at: new Date().toISOString(),
      };

      // Mark the old memory as superseded and record the reason in metadata.
      const oldRows = await tx
        .update(memoriesTable)
        .set({
          supersededBy: replacement.id,
          metadata: mergedMetadata,
          updatedAt: new Date(),
        })
        .where(eq(memoriesTable.id, oldId))
        .returning();

      return {
        newRecord: replacement,
        oldRecord: rowToRecord(oldRows[0] as Record<string, unknown>),
      };
    });

    // Compute embedding for the new memory outside the transaction.
    await this.tryStoreEmbedding(newRecord.id, newInput.content);

    return { old: oldRecord, replacement: newRecord };
  }

  // -------------------------------------------------------------------------
  // Lineage
  // -------------------------------------------------------------------------

  /**
   * Walk the supersession chain for a given memory ID and return the ordered chain
   * from oldest ancestor to newest descendant.
   *
   * Algorithm:
   * 1. Load the starting record.
   * 2. Walk BACKWARD: find records A where A.supersededBy === current.id (predecessors).
   * 3. Walk FORWARD: follow current.supersededBy to find newer replacements.
   * 4. Return chain ordered [oldest ancestor, ..., newest descendant].
   * 5. Cycle guard: track visited IDs; break + set truncated=true on repeat.
   * 6. Max depth: 100 iterations total to prevent runaway.
   */
  async lineage(id: string): Promise<{ chain: MemoryRecord[]; truncated: boolean }> {
    const MAX_DEPTH = 100;
    const visited = new Set<string>();
    let truncated = false;

    // Load the starting record.
    const start = await this.getById(id);
    if (!start) return { chain: [], truncated: false };

    // Walk BACKWARD to find oldest ancestor.
    const ancestors: MemoryRecord[] = [];
    let current = start;
    let depth = 0;
    while (depth < MAX_DEPTH) {
      if (visited.has(current.id)) {
        truncated = true;
        break;
      }
      visited.add(current.id);

      // Find the predecessor: a record whose supersededBy points to current.id
      const predecessorRows = (await this.deps.db
        .select()
        .from(memoriesTable)
        .where(eq(memoriesTable.supersededBy, current.id))) as Record<string, unknown>[];

      if (predecessorRows.length === 0) break;
      const predecessor = rowToRecord(predecessorRows[0] as Record<string, unknown>);
      ancestors.push(predecessor);
      current = predecessor;
      depth++;
    }

    if (depth >= MAX_DEPTH) truncated = true;

    // ancestors is [direct predecessor, ..., oldest ancestor] — reverse to get [oldest, ...]
    ancestors.reverse();

    // Walk FORWARD from start to find newer replacements.
    const descendants: MemoryRecord[] = [];
    current = start;
    depth = 0;
    while (depth < MAX_DEPTH && current.supersededBy) {
      if (visited.has(current.supersededBy)) {
        truncated = true;
        break;
      }
      visited.add(current.supersededBy);

      const nextRecord = await this.getById(current.supersededBy);
      if (!nextRecord) break;
      descendants.push(nextRecord);
      current = nextRecord;
      depth++;
    }

    if (depth >= MAX_DEPTH) truncated = true;

    const chain = [...ancestors, start, ...descendants];
    return { chain, truncated };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Fetch a record by ID without triggering access tracking (internal helper).
   */
  private async getById(id: string): Promise<MemoryRecord | null> {
    const rows = await this.deps.db.select().from(memoriesTable).where(eq(memoriesTable.id, id));
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Fire-and-forget access tracking bump.
   * Updates last_accessed_at = NOW() and access_count += 1 for the given IDs.
   * Non-blocking: search/get latency is not gated on this update.
   * Errors are logged as warnings but do not propagate to callers.
   */
  private bumpAccessCount(ids: string[]): void {
    if (ids.length === 0) return;
    // Wrap in Promise.resolve so we can attach .catch even if the underlying
    // query-builder doesn't return a native Promise (e.g., fake DBs in tests
    // that model the Drizzle chain with plain objects).
    Promise.resolve(
      this.deps.db
        .update(memoriesTable)
        .set({
          lastAccessedAt: new Date(),
          accessCount: sql`${memoriesTable.accessCount} + 1`,
        })
        .where(inArray(memoriesTable.id, ids))
    ).catch((err: unknown) => {
      log.warn("[memory] access tracking bump failed", { err });
    });
  }

  private async tryStoreEmbedding(id: string, content: string): Promise<void> {
    try {
      const vector = await this.deps.embeddingService.generateEmbedding(content);
      await this.deps.vectorStorage.store(id, vector, { memoryId: id });
    } catch (err) {
      log.warn("[memory.create] Embedding failed; record stored without vector", { id, err });
    }
  }
}
