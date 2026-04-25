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
 *
 * Reference: ADR-006 §The Ask entity; mt#1237 spec.
 */

import { injectable } from "tsyringe";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { asksTable } from "../storage/schemas/ask-schema";
import type { AskRecord, AskInsert } from "../storage/schemas/ask-schema";
import type { Ask, AskState, AskKind } from "./types";
import { guardTransition } from "./state-machine";

// ---------------------------------------------------------------------------
// Row ↔ domain mapping
// ---------------------------------------------------------------------------

/**
 * Map a raw Drizzle row (`AskRecord`) to the typed domain `Ask` object.
 *
 * Timestamps stored as `Date | null` in Drizzle are converted to ISO-8601
 * strings (or `undefined`) to match the `Ask` interface.
 */
function toAsk(row: AskRecord): Ask {
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
    state: input.state ?? "detected",
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
    metadata: input.metadata ?? {},
  };
}

// ---------------------------------------------------------------------------
// Input / option types
// ---------------------------------------------------------------------------

/** Input for creating a new Ask. `id` and `createdAt` are auto-assigned. */
export interface CreateAskInput {
  kind: AskKind;
  classifierVersion: string;
  /** Defaults to "detected" when omitted. */
  state?: AskState;
  requestor: string;
  routingTarget?: string;
  parentTaskId?: string;
  parentSessionId?: string;
  title: string;
  question: string;
  options?: Ask["options"];
  contextRefs?: Ask["contextRefs"];
  deadline?: string;
  metadata?: Record<string, unknown>;
}

/** Input for closing an Ask (state → "closed"). */
export interface CloseAskInput {
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
   * Close an Ask (convenience wrapper around `transition`).
   *
   * Transitions state to "closed" and writes the response payload in a single
   * operation. Throws on invalid transitions (same as `transition`).
   */
  close(id: string, input: CloseAskInput): Promise<Ask>;
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
        respondedAt: existing.respondedAt ? undefined : now,
      })
      .where(eq(asksTable.id, id))
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error(`Ask close returned no row: ${id}`);
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
      state: input.state ?? "detected",
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
}
