/**
 * Ask repository — interface + Drizzle/Postgres implementation.
 *
 * The `AskRepository` interface is the domain contract; all consumers depend
 * on the interface only. `DrizzleAskRepository` is the Postgres implementation
 * wired at composition time via tsyringe.
 *
 * Operations:
 *   create                 — insert a new Ask row
 *   getById                — fetch by primary key
 *   listByParentTask       — all Asks for a task
 *   listByParentSession    — all Asks for a session
 *   listByState            — all Asks in a given state
 *   listByClassifierVersion — all Asks produced by a classifier version
 *   transition             — state-machine-aware state update (throws on invalid move)
 *   close                  — convenience wrapper: transition to "closed" + attach response
 *   respondAndClose        — atomic suspended → closed walk (mt#1458)
 *
 * Reference: ADR per mt#1034 (pending merge); mt#1237 spec; mt#1458 (respondAndClose).
 */

import { injectable } from "tsyringe";
import { and, desc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { asksTable } from "../storage/schemas/ask-schema";
import type { AskRecord, AskInsert } from "../storage/schemas/ask-schema";
import type { Ask, AskState, AskKind, AgentId } from "./types";
import { guardTransition, isTerminal, TERMINAL_ASK_STATES } from "./state-machine";

// ---------------------------------------------------------------------------
// Row ↔ domain mapping
// ---------------------------------------------------------------------------

/**
 * Map a raw Drizzle row (`AskRecord`) to the typed domain `Ask` object.
 *
 * Timestamps stored as `Date | null` in Drizzle are converted to ISO-8601
 * strings (or `undefined`) to match the `Ask` interface.
 *
 * @internal Exported for unit testing only — do not import outside of tests.
 */
export function toAsk(row: AskRecord): Ask {
  return {
    id: row.id,
    kind: row.kind as AskKind,
    classifierVersion: row.classifierVersion,
    state: row.state as AskState,
    requestor: row.requestor,
    routingTarget: row.routingTarget ?? undefined,
    parentTaskId: row.parentTaskId ?? undefined,
    parentSessionId: row.parentSessionId ?? undefined,
    title: row.title,
    question: row.question,
    options: row.options ?? undefined,
    contextRefs: row.contextRefs ?? undefined,
    response: (row.response as Ask["response"]) ?? undefined,
    deadline: row.deadline ? row.deadline.toISOString() : undefined,
    createdAt: row.createdAt.toISOString(),
    routedAt: row.routedAt ? row.routedAt.toISOString() : undefined,
    suspendedAt: row.suspendedAt ? row.suspendedAt.toISOString() : undefined,
    respondedAt: row.respondedAt ? row.respondedAt.toISOString() : undefined,
    closedAt: row.closedAt ? row.closedAt.toISOString() : undefined,
    // Service-window fields (mt#1411 spine — mt#1488)
    serviceStrategy: (row.serviceStrategy as Ask["serviceStrategy"]) ?? undefined,
    windowKey: row.windowKey ?? undefined,
    // Coalesce NULLs to documented defaults: types.ts states "Defaults to 0 when absent"
    // and "Defaults to false when absent". Legacy rows (pre-migration-0029) may have NULL
    // because PostgreSQL ADD COLUMN DEFAULT does not backfill existing rows.
    windowMissedCount: row.windowMissedCount ?? 0,
    forceImmediate: row.forceImmediate ?? false,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * Map a `CreateAskInput` to a Drizzle `AskInsert` row.
 *
 * `id` and `createdAt` are omitted — the DB defaults handle them.
 */
function toInsert(input: CreateAskInput): AskInsert {
  return {
    kind: input.kind,
    classifierVersion: input.classifierVersion,
    state: "detected",
    requestor: input.requestor,
    routingTarget: input.routingTarget ?? null,
    parentTaskId: input.parentTaskId ?? null,
    parentSessionId: input.parentSessionId ?? null,
    title: input.title,
    question: input.question,
    options: input.options ?? null,
    contextRefs: input.contextRefs ?? null,
    response: null,
    deadline: input.deadline ? new Date(input.deadline) : null,
    // Service-window fields (mt#1411 spine — mt#1488)
    serviceStrategy: input.serviceStrategy ?? null,
    windowKey: input.windowKey ?? null,
    windowMissedCount: input.windowMissedCount ?? 0,
    forceImmediate: input.forceImmediate ?? false,
    metadata: input.metadata ?? {},
  };
}

// ---------------------------------------------------------------------------
// Input / option types
// ---------------------------------------------------------------------------

/** Input for creating a new Ask. `id` and `createdAt` are auto-assigned. All Asks start in "detected". */
export interface CreateAskInput {
  kind: AskKind;
  classifierVersion: string;
  requestor: AgentId;
  routingTarget?: Ask["routingTarget"];
  parentTaskId?: string;
  parentSessionId?: string;
  title: string;
  question: string;
  options?: Ask["options"];
  contextRefs?: Ask["contextRefs"];
  deadline?: string;
  metadata?: Record<string, unknown>;
  /** Service-window routing strategy (mt#1411 spine — mt#1488). */
  serviceStrategy?: Ask["serviceStrategy"];
  /** Named window to target when strategy is "scheduled". */
  windowKey?: string;
  /** Count of windows already missed (defaults to 0 on insert). */
  windowMissedCount?: number;
  /** Bypass window check and route immediately. */
  forceImmediate?: boolean;
}

/** Input for closing an Ask (state → "closed"). */
export interface CloseAskInput {
  response: NonNullable<Ask["response"]>;
}

/** Input for recording a response on an Ask (state → "responded"). */
export interface RespondAskInput {
  response: NonNullable<Ask["response"]>;
}

// ---------------------------------------------------------------------------
// AskRepository interface
// ---------------------------------------------------------------------------

/**
 * Domain contract for Ask persistence.
 *
 * All business logic that touches Asks must depend on this interface, not on
 * the concrete Drizzle implementation, so tests can inject a fake.
 */
export interface AskRepository {
  /** Insert a new Ask row and return the persisted entity. */
  create(input: CreateAskInput): Promise<Ask>;

  /** Fetch an Ask by primary key. Returns `null` if not found. */
  getById(id: string): Promise<Ask | null>;

  /** List all Asks whose `parentTaskId` matches the given task ID. */
  listByParentTask(taskId: string): Promise<Ask[]>;

  /** List all Asks whose `parentSessionId` matches the given session ID. */
  listByParentSession(sessionId: string): Promise<Ask[]>;

  /** List all Asks currently in the given state. */
  listByState(state: AskState): Promise<Ask[]>;

  /** List all Asks produced by the given classifier version. */
  listByClassifierVersion(version: string): Promise<Ask[]>;

  /**
   * Batch-list open Asks for any task in `taskIds`.
   *
   * "Open" means state is not one of the terminal states (closed / cancelled
   * / expired). Rows are returned ordered by `createdAt` descending so the
   * caller can group by `parentTaskId` and pick the first row per task.
   *
   * Replaces the N-query `Promise.all(taskIds.map(listByParentTask))` pattern
   * with a single query — see `getOpenAsksByTaskIds` in queries.ts. Returns
   * an empty array when `taskIds` is empty (no query is issued).
   *
   * @param taskIds Task IDs to filter by.
   * @returns       Open Asks across all matching tasks, sorted createdAt desc.
   */
  findOpenByTaskIds(taskIds: string[]): Promise<Ask[]>;

  /**
   * Transition an Ask to a new state.
   *
   * Enforces the state machine — throws `InvalidAskTransitionError` when the
   * requested `from → to` pair is not in the valid-transitions table.
   *
   * @param id  Primary key of the Ask to update.
   * @param to  Target state.
   * @returns   The updated Ask.
   * @throws    `InvalidAskTransitionError` — invalid transition.
   * @throws    `Error` — Ask not found.
   */
  transition(id: string, to: AskState): Promise<Ask>;

  /**
   * Record a response on an Ask (state → "responded").
   *
   * Transitions state to "responded", attaches the response payload, and sets
   * `respondedAt`. Throws on invalid transitions (same as `transition`).
   *
   * @param id     Primary key of the Ask to update.
   * @param input  The response payload to attach.
   * @returns      The updated Ask.
   * @throws       `InvalidAskTransitionError` — invalid transition.
   * @throws       `Error` — Ask not found.
   */
  respond(id: string, input: RespondAskInput): Promise<Ask>;

  /**
   * Close an Ask (convenience wrapper around `transition`).
   *
   * Transitions state to "closed" and writes the response payload in a single
   * operation. Throws on invalid transitions (same as `transition`).
   */
  close(id: string, input: CloseAskInput): Promise<Ask>;

  /**
   * Atomically respond to and close a `"suspended"` Ask in one step.
   *
   * Logically walks the Ask through `suspended → responded → closed`, but
   * persists ONLY the close stage: the row goes from suspended to closed
   * in a single UPDATE with `respondedAt` and `closedAt` both set to now,
   * `state: "closed"`, and `response = closeInput.response`. The
   * `respondInput` parameter exists solely to document the two-stage
   * logical model (the same shape `repo.respond` would receive); the
   * intermediate "responded" payload is NOT persisted to a separate row
   * or column. Callers that need an audit trail of the intermediate
   * payload should design that separately.
   *
   * Atomicity guarantee:
   *   - **Drizzle backend**: optimistic-concurrency `WHERE id = ? AND
   *     state = 'suspended'` clause. If a concurrent actor transitions
   *     the Ask between this call and its execution (cancel, expire,
   *     etc.), the update matches zero rows and the method throws
   *     `ConcurrentTransitionError` describing the actual current state.
   *   - **Fake backend**: single-threaded — atomic by virtue of the
   *     synchronous in-memory implementation.
   *
   * Used by `respondToAsk` (mt#1458) to honor the `Ask.response` contract
   * (`attentionCost` is filled on close) AND the no-stuck-in-responded
   * invariant.
   *
   * @throws `Error` — Ask not found.
   * @throws `ConcurrentTransitionError` — Ask was not in `"suspended"` state
   *         when the atomic update ran.
   */
  respondAndClose(
    id: string,
    respondInput: RespondAskInput,
    closeInput: CloseAskInput
  ): Promise<Ask>;
}

/**
 * Thrown when `respondAndClose` finds the Ask is not in `"suspended"` state
 * at the moment of the atomic update — typically because a concurrent actor
 * cancelled / expired / closed the Ask between read and write.
 *
 * The deletion race (Ask removed between read and write) surfaces as a
 * plain `Error("Ask not found: ${id}")` instead, matching the rest of the
 * repository's not-found semantics.
 */
export class ConcurrentTransitionError extends Error {
  readonly id: string;
  readonly observedState: AskState;

  constructor(id: string, observedState: AskState) {
    super(
      `Concurrent transition on Ask ${id}: expected state="suspended" at atomic respondAndClose, found state="${observedState}". Another actor (cancel / expire / close) transitioned the Ask between read and write.`
    );
    this.name = "ConcurrentTransitionError";
    this.id = id;
    this.observedState = observedState;
  }
}

// ---------------------------------------------------------------------------
// DrizzleAskRepository — Postgres implementation
// ---------------------------------------------------------------------------

/**
 * Postgres implementation of `AskRepository` using the Drizzle ORM.
 *
 * Injected via tsyringe at composition time with a `PostgresJsDatabase`
 * instance. All queries use the typed `asksTable` schema — no raw SQL.
 */
@injectable()
export class DrizzleAskRepository implements AskRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async create(input: CreateAskInput): Promise<Ask> {
    const rows = await this.db.insert(asksTable).values(toInsert(input)).returning();
    const row = rows[0];
    if (!row) {
      throw new Error("Ask insert returned no row");
    }
    return toAsk(row);
  }

  async getById(id: string): Promise<Ask | null> {
    const rows = await this.db.select().from(asksTable).where(eq(asksTable.id, id)).limit(1);
    const row = rows[0];
    return row ? toAsk(row) : null;
  }

  async listByParentTask(taskId: string): Promise<Ask[]> {
    const rows = await this.db.select().from(asksTable).where(eq(asksTable.parentTaskId, taskId));
    return rows.map(toAsk);
  }

  async listByParentSession(sessionId: string): Promise<Ask[]> {
    const rows = await this.db
      .select()
      .from(asksTable)
      .where(eq(asksTable.parentSessionId, sessionId));
    return rows.map(toAsk);
  }

  async listByState(state: AskState): Promise<Ask[]> {
    const rows = await this.db.select().from(asksTable).where(eq(asksTable.state, state));
    return rows.map(toAsk);
  }

  async listByClassifierVersion(version: string): Promise<Ask[]> {
    const rows = await this.db
      .select()
      .from(asksTable)
      .where(eq(asksTable.classifierVersion, version));
    return rows.map(toAsk);
  }

  async findOpenByTaskIds(taskIds: string[]): Promise<Ask[]> {
    if (taskIds.length === 0) return [];
    // Explicit isNotNull on parentTaskId is redundant with `IN (...)` in
    // standard SQL (NULL evaluates to UNKNOWN and is filtered out), but
    // we keep it explicit for parity with FakeAskRepository and for
    // robustness against ORM/dialect surprises.
    const rows = await this.db
      .select()
      .from(asksTable)
      .where(
        and(
          isNotNull(asksTable.parentTaskId),
          inArray(asksTable.parentTaskId, taskIds),
          notInArray(asksTable.state, TERMINAL_ASK_STATES as AskState[])
        )
      )
      .orderBy(desc(asksTable.createdAt));
    return rows.map(toAsk);
  }

  async transition(id: string, to: AskState): Promise<Ask> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    // Throws InvalidAskTransitionError on invalid moves.
    guardTransition(existing.state, to);

    // Build timestamp updates for lifecycle tracking.
    const now = new Date();
    const updates: Partial<AskInsert> = { state: to };

    if (to === "routed") updates.routedAt = now;
    else if (to === "suspended") updates.suspendedAt = now;
    else if (to === "responded") updates.respondedAt = now;
    else if (to === "closed" || to === "cancelled" || to === "expired") updates.closedAt = now;

    const rows = await this.db
      .update(asksTable)
      .set(updates)
      .where(eq(asksTable.id, id))
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error(`Ask update returned no row: ${id}`);
    }
    return toAsk(row);
  }

  async respond(id: string, input: RespondAskInput): Promise<Ask> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    // Throws InvalidAskTransitionError on invalid moves.
    guardTransition(existing.state, "responded");

    const now = new Date();
    const rows = await this.db
      .update(asksTable)
      .set({
        state: "responded",
        response: input.response as AskInsert["response"],
        respondedAt: now,
      })
      .where(eq(asksTable.id, id))
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error(`Ask respond returned no row: ${id}`);
    }
    return toAsk(row);
  }

  async close(id: string, input: CloseAskInput): Promise<Ask> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    // Throws InvalidAskTransitionError on invalid moves.
    guardTransition(existing.state, "closed");

    const now = new Date();
    const rows = await this.db
      .update(asksTable)
      .set({
        state: "closed",
        response: input.response as AskInsert["response"],
        closedAt: now,
        respondedAt: existing.respondedAt ? new Date(existing.respondedAt) : now,
      })
      .where(eq(asksTable.id, id))
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error(`Ask close returned no row: ${id}`);
    }
    return toAsk(row);
  }

  async respondAndClose(
    id: string,
    _respondInput: RespondAskInput,
    closeInput: CloseAskInput
  ): Promise<Ask> {
    // Invariant enforcement: the persistence-level atomic update writes
    // state="closed" directly, but the LOGICAL walk is suspended → responded
    // → closed. We invoke guardTransition twice here so the state-machine
    // table is consulted as the source of truth.
    guardTransition("suspended", "responded");
    guardTransition("responded", "closed");

    // Optimistic concurrency: only update if the row is still in "suspended".
    // If a concurrent actor transitioned the Ask between this call and its
    // execution, the WHERE clause matches zero rows and we surface
    // ConcurrentTransitionError. No stuck-in-responded state is possible.
    const now = new Date();
    const rows = await this.db
      .update(asksTable)
      .set({
        state: "closed",
        response: closeInput.response as AskInsert["response"],
        respondedAt: now,
        closedAt: now,
      })
      .where(and(eq(asksTable.id, id), eq(asksTable.state, "suspended")))
      .returning();

    if (rows.length === 0) {
      // Disambiguate: not-found vs. wrong-state.
      const existing = await this.getById(id);
      if (!existing) {
        throw new Error(`Ask not found: ${id}`);
      }
      throw new ConcurrentTransitionError(id, existing.state);
    }
    const row = rows[0];
    if (!row) {
      throw new Error(`Ask respondAndClose returned no row: ${id}`);
    }
    return toAsk(row);
  }
}

// ---------------------------------------------------------------------------
// FakeAskRepository — hermetic test double
// ---------------------------------------------------------------------------

/**
 * In-memory `AskRepository` for hermetic unit tests.
 *
 * Implements the full `AskRepository` interface using a `Map<string, Ask>`.
 * No I/O of any kind — safe to use in CI and on developer laptops without
 * any database configuration.
 *
 * State-machine enforcement is identical to the production implementation:
 * both call `guardTransition`, so invalid-transition tests are meaningful.
 *
 * @example
 *   const repo = new FakeAskRepository();
 *   const ask = await repo.create({ ... });
 *   await repo.transition(ask.id, "classified");
 */
export class FakeAskRepository implements AskRepository {
  private readonly store = new Map<string, Ask>();
  private idCounter = 0;

  /** Current snapshot of all stored Asks (for test assertions). */
  get all(): Ask[] {
    return Array.from(this.store.values());
  }

  /** Clear all stored Asks (useful in beforeEach). */
  clear(): void {
    this.store.clear();
    this.idCounter = 0;
  }

  async create(input: CreateAskInput): Promise<Ask> {
    const id = `fake-ask-${++this.idCounter}`;
    const now = new Date().toISOString();
    const ask: Ask = {
      id,
      kind: input.kind,
      classifierVersion: input.classifierVersion,
      state: "detected",
      requestor: input.requestor,
      routingTarget: input.routingTarget,
      parentTaskId: input.parentTaskId,
      parentSessionId: input.parentSessionId,
      title: input.title,
      question: input.question,
      options: input.options,
      contextRefs: input.contextRefs,
      response: undefined,
      deadline: input.deadline,
      createdAt: now,
      // Service-window fields (mt#1411 spine — mt#1488)
      serviceStrategy: input.serviceStrategy,
      windowKey: input.windowKey,
      windowMissedCount: input.windowMissedCount ?? 0,
      forceImmediate: input.forceImmediate ?? false,
      metadata: input.metadata ?? {},
    };
    this.store.set(id, ask);
    return { ...ask };
  }

  async getById(id: string): Promise<Ask | null> {
    const ask = this.store.get(id);
    return ask ? { ...ask } : null;
  }

  async listByParentTask(taskId: string): Promise<Ask[]> {
    return this.all.filter((a) => a.parentTaskId === taskId).map((a) => ({ ...a }));
  }

  async listByParentSession(sessionId: string): Promise<Ask[]> {
    return this.all.filter((a) => a.parentSessionId === sessionId).map((a) => ({ ...a }));
  }

  async listByState(state: AskState): Promise<Ask[]> {
    return this.all.filter((a) => a.state === state).map((a) => ({ ...a }));
  }

  async listByClassifierVersion(version: string): Promise<Ask[]> {
    return this.all.filter((a) => a.classifierVersion === version).map((a) => ({ ...a }));
  }

  async findOpenByTaskIds(taskIds: string[]): Promise<Ask[]> {
    if (taskIds.length === 0) return [];
    const taskIdSet = new Set(taskIds);
    return this.all
      .filter(
        (a) => a.parentTaskId !== undefined && taskIdSet.has(a.parentTaskId) && !isTerminal(a.state)
      )
      .sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0))
      .map((a) => ({ ...a }));
  }

  async transition(id: string, to: AskState): Promise<Ask> {
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    // Enforce the state machine — same guard as Drizzle implementation.
    guardTransition(existing.state, to);

    const now = new Date().toISOString();
    const updated: Ask = { ...existing, state: to };

    if (to === "routed") updated.routedAt = now;
    else if (to === "suspended") updated.suspendedAt = now;
    else if (to === "responded") updated.respondedAt = now;
    else if (to === "closed" || to === "cancelled" || to === "expired") updated.closedAt = now;

    this.store.set(id, updated);
    return { ...updated };
  }

  async respond(id: string, input: RespondAskInput): Promise<Ask> {
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    // Same guard as production.
    guardTransition(existing.state, "responded");

    const now = new Date().toISOString();
    const updated: Ask = {
      ...existing,
      state: "responded",
      response: input.response,
      respondedAt: now,
    };

    this.store.set(id, updated);
    return { ...updated };
  }

  async close(id: string, input: CloseAskInput): Promise<Ask> {
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }

    // Same guard as production.
    guardTransition(existing.state, "closed");

    const now = new Date().toISOString();
    const updated: Ask = {
      ...existing,
      state: "closed",
      response: input.response,
      closedAt: now,
      respondedAt: existing.respondedAt ?? now,
    };

    this.store.set(id, updated);
    return { ...updated };
  }

  async respondAndClose(
    id: string,
    _respondInput: RespondAskInput,
    closeInput: CloseAskInput
  ): Promise<Ask> {
    // Mirror the Drizzle backend's invariant enforcement: consult
    // guardTransition for both legs of the logical walk.
    guardTransition("suspended", "responded");
    guardTransition("responded", "closed");

    // Single-threaded fake — atomic by virtue of synchronous in-memory ops.
    // Mirrors the Drizzle backend's optimistic-concurrency check: refuses if
    // state is not "suspended" at the moment of the call.
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Ask not found: ${id}`);
    }
    if (existing.state !== "suspended") {
      throw new ConcurrentTransitionError(id, existing.state);
    }

    const now = new Date().toISOString();
    const updated: Ask = {
      ...existing,
      state: "closed",
      response: closeInput.response,
      respondedAt: now,
      closedAt: now,
    };

    this.store.set(id, updated);
    return { ...updated };
  }

  /**
   * Test seam only — NOT on AskRepository interface or DrizzleAskRepository.
   *
   * Directly inserts an Ask at an arbitrary state, bypassing lifecycle guards.
   * Use only in tests that need to set up preconditions for invalid-transition
   * assertions where walking through valid transitions would be tedious.
   */
  _seedAtState(ask: Ask): void {
    this.store.set(ask.id, { ...ask });
  }
}
