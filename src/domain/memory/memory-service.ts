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
import { eq, and, isNull, inArray } from "drizzle-orm";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { VectorStorage } from "../storage/vector/types";
import { memoriesTable } from "../storage/schemas/memory-embeddings";
import { log } from "../../utils/logger";
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
export class MemoryService {
  constructor(private readonly deps: MemoryServiceDeps) {}

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  /**
   * Insert a new memory row and compute + store its embedding.
   * Embedding failure is non-fatal: the row is still inserted and returned.
   */
  async create(input: MemoryCreateInput): Promise<MemoryRecord> {
    const rows = await this.deps.db
      .insert(memoriesTable)
      .values({
        type: input.type,
        name: input.name,
        description: input.description,
        content: input.content,
        scope: input.scope,
        projectId: input.projectId ?? null,
        tags: input.tags ?? [],
        sourceAgentId: input.sourceAgentId ?? null,
        sourceSessionId: input.sourceSessionId ?? null,
        confidence: input.confidence ?? null,
        supersededBy: null,
      })
      .returning();

    const row = rows[0] as Record<string, unknown>;
    const record = rowToRecord(row);

    // Attempt to store embedding; degrade gracefully on failure.
    await this.tryStoreEmbedding(record.id, input.content);

    return record;
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  async get(id: string): Promise<MemoryRecord | null> {
    const rows = await this.deps.db.select().from(memoriesTable).where(eq(memoriesTable.id, id));

    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
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
    if (filter?.projectId) {
      conditions.push(eq(memoriesTable.projectId, filter.projectId));
    }
    if (filter?.excludeSuperseded) {
      conditions.push(isNull(memoriesTable.supersededBy));
    }

    const query = this.deps.db.select().from(memoriesTable);
    const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;

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
    if (opts?.filter?.projectId) {
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

    return { results, backend: "embeddings", degraded: false };
  }

  // -------------------------------------------------------------------------
  // Similar (find neighbors of an existing memory)
  // -------------------------------------------------------------------------

  async similar(
    id: string,
    opts?: Pick<MemorySearchOptions, "limit" | "threshold">
  ): Promise<MemorySearchResult[]> {
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
    const rows = (await this.deps.db
      .select()
      .from(memoriesTable)
      .where(inArray(memoriesTable.id, ids))) as Record<string, unknown>[];

    const rowById = new Map(rows.map((r) => [String(r["id"]), r]));

    return filtered
      .map((sr) => {
        const row = rowById.get(sr.id);
        return row ? { record: rowToRecord(row), score: sr.score } : null;
      })
      .filter((r): r is MemorySearchResult => r !== null);
  }

  // -------------------------------------------------------------------------
  // Supersede
  // -------------------------------------------------------------------------

  /**
   * Atomically create a replacement memory and mark the old one as superseded.
   * The old memory remains in the database but is excluded from
   * `list({ excludeSuperseded: true })`.
   */
  async supersede(
    oldId: string,
    newInput: MemoryCreateInput,
    _reason?: string
  ): Promise<{ old: MemoryRecord; replacement: MemoryRecord }> {
    const { oldRecord, newRecord } = await this.deps.db.transaction(async (tx: MemoryServiceDb) => {
      // Insert new memory inside the transaction.
      const newRows = await tx
        .insert(memoriesTable)
        .values({
          type: newInput.type,
          name: newInput.name,
          description: newInput.description,
          content: newInput.content,
          scope: newInput.scope,
          projectId: newInput.projectId ?? null,
          tags: newInput.tags ?? [],
          sourceAgentId: newInput.sourceAgentId ?? null,
          sourceSessionId: newInput.sourceSessionId ?? null,
          confidence: newInput.confidence ?? null,
          supersededBy: null,
        })
        .returning();

      const replacement = rowToRecord(newRows[0] as Record<string, unknown>);

      // Mark the old memory as superseded.
      const oldRows = await tx
        .update(memoriesTable)
        .set({ supersededBy: replacement.id, updatedAt: new Date() })
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
  // Helpers
  // -------------------------------------------------------------------------

  private async tryStoreEmbedding(id: string, content: string): Promise<void> {
    try {
      const vector = await this.deps.embeddingService.generateEmbedding(content);
      await this.deps.vectorStorage.store(id, vector, { memoryId: id });
    } catch (err) {
      log.warn("[memory.create] Embedding failed; record stored without vector", { id, err });
    }
  }
}
