import { describe, test, expect } from "bun:test";
import { deriveSessionLiveness, SessionStatus } from "./types";

// Use a fixed reference time so tests don't depend on current wall-clock time.
// deriveSessionLiveness compares timestamps with Date.now() internally, so the
// offsets below need to be calculated relative to Date.now() at call time.
describe("deriveSessionLiveness", () => {
  test("returns healthy for recently active session", () => {
    const now = new Date().toISOString();
    expect(
      deriveSessionLiveness({
        lastActivityAt: now,
        status: SessionStatus.ACTIVE,
        createdAt: now,
      })
    ).toBe("healthy");
  });

  test("returns idle for session inactive > 30 min", () => {
    const referenceNow = new Date().getTime();
    const thirtyOneMinAgo = new Date(referenceNow - 31 * 60 * 1000).toISOString();
    expect(
      deriveSessionLiveness({
        lastActivityAt: thirtyOneMinAgo,
        status: SessionStatus.ACTIVE,
        createdAt: thirtyOneMinAgo,
      })
    ).toBe("idle");
  });

  test("returns stale for session inactive > 2 hours", () => {
    const referenceNow = new Date().getTime();
    const threeHoursAgo = new Date(referenceNow - 3 * 60 * 60 * 1000).toISOString();
    expect(
      deriveSessionLiveness({
        lastActivityAt: threeHoursAgo,
        status: SessionStatus.ACTIVE,
        createdAt: threeHoursAgo,
      })
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
    const referenceNow = new Date().getTime();
    const fiveMinAgo = new Date(referenceNow - 5 * 60 * 1000).toISOString();
    expect(
      deriveSessionLiveness(
        { lastActivityAt: fiveMinAgo, status: SessionStatus.ACTIVE, createdAt: fiveMinAgo },
        { idleThresholdMs: 3 * 60 * 1000 }
      )
    ).toBe("idle");
  });
});
