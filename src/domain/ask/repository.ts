/**
 * Ask Repository
 *
 * CRUD for the Ask domain entity (mt#1068). Wave 1 of the attention-allocation
 * subsystem (ADR-006 / mt#1034).
 *
 * Design:
 * - Follows the narrow MinskyBackendDb interface pattern from MemoryService to
 *   avoid `as unknown as PostgresJsDatabase` casts in tests.
 * - No embeddings, no vector storage — simpler than MemoryService.
 * - State transitions are NOT enforced here; the router (mt#1069) owns lifecycle.
 *   This repository only ensures CRUD round-trip and close-with-response atomicity.
 */

import { eq, and } from "drizzle-orm";
import { asksTable } from "../storage/schemas/ask-schema";
import type {
  Ask,
  AskCreateInput,
  AskCloseInput,
  AskListFilter,
  AskKind,
  AskState,
  AskPayload,
  AskResponse,
  TransportBinding,
} from "./types";

// ---------------------------------------------------------------------------
// Narrow DB interface — allows test fakes without `as unknown` casts
// ---------------------------------------------------------------------------

export interface AskRepositoryDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields?: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(table: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(table: any): any;
}

// ---------------------------------------------------------------------------
// Row → domain mapper
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToAsk(row: Record<string, any>): Ask {
  return {
    id: String(row["id"]),
    kind: row["kind"] as AskKind,
    classifierVersion: String(row["classifier_version"] ?? row["classifierVersion"] ?? "v1"),
    state: row["state"] as AskState,
    requestor: String(row["requestor"]),
    routingTarget:
      (row["routing_target"] as TransportBinding | null | undefined) ??
      (row["routingTarget"] as TransportBinding | null | undefined) ??
      null,
    parentTaskId: row["parent_task_id"] ?? row["parentTaskId"] ?? null,
    parentSessionId: row["parent_session_id"] ?? row["parentSessionId"] ?? null,
    title: String(row["title"]),
    question: String(row["question"]),
    payload: row["payload"] as AskPayload,
    response: (row["response"] as AskResponse | null | undefined) ?? null,
    metadata: (row["metadata"] as Record<string, unknown> | null | undefined) ?? null,
    deadline: coerceDate(row["deadline"]),
    createdAt: coerceDate(row["created_at"] ?? row["createdAt"]) ?? new Date(),
    routedAt: coerceDate(row["routed_at"] ?? row["routedAt"]),
    suspendedAt: coerceDate(row["suspended_at"] ?? row["suspendedAt"]),
    respondedAt: coerceDate(row["responded_at"] ?? row["respondedAt"]),
    closedAt: coerceDate(row["closed_at"] ?? row["closedAt"]),
  };
}

function coerceDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") return new Date(v);
  return null;
}

// ---------------------------------------------------------------------------
// AskRepository
// ---------------------------------------------------------------------------

export interface AskRepositorySurface {
  create(input: AskCreateInput): Promise<Ask>;
  get(id: string): Promise<Ask | null>;
  list(filter?: AskListFilter): Promise<Ask[]>;
  close(id: string, input: AskCloseInput): Promise<Ask | null>;
}

export class AskRepository implements AskRepositorySurface {
  constructor(private readonly db: AskRepositoryDb) {}

  /**
   * Insert a new Ask. Lifecycle timestamps default to sensible values so callers
   * constructing an Ask from a raw intent don't have to set them.
   */
  async create(input: AskCreateInput): Promise<Ask> {
    const rows = await this.db
      .insert(asksTable)
      .values({
        kind: input.kind,
        classifierVersion: input.classifierVersion ?? "v1",
        state: "pending",
        requestor: input.requestor,
        routingTarget: null,
        parentTaskId: input.parentTaskId ?? null,
        parentSessionId: input.parentSessionId ?? null,
        title: input.title,
        question: input.question,
        payload: input.payload,
        response: null,
        metadata: input.metadata ?? null,
        deadline: input.deadline ?? null,
      })
      .returning();

    const row = rows[0] as Record<string, unknown>;
    return rowToAsk(row);
  }

  async get(id: string): Promise<Ask | null> {
    const rows = await this.db.select().from(asksTable).where(eq(asksTable.id, id));
    const row = (rows as Record<string, unknown>[])[0];
    if (!row) return null;
    return rowToAsk(row);
  }

  async list(filter?: AskListFilter): Promise<Ask[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conditions: any[] = [];

    if (filter?.state) conditions.push(eq(asksTable.state, filter.state));
    if (filter?.kind) conditions.push(eq(asksTable.kind, filter.kind));
    if (filter?.classifierVersion) {
      conditions.push(eq(asksTable.classifierVersion, filter.classifierVersion));
    }
    if (filter?.parentTaskId) {
      conditions.push(eq(asksTable.parentTaskId, filter.parentTaskId));
    }
    if (filter?.parentSessionId) {
      conditions.push(eq(asksTable.parentSessionId, filter.parentSessionId));
    }

    const baseQuery = this.db.select().from(asksTable);
    const filteredQuery = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;

    const rows = await filteredQuery;
    return (rows as Record<string, unknown>[]).map(rowToAsk);
  }

  /**
   * Transition an Ask to `closed`, recording the response and setting
   * `responded_at` and `closed_at` atomically at the query level.
   * Merges supplied metadata into any existing metadata (shallow).
   */
  async close(id: string, input: AskCloseInput): Promise<Ask | null> {
    const now = new Date();

    // Fetch current metadata for shallow merge; avoids round-tripping full row.
    const existing = await this.get(id);
    if (!existing) return null;

    const mergedMetadata =
      input.metadata == null
        ? existing.metadata
        : { ...(existing.metadata ?? {}), ...input.metadata };

    const rows = await this.db
      .update(asksTable)
      .set({
        state: "closed",
        response: input.response,
        respondedAt: existing.respondedAt ?? now,
        closedAt: now,
        metadata: mergedMetadata,
      })
      .where(eq(asksTable.id, id))
      .returning();

    const row = (rows as Record<string, unknown>[])[0];
    if (!row) return null;
    return rowToAsk(row);
  }
}

// ---------------------------------------------------------------------------
// Standalone helper: createAsk()
// ---------------------------------------------------------------------------

/**
 * Thin wrapper around AskRepository.create(). Exists as a named export so
 * callers that don't hold a repository instance (e.g., the 2-strikes rule
 * callsite emitting a stuck.unblock ask via a registry lookup) can import
 * one function instead of wiring the class.
 *
 * Callers holding an AskRepository should prefer `repo.create()` directly.
 */
export async function createAsk(repo: AskRepositorySurface, input: AskCreateInput): Promise<Ask> {
  return repo.create(input);
}
