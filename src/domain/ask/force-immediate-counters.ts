/**
 * forceImmediate anti-pattern counters — mt#1490.
 *
 * Tracks per-requestor `forceImmediate` usage. v1 records only; the mt#1035
 * noticer (out of scope for mt#1490) will consume these counters to alert
 * when a requestor abuses the bypass flag.
 *
 * Design notes:
 * - v1 is intentionally in-memory: the counters are observational; losing
 *   them on restart is acceptable at this stage.
 * - The interface is injectable so tests can verify recording without
 *   depending on module-level singleton state.
 * - A future persistence-backed implementation can swap in without changes
 *   to the Reaper or Router that call `recordForceImmediate`.
 */

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Counter record for a single requestor's forceImmediate usage.
 */
export interface ForceImmediateRecord {
  /** The requestor AgentId string. */
  requestor: string;
  /** Total number of forceImmediate=true Asks recorded for this requestor. */
  count: number;
  /** ISO-8601 timestamp of the most recent forceImmediate Ask. */
  lastSeenAt: string;
}

/**
 * Interface for the forceImmediate counter store.
 *
 * Injected into the Router/Reaper so tests can verify recording behavior
 * without side-effecting the singleton store.
 */
export interface ForceImmediateCounterStore {
  /**
   * Record a forceImmediate=true usage for the given requestor.
   *
   * Increments the per-requestor count. Creates a new record if the
   * requestor has never been seen before.
   *
   * @param requestor  AgentId of the requestor.
   * @param nowIso     ISO-8601 timestamp (injectable for tests).
   */
  record(requestor: string, nowIso?: string): void;

  /**
   * Return the current record for the given requestor, or null if never seen.
   */
  getRecord(requestor: string): ForceImmediateRecord | null;

  /**
   * Return all recorded requestors with their counts.
   * Useful for the mt#1035 noticer sweep.
   */
  listAll(): ForceImmediateRecord[];
}

// ---------------------------------------------------------------------------
// In-memory implementation (v1)
// ---------------------------------------------------------------------------

/**
 * In-memory `ForceImmediateCounterStore`.
 *
 * Not persistent: counters reset on process restart. v1 semantics per spec.
 * Thread-safe by virtue of single-threaded Node/Bun event loop.
 */
export class InMemoryForceImmediateCounterStore implements ForceImmediateCounterStore {
  private readonly records = new Map<string, ForceImmediateRecord>();

  record(requestor: string, nowIso: string = new Date().toISOString()): void {
    const existing = this.records.get(requestor);
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = nowIso;
    } else {
      this.records.set(requestor, {
        requestor,
        count: 1,
        lastSeenAt: nowIso,
      });
    }
  }

  getRecord(requestor: string): ForceImmediateRecord | null {
    return this.records.get(requestor) ?? null;
  }

  listAll(): ForceImmediateRecord[] {
    return Array.from(this.records.values()).map((r) => ({ ...r }));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh in-memory counter store.
 *
 * Use this factory in composition code (DI container wiring) to obtain
 * the process-lifetime store instance. Tests should call this per-test
 * to avoid shared state.
 *
 * NOTE: No singleton export — per the `custom/no-domain-singleton` rule,
 * singletons must be wired at composition time via the DI container, not
 * exported from domain modules. Inject `ForceImmediateCounterStore` via
 * tsyringe wherever the store is needed.
 */
export function createForceImmediateCounterStore(): ForceImmediateCounterStore {
  return new InMemoryForceImmediateCounterStore();
}
