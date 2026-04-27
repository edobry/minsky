/**
 * PostgreSQL pool-exhaustion retry helper (mt#1193)
 *
 * Supavisor's session-mode pooler rejects new connections with SQLSTATE
 * 53300 ("too_many_connections") or a "max clients reached" message once
 * pool_size is reached. Under multi-consumer setups (e.g., laptop MCP +
 * Railway MCP) these rejections happen during deploys and transient
 * overlap. Instead of cascade-failing every tool call, we retry with
 * exponential backoff so transient saturation is absorbed.
 */

import { log } from "../../utils/logger";

export interface PgPoolRetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Deterministic jitter override for tests. In production, jitter is
   * sampled from Math.random(); tests can pass a fixed value in [0, 1)
   * to make backoff timing reproducible.
   */
  jitter?: () => number;
}

// Attempt-vs-wait relationship (mt#1277): `maxAttempts` counts total
// invocations of `fn`, not the number of retry waits. With the defaults
// below — maxAttempts=3, initialDelay=150ms, factor=2 — the sequence is:
//   attempt 1: call fn → fail → wait ~150ms
//   attempt 2: call fn → fail → wait ~300ms
//   attempt 3: call fn → fail → throw (no further wait)
// i.e. 3 attempts = 1 initial call + 2 retry waits, totaling ~450ms before
// surfacing the error. This is intentional: the retry exists to absorb
// transient pool overlap (e.g. Railway redeploys), not to wait through a
// full deploy cycle. See `docs/persistence-configuration.md` for the
// operator-facing schedule.
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 150;
const DEFAULT_MAX_DELAY_MS = 2000;
// ±20% jitter multiplier range: [0.8, 1.2). Spreads synchronized retries
// across concurrent callers so they don't all reattempt in lock-step
// against the same saturated pool ("thundering herd").
const JITTER_SPREAD = 0.4;
const JITTER_FLOOR = 0.8;

export function isPgPoolExhaustionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  // postgres-js sets `query` on errors that came back from the server after
  // the query was transmitted. Pool saturation manifests during connection
  // acquisition (before any query reaches the server) and must have no
  // `query` field. Skipping errors where `query` is present guarantees
  // retries are safe on mutating callers (no at-least-once effects).
  // Use presence check (`in`) rather than truthiness so an empty-string
  // marker from a wrapper doesn't slip through.
  if ("query" in e) return false;
  const code = typeof e.code === "string" ? e.code : undefined;
  const message = typeof e.message === "string" ? e.message : String(e);
  return (
    code === "53300" ||
    (code === "XX000" && /max clients reached/i.test(message)) ||
    /max clients reached/i.test(message) ||
    /too_many_connections/i.test(message) ||
    /sorry, too many clients already/i.test(message)
  );
}

export async function withPgPoolRetry<T>(
  fn: () => Promise<T>,
  label: string,
  opts: PgPoolRetryOptions = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitter = opts.jitter ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isPgPoolExhaustionError(err) || attempt === maxAttempts) {
        throw err;
      }
      lastErr = err;
      const base = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const multiplier = JITTER_FLOOR + jitter() * JITTER_SPREAD;
      const delay = Math.round(base * multiplier);
      const e = err as { code?: unknown; message?: unknown };
      const errCode = typeof e.code === "string" ? e.code : "?";
      const rawMessage = typeof e.message === "string" ? e.message : String(err);
      const errSummary = rawMessage.length > 120 ? `${rawMessage.slice(0, 117)}...` : rawMessage;
      log.warn(
        `[retry ${attempt}/${maxAttempts}] ${label}: pg pool saturation (code=${errCode}): ${errSummary} — retrying in ${delay}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // Unreachable: loop either returns or throws on the final attempt.
  throw lastErr;
}
