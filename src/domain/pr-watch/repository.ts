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
import { eq, isNull, or } from "drizzle-orm";
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

    const now = new Date();
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

  async delete(id: string): Promise<void> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new Error(`PrWatch not found: ${id}`);
    }

    await this.db.delete(prWatchesTable).where(eq(prWatchesTable.id, id));
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
