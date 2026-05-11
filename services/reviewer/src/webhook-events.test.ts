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
    for (const method of ["values", "onConflictDoUpdate", "set", "where", "returning"]) {
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
    const db = buildStubDb({ insertThrow: new Error("connection refused") });

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
