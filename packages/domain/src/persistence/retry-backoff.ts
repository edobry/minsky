/**
 * Shared retry/backoff bookkeeping for a usage-gated re-initialization
 * attempt (ADR-035 rule 1: "a failed initializer must not be memoized as a
 * value").
 *
 * Values intentionally MIRROR the composition-layer precedent shipped by
 * mt#3635 (`packages/domain/src/composition/container.ts`'s
 * `RETRY_MIN_INTERVAL_MS` / `RETRY_MAX_INTERVAL_MS`) rather than inventing a
 * second convention (mt#3751 Planning Audit, "Implementation direction").
 * This module lives in `persistence/` (a layer `composition/` depends ON,
 * not the reverse), so `container.ts` cannot import FROM here without
 * inverting that dependency — the values are kept numerically identical by
 * convention instead, and this comment is the cross-check a future reader
 * (or a diff) should verify against.
 *
 * Adds one extension beyond the mt#3635 shape: JITTER. `container.ts`'s
 * per-key backoff is pure exponential doubling with no jitter, which is fine
 * for a single in-process key. This module backs consumers exercised by the
 * SAME 70+-process fleet (mt#2430) — `PersistenceService.getProviderWithRetry`
 * and its callers — each independently computing "now + delay" off the same
 * wall clock; pure doubling would put every process's Nth retry at the same
 * instant, recreating the thundering herd the backoff exists to prevent
 * (mt#3751 Success Criterion 3). Jitter spreads that out. The spread matches
 * this package's existing convention in `postgres-retry.ts`
 * (`JITTER_FLOOR`/`JITTER_SPREAD`, ±20%) rather than inventing a third one.
 */

/** Floor between re-initialization attempts — see container.ts's precedent. */
export const RETRY_MIN_INTERVAL_MS = 10_000;

/** Ceiling for the exponential backoff — see container.ts's precedent. */
export const RETRY_MAX_INTERVAL_MS = 5 * 60_000;

const JITTER_FLOOR = 0.8;
const JITTER_SPREAD = 0.4;

export interface RetryBackoffState {
  /** Monotonic ms of the last attempt, or null when none has run yet. */
  lastAttemptAtMs: number | null;
  /** Delay that must elapse before the next attempt. */
  delayMs: number;
}

/** A fresh backoff state: no attempt yet, delay at the floor. */
export function initialRetryBackoffState(): RetryBackoffState {
  return { lastAttemptAtMs: null, delayMs: RETRY_MIN_INTERVAL_MS };
}

/** Is a new attempt allowed right now, given the current backoff state? */
export function canAttempt(state: RetryBackoffState, nowMs: number = Date.now()): boolean {
  return state.lastAttemptAtMs === null || nowMs - state.lastAttemptAtMs >= state.delayMs;
}

/**
 * Record that an attempt is starting NOW. Call before the attempt (mirrors
 * container.ts's claim-before-await ordering) so a slow attempt cannot let a
 * second caller slip through the gate while the first is still in flight.
 */
export function recordAttemptStart(state: RetryBackoffState, nowMs: number = Date.now()): void {
  state.lastAttemptAtMs = nowMs;
}

/** Double the delay, capped at {@link RETRY_MAX_INTERVAL_MS}. Call after a FAILED attempt. */
export function widenBackoff(state: RetryBackoffState): void {
  state.delayMs = Math.min(state.delayMs * 2, RETRY_MAX_INTERVAL_MS);
}

/** Reset to the floor and clear the attempt timestamp. Call after a SUCCESSFUL attempt. */
export function resetBackoff(state: RetryBackoffState): void {
  state.delayMs = RETRY_MIN_INTERVAL_MS;
  state.lastAttemptAtMs = null;
}

/**
 * Apply ±20% jitter to a delay (mt#3751 extension over the mt#3635 shape).
 * `rand` is injectable so tests can make the jitter deterministic.
 */
export function applyJitter(delayMs: number, rand: () => number = Math.random): number {
  const multiplier = JITTER_FLOOR + rand() * JITTER_SPREAD;
  return Math.round(delayMs * multiplier);
}
