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

import { log } from "@minsky/shared/logger";
import { safeTruncate } from "../../../../src/utils/safe-truncate.ts";

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

// Shared pre-send guard for retryable connection-class predicates.
// postgres-js attaches `query` as an own-property to ALL `PostgresError`
// instances. For pre-send errors (connection acquisition failures, including
// pool saturation and stale-connection closures), `query` is exactly
// `undefined`; for post-send errors, it holds the SQL string that reached the
// server. Only pre-send errors are safe to retry — retrying a mutation whose
// query already executed would double-apply.
//
// Errors with NO `query` own-property at all (e.g. plain Error from undici,
// PgBouncer's wire-protocol-rejection errors that bypass postgres-js' error
// wrapping) fall through to the predicate's code/message match — they could
// not have transmitted a query through postgres-js.
//
// mt#1193 originally used `"query" in e` (presence + prototype-chain check),
// which returns `true` even when `e.query === undefined`. That made the
// exhaustion predicate reject every real `PostgresError`, and
// `withPgPoolRetry` was a silent no-op for the production path from
// 2026-04-25 to 2026-04-28. mt#1461 corrected this to a CONSERVATIVE
// own-property check: only `query === undefined` (own-property) counts as
// pre-send. Any other own-property value of `query` — including `null`,
// `""`, or a SQL string — is treated as ambiguous and rejected. A wrapper
// that redacts post-send SQL to `null` would otherwise create a double-apply
// hazard for mutating callers; rejecting it is the safe default.
//
// Why hasOwnProperty instead of `in`: prototype-chain inheritance. If any
// wrapper or accidental global mutation defines `query` on `Error.prototype`,
// `"query" in e` would be true for unrelated errors and they'd be silently
// rejected. Own-property check guarantees we only inspect what postgres-js
// actually attached. (Reviewer-bot raised this on PR #893.)
function hasNonRetryableQueryShape(e: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(e, "query") && e.query !== undefined;
}

export function isPgPoolExhaustionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (hasNonRetryableQueryShape(e)) return false;
  const code = typeof e.code === "string" ? e.code : undefined;
  const message = typeof e.message === "string" ? e.message : String(e);
  return (
    code === "53300" ||
    /max clients reached/i.test(message) ||
    /too_many_connections/i.test(message) ||
    /sorry, too many clients already/i.test(message)
  );
}

// Strong code-based signals for the stale-connection class. Any of these as
// `code` is sufficient evidence that the error fired during connection
// acquisition or first use of a dead pooled client — postgres-js / undici
// only emit these codes on the transport layer before the query reaches the
// server, so retrying is safe regardless of whether `query` is set.
const PG_RETRYABLE_CONNECTION_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "ECONNRESET",
  "EPIPE",
]);

/**
 * mt#1831: matches transient connection-closed shapes — the in-process pool
 * had a dead postgres-js client whose socket was torn down by the OS / DB
 * while idle. First use of that client surfaces as `ECONNRESET`,
 * `CONNECTION_CLOSED`, `CONNECTION_ENDED`, or "Connection terminated".
 *
 * Unlike pool exhaustion (server is overloaded), stale-connection failures
 * resolve immediately on retry because postgres-js discards the dead client
 * and acquires a fresh one. The pre-send guard (`query === undefined` own-
 * property) applies — retrying a post-send error would double-apply
 * mutations, which is rejected by design.
 *
 * mt#1831 PR #1113 R1 BLOCKING (reviewer-bot, 2026-05-13): strict two-tier
 * matching to preserve the pre-send safety contract:
 *
 * 1. **Strong path (code match).** Any of `PG_RETRYABLE_CONNECTION_CODES`
 *    as `code` is sufficient on its own — these codes are only emitted at
 *    the transport layer before the query reaches the server, so retrying
 *    is safe regardless of whether `query` is an own-property.
 *
 * 2. **Weak path (message-only match).** Message regexes alone (e.g.,
 *    "connection terminated", "socket hang up") are NOT sufficient — a
 *    wrapper that rethrows after a post-send transport failure could drop
 *    properties entirely, leaving us with just a message. We require
 *    positive evidence that the error is pre-send: `query` is an own-
 *    property with value `undefined` (the concrete postgres-js
 *    connection-acquisition shape from mt#1461). Wrappers that drop
 *    `query` entirely are ambiguous and rejected as non-retryable.
 */
export function isPgStaleConnectionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (hasNonRetryableQueryShape(e)) return false;

  const code = typeof e.code === "string" ? e.code : undefined;
  const message = typeof e.message === "string" ? e.message : String(e);

  // Strong path: code-only match is safe regardless of `query` shape.
  if (code !== undefined && PG_RETRYABLE_CONNECTION_CODES.has(code)) return true;

  // Weak path: message-only matches require positive pre-send evidence.
  // postgres-js attaches `query: undefined` as an own-property on
  // connection-acquisition failures; that's the only shape that proves the
  // query did NOT reach the server. Wrappers that drop `query` entirely are
  // ambiguous — treat them as non-retryable to avoid double-applying a
  // mutation that already executed.
  const hasPreSendShape = Object.prototype.hasOwnProperty.call(e, "query") && e.query === undefined;
  if (!hasPreSendShape) return false;

  return (
    /connection terminated/i.test(message) ||
    /connection (closed|ended|destroyed)/i.test(message) ||
    /socket hang up/i.test(message) ||
    /econnreset/i.test(message)
  );
}

/**
 * Union predicate used by `withPgPoolRetry` — fires on either pool-exhaustion
 * or stale-connection shapes. Both classes are pre-send retryable failures
 * where retry-with-backoff is the correct recovery, not operator intervention.
 */
export function isPgRetryableConnectionError(err: unknown): boolean {
  return isPgPoolExhaustionError(err) || isPgStaleConnectionError(err);
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
      if (!isPgRetryableConnectionError(err) || attempt === maxAttempts) {
        throw err;
      }
      lastErr = err;
      const base = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const multiplier = JITTER_FLOOR + jitter() * JITTER_SPREAD;
      const delay = Math.round(base * multiplier);
      const e = err as { code?: unknown; message?: unknown };
      const errCode = typeof e.code === "string" ? e.code : "?";
      const rawMessage = typeof e.message === "string" ? e.message : String(err);
      const errSummary =
        rawMessage.length > 120 ? `${safeTruncate(rawMessage, 117, "head")}...` : rawMessage;
      // mt#1831: distinguish the two retry classes in the log line so
      // operators can tell pool saturation (server overloaded) from stale
      // connections (client-side socket teardown) without spelunking the raw
      // error text.
      const failureClass = isPgPoolExhaustionError(err)
        ? "pg pool saturation"
        : "pg stale connection";
      log.warn(
        `[retry ${attempt}/${maxAttempts}] ${label}: ${failureClass} (code=${errCode}): ${errSummary} — retrying in ${delay}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // Unreachable: loop either returns or throws on the final attempt.
  throw lastErr;
}
