/**
 * StrikeTracker — 2-strikes mechanization (ADR-008 §Detection, mt#1464).
 *
 * Records per-(taskId, toolName, errorSignature) strike counts.
 * On the 2nd identical error signature for the same (taskId, toolName) pair,
 * the caller receives the prior attempts so it can emit a `stuck.unblock` Ask.
 *
 * Storage: in-process Map with insertion-order LRU eviction, capacity 256.
 * No TTL — eviction is usage-driven, not wall-clock-bound.
 * No persistence — strikes are intra-process only; agent restart clears state.
 */

/** Key uniquely identifying a (taskId, toolName, errorSignature) triple. */
export interface StrikeKey {
  taskId: string;
  toolName: string;
  errorSignature: string;
}

/** Per-strike record stored in the Map. */
export interface StrikeRecord {
  /** Serialised error payloads in insertion order (one per strike). */
  attempts: unknown[];
}

/** Return value of `recordError`. */
export interface RecordErrorResult {
  /** Total strike count (including this call). */
  count: number;
  /** All recorded error payloads for this key (including this call). */
  attempts: unknown[];
}

/**
 * Domain interface for the 2-strikes counter.
 *
 * Consumers depend on the interface so a future durable implementation
 * can be swapped in without touching call sites.
 */
export interface StrikeTracker {
  /**
   * Record one error against `(taskId, toolName, errorSignature)`.
   *
   * @returns `{ count, attempts }` — count is the running total for this key,
   *   attempts contains every error payload recorded so far (including this one).
   */
  recordError(key: StrikeKey, errorPayload: unknown): RecordErrorResult;

  /**
   * A successful call on `(taskId, toolName)` clears all strike signatures
   * recorded for that pair.  The next error on the same pair starts fresh.
   */
  recordSuccess(taskId: string, toolName: string): void;
}

// ---------------------------------------------------------------------------
// Error-signature normalization
// ---------------------------------------------------------------------------

/**
 * Derive a stable, human-readable error signature from an error value.
 *
 * Priority:
 *   1. `error.code` (string or number) — MCP errors carry numeric codes (e.g. -32000, -32600).
 *   2. First 200 chars of `error.message`.
 *   3. First 200 chars of `String(error)`.
 */
export function normalizeErrorSignature(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    const code = obj["code"];
    if (code != null && (typeof code === "string" || typeof code === "number")) {
      const codeStr = String(code);
      if (codeStr.length > 0) {
        return codeStr;
      }
    }
    if (typeof obj["message"] === "string") {
      return obj["message"].slice(0, 200);
    }
  }
  return String(error).slice(0, 200);
}

// ---------------------------------------------------------------------------
// MapLruStrikeTracker — in-process LRU-backed implementation
// ---------------------------------------------------------------------------

/** Composite key string used as Map key. */
function toMapKey(key: StrikeKey): string {
  return `${key.taskId}\0${key.toolName}\0${key.errorSignature}`;
}

/** Prefix key for a (taskId, toolName) pair (used for success-clear sweep). */
function toPairPrefix(taskId: string, toolName: string): string {
  return `${taskId}\0${toolName}\0`;
}

/**
 * In-process `StrikeTracker` backed by a `Map` with insertion-order LRU eviction.
 *
 * Capacity is capped at 256 entries.  When a new key is inserted that would
 * exceed capacity, the oldest entry (first in insertion order) is evicted.
 * No TTL — eviction is purely usage-driven.
 */
export class MapLruStrikeTracker implements StrikeTracker {
  private readonly capacity: number;
  /** Map preserves insertion order, enabling O(1) LRU eviction. */
  private readonly store = new Map<string, StrikeRecord>();

  constructor(capacity = 256) {
    if (capacity < 1) {
      throw new Error("StrikeTracker capacity must be >= 1");
    }
    this.capacity = capacity;
  }

  recordError(key: StrikeKey, errorPayload: unknown): RecordErrorResult {
    const mapKey = toMapKey(key);
    const existing = this.store.get(mapKey);

    if (existing) {
      // Refresh LRU position: delete then re-insert.
      this.store.delete(mapKey);
      existing.attempts.push(errorPayload);
      this.store.set(mapKey, existing);
      return { count: existing.attempts.length, attempts: [...existing.attempts] };
    }

    // New key — evict oldest if at capacity.
    if (this.store.size >= this.capacity) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }

    const record: StrikeRecord = { attempts: [errorPayload] };
    this.store.set(mapKey, record);
    return { count: 1, attempts: [errorPayload] };
  }

  recordSuccess(taskId: string, toolName: string): void {
    const prefix = toPairPrefix(taskId, toolName);
    const keysToDelete: string[] = [];
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.store.delete(key);
    }
  }
}
