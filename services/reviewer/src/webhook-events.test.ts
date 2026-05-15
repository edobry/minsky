/**
 * Unit tests for webhook-events.ts persistence module.
 *
 * Strategy:
 *   - Inject a stub DB object that records the calls made to it.
 *   - Assert that the right SQL methods are invoked with the right arguments.
 *   - Verify error-swallowing: DB errors must not propagate (persistence must
 *     never crash the webhook handler).
 *   - Verify extractPersistedHeaders produces the correct header subset.
 *
 * These are pure unit tests — no real DB connection required.
 */

import { describe, test, expect } from "bun:test";
import {
  recordWebhookReceipt,
  updateOutcome,
  pruneOldRows,
  extractPersistedHeaders,
  extractPgErrorContext,
} from "./webhook-events";
import type { PersistedHeaders } from "./webhook-events";

// ---------------------------------------------------------------------------
// Shared header name constants (avoid magic-string duplication warnings)
// ---------------------------------------------------------------------------

const HDR_DELIVERY = "x-github-delivery";
const HDR_EVENT = "x-github-event";
const HDR_SIGNATURE = "x-hub-signature-256";
const HDR_SIGNATURE_PREFIX = "x-hub-signature-256-prefix";
const HDR_USER_AGENT = "user-agent";

// Outcome constant used in multiple tests
const OUTCOME_REVIEW_SUBMITTED = "review_submitted";

// Magic-string constants extracted to satisfy custom/no-magic-string-duplication
const TABLE_NAME_REVIEWER_WEBHOOK_EVENTS = "reviewer_webhook_events";
const ERR_CONNECTION_REFUSED = "connection refused";
const ERR_FAILED_QUERY_INSERT = "Failed query: insert into ...";

// ---------------------------------------------------------------------------
// Stub DB factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal stub DB that records calls to insert/update/delete and
 * resolves each to the given outcome.
 *
 * Drizzle's query-builder uses method chaining (.insert().values().onConflict...),
 * so we need a chainable stub that resolves at the end of the chain.
 */
function buildStubDb(opts: {
  insertResolve?: boolean;
  insertThrow?: Error;
  updateResolve?: boolean;
  updateThrow?: Error;
  deleteRows?: Array<{ id: string }>;
  deleteThrow?: Error;
}) {
  const calls: { method: string; args: unknown[] }[] = [];

  // Each builder method returns `this` to allow chaining, except the terminal
  // `await`-able step which returns a Promise. We model this by making every
  // method return the same object with a then() so it can be awaited.
  function makeChainable(resolve: () => Promise<unknown>): Record<string, unknown> {
    const obj: Record<string, unknown> = {};

    // Chainable no-ops
    for (const method of [
      "values",
      "onConflictDoUpdate",
      "onConflictDoNothing",
      "set",
      "where",
      "returning",
    ]) {
      obj[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return obj;
      };
    }

    // Make the object thenable so `await` resolves it.
    obj["then"] = (
      onfulfilled: (value: unknown) => unknown,
      onrejected: ((reason: unknown) => unknown) | undefined
    ) => resolve().then(onfulfilled, onrejected);

    obj["catch"] = (onrejected: (reason: unknown) => unknown) => resolve().catch(onrejected);

    return obj;
  }

  const stub = {
    _calls: calls,

    insert: (...args: unknown[]) => {
      calls.push({ method: "insert", args });
      if (opts.insertThrow) {
        return makeChainable(() => Promise.reject(opts.insertThrow));
      }
      return makeChainable(() => Promise.resolve([]));
    },

    update: (...args: unknown[]) => {
      calls.push({ method: "update", args });
      if (opts.updateThrow) {
        return makeChainable(() => Promise.reject(opts.updateThrow));
      }
      return makeChainable(() => Promise.resolve([]));
    },

    delete: (...args: unknown[]) => {
      calls.push({ method: "delete", args });
      if (opts.deleteThrow) {
        return makeChainable(() => Promise.reject(opts.deleteThrow));
      }
      const rows = opts.deleteRows ?? [];
      return makeChainable(() => Promise.resolve(rows));
    },
  };

  return stub;
}

/** Find the first call matching `method` and return its first arg as Record, or throw. */
function findCallArgs(
  calls: { method: string; args: unknown[] }[],
  method: string
): Record<string, unknown> {
  const call = calls.find((c) => c.method === method);
  if (!call) throw new Error(`No call found for method=${method}`);
  return call.args[0] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// extractPersistedHeaders
// ---------------------------------------------------------------------------

describe("extractPersistedHeaders", () => {
  test("extracts all four canonical headers when present", () => {
    const get = (name: string): string | null => {
      const map: Record<string, string> = {
        [HDR_DELIVERY]: "abc-123",
        [HDR_EVENT]: "pull_request",
        [HDR_SIGNATURE]: "sha256=abcdef1234567890",
        [HDR_USER_AGENT]: "GitHub-Hookshot/abc123",
      };
      return map[name] ?? null;
    };

    const result = extractPersistedHeaders(get);

    expect(result[HDR_DELIVERY]).toBe("abc-123");
    expect(result[HDR_EVENT]).toBe("pull_request");
    expect(result[HDR_USER_AGENT]).toBe("GitHub-Hookshot/abc123");
    // Signature is truncated to 12 chars
    expect(result[HDR_SIGNATURE_PREFIX]).toBe("sha256=abcde");
    // Full signature is NOT stored
    expect(result[HDR_SIGNATURE]).toBeUndefined();
  });

  test("omits absent headers rather than storing null/undefined", () => {
    const get = (_name: string): string | null => null;
    const result = extractPersistedHeaders(get);

    expect(Object.keys(result)).toHaveLength(0);
  });

  test("partial headers — only present ones are included", () => {
    const get = (name: string): string | null => (name === HDR_DELIVERY ? "del-456" : null);

    const result = extractPersistedHeaders(get);

    expect(result[HDR_DELIVERY]).toBe("del-456");
    expect(Object.keys(result)).toHaveLength(1);
  });

  test("signature prefix is always 12 chars even for short signatures", () => {
    const get = (name: string): string | null => (name === HDR_SIGNATURE ? "sha256=abc" : null);

    const result = extractPersistedHeaders(get);

    // "sha256=abc" is 10 chars — slice(0, 12) is the full string (no error)
    expect(result[HDR_SIGNATURE_PREFIX]).toBe("sha256=abc");
  });
});

// ---------------------------------------------------------------------------
// recordWebhookReceipt
// ---------------------------------------------------------------------------

describe("recordWebhookReceipt", () => {
  test("calls db.insert with correct arguments", async () => {
    const db = buildStubDb({ insertResolve: true });
    const headers: PersistedHeaders = { [HDR_DELIVERY]: "del-001" };
    const body = { action: "opened", pull_request: { number: 42 } };

    await recordWebhookReceipt(
      db as unknown as Parameters<typeof recordWebhookReceipt>[0],
      "del-001",
      "pull_request",
      headers,
      body
    );

    const insertCall = db._calls.find((c) => c.method === "insert");
    expect(insertCall).toBeDefined();

    const vals = findCallArgs(db._calls, "values");
    expect(vals["deliveryId"]).toBe("del-001");
    expect(vals["eventType"]).toBe("pull_request");
    expect(vals["outcome"]).toBe("received");
  });

  test("does not throw when DB insert fails", async () => {
    const db = buildStubDb({ insertThrow: new Error(ERR_CONNECTION_REFUSED) });

    // Must not throw — persistence errors are swallowed
    await expect(
      recordWebhookReceipt(
        db as unknown as Parameters<typeof recordWebhookReceipt>[0],
        "del-002",
        "push",
        {},
        {}
      )
    ).resolves.toBeUndefined();
  });

  test("handles non-JSON body by wrapping in { raw } object", async () => {
    const db = buildStubDb({ insertResolve: true });

    // Pass a raw string body (what the caller passes when JSON.parse failed)
    await recordWebhookReceipt(
      db as unknown as Parameters<typeof recordWebhookReceipt>[0],
      "del-003",
      "push",
      {},
      { raw: "not-json" }
    );

    const vals = findCallArgs(db._calls, "values");
    expect((vals["body"] as Record<string, unknown>)["raw"]).toBe("not-json");
  });

  test("uses ON CONFLICT DO NOTHING (R1 BLOCKING #1 regression — re-delivery must not overwrite terminal outcomes)", async () => {
    const db = buildStubDb({ insertResolve: true });

    await recordWebhookReceipt(
      db as unknown as Parameters<typeof recordWebhookReceipt>[0],
      "del-redelivery",
      "pull_request",
      {},
      { action: "opened" }
    );

    // The R1 fix changed onConflictDoUpdate → onConflictDoNothing so that
    // a re-delivery (same delivery_id) does NOT overwrite an existing row
    // whose outcome has progressed to a terminal state (review_submitted,
    // failed_at_*, skipped). The original UPSERT cleared processedAt and
    // errorDetails on every re-delivery, corrupting forensic state.
    const conflictCall = db._calls.find((c) => c.method === "onConflictDoNothing");
    expect(conflictCall).toBeDefined();

    // Belt-and-suspenders: ensure the obsolete onConflictDoUpdate is NOT used.
    const oldConflictCall = db._calls.find((c) => c.method === "onConflictDoUpdate");
    expect(oldConflictCall).toBeUndefined();
  });

  test("accepts 'unknown' sentinel eventType (R1 BLOCKING #3 regression — every POST is persisted)", async () => {
    // server.ts passes "unknown" when x-github-event header is absent so that
    // even malformed webhooks produce forensic rows. recordWebhookReceipt itself
    // does not validate eventType — any string is accepted.
    const db = buildStubDb({ insertResolve: true });

    await recordWebhookReceipt(
      db as unknown as Parameters<typeof recordWebhookReceipt>[0],
      "del-no-event-header",
      "unknown",
      {},
      { raw: "weird-payload" }
    );

    const vals = findCallArgs(db._calls, "values");
    expect(vals["eventType"]).toBe("unknown");
    expect(vals["outcome"]).toBe("received");
  });
});

// ---------------------------------------------------------------------------
// updateOutcome
// ---------------------------------------------------------------------------

describe("updateOutcome", () => {
  test("calls db.update and db.where with the delivery ID", async () => {
    const db = buildStubDb({ updateResolve: true });

    await updateOutcome(
      db as unknown as Parameters<typeof updateOutcome>[0],
      "del-100",
      OUTCOME_REVIEW_SUBMITTED
    );

    const updateCall = db._calls.find((c) => c.method === "update");
    expect(updateCall).toBeDefined();

    const setArgs = findCallArgs(db._calls, "set");
    expect(setArgs["outcome"]).toBe(OUTCOME_REVIEW_SUBMITTED);
    // Terminal outcome: processedAt should be set
    expect(setArgs["processedAt"]).toBeInstanceOf(Date);
  });

  test("does NOT set processedAt for non-terminal outcomes", async () => {
    const db = buildStubDb({ updateResolve: true });

    await updateOutcome(
      db as unknown as Parameters<typeof updateOutcome>[0],
      "del-101",
      "reviewer_called"
    );

    const setArgs = findCallArgs(db._calls, "set");
    expect(setArgs["outcome"]).toBe("reviewer_called");
    // Non-terminal outcome: processedAt must NOT be in the set object
    expect(Object.keys(setArgs)).not.toContain("processedAt");
  });

  test("includes errorDetails when provided", async () => {
    const db = buildStubDb({ updateResolve: true });

    await updateOutcome(
      db as unknown as Parameters<typeof updateOutcome>[0],
      "del-102",
      "failed_at_reviewer",
      { message: "runReview threw", stage: "reviewer" }
    );

    const setArgs = findCallArgs(db._calls, "set");
    expect(setArgs["outcome"]).toBe("failed_at_reviewer");
    expect(setArgs["errorDetails"]).toMatchObject({
      message: "runReview threw",
      stage: "reviewer",
    });
    // Terminal outcome
    expect(setArgs["processedAt"]).toBeInstanceOf(Date);
  });

  test("does not throw when DB update fails", async () => {
    const db = buildStubDb({ updateThrow: new Error("timeout") });

    await expect(
      updateOutcome(
        db as unknown as Parameters<typeof updateOutcome>[0],
        "del-103",
        OUTCOME_REVIEW_SUBMITTED
      )
    ).resolves.toBeUndefined();
  });

  test("skipped is a terminal outcome", async () => {
    const db = buildStubDb({ updateResolve: true });

    await updateOutcome(db as unknown as Parameters<typeof updateOutcome>[0], "del-104", "skipped");

    const setArgs = findCallArgs(db._calls, "set");
    expect(setArgs["processedAt"]).toBeInstanceOf(Date);
  });

  test("received is a non-terminal outcome", async () => {
    const db = buildStubDb({ updateResolve: true });

    await updateOutcome(
      db as unknown as Parameters<typeof updateOutcome>[0],
      "del-105",
      "received"
    );

    const setArgs = findCallArgs(db._calls, "set");
    expect(Object.keys(setArgs)).not.toContain("processedAt");
  });
});

// ---------------------------------------------------------------------------
// pruneOldRows
// ---------------------------------------------------------------------------

describe("pruneOldRows", () => {
  test("calls db.delete and returns the row count", async () => {
    const db = buildStubDb({
      deleteRows: [{ id: "uuid-1" }, { id: "uuid-2" }],
    });

    const count = await pruneOldRows(db as unknown as Parameters<typeof pruneOldRows>[0], 90);

    expect(count).toBe(2);
    const deleteCall = db._calls.find((c) => c.method === "delete");
    expect(deleteCall).toBeDefined();
  });

  test("returns -1 when DB delete fails", async () => {
    const db = buildStubDb({ deleteThrow: new Error("constraint") });

    const count = await pruneOldRows(db as unknown as Parameters<typeof pruneOldRows>[0], 90);

    expect(count).toBe(-1);
  });

  test("returns -1 when DB delete throws a postgres-like error with .cause (mt#1850)", async () => {
    // Regression test for mt#1850: pruneOldRows catch block now uses
    // extractPgErrorContext to surface postgres error code/cause in the log
    // payload (same shape as recordWebhookReceipt and updateOutcome). This test
    // exercises the cause-bearing-error code path to confirm the catch block
    // doesn't break when err.cause is present. The structured-field surfacing
    // itself is independently covered by the extractPgErrorContext describe
    // block at the bottom of this file.
    const pgError = Object.assign(
      new Error(`permission denied for table ${TABLE_NAME_REVIEWER_WEBHOOK_EVENTS}`),
      {
        code: "42501",
        severity: "ERROR",
        table_name: TABLE_NAME_REVIEWER_WEBHOOK_EVENTS,
      }
    );
    const wrapped = new Error(
      `Failed query: delete from "${TABLE_NAME_REVIEWER_WEBHOOK_EVENTS}" ...`
    );
    Object.defineProperty(wrapped, "cause", { value: pgError, enumerable: false });

    const db = buildStubDb({ deleteThrow: wrapped });

    const count = await pruneOldRows(db as unknown as Parameters<typeof pruneOldRows>[0], 90);

    expect(count).toBe(-1);
  });

  test("returns 0 when no rows are deleted", async () => {
    const db = buildStubDb({ deleteRows: [] });

    const count = await pruneOldRows(db as unknown as Parameters<typeof pruneOldRows>[0], 30);

    expect(count).toBe(0);
  });

  test("uses default retention of 90 days when not specified", async () => {
    const db = buildStubDb({ deleteRows: [] });

    // Should not throw
    await expect(pruneOldRows(db as unknown as Parameters<typeof pruneOldRows>[0])).resolves.toBe(
      0
    );
  });
});

// ---------------------------------------------------------------------------
// extractPgErrorContext (mt#1849 — diagnostic instrumentation)
// ---------------------------------------------------------------------------
//
// Bug mt#1849: webhook_event_record_failed and webhook_outcome_update_failed
// log only the wrapped drizzle error message ("Failed query: insert into ...").
// The underlying postgres error (with .code, .severity, .detail, .constraint,
// .table, .column, .schema fields) is silently dropped because the catch
// blocks call `err.message` directly and ignore `err.cause`.
//
// This made it impossible to diagnose 6+ days of silent webhook-event-record
// failures in production — the actual postgres error code (e.g., 42P01
// "relation does not exist", or 42501 "permission denied") never reached the
// logs. extractPgErrorContext is the pure helper that walks `err.cause` and
// surfaces the structured fields.

describe("extractPgErrorContext", () => {
  test("postgres-like error with .cause containing code/severity/message produces structured fields", () => {
    // Simulates what drizzle wraps around a postgres-js error. postgres-js
    // raises an Error subclass with code/severity/message at the top level;
    // drizzle wraps it as `cause` on its own Error instance.
    const pgError = Object.assign(
      new Error(`relation "${TABLE_NAME_REVIEWER_WEBHOOK_EVENTS}" does not exist`),
      {
        code: "42P01",
        severity: "ERROR",
        schema_name: "public",
        table_name: TABLE_NAME_REVIEWER_WEBHOOK_EVENTS,
      }
    );
    const drizzleErr = new Error(
      `Failed query: insert into "${TABLE_NAME_REVIEWER_WEBHOOK_EVENTS}" ...`
    );
    Object.defineProperty(drizzleErr, "cause", { value: pgError, enumerable: false });

    const ctx = extractPgErrorContext(drizzleErr);

    expect(ctx["error"]).toBe(
      `Failed query: insert into "${TABLE_NAME_REVIEWER_WEBHOOK_EVENTS}" ...`
    );
    expect(ctx["error_code"]).toBe("42P01");
    expect(ctx["error_severity"]).toBe("ERROR");
    expect(ctx["error_detail"]).toBe(
      `relation "${TABLE_NAME_REVIEWER_WEBHOOK_EVENTS}" does not exist`
    );
    expect(ctx["error_table"]).toBe(TABLE_NAME_REVIEWER_WEBHOOK_EVENTS);
    expect(ctx["error_schema"]).toBe("public");
  });

  test("error without .cause still produces the original `error` field (backward compat)", () => {
    const plainErr = new Error(ERR_CONNECTION_REFUSED);

    const ctx = extractPgErrorContext(plainErr);

    expect(ctx["error"]).toBe(ERR_CONNECTION_REFUSED);
    expect(ctx["error_code"]).toBeUndefined();
    expect(ctx["error_severity"]).toBeUndefined();
    expect(ctx["error_detail"]).toBeUndefined();
  });

  test("non-Error thrown value (string) still produces a sensible payload", () => {
    const ctx = extractPgErrorContext("plain string error");

    expect(ctx["error"]).toBe("plain string error");
    expect(ctx["error_code"]).toBeUndefined();
  });

  test("constraint-violation error surfaces constraint and column names", () => {
    const pgError = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "reviewer_webhook_events_delivery_id_unique"'
      ),
      {
        code: "23505",
        severity: "ERROR",
        constraint_name: "reviewer_webhook_events_delivery_id_unique",
        table_name: TABLE_NAME_REVIEWER_WEBHOOK_EVENTS,
      }
    );
    const drizzleErr = new Error(ERR_FAILED_QUERY_INSERT);
    Object.defineProperty(drizzleErr, "cause", { value: pgError, enumerable: false });

    const ctx = extractPgErrorContext(drizzleErr);

    expect(ctx["error_code"]).toBe("23505");
    expect(ctx["error_constraint"]).toBe("reviewer_webhook_events_delivery_id_unique");
    expect(ctx["error_table"]).toBe(TABLE_NAME_REVIEWER_WEBHOOK_EVENTS);
  });

  test("permission-denied error (42501) surfaces code so it's distinguishable from missing-table", () => {
    const pgError = Object.assign(
      new Error(`permission denied for table ${TABLE_NAME_REVIEWER_WEBHOOK_EVENTS}`),
      {
        code: "42501",
        severity: "ERROR",
        table_name: TABLE_NAME_REVIEWER_WEBHOOK_EVENTS,
      }
    );
    const drizzleErr = new Error(ERR_FAILED_QUERY_INSERT);
    Object.defineProperty(drizzleErr, "cause", { value: pgError, enumerable: false });

    const ctx = extractPgErrorContext(drizzleErr);

    expect(ctx["error_code"]).toBe("42501");
    expect(ctx["error_detail"]).toBe(
      `permission denied for table ${TABLE_NAME_REVIEWER_WEBHOOK_EVENTS}`
    );
  });

  test("cause exists but lacks standard fields — keys + truncated JSON surface (mt#1851)", () => {
    // Phase 2: when the helper doesn't recognize the cause's shape (no .code as
    // string), surface diagnostic info so production observability isn't a
    // dead-end. PR #1130's webhook (delivery fc841420-...) revealed this case
    // in production — cause IS present (drizzle wraps), just not with the
    // postgres-js fields the Phase 1 check expected.
    const opaqueCause = { random_field: "x", another: 42, nested: { deep: true } };
    const drizzleErr = new Error(ERR_FAILED_QUERY_INSERT);
    Object.defineProperty(drizzleErr, "cause", { value: opaqueCause, enumerable: false });

    const ctx = extractPgErrorContext(drizzleErr);

    // Keys array sorted for stable test output
    expect(ctx["error_cause_keys"]).toEqual(["another", "nested", "random_field"]);
    // JSON preview present and contains the data
    expect(typeof ctx["error_cause_json"]).toBe("string");
    expect(ctx["error_cause_json"] as string).toContain("random_field");
    expect(ctx["error_cause_json"] as string).toContain("42");
    // Length cap honored
    expect((ctx["error_cause_json"] as string).length).toBeLessThanOrEqual(500);
  });

  test("postgres-like fields directly on err itself (no .cause wrapping) — surface them (mt#1851)", () => {
    // When the thrown error IS the postgres-js PostgresError (not wrapped by
    // drizzle), fields are at the top level. Phase 1 only walked .cause; this
    // case was a hole.
    const directPgError = Object.assign(new Error("connection terminated unexpectedly"), {
      code: "57P01",
      severity: "FATAL",
      table_name: TABLE_NAME_REVIEWER_WEBHOOK_EVENTS,
    });

    const ctx = extractPgErrorContext(directPgError);

    expect(ctx["error_code"]).toBe("57P01");
    expect(ctx["error_severity"]).toBe("FATAL");
    expect(ctx["error_table"]).toBe(TABLE_NAME_REVIEWER_WEBHOOK_EVENTS);
  });

  test("standard-cause-fields case does NOT also emit error_cause_keys (avoid double-emission noise)", () => {
    // Backward-compat: when standard fields ARE recognized on cause, the new
    // fallback (error_cause_keys / error_cause_json) MUST NOT also fire — that
    // would double the log payload size for every well-behaved postgres error.
    const pgError = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
      severity: "ERROR",
      table_name: TABLE_NAME_REVIEWER_WEBHOOK_EVENTS,
    });
    const drizzleErr = new Error(ERR_FAILED_QUERY_INSERT);
    Object.defineProperty(drizzleErr, "cause", { value: pgError, enumerable: false });

    const ctx = extractPgErrorContext(drizzleErr);

    expect(ctx["error_code"]).toBe("42P01");
    // Fallback fields MUST be absent when standard fields fired
    expect(ctx["error_cause_keys"]).toBeUndefined();
    expect(ctx["error_cause_json"]).toBeUndefined();
  });

  test("error_cause_json is truncated to <=500 chars even when cause is enormous", () => {
    // Belt-and-suspenders for the length cap: if cause is huge (e.g., a webhook
    // payload accidentally got attached as cause), don't blow up the log line.
    const huge: Record<string, string> = {};
    for (let i = 0; i < 100; i++) huge[`field_${i}`] = `value_${i}_${"x".repeat(50)}`;
    const drizzleErr = new Error("Failed query: ...");
    Object.defineProperty(drizzleErr, "cause", { value: huge, enumerable: false });

    const ctx = extractPgErrorContext(drizzleErr);

    expect(typeof ctx["error_cause_json"]).toBe("string");
    expect((ctx["error_cause_json"] as string).length).toBeLessThanOrEqual(500);
  });
});
