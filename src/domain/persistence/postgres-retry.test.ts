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
});
