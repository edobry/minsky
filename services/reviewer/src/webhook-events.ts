/**
 * Webhook-event persistence for the minsky-reviewer service.
 *
 * Three public operations:
 *
 *   recordWebhookReceipt(deliveryId, eventType, headers, body)
 *     — insert a new row when the webhook arrives. Uses ON CONFLICT DO NOTHING
 *       on delivery_id; re-deliveries are no-ops, preserving the original row's
 *       processing state (including terminal outcomes). GitHub re-delivers
 *       when the original POST didn't get a 2xx — by then we already have
 *       the row's content; refreshing it back to "received" would corrupt
 *       forensic state for any delivery that progressed past the receipt stage.
 *
 *   updateOutcome(deliveryId, outcome, errorDetails?)
 *     — update the outcome column as the request progresses through the
 *       pipeline. Also sets processed_at on terminal outcomes.
 *
 *   pruneOldRows(retentionDays)
 *     — delete rows older than `retentionDays`. Called by the retention
 *       scheduler so the table does not grow unbounded.
 *
 * All operations wrap DB calls in try/catch. Errors are logged via the
 * reviewer-local logger (log.*) but NOT re-thrown — persistence is
 * observability infrastructure and must never crash the webhook handler.
 *
 * TOCTOU analysis (§7b):
 *   - Read atomicity: recordWebhookReceipt and updateOutcome each make one
 *     DB call. No multiple reads of the same row in sequence. Accept.
 *   - Decision-action gap: updateOutcome writes outcome without re-reading
 *     the current row first. Idempotent: repeated calls with the same outcome
 *     leave the row in the same state. Accept (idempotent).
 *   - Stale-read: not applicable — this module only writes, it never reads
 *     back to make decisions. Accept (N/A).
 *   - Re-delivery DO NOTHING: GitHub may re-deliver a webhook with the same
 *     delivery ID. The ON CONFLICT DO NOTHING on conflict(delivery_id) is a
 *     no-op for the existing row — first-delivery wins. Accept-rationale:
 *     re-delivery happens when GitHub didn't get a 2xx, but our async
 *     persistence has already recorded the body/headers from the original
 *     request; the body/headers are guaranteed identical on re-delivery
 *     (same delivery_id is the same content); processed state (outcome,
 *     processedAt, errorDetails) from the original is forensically valuable
 *     and must NOT be overwritten. This was the bug the R1 review caught.
 *
 * OperatorNotify wiring:
 *   Non-2xx webhook responses and unhandled processing exceptions are
 *   surfaced by the caller (server.ts) via structured log.error calls at
 *   event="webhook_processing_failed". The reviewer service runs on Railway
 *   where stdout/stderr are the operator-visible channel (Railway logs).
 *   These error events are the service-level OperatorNotify equivalent —
 *   distinct from mt#1310 (which alerts on missing reviews from GitHub's
 *   perspective). Railway log monitoring / alerting can subscribe to
 *   event="webhook_processing_failed" for automated escalation.
 *
 * See mt#1372 and docs/incidents/reviewer-webhook-investigation.md.
 */

import { eq, lt } from "drizzle-orm";
import { log } from "./logger";
import type { ReviewerDb } from "./db/client";
import { webhookEventsTable, type WebhookOutcome } from "./db/schemas/webhook-events-schema";

// ---------------------------------------------------------------------------
// extractPgErrorContext (mt#1849)
// ---------------------------------------------------------------------------

/**
 * Extract structured postgres-error context from a drizzle-wrapped error.
 *
 * Drizzle's `postgres-js` driver throws an Error whose `.message` is the
 * wrapped query SQL ("Failed query: insert into ..."), and whose `.cause`
 * carries the underlying postgres-js error with structured fields:
 *   - `code`            (e.g. "42P01" for relation-does-not-exist)
 *   - `severity`        (e.g. "ERROR")
 *   - `message`         (the actual postgres-side message)
 *   - `constraint_name` (on constraint violations)
 *   - `table_name`      (on relation-bound errors)
 *   - `column_name`     (on column-bound errors)
 *   - `schema_name`     (on relation-bound errors)
 *
 * **Phase 2 (mt#1851):** the helper now also handles two cases Phase 1 missed:
 *   1. **Postgres fields directly on err itself** (no wrapping) — when the
 *      thrown error IS the postgres-js `PostgresError`, fields are at the
 *      top level. The helper now checks both `err.cause` AND `err` directly.
 *   2. **Cause exists but lacks standard fields** — when no standard fields
 *      are recognized (this happens when the cause's shape diverges from
 *      `postgres-js PostgresError`), the helper surfaces `error_cause_keys`
 *      (sorted Object.keys) and `error_cause_json` (JSON.stringify, capped at
 *      500 chars) so production observability is never a dead-end. PR #1130's
 *      webhook (delivery `fc841420-...`) revealed this case in production —
 *      cause IS present, just not with the expected shape.
 *
 * Returns a context object suitable for spreading into the log payload.
 * Backward-compatible: errors without `.cause` (or non-Error throws) still
 * produce the original `error: message` field; structured fields are
 * undefined and omitted by JSON serialization. The fallback fields
 * (`error_cause_keys` / `error_cause_json`) only fire when standard fields
 * weren't recognized — avoiding double-emission noise on well-behaved errors.
 */
const ERROR_CAUSE_JSON_MAX = 500;

/**
 * Walk a candidate postgres-error-shaped object and extract the standard
 * fields into ctx. Returns the number of fields recognized so the caller
 * can decide whether to invoke the fallback (keys+JSON) path.
 */
function extractStandardPgFields(
  source: Record<string, unknown>,
  ctx: Record<string, unknown>
): number {
  let recognized = 0;
  if (typeof source["code"] === "string") {
    ctx["error_code"] = source["code"];
    recognized++;
  }
  if (typeof source["severity"] === "string") {
    ctx["error_severity"] = source["severity"];
    recognized++;
  }
  if (typeof source["message"] === "string") {
    ctx["error_detail"] = source["message"];
    recognized++;
  }
  if (typeof source["constraint_name"] === "string") {
    ctx["error_constraint"] = source["constraint_name"];
    recognized++;
  }
  if (typeof source["table_name"] === "string") {
    ctx["error_table"] = source["table_name"];
    recognized++;
  }
  if (typeof source["column_name"] === "string") {
    ctx["error_column"] = source["column_name"];
    recognized++;
  }
  if (typeof source["schema_name"] === "string") {
    ctx["error_schema"] = source["schema_name"];
    recognized++;
  }
  return recognized;
}

export function extractPgErrorContext(err: unknown): Record<string, unknown> {
  const message = err instanceof Error ? err.message : String(err);
  const ctx: Record<string, unknown> = { error: message };

  if (!(err instanceof Error)) return ctx;

  // (1) Check top-level fields on err itself — handles the "postgres-js
  // PostgresError thrown directly without drizzle wrapping" case (mt#1851).
  // GUARD: only treat err as a postgres error if it has a string `code`. Every
  // Error has `.message` as a string, so without this guard we'd extract
  // `error_detail` from regular Errors and break backward-compat AND prevent
  // the cause-fallback path from firing.
  // The cast is safe: err is already narrowed to Error, and we treat it as a
  // generic record only to read possible postgres-js fields.
  const errAsRecord = err as Error & Record<string, unknown>;
  let topRecognized = 0;
  if (typeof errAsRecord["code"] === "string") {
    topRecognized = extractStandardPgFields(errAsRecord, ctx);
  }

  // (2) Check err.cause — drizzle's DrizzleQueryError sets this for query
  // errors. The cause is typically the underlying postgres-js error.
  const cause = (err as Error & { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return ctx;

  const c = cause as Record<string, unknown>;
  const causeRecognized = extractStandardPgFields(c, ctx);

  // (3) Fallback: if NEITHER top-level NOR cause produced any recognized
  // fields, surface diagnostic info so production observability isn't a
  // dead-end. This was the gap mt#1851 closed — PR #1130's webhook had a
  // cause but no fields the helper recognized.
  if (topRecognized === 0 && causeRecognized === 0) {
    const keys = Object.keys(c).sort();
    ctx["error_cause_keys"] = keys;
    let json: string;
    try {
      json = JSON.stringify(c);
    } catch {
      // Cause has circular references or unserializable values
      json = `[unserializable: ${keys.join(",")}]`;
    }
    ctx["error_cause_json"] =
      json.length > ERROR_CAUSE_JSON_MAX ? `${json.slice(0, ERROR_CAUSE_JSON_MAX - 3)}...` : json;
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of incoming HTTP headers to persist (forensically relevant). */
export interface PersistedHeaders {
  "x-github-delivery"?: string;
  "x-github-event"?: string;
  /** SHA-256 signature truncated to 12 chars — enough to verify format, not leaking full secret. */
  "x-hub-signature-256-prefix"?: string;
  "user-agent"?: string;
  [key: string]: string | undefined;
}

/** Error details stored when a webhook fails at any stage. */
export interface WebhookErrorDetails extends Record<string, unknown> {
  /** Human-readable error message. */
  message: string;
  /** Processing stage where the failure occurred. */
  stage: string;
  /** Optional stack trace, truncated for log safety. */
  stack?: string;
}

// ---------------------------------------------------------------------------
// Terminal outcome set (triggers processedAt)
// ---------------------------------------------------------------------------

/**
 * Outcomes that are terminal: once reached, processed_at is set.
 * Non-terminal outcomes (received, tier_resolved, reviewer_called) may still
 * transition to a later stage.
 */
const TERMINAL_OUTCOMES = new Set<WebhookOutcome>([
  "review_submitted",
  "skipped",
  "failed_at_signature",
  "failed_at_tier_resolve",
  "failed_at_reviewer",
]);

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/**
 * Insert a new webhook-event row when the webhook arrives.
 *
 * Uses ON CONFLICT(delivery_id) DO NOTHING to handle GitHub re-deliveries
 * idempotently — a re-delivered webhook is a no-op.
 *
 * @param db          Drizzle DB instance.
 * @param deliveryId  X-GitHub-Delivery header value (unique per delivery).
 * @param eventType   X-GitHub-Event header value (e.g. "pull_request").
 * @param headers     Subset of HTTP headers to persist.
 * @param body        Parsed JSON body of the webhook payload (or raw text wrapper).
 */
export async function recordWebhookReceipt(
  db: ReviewerDb,
  deliveryId: string,
  eventType: string,
  headers: PersistedHeaders,
  body: unknown
): Promise<void> {
  try {
    await db
      .insert(webhookEventsTable)
      .values({
        deliveryId,
        eventType,
        headers: headers as Record<string, unknown>,
        body: (body ?? {}) as Record<string, unknown>,
        outcome: "received",
      })
      .onConflictDoNothing({
        target: webhookEventsTable.deliveryId,
      });

    log.debug("webhook_event_recorded", {
      event: "webhook_event_recorded",
      delivery_id: deliveryId,
      event_type: eventType,
    });
  } catch (err: unknown) {
    log.error("webhook_event_record_failed", {
      event: "webhook_event_record_failed",
      delivery_id: deliveryId,
      ...extractPgErrorContext(err),
    });
    // Do NOT re-throw — persistence must not crash the webhook handler.
  }
}

/**
 * Update the processing outcome for a webhook delivery.
 *
 * Sets processed_at when the outcome is terminal (review_submitted, skipped,
 * or any failed_at_* variant). Non-terminal updates (tier_resolved,
 * reviewer_called) leave processed_at null.
 *
 * @param db            Drizzle DB instance.
 * @param deliveryId    Delivery ID to update.
 * @param outcome       New outcome value.
 * @param errorDetails  Optional error context for failure outcomes.
 */
export async function updateOutcome(
  db: ReviewerDb,
  deliveryId: string,
  outcome: WebhookOutcome,
  errorDetails?: WebhookErrorDetails
): Promise<void> {
  const isTerminal = TERMINAL_OUTCOMES.has(outcome);
  const now = new Date();

  try {
    await db
      .update(webhookEventsTable)
      .set({
        outcome,
        errorDetails: errorDetails ? (errorDetails as Record<string, unknown>) : null,
        ...(isTerminal ? { processedAt: now } : {}),
      })
      .where(eq(webhookEventsTable.deliveryId, deliveryId));

    log.debug("webhook_outcome_updated", {
      event: "webhook_outcome_updated",
      delivery_id: deliveryId,
      outcome,
      terminal: isTerminal,
    });
  } catch (err: unknown) {
    log.error("webhook_outcome_update_failed", {
      event: "webhook_outcome_update_failed",
      delivery_id: deliveryId,
      outcome,
      ...extractPgErrorContext(err),
    });
    // Do NOT re-throw — persistence must not crash the webhook handler.
  }
}

/**
 * Delete webhook-event rows older than `retentionDays`.
 *
 * Called by the retention scheduler on a configurable interval.
 * Returns the number of rows deleted, or -1 on error.
 *
 * @param db            Drizzle DB instance.
 * @param retentionDays Rows older than this many days are deleted (default: 90).
 */
export async function pruneOldRows(db: ReviewerDb, retentionDays: number = 90): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  try {
    const deleted = await db
      .delete(webhookEventsTable)
      .where(lt(webhookEventsTable.receivedAt, cutoff))
      .returning({ id: webhookEventsTable.id });

    const count = deleted.length;
    log.info("webhook_events_pruned", {
      event: "webhook_events_pruned",
      retention_days: retentionDays,
      cutoff: cutoff.toISOString(),
      deleted_count: count,
    });
    return count;
  } catch (err: unknown) {
    log.error("webhook_events_prune_failed", {
      event: "webhook_events_prune_failed",
      retention_days: retentionDays,
      ...extractPgErrorContext(err),
    });
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Header extraction helper
// ---------------------------------------------------------------------------

/**
 * Extract the forensically relevant subset of HTTP headers from an incoming
 * request. Truncates the HMAC signature to a short prefix for privacy.
 *
 * @param getHeader  Function to read a header value by name (matches the
 *                   Bun Request.headers.get() signature).
 */
export function extractPersistedHeaders(
  getHeader: (name: string) => string | null
): PersistedHeaders {
  const deliveryId = getHeader("x-github-delivery");
  const event = getHeader("x-github-event");
  const sig = getHeader("x-hub-signature-256");
  const ua = getHeader("user-agent");

  const result: PersistedHeaders = {};
  if (deliveryId) result["x-github-delivery"] = deliveryId;
  if (event) result["x-github-event"] = event;
  // Store only the first 12 chars of the HMAC signature — enough to confirm
  // the header was present and correctly prefixed, without persisting the
  // full secret-derived value.
  if (sig) result["x-hub-signature-256-prefix"] = sig.slice(0, 12);
  if (ua) result["user-agent"] = ua;

  return result;
}
