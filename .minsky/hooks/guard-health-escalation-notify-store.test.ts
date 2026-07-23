// Tests for guard-health-escalation-notify-store.ts (mt#3072 SC3).

import { describe, test, expect } from "bun:test";
import {
  escalationSignature,
  shouldNotifyEscalation,
  ESCALATION_NOTIFY_COOLDOWN_MS,
} from "./guard-health-escalation-notify-store";
import type { GuardHealthSummary } from "./guard-health";

function summaryWithCritical(
  guardName: string,
  lastEventTimestamp: string,
  lastEventMessage: string
): GuardHealthSummary {
  return {
    byGuard: {
      [guardName]: {
        failureCount24h: 3,
        failureCount7d: 3,
        consecutiveStreak: 3,
        lastEvent: {
          timestamp: lastEventTimestamp,
          guardName,
          event: "PreToolUse",
          kind: "check-skip",
          message: lastEventMessage,
        },
        escalation: "critical",
      },
    },
    criticalGuards: [guardName],
    attentionGuards: [],
    escalation: "critical",
  };
}

// In-memory fs stub — avoids real fs entirely for the pure-decision tests
// below (the "real fs" integration coverage lives in the escalation
// detector's own test file, mirroring guard-health-write-isolation.test.ts's
// division of concerns).
function memoryFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    fs: {
      existsSync: (p: string) => files.has(p) || dirs.has(p),
      mkdirSync: (p: string) => {
        dirs.add(p);
      },
      readFileSync: (p: string) => {
        const content = files.get(p);
        if (content === undefined) throw new Error(`ENOENT: ${p}`);
        return content;
      },
      writeFileSync: (p: string, data: string) => {
        files.set(p, data);
      },
    },
  };
}

describe("escalationSignature", () => {
  test("composes guardName:timestamp:message per critical guard, sorted", () => {
    const summary: GuardHealthSummary = {
      byGuard: {
        b: {
          failureCount24h: 1,
          failureCount7d: 1,
          consecutiveStreak: 3,
          lastEvent: {
            timestamp: "2026-07-01T00:00:00Z",
            guardName: "b",
            event: "PreToolUse",
            kind: "error",
            message: "boom-b",
          },
          escalation: "critical",
        },
        a: {
          failureCount24h: 1,
          failureCount7d: 1,
          consecutiveStreak: 3,
          lastEvent: {
            timestamp: "2026-07-01T00:00:01Z",
            guardName: "a",
            event: "PreToolUse",
            kind: "error",
            message: "boom-a",
          },
          escalation: "critical",
        },
      },
      criticalGuards: ["b", "a"],
      attentionGuards: [],
      escalation: "critical",
    };
    expect(escalationSignature(summary)).toBe(
      "a:2026-07-01T00:00:01Z:boom-a|b:2026-07-01T00:00:00Z:boom-b"
    );
  });

  test("is stable across two summaries with the SAME critical state (order-independent)", () => {
    const s1 = summaryWithCritical("g", "2026-07-01T00:00:00Z", "same failure");
    const s2 = summaryWithCritical("g", "2026-07-01T00:00:00Z", "same failure");
    expect(escalationSignature(s1)).toBe(escalationSignature(s2));
  });

  test("changes when the last event's timestamp/message changes (a new failure)", () => {
    const s1 = summaryWithCritical("g", "2026-07-01T00:00:00Z", "first failure");
    const s2 = summaryWithCritical("g", "2026-07-02T00:00:00Z", "second failure");
    expect(escalationSignature(s1)).not.toBe(escalationSignature(s2));
  });

  test("empty when there are no critical guards", () => {
    const summary: GuardHealthSummary = {
      byGuard: {},
      criticalGuards: [],
      attentionGuards: [],
      escalation: "none",
    };
    expect(escalationSignature(summary)).toBe("");
  });
});

describe("shouldNotifyEscalation (mt#3072 SC3 — cooldown/dedup)", () => {
  test("surfaces on the FIRST call for a session (no prior record)", () => {
    const { fs } = memoryFs();
    const now = new Date("2026-07-19T00:00:00Z");
    expect(shouldNotifyEscalation("sess-1", "sig-A", { fs, now: () => now, dir: "/store" })).toBe(
      true
    );
  });

  test("SUPPRESSES a repeat of the SAME signature within the cooldown window", () => {
    const { fs } = memoryFs();
    const t0 = new Date("2026-07-19T00:00:00Z");
    expect(shouldNotifyEscalation("sess-1", "sig-A", { fs, now: () => t0, dir: "/store" })).toBe(
      true
    );
    const t1 = new Date(t0.getTime() + 5 * 60 * 1000); // 5 minutes later
    expect(shouldNotifyEscalation("sess-1", "sig-A", { fs, now: () => t1, dir: "/store" })).toBe(
      false
    );
  });

  test("resurfaces once the cooldown elapses for the SAME signature", () => {
    const { fs } = memoryFs();
    const t0 = new Date("2026-07-19T00:00:00Z");
    expect(shouldNotifyEscalation("sess-1", "sig-A", { fs, now: () => t0, dir: "/store" })).toBe(
      true
    );
    const tAfter = new Date(t0.getTime() + ESCALATION_NOTIFY_COOLDOWN_MS + 1);
    expect(
      shouldNotifyEscalation("sess-1", "sig-A", { fs, now: () => tAfter, dir: "/store" })
    ).toBe(true);
  });

  test("resurfaces IMMEDIATELY for a DIFFERENT signature, even mid-cooldown (a new failure)", () => {
    const { fs } = memoryFs();
    const t0 = new Date("2026-07-19T00:00:00Z");
    expect(shouldNotifyEscalation("sess-1", "sig-A", { fs, now: () => t0, dir: "/store" })).toBe(
      true
    );
    const t1 = new Date(t0.getTime() + 60 * 1000); // 1 minute later — well within cooldown
    expect(shouldNotifyEscalation("sess-1", "sig-B", { fs, now: () => t1, dir: "/store" })).toBe(
      true
    );
  });

  test("a sustained failure across MANY consecutive calls surfaces far below every-turn (mt#3072 AT2)", () => {
    const { fs } = memoryFs();
    const t0 = new Date("2026-07-19T00:00:00Z").getTime();
    let surfaced = 0;
    const TURNS = 20;
    // Simulate 20 consecutive turns, one every ~5 minutes, with the identical
    // persisting critical-escalation signature (the standalone-duplicate-
    // matcher incident's actual shape: the SAME known cause, unchanged,
    // across many turns).
    for (let i = 0; i < TURNS; i++) {
      const now = new Date(t0 + i * 5 * 60 * 1000);
      const surfacedThisTurn = shouldNotifyEscalation("sess-sustained", "sig-sustained", {
        fs,
        now: () => now,
        dir: "/store",
      });
      if (surfacedThisTurn) {
        surfaced++;
      }
    }
    // 20 turns over 100 minutes, 1h cooldown -> at most 2 surfaces (turn 0,
    // and once more after the cooldown elapses ~turn 12); nowhere near the
    // 385/697 (55%) every-turn rate the incident produced.
    expect(surfaced).toBeLessThanOrEqual(2);
    expect(surfaced / TURNS).toBeLessThan(0.55);
  });

  test("two session ids that collide under naive char-sanitization get INDEPENDENT cooldowns (reviewer finding)", () => {
    // "sess:1" and "sess/1" both sanitize to "sess_1" under a plain
    // [^A-Za-z0-9_-] -> "_" replace -- the store must not let one clobber the
    // other's cooldown state.
    const { fs, files } = memoryFs();
    const t0 = new Date("2026-07-19T00:00:00Z");
    expect(shouldNotifyEscalation("sess:1", "sig-A", { fs, now: () => t0, dir: "/store" })).toBe(
      true
    );
    // A different session whose sanitized form would collide must still see
    // a FIRST-time surface, not be treated as "already surfaced" via sess:1's
    // record.
    expect(shouldNotifyEscalation("sess/1", "sig-A", { fs, now: () => t0, dir: "/store" })).toBe(
      true
    );
    expect(files.size).toBe(2);
  });

  test("a DIFFERENT session gets its own independent cooldown (per-session scope)", () => {
    const { fs } = memoryFs();
    const t0 = new Date("2026-07-19T00:00:00Z");
    expect(shouldNotifyEscalation("sess-1", "sig-A", { fs, now: () => t0, dir: "/store" })).toBe(
      true
    );
    // A brand-new conversation must still see the warning at least once,
    // even though sess-1's cooldown is running.
    expect(shouldNotifyEscalation("sess-2", "sig-A", { fs, now: () => t0, dir: "/store" })).toBe(
      true
    );
  });

  test("fails OPEN (surfaces) when the store read throws", () => {
    const fs = {
      existsSync: () => true,
      mkdirSync: () => {},
      readFileSync: () => {
        throw new Error("EACCES");
      },
      writeFileSync: () => {},
    };
    expect(shouldNotifyEscalation("sess-1", "sig-A", { fs, dir: "/store" })).toBe(true);
  });

  test("fails OPEN (still returns true) when the store write throws", () => {
    const fs = {
      existsSync: () => false,
      mkdirSync: () => {},
      readFileSync: () => "",
      writeFileSync: () => {
        throw new Error("ENOSPC");
      },
    };
    expect(shouldNotifyEscalation("sess-1", "sig-A", { fs, dir: "/store" })).toBe(true);
  });
});
