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
    const thirtyOneMinAgo = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    expect(
      deriveSessionLiveness({
        lastActivityAt: thirtyOneMinAgo,
        status: SessionStatus.ACTIVE,
        createdAt: thirtyOneMinAgo,
      })
    ).toBe("idle");
  });

  test("returns stale for session inactive > 2 hours", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
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
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(
      deriveSessionLiveness(
        { lastActivityAt: fiveMinAgo, status: SessionStatus.ACTIVE, createdAt: fiveMinAgo },
        { idleThresholdMs: 3 * 60 * 1000 }
      )
    ).toBe("idle");
  });
});
