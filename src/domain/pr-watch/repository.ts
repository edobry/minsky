/**
 * PrWatch repository — interface + Drizzle/Postgres implementation + test fake.
 *
 * The `PrWatchRepository` interface is the domain contract; all consumers
 * depend on the interface only. `DrizzlePrWatchRepository` is the Postgres
 * implementation wired at composition time via tsyringe.
 *
 * Operations:
 *   create          — insert a new PrWatch row
 *   getById         — fetch by primary key
 *   listActive      — watches not yet consumed (triggered_at IS NULL, or keep=true)
 *   markTriggered   — set triggered_at to now on a given watch
 *   delete          — hard-delete a watch by ID
 *
 * Reference: mt#1294 spec; pattern from src/domain/ask/repository.ts (mt#1237).
 */

import { injectable } from "tsyringe";
import { and, eq, isNull, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { prWatchesTable } from "../storage/schemas/pr-watch-schema";
import type { PrWatchRecord, PrWatchInsert } from "../storage/schemas/pr-watch-schema";
import type { PrWatch, PrWatchEvent } from "./types";

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

/**
 * Map a raw Drizzle row (`PrWatchRecord`) to the typed domain `PrWatch` object.
 *
 * Timestamps stored as `Date | null` in Drizzle are converted to ISO-8601
 * strings (or `undefined`) to match the `PrWatch` interface.
 */
function toPrWatch(row: PrWatchRecord): PrWatch {
  return {
    id: row.id,
    prOwner: row.prOwner,
    prRepo: row.prRepo,
    prNumber: row.prNumber,
    event: row.event as PrWatchEvent,
    keep: row.keep,
    watcherId: row.watcherId,
    lastSeen: (row.lastSeen as Record<string, unknown>) ?? undefined,
    createdAt: row.createdAt.toISOString(),
    triggeredAt: row.triggeredAt ? row.triggeredAt.toISOString() : undefined,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * Map a `CreatePrWatchInput` to a Drizzle `PrWatchInsert` row.
 *
 * `id` and `createdAt` are omitted — the DB defaults handle them.
 */
function toInsert(input: CreatePrWatchInput): PrWatchInsert {
  return {
    prOwner: input.prOwner,
    prRepo: input.prRepo,
    prNumber: input.prNumber,
    event: input.event,
    keep: input.keep,
    watcherId: input.watcherId,
    lastSeen: input.lastSeen ?? null,
    metadata: input.metadata ?? {},
  };
}

// ---------------------------------------------------------------------------
// Input / option types
// ---------------------------------------------------------------------------

/** Input for creating a new PrWatch. `id` and `createdAt` are auto-assigned. */
export interface CreatePrWatchInput {
  prOwner: string;
  prRepo: string;
  prNumber: number;
  event: PrWatchEvent;
  keep: boolean;
  watcherId: string;
  lastSeen?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PrWatchRepository interface
// ---------------------------------------------------------------------------

/**
 * Domain contract for PrWatch persistence.
 *
 * All business logic that touches PrWatches must depend on this interface,
 * not on the concrete Drizzle implementation, so tests can inject a fake.
 */
export interface PrWatchRepository {
  /** Insert a new PrWatch row and return the persisted entity. */
  create(input: CreatePrWatchInput): Promise<PrWatch>;

  /** Fetch a PrWatch by primary key. Returns `null` if not found. */
  getById(id: string): Promise<PrWatch | null>;

  /**
   * List watches that are still active (should be processed by the reconciler).
   *
   * A watch is active if:
   *   - `triggered_at` IS NULL (never fired), OR
   *   - `keep = true` (persistent watch, re-fires on every matching event)
   */
  listActive(): Promise<PrWatch[]>;

  /**
   * Record the current timestamp as `triggered_at` on the given watch.
   *
   * For one-shot watches (keep=false) this effectively marks them consumed.
   * For persistent watches (keep=true) this records the last fire time.
   *
   * @param id  Primary key of the PrWatch to update.
   * @returns   The updated PrWatch.
   * @throws    `Error` — PrWatch not found.
   */
  markTriggered(id: string): Promise<PrWatch>;

  /**
   * Hard-delete a PrWatch by ID.
   *
   * @param id  Primary key of the PrWatch to delete.
   * @throws    `Error` — PrWatch not found.
   */
  delete(id: string): Promise<void>;

  /**
   * Update the `lastSeen` cursor on a PrWatch.
   *
   * Used by the reconciler to record the last-observed event id/conclusion
   * after a match, so persistent watches (keep=true) do not re-fire on the
   * same event in subsequent passes.
   *
   * @param id        Primary key of the PrWatch to update.
   * @param lastSeen  Event-specific cursor payload (replaces existing).
   * @returns         The updated PrWatch.
   * @throws          `Error` — PrWatch not found.
   */
  updateLastSeen(id: string, lastSeen: Record<string, unknown>): Promise<PrWatch>;
}

// ---------------------------------------------------------------------------
// DrizzlePrWatchRepository — Postgres implementation
// ---------------------------------------------------------------------------

/**
 * Postgres implementation of `PrWatchRepository` using the Drizzle ORM.
 *
 * Injected via tsyringe at composition time with a `PostgresJsDatabase`
 * instance. All queries use the typed `prWatchesTable` schema — no raw SQL.
 */
@injectable()
export class DrizzlePrWatchRepository implements PrWatchRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async create(input: CreatePrWatchInput): Promise<PrWatch> {
    const rows = await this.db.insert(prWatchesTable).values(toInsert(input)).returning();
    const row = rows[0];
    if (!row) {
      throw new Error("PrWatch insert returned no row");
    }
    return toPrWatch(row);
  }

  async getById(id: string): Promise<PrWatch | null> {
    const rows = await this.db
      .select()
      .from(prWatchesTable)
      .where(eq(prWatchesTable.id, id))
      .limit(1);
    const row = rows[0];
    return row ? toPrWatch(row) : null;
  }

  async listActive(): Promise<PrWatch[]> {
    const rows = await this.db
      .select()
      .from(prWatchesTable)
      .where(or(isNull(prWatchesTable.triggeredAt), eq(prWatchesTable.keep, true)));
    return rows.map(toPrWatch);
  }

  async markTriggered(id: string): Promise<PrWatch> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`PrWatch not found: ${id}`);
    }

    // Idempotency: one-shot watches that are already triggered are no-ops.
    // Returning the existing record matches the contract: "ensure this watch
    // has been marked triggered". Concurrent callers either both observe the
    // same triggeredAt timestamp or compete via the conditional UPDATE below.
    if (!existing.keep && existing.triggeredAt) {
      return existing;
    }

    const now = new Date();

    if (existing.keep) {
      // Persistent watch: always update triggered_at (records last-fire time).
      const rows = await this.db
        .update(prWatchesTable)
        .set({ triggeredAt: now })
        .where(eq(prWatchesTable.id, id))
        .returning();

      const row = rows[0];
      if (!row) {
        throw new Error(`PrWatch update returned no row: ${id}`);
      }
      return toPrWatch(row);
    }

    // One-shot watch: conditional UPDATE — only succeeds if triggered_at is
    // still NULL. If a concurrent worker already set it, this returns 0 rows
    // and we re-fetch to return the winner's state idempotently.
    const rows = await this.db
      .update(prWatchesTable)
      .set({ triggeredAt: now })
      .where(and(eq(prWatchesTable.id, id), isNull(prWatchesTable.triggeredAt)))
      .returning();

    const row = rows[0];
    if (row) {
      return toPrWatch(row);
    }

    // Race-loss: another worker triggered first. Re-fetch and return their state.
    const refetched = await this.getById(id);
    if (!refetched) {
      throw new Error(`PrWatch disappeared between guard and re-fetch: ${id}`);
    }
    return refetched;
  }

  async delete(id: string): Promise<void> {
    // Single-statement conditional delete; if zero rows were affected the
    // record did not exist (or was already deleted by a concurrent worker).
    // This honors the contract — throws "PrWatch not found" — without a
    // check-then-delete race window.
    const rows = await this.db
      .delete(prWatchesTable)
      .where(eq(prWatchesTable.id, id))
      .returning({ id: prWatchesTable.id });

    if (rows.length === 0) {
      throw new Error(`PrWatch not found: ${id}`);
    }
  }

  async updateLastSeen(id: string, lastSeen: Record<string, unknown>): Promise<PrWatch> {
    const rows = await this.db
      .update(prWatchesTable)
      .set({ lastSeen })
      .where(eq(prWatchesTable.id, id))
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error(`PrWatch not found: ${id}`);
    }
    return toPrWatch(row);
  }
}

// ---------------------------------------------------------------------------
// FakePrWatchRepository — hermetic test double
// ---------------------------------------------------------------------------

/**
 * In-memory `PrWatchRepository` for hermetic unit tests.
 *
 * Implements the full `PrWatchRepository` interface using a `Map<string, PrWatch>`.
 * No I/O of any kind — safe to use in CI and on developer laptops without
 * any database configuration.
 *
 * @example
 *   const repo = new FakePrWatchRepository();
 *   const watch = await repo.create({ ... });
 *   await repo.markTriggered(watch.id);
 */
export class FakePrWatchRepository implements PrWatchRepository {
  private readonly store = new Map<string, PrWatch>();
  private idCounter = 0;

  /** Current snapshot of all stored PrWatches (for test assertions). */
  get all(): PrWatch[] {
    return Array.from(this.store.values());
  }

  /** Clear all stored PrWatches (useful in beforeEach). */
  clear(): void {
    this.store.clear();
    this.idCounter = 0;
  }

  /** Return a deep copy of a PrWatch to prevent aliasing between callers and the store. */
  private clone(watch: PrWatch): PrWatch {
    return {
      ...watch,
      lastSeen: watch.lastSeen ? { ...watch.lastSeen } : undefined,
      metadata: { ...watch.metadata },
    };
  }

  async create(input: CreatePrWatchInput): Promise<PrWatch> {
    const id = `fake-pr-watch-${++this.idCounter}`;
    const now = new Date().toISOString();
    const watch: PrWatch = {
      id,
      prOwner: input.prOwner,
      prRepo: input.prRepo,
      prNumber: input.prNumber,
      event: input.event,
      keep: input.keep,
      watcherId: input.watcherId,
      lastSeen: input.lastSeen ? { ...input.lastSeen } : undefined,
      createdAt: now,
      triggeredAt: undefined,
      metadata: { ...(input.metadata ?? {}) },
    };
    this.store.set(id, this.clone(watch));
    return this.clone(watch);
  }

  async getById(id: string): Promise<PrWatch | null> {
    const watch = this.store.get(id);
    return watch ? this.clone(watch) : null;
  }

  async listActive(): Promise<PrWatch[]> {
    return this.all
      .filter((w) => w.triggeredAt === undefined || w.keep === true)
      .map((w) => this.clone(w));
  }

  async markTriggered(id: string): Promise<PrWatch> {
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`PrWatch not found: ${id}`);
    }

    // Mirror Drizzle idempotency: one-shot watches already triggered are no-ops.
    if (!existing.keep && existing.triggeredAt) {
      return this.clone(existing);
    }

    const now = new Date().toISOString();
    const updated: PrWatch = { ...existing, triggeredAt: now };
    this.store.set(id, this.clone(updated));
    return this.clone(updated);
  }

  async delete(id: string): Promise<void> {
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`PrWatch not found: ${id}`);
    }
    this.store.delete(id);
  }

  async updateLastSeen(id: string, lastSeen: Record<string, unknown>): Promise<PrWatch> {
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`PrWatch not found: ${id}`);
    }
    const updated: PrWatch = { ...existing, lastSeen: { ...lastSeen } };
    this.store.set(id, this.clone(updated));
    return this.clone(updated);
  }

  /**
   * Test seam only — NOT on PrWatchRepository interface or DrizzlePrWatchRepository.
   *
   * Directly inserts a PrWatch at an arbitrary state, bypassing lifecycle guards.
   * Use only in tests that need to set up preconditions without going through
   * the normal create flow.
   */
  _seed(watch: PrWatch): void {
    this.store.set(watch.id, { ...watch });
  }
}
