import { describe, test, expect } from "bun:test";
import { isPgPoolExhaustionError, withPgPoolRetry } from "./postgres-retry";

// Supavisor's saturation message — duplicated in real error paths, so tests
// centralize it here rather than repeating the literal string per case.
const SUPAVISOR_SATURATION_MESSAGE = "max clients reached";

describe("isPgPoolExhaustionError", () => {
  test("matches PG SQLSTATE 53300", () => {
    expect(isPgPoolExhaustionError({ code: "53300", message: "too_many_connections" })).toBe(true);
  });

  test("matches Supavisor 'max clients reached' with XX000", () => {
    expect(
      isPgPoolExhaustionError({
        code: "XX000",
        message: `${SUPAVISOR_SATURATION_MESSAGE} in session mode — max clients are limited to pool_size: 15`,
      })
    ).toBe(true);
  });

  test("matches 'max clients reached' without code", () => {
    expect(isPgPoolExhaustionError(new Error(SUPAVISOR_SATURATION_MESSAGE))).toBe(true);
  });

  test("matches 'too_many_connections' string", () => {
    expect(isPgPoolExhaustionError(new Error("FATAL: too_many_connections"))).toBe(true);
  });

  test("rejects unrelated errors", () => {
    expect(isPgPoolExhaustionError(new Error("syntax error"))).toBe(false);
    expect(isPgPoolExhaustionError({ code: "42601" })).toBe(false);
    expect(isPgPoolExhaustionError(null)).toBe(false);
    expect(isPgPoolExhaustionError(undefined)).toBe(false);
    expect(isPgPoolExhaustionError("string error")).toBe(false);
  });

  test("rejects errors with a non-null `query` value (query already reached server)", () => {
    // postgres-js attaches `query` as a defined string when the query was
    // transmitted to the server — retrying could double-apply mutations.
    // Must be rejected even if the message matches.
    expect(
      isPgPoolExhaustionError({
        code: "XX000",
        message: SUPAVISOR_SATURATION_MESSAGE,
        query: "SELECT 1",
      })
    ).toBe(false);
  });

  test("matches PgBouncer 'sorry, too many clients already'", () => {
    expect(isPgPoolExhaustionError(new Error("FATAL: sorry, too many clients already"))).toBe(true);
  });

  test("rejects errors with empty-string `query` field (defense against ambiguous wrapper output)", () => {
    // A wrapper that sets `query: ""` (e.g. sanitization) is ambiguous about
    // whether the query reached the server. We err on the safe side and reject;
    // empty string is truthy enough to fail the `!= null` check.
    expect(
      isPgPoolExhaustionError({
        code: "53300",
        message: SUPAVISOR_SATURATION_MESSAGE,
        query: "",
      })
    ).toBe(false);
  });

  test("matches errors with `query: undefined` (postgres-js connection-acquisition shape, mt#1461 regression test)", () => {
    // postgres-js attaches `query` as an own-property to ALL `PostgresError`
    // instances, with value `undefined` for pre-send errors (connection
    // acquisition failures, including pool saturation). The original mt#1193
    // logic used `"query" in e` (presence check), which returned true here
    // and silently rejected every real PostgresError. mt#1461 corrects to
    // `e.query != null` so undefined passes through to the code/message check.
    expect(
      isPgPoolExhaustionError({
        code: "53300",
        message: "sorry, too many clients already",
        query: undefined,
      })
    ).toBe(true);
  });

  test("matches errors with `query: null` (defensive: null also indicates pre-send)", () => {
    // Some wrappers may set `query: null` instead of `undefined`. Both should
    // pass the guard since neither indicates a transmitted query.
    expect(
      isPgPoolExhaustionError({
        code: "XX000",
        message: SUPAVISOR_SATURATION_MESSAGE,
        query: null,
      })
    ).toBe(true);
  });
});

describe("withPgPoolRetry", () => {
  test("returns result on first success without retrying", async () => {
    let calls = 0;
    const result = await withPgPoolRetry(async () => {
      calls += 1;
      return 42;
    }, "test.first-success");
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  test("retries on pool-exhaustion error then succeeds", async () => {
    let calls = 0;
    const result = await withPgPoolRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          const err = new Error(SUPAVISOR_SATURATION_MESSAGE) as Error & { code: string };
          err.code = "XX000";
          throw err;
        }
        return "ok";
      },
      "test.retry-then-succeed",
      { initialDelayMs: 1, maxDelayMs: 4 }
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("does not retry non-pool errors", async () => {
    let calls = 0;
    await expect(
      withPgPoolRetry(
        async () => {
          calls += 1;
          throw new Error("unrelated");
        },
        "test.no-retry",
        { initialDelayMs: 1 }
      )
    ).rejects.toThrow("unrelated");
    expect(calls).toBe(1);
  });

  test("gives up after maxAttempts and rethrows", async () => {
    let calls = 0;
    await expect(
      withPgPoolRetry(
        async () => {
          calls += 1;
          throw new Error(SUPAVISOR_SATURATION_MESSAGE);
        },
        "test.exhaust",
        { maxAttempts: 2, initialDelayMs: 1 }
      )
    ).rejects.toThrow(SUPAVISOR_SATURATION_MESSAGE);
    expect(calls).toBe(2);
  });

  test("retries postgres-js-shaped errors with `query: undefined` (mt#1461 regression)", async () => {
    // End-to-end check that the guard fix flows into the retry loop:
    // a synthetic postgres-js-shaped error (with `query: undefined` as an
    // own-property, matching the real shape captured during the mt#1461
    // incident) must trigger retries, not the silent no-op of the prior bug.
    let calls = 0;
    const result = await withPgPoolRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          const err = Object.assign(new Error("sorry, too many clients already"), {
            code: "53300",
            query: undefined,
          });
          throw err;
        }
        return "ok";
      },
      "test.mt1461-regression",
      { initialDelayMs: 1, maxDelayMs: 4 }
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });
});

describe("withPgPoolRetry backoff timing", () => {
  test("jitter=0 produces delay at 0.8× base", async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    // Capture setTimeout delay arguments without actually waiting
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
      fn: () => void,
      ms: number
    ) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0);
    }) as typeof setTimeout;

    try {
      let calls = 0;
      await withPgPoolRetry(
        async () => {
          calls += 1;
          if (calls < 2) throw new Error(SUPAVISOR_SATURATION_MESSAGE);
          return "ok";
        },
        "test.jitter-low",
        { initialDelayMs: 100, maxDelayMs: 1000, jitter: () => 0 }
      );
      // base = 100 * 2^0 = 100; multiplier = 0.8 + 0 * 0.4 = 0.8 → delay = 80
      expect(delays[0]).toBe(80);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("jitter=0.9999 produces delay near 1.2× base", async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
      fn: () => void,
      ms: number
    ) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0);
    }) as typeof setTimeout;

    try {
      let calls = 0;
      await withPgPoolRetry(
        async () => {
          calls += 1;
          if (calls < 2) throw new Error(SUPAVISOR_SATURATION_MESSAGE);
          return "ok";
        },
        "test.jitter-high",
        { initialDelayMs: 100, maxDelayMs: 1000, jitter: () => 0.9999 }
      );
      // base = 100; multiplier ≈ 0.8 + 0.9999 * 0.4 ≈ 1.19996 → delay ≈ 120
      expect(delays[0]).toBeGreaterThanOrEqual(119);
      expect(delays[0]).toBeLessThanOrEqual(120);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
