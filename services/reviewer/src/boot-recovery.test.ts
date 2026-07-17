/**
 * Unit tests for boot-recovery.ts (mt#2799 Layer 2).
 *
 * Strategy:
 *   - Stub DB: `.select().from().where().limit()` resolves to an injected
 *     row array; `.update().set().where()` records each call's `.set()`
 *     payload so tests can assert the persisted outcome without decoding
 *     drizzle's `where()` condition objects.
 *   - Inject a fake `runReviewFn` per test to control the ReviewResult
 *     boot recovery reacts to (reviewed / skipped / concurrent_inflight /
 *     error / throw).
 *   - Dispatch is fire-and-forget inside recoverPendingReviews (matching
 *     production's detached shape), so tests await a microtask tick after
 *     the function returns before asserting on the update-call log.
 */

import { describe, test, expect } from "bun:test";
import {
  recoverPendingReviews,
  loadBootRecoveryConfig,
  extractRecoveryTarget,
  type BootRecoveryConfig,
  type RunReviewFn,
} from "./boot-recovery";
import type { ReviewResult } from "./review-worker";
import type { ReviewerConfig } from "./config";
import type { WebhookEventRecord } from "./db/schemas/webhook-events-schema";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG: ReviewerConfig = {
  appId: 1,
  privateKey: "",
  installationId: 1,
  webhookSecret: "secret",
  provider: "openai",
  providerApiKey: "sk-fake",
  providerModel: "gpt-5",
  tier2Enabled: false,
  mcpUrl: undefined,
  mcpToken: undefined,
  port: 0,
  logLevel: "info",
  modelTimeoutMs: 120_000,
  githubTimeoutMs: 30_000,
};

const ENABLED_CFG: BootRecoveryConfig = {
  enabled: true,
  maxAgeMs: 30 * 60_000,
  maxRows: 20,
};

function buildRow(overrides: Partial<WebhookEventRecord> = {}): WebhookEventRecord {
  return {
    id: "row-1",
    deliveryId: "delivery-1",
    eventType: "pull_request",
    headers: {},
    body: {
      pull_request: {
        number: 42,
        user: { login: "author" },
        head: { sha: "abc123" },
      },
      repository: { owner: { login: "edobry" }, name: "minsky" },
    },
    outcome: "reviewer_called",
    errorDetails: null,
    receivedAt: new Date(),
    processedAt: null,
    ...overrides,
  } as WebhookEventRecord;
}

/** Await a couple of microtask ticks so fire-and-forget dispatch settles. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

// ---------------------------------------------------------------------------
// Stub DB
// ---------------------------------------------------------------------------

interface SetCall {
  payload: Record<string, unknown>;
}

function buildStubDb(rows: WebhookEventRecord[], opts: { selectThrows?: boolean } = {}) {
  const setCalls: SetCall[] = [];
  let capturedLimit: number | undefined;

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: (n: number) => {
            capturedLimit = n;
            if (opts.selectThrows) {
              return Promise.reject(new Error("select failed (injected)"));
            }
            return Promise.resolve(rows);
          },
        }),
      }),
    }),
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        setCalls.push({ payload });
        return {
          where: () => Promise.resolve([]),
        };
      },
    }),
  };

  return { db, setCalls, getCapturedLimit: () => capturedLimit };
}

// ---------------------------------------------------------------------------
// loadBootRecoveryConfig
// ---------------------------------------------------------------------------

const ENV_ENABLED = "REVIEWER_BOOT_RECOVERY_ENABLED";
const ENV_MAX_AGE_MS = "REVIEWER_BOOT_RECOVERY_MAX_AGE_MS";
const ENV_MAX_ROWS = "REVIEWER_BOOT_RECOVERY_MAX_ROWS";

describe("loadBootRecoveryConfig", () => {
  test("defaults to enabled=true with default maxAgeMs/maxRows when env unset", () => {
    const prevEnabled = process.env[ENV_ENABLED];
    const prevMaxAge = process.env[ENV_MAX_AGE_MS];
    const prevMaxRows = process.env[ENV_MAX_ROWS];
    delete process.env[ENV_ENABLED];
    delete process.env[ENV_MAX_AGE_MS];
    delete process.env[ENV_MAX_ROWS];

    try {
      const cfg = loadBootRecoveryConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.maxAgeMs).toBe(30 * 60_000);
      expect(cfg.maxRows).toBe(20);
    } finally {
      if (prevEnabled !== undefined) process.env[ENV_ENABLED] = prevEnabled;
      if (prevMaxAge !== undefined) process.env[ENV_MAX_AGE_MS] = prevMaxAge;
      if (prevMaxRows !== undefined) process.env[ENV_MAX_ROWS] = prevMaxRows;
    }
  });

  test("REVIEWER_BOOT_RECOVERY_ENABLED=false disables recovery", () => {
    const prev = process.env[ENV_ENABLED];
    process.env[ENV_ENABLED] = "false";
    try {
      expect(loadBootRecoveryConfig().enabled).toBe(false);
    } finally {
      if (prev !== undefined) {
        process.env[ENV_ENABLED] = prev;
      } else {
        delete process.env[ENV_ENABLED];
      }
    }
  });
});

// ---------------------------------------------------------------------------
// extractRecoveryTarget
// ---------------------------------------------------------------------------

describe("extractRecoveryTarget", () => {
  test("extracts owner/repo/prNumber/headSha/prAuthorLogin from a well-formed row", () => {
    const target = extractRecoveryTarget(buildRow());
    expect(target).toEqual({
      owner: "edobry",
      repo: "minsky",
      prNumber: 42,
      headSha: "abc123",
      prAuthorLogin: "author",
    });
  });

  test("returns null when owner is missing", () => {
    const row = buildRow({
      body: {
        pull_request: { number: 1, head: { sha: "x" } },
        repository: { name: "minsky" },
      } as unknown as Record<string, unknown>,
    });
    expect(extractRecoveryTarget(row)).toBeNull();
  });

  test("returns null when headSha is missing", () => {
    const row = buildRow({
      body: {
        pull_request: { number: 1, user: { login: "a" } },
        repository: { owner: { login: "o" }, name: "r" },
      } as unknown as Record<string, unknown>,
    });
    expect(extractRecoveryTarget(row)).toBeNull();
  });

  test("defaults prAuthorLogin to 'unknown' when absent", () => {
    const row = buildRow({
      body: {
        pull_request: { number: 1, head: { sha: "x" } },
        repository: { owner: { login: "o" }, name: "r" },
      } as unknown as Record<string, unknown>,
    });
    const target = extractRecoveryTarget(row);
    expect(target?.prAuthorLogin).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// recoverPendingReviews
// ---------------------------------------------------------------------------

describe("recoverPendingReviews", () => {
  test("disabled config: returns zero counts, never queries", async () => {
    let selectCalled = false;
    const db = {
      select: () => {
        selectCalled = true;
        return { from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) };
      },
    };
    const runReviewFn: RunReviewFn = (async () => ({
      status: "reviewed",
      reason: "n/a",
      tier: 3,
    })) as unknown as RunReviewFn;

    const result = await recoverPendingReviews(
      db as never,
      BASE_CONFIG,
      { ...ENABLED_CFG, enabled: false },
      runReviewFn
    );

    expect(result).toEqual({ candidates: 0, dispatched: 0, malformed: 0 });
    expect(selectCalled).toBe(false);
  });

  test("no candidate rows: returns zero counts", async () => {
    const { db } = buildStubDb([]);
    const runReviewFn: RunReviewFn = (async () => ({
      status: "reviewed",
      reason: "n/a",
      tier: 3,
    })) as unknown as RunReviewFn;

    const result = await recoverPendingReviews(db as never, BASE_CONFIG, ENABLED_CFG, runReviewFn);
    expect(result).toEqual({ candidates: 0, dispatched: 0, malformed: 0 });
  });

  test("query error: returns zero counts, does not throw", async () => {
    const { db } = buildStubDb([], { selectThrows: true });
    const runReviewFn: RunReviewFn = (async () => ({
      status: "reviewed",
      reason: "n/a",
      tier: 3,
    })) as unknown as RunReviewFn;

    await expect(
      recoverPendingReviews(db as never, BASE_CONFIG, ENABLED_CFG, runReviewFn)
    ).resolves.toEqual({ candidates: 0, dispatched: 0, malformed: 0 });
  });

  test("passes maxRows through to the query's .limit() call", async () => {
    const { db, getCapturedLimit } = buildStubDb([]);
    const runReviewFn: RunReviewFn = (async () => ({
      status: "reviewed",
      reason: "n/a",
      tier: 3,
    })) as unknown as RunReviewFn;

    await recoverPendingReviews(
      db as never,
      BASE_CONFIG,
      { ...ENABLED_CFG, maxRows: 7 },
      runReviewFn
    );
    expect(getCapturedLimit()).toBe(7);
  });

  test("well-formed row: dispatches via runReviewFn with a recovered-<id> delivery id, persists review_submitted on success", async () => {
    const row = buildRow({ deliveryId: "orig-1" });
    const { db, setCalls } = buildStubDb([row]);

    const calls: Array<{
      owner: string;
      repo: string;
      prNumber: number;
      deliveryId: string;
      headSha: string;
    }> = [];
    const runReviewFn: RunReviewFn = async (
      _config,
      owner,
      repo,
      prNumber,
      _prAuthorLogin,
      deliveryId,
      headSha
    ) => {
      calls.push({
        owner,
        repo,
        prNumber,
        deliveryId: deliveryId ?? "unknown",
        headSha: headSha ?? "",
      });
      return { status: "reviewed", reason: "ok", tier: 3 } satisfies ReviewResult;
    };

    const result = await recoverPendingReviews(db as never, BASE_CONFIG, ENABLED_CFG, runReviewFn);

    expect(result).toEqual({ candidates: 1, dispatched: 1, malformed: 0 });
    expect(calls.length).toBe(1);
    expect(calls[0]?.deliveryId).toBe("recovered-orig-1");
    expect(calls[0]?.owner).toBe("edobry");
    expect(calls[0]?.repo).toBe("minsky");
    expect(calls[0]?.prNumber).toBe(42);
    expect(calls[0]?.headSha).toBe("abc123");

    await flush();
    expect(setCalls.length).toBe(1);
    expect(setCalls[0]?.payload["outcome"]).toBe("review_submitted");
  });

  test("malformed row (missing required fields): counted as malformed, never dispatched", async () => {
    const badRow = buildRow({
      deliveryId: "bad-1",
      body: { repository: { owner: { login: "o" }, name: "r" } } as unknown as Record<
        string,
        unknown
      >,
    });
    const { db, setCalls } = buildStubDb([badRow]);
    let dispatchedCount = 0;
    const runReviewFn: RunReviewFn = (async () => {
      dispatchedCount++;
      return { status: "reviewed", reason: "ok", tier: 3 } satisfies ReviewResult;
    }) as unknown as RunReviewFn;

    const result = await recoverPendingReviews(db as never, BASE_CONFIG, ENABLED_CFG, runReviewFn);
    expect(result).toEqual({ candidates: 1, dispatched: 0, malformed: 1 });
    expect(dispatchedCount).toBe(0);

    await flush();
    expect(setCalls.length).toBe(0);
  });

  test("concurrent_inflight skip: does NOT call updateOutcome (leaves the row for its real owner)", async () => {
    const row = buildRow({ deliveryId: "orig-2" });
    const { db, setCalls } = buildStubDb([row]);
    const runReviewFn: RunReviewFn = (async () =>
      ({
        status: "skipped",
        reason: "concurrent_inflight",
        tier: 3,
      }) satisfies ReviewResult) as unknown as RunReviewFn;

    const result = await recoverPendingReviews(db as never, BASE_CONFIG, ENABLED_CFG, runReviewFn);
    expect(result.dispatched).toBe(1);

    await flush();
    expect(setCalls.length).toBe(0);
  });

  test("review error status: persists failed_at_reviewer with error details", async () => {
    const row = buildRow({ deliveryId: "orig-3" });
    const { db, setCalls } = buildStubDb([row]);
    const runReviewFn: RunReviewFn = (async () =>
      ({
        status: "error",
        reason: "boom",
        tier: 3,
      }) satisfies ReviewResult) as unknown as RunReviewFn;

    await recoverPendingReviews(db as never, BASE_CONFIG, ENABLED_CFG, runReviewFn);
    await flush();

    expect(setCalls.length).toBe(1);
    expect(setCalls[0]?.payload["outcome"]).toBe("failed_at_reviewer");
    const errorDetails = setCalls[0]?.payload["errorDetails"] as Record<string, unknown>;
    expect(errorDetails["message"]).toBe("boom");
    expect(errorDetails["stage"]).toBe("boot_recovery");
  });

  test("runReviewFn throws: persists failed_at_reviewer, does not propagate", async () => {
    const row = buildRow({ deliveryId: "orig-4" });
    const { db, setCalls } = buildStubDb([row]);
    const runReviewFn: RunReviewFn = (async () => {
      throw new Error("network blew up");
    }) as unknown as RunReviewFn;

    await expect(
      recoverPendingReviews(db as never, BASE_CONFIG, ENABLED_CFG, runReviewFn)
    ).resolves.toEqual({ candidates: 1, dispatched: 1, malformed: 0 });

    await flush();
    expect(setCalls.length).toBe(1);
    expect(setCalls[0]?.payload["outcome"]).toBe("failed_at_reviewer");
    const errorDetails = setCalls[0]?.payload["errorDetails"] as Record<string, unknown>;
    expect(errorDetails["message"]).toBe("network blew up");
  });

  test("skipped (non-concurrent) status: persists skipped outcome", async () => {
    const row = buildRow({ deliveryId: "orig-5" });
    const { db, setCalls } = buildStubDb([row]);
    const runReviewFn: RunReviewFn = (async () =>
      ({
        status: "skipped",
        reason: "tier_routing_skip",
        tier: 3,
      }) satisfies ReviewResult) as unknown as RunReviewFn;

    await recoverPendingReviews(db as never, BASE_CONFIG, ENABLED_CFG, runReviewFn);
    await flush();

    expect(setCalls.length).toBe(1);
    expect(setCalls[0]?.payload["outcome"]).toBe("skipped");
  });
});
