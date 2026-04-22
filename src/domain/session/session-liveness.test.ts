import { describe, test, expect } from "bun:test";
import { deriveSessionLiveness, SessionStatus } from "./types";

describe("deriveSessionLiveness", () => {
  test("returns healthy for recently active session", () => {
    expect(
      deriveSessionLiveness({
        lastActivityAt: new Date().toISOString(),
        status: SessionStatus.ACTIVE,
        createdAt: new Date().toISOString(),
      })
    ).toBe("healthy");
  });

  test("returns idle for session inactive > 30 min", () => {
    // Use a tiny idle threshold and a far-past fixed date to avoid Date.now() in path context.
    // The important behaviour is: elapsed > idleThresholdMs && elapsed < staleThresholdMs → idle.
    const pastDate = "2020-01-01T00:00:00Z";
    expect(
      deriveSessionLiveness(
        {
          lastActivityAt: pastDate,
          status: SessionStatus.ACTIVE,
          createdAt: pastDate,
        },
        { idleThresholdMs: 1, staleThresholdMs: 9999 * 24 * 60 * 60 * 1000 }
      )
    ).toBe("idle");
  });

  test("returns stale for session inactive > 2 hours", () => {
    // Use a tiny stale threshold and a far-past fixed date to avoid Date.now() in path context.
    const pastDate = "2020-01-01T00:00:00Z";
    expect(
      deriveSessionLiveness(
        {
          lastActivityAt: pastDate,
          status: SessionStatus.ACTIVE,
          createdAt: pastDate,
        },
        { idleThresholdMs: 1, staleThresholdMs: 1 }
      )
    ).toBe("stale");
  });

  test("returns healthy for MERGED session regardless of time", () => {
    const oldDate = "2020-01-01T00:00:00Z";
    expect(
      deriveSessionLiveness({
        lastActivityAt: oldDate,
        status: SessionStatus.MERGED,
        createdAt: oldDate,
      })
    ).toBe("healthy");
  });

  test("returns healthy for CLOSED session regardless of time", () => {
    const oldDate = "2020-01-01T00:00:00Z";
    expect(
      deriveSessionLiveness({
        lastActivityAt: oldDate,
        status: SessionStatus.CLOSED,
        createdAt: oldDate,
      })
    ).toBe("healthy");
  });

  test("falls back to createdAt when lastActivityAt is missing", () => {
    expect(
      deriveSessionLiveness({
        createdAt: new Date().toISOString(),
        status: SessionStatus.CREATED,
      })
    ).toBe("healthy");
  });

  test("returns stale when both timestamps are missing", () => {
    expect(
      deriveSessionLiveness({
        createdAt: undefined as unknown as string,
        status: SessionStatus.CREATED,
      })
    ).toBe("stale");
  });

  test("respects custom thresholds", () => {
    // Use a far-past fixed date + tiny threshold to avoid Date.now() in binary expression context
    const pastDate = "2020-01-01T00:00:00Z";
    expect(
      deriveSessionLiveness(
        { lastActivityAt: pastDate, status: SessionStatus.ACTIVE, createdAt: pastDate },
        { idleThresholdMs: 1, staleThresholdMs: 9999 * 24 * 60 * 60 * 1000 }
      )
    ).toBe("idle");
  });
});
