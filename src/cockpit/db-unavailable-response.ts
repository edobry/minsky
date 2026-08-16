/**
 * One place to answer a cockpit HTTP request when the failure is the DATABASE
 * being unreachable rather than a bug in the handler (mt#4125).
 *
 * ## Why this exists
 *
 * `isDatabaseUnavailableError` (mt#3398) was built to answer exactly one
 * question for an HTTP caller — "is this a 503 or a 500?" — and had three
 * adopter call sites against 42 unconditional `status(500)` sites across the
 * cockpit HTTP layer. Every one of those that can see a persistence error
 * reported a pool exhaustion or a dropped connection to the operator as an
 * application bug. mt#4086 is the worked instance: `GET /api/changesets`
 * answered 500 when Supavisor refused one of two concurrent requests with
 * `(EMAXCONNSESSION) max clients reached in session mode`, and diagnosing that
 * one route took several full-suite reproductions.
 *
 * ## Why a helper rather than 42 inline branches
 *
 * The branch is four lines and identical everywhere, so copies drift — and the
 * predicate choice is the part that is easy to get wrong (see below). A single
 * greppable call site per handler also gives the regression guard something to
 * key on.
 *
 * ## Why `isDatabaseUnavailableError` and not `isPgRetryableConnectionError`
 *
 * They answer different questions. `isPgRetryableConnectionError` asks "is it
 * safe to re-run this?" and rejects any error carrying a `query` own-property,
 * because a post-send failure may already have applied a mutation. That guard
 * is correct there and wrong here: a post-send connection failure is unsafe to
 * retry AND is a database outage. Drizzle wraps the driver error and carries
 * the QUERY TEXT as the wrapper's own message, so only the cause-walking
 * predicate sees the driver error underneath. Its own docblock records that a
 * caller using the retry predicate for status classification "would pass its
 * own unit tests and misreport the real outage as an application bug."
 */

import type { Response } from "express";
import { isDatabaseUnavailableError } from "@minsky/domain/persistence/postgres-retry";
import { getLoggableErrorSummary } from "@minsky/domain/schemas/error";
import { log } from "@minsky/shared/logger";
import { describeServerPersistenceUnavailability } from "./db-providers";

/**
 * Answer `res` with 503 if `err` is the database being unreachable.
 *
 * Returns `true` when it answered — the caller returns immediately. Returns
 * `false` when the error is something else, leaving the caller's own 500 branch
 * (and its own message) untouched. The boolean shape is deliberate: each
 * handler keeps its specific 500 copy, which is what makes this a
 * classification change rather than a rewrite of every error body.
 *
 * Logs through `getLoggableErrorSummary`, which walks the `cause` chain. A
 * drizzle failure's own message IS the query text, so a message-only log names
 * the statement and never the reason it failed.
 *
 * Respects `headersSent` for streaming handlers (SSE live-tail), where the
 * response may already be committed by the time the error surfaces.
 */
export interface DbUnavailableDeps {
  /** Defaults to the shared logger. Injected so the log CONTENT is assertable. */
  logWarn?: (message: string, meta: Record<string, unknown>) => void;
  /** Defaults to the server's persistence description. Injected for the same reason. */
  describeUnavailability?: () => Promise<string>;
}

export async function respondIfDatabaseUnavailable(
  res: Response,
  err: unknown,
  scope: string,
  deps: DbUnavailableDeps = {}
): Promise<boolean> {
  if (!isDatabaseUnavailableError(err)) return false;

  // Seams rather than module patching (ADR-036): the two observables that
  // matter here — that the log carries the CAUSE CHAIN and that the 503 body
  // carries the persistence description — are otherwise only reachable by
  // spying on the logger, which is banned and would not survive a refactor.
  const logWarn = deps.logWarn ?? ((message, meta) => log.warn(message, meta));
  const describe = deps.describeUnavailability ?? describeServerPersistenceUnavailability;

  logWarn(`[${scope}] database unavailable`, {
    error: getLoggableErrorSummary(err),
  });

  if (!res.headersSent) {
    res.status(503).json({
      error: `Service unavailable — ${await describe()}`,
    });
  }
  return true;
}
