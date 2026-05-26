/**
 * Tests for pendingAsksForWindow query and helpers — mt#1490.
 *
 * All tests use FakeAskRepository — hermetic, no DB required.
 * Tests cover:
 *   - isEligibleForWindow predicate
 *   - compareAskPriority sort order
 *   - pendingAsksForWindow integration
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { FakeAskRepository } from "./repository";
import type { Ask } from "./types";
import {
  isEligibleForWindow,
  compareAskPriority,
  pendingAsksForWindow,
} from "./pending-asks-for-window";
import { PAGE_THRESHOLD_MS } from "./router";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_NOW_MS = new Date("2025-01-15T12:00:00.000Z").getTime();
const WINDOW_KEY = "ask-hours";
const REQUESTOR = "test-agent:proc:abc123";
const KIND_DIR_DECIDE = "direction.decide" as const;
const KIND_STUCK_UNBLOCK = "stuck.unblock" as const;
const KIND_AUTH_APPROVE = "authorization.approve" as const;
const KIND_QUALITY_REVIEW = "quality.review" as const;
const KIND_COORD_NOTIFY = "coordination.notify" as const;

function makeSuspendedAsk(overrides: Partial<Ask> = {}): Ask {
  return {
    id: `ask-${Math.random().toString(36).slice(2, 8)}`,
    kind: KIND_DIR_DECIDE,
    classifierVersion: "v1",
    requestor: REQUESTOR,
    state: "suspended",
    title: "Test ask",
    question: "What direction?",
    createdAt: new Date(BASE_NOW_MS - 60_000).toISOString(), // 1min ago
    serviceStrategy: "scheduled",
    windowKey: WINDOW_KEY,
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isEligibleForWindow
// ---------------------------------------------------------------------------

describe("isEligibleForWindow", () => {
  describe("state filter", () => {
    it("returns true for suspended Asks", () => {
      const ask = makeSuspendedAsk({ state: "suspended" });
      expect(isEligibleForWindow(ask, WINDOW_KEY, BASE_NOW_MS)).toBe(true);
    });

    it("returns true for routed Asks", () => {
      const ask = makeSuspendedAsk({ state: "routed" });
      expect(isEligibleForWindow(ask, WINDOW_KEY, BASE_NOW_MS)).toBe(true);
    });

    it("returns false for detected state", () => {
      const ask = makeSuspendedAsk({ state: "detected" });
      expect(isEligibleForWindow(ask, WINDOW_KEY, BASE_NOW_MS)).toBe(false);
    });

    it("returns false for closed state", () => {
      const ask = makeSuspendedAsk({ state: "closed" });
      expect(isEligibleForWindow(ask, WINDOW_KEY, BASE_NOW_MS)).toBe(false);
    });

    it("returns false for responded state", () => {
      const ask = makeSuspendedAsk({ state: "responded" });
      expect(isEligibleForWindow(ask, WINDOW_KEY, BASE_NOW_MS)).toBe(false);
    });
  });

  describe("scheduled strategy (condition a)", () => {
    it("returns true when strategy is scheduled and windowKey matches", () => {
      const ask = makeSuspendedAsk({
        serviceStrategy: "scheduled",
        windowKey: WINDOW_KEY,
      });
      expect(isEligibleForWindow(ask, WINDOW_KEY, BASE_NOW_MS)).toBe(true);
    });

    it("returns false when strategy is scheduled but windowKey does not match", () => {
      const ask = makeSuspendedAsk({
        serviceStrategy: "scheduled",
        windowKey: "weekly-review",
      });
      expect(isEligibleForWindow(ask, WINDOW_KEY, BASE_NOW_MS)).toBe(false);
    });

    it("returns false when strategy is scheduled and windowKey is absent", () => {
      const ask = makeSuspendedAsk({
        serviceStrategy: "scheduled",
        windowKey: undefined,
      });
      expect(isEligibleForWindow(ask, WINDOW_KEY, BASE_NOW_MS)).toBe(false);
    });
  });

  describe("deadline-bound strategy (condition b)", () => {
    it("returns true when deadline-bound and deadline is within PAGE_THRESHOLD", () => {
      const ask = makeSuspendedAsk({
        serviceStrategy: "deadline-bound",
        windowKey: undefined,
        deadline: new Date(BASE_NOW_MS + 14 * 60 * 1000).toISOString(), // 14min from now
      });
      expect(isEligibleForWindow(ask, WINDOW_KEY, BASE_NOW_MS)).toBe(true);
    });

    it("returns true when deadline is exactly at PAGE_THRESHOLD", () => {
      const ask = makeSuspendedAsk({
        serviceStrategy: "deadline-bound",
        windowKey: undefined,
        deadline: new Date(BASE_NOW_MS + PAGE_THRESHOLD_MS).toISOString(),
      });
      expect(isEligibleForWindow(ask, WINDOW_KEY, BASE_NOW_MS)).toBe(true);
    });

    it("returns false when deadline-bound but deadline is beyond threshold", () => {
      const ask = makeSuspendedAsk({
        serviceStrategy: "deadline-bound",
        windowKey: undefined,
        deadline: new Date(BASE_NOW_MS + 60 * 60 * 1000).toISOString(), // 1 hour
      });
      expect(isEligibleForWindow(ask, WINDOW_KEY, BASE_NOW_MS)).toBe(false);
    });

    it("returns false when deadline-bound and no deadline is set", () => {
      const ask = makeSuspendedAsk({
        serviceStrategy: "deadline-bound",
        windowKey: undefined,
        deadline: undefined,
      });
      expect(isEligibleForWindow(ask, WINDOW_KEY, BASE_NOW_MS)).toBe(false);
    });
  });

  describe("pinnedToWindow metadata (condition c)", () => {
    it("returns true when metadata.pinnedToWindow matches the window key", () => {
      const ask = makeSuspendedAsk({
        serviceStrategy: "asap", // normally would not be eligible
        windowKey: undefined,
        metadata: { pinnedToWindow: WINDOW_KEY },
      });
      expect(isEligibleForWindow(ask, WINDOW_KEY, BASE_NOW_MS)).toBe(true);
    });

    it("returns false when metadata.pinnedToWindow does not match", () => {
      const ask = makeSuspendedAsk({
        serviceStrategy: "asap",
        windowKey: undefined,
        metadata: { pinnedToWindow: "other-window" },
      });
      expect(isEligibleForWindow(ask, WINDOW_KEY, BASE_NOW_MS)).toBe(false);
    });

    it("returns false when metadata.pinnedToWindow is absent", () => {
      const ask = makeSuspendedAsk({
        serviceStrategy: "asap",
        windowKey: undefined,
        metadata: {},
      });
      expect(isEligibleForWindow(ask, WINDOW_KEY, BASE_NOW_MS)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// compareAskPriority
// ---------------------------------------------------------------------------

describe("compareAskPriority", () => {
  it("sorts stuck.unblock before authorization.approve", () => {
    const a = makeSuspendedAsk({ kind: KIND_STUCK_UNBLOCK });
    const b = makeSuspendedAsk({ kind: KIND_AUTH_APPROVE });
    expect(compareAskPriority(a, b)).toBeLessThan(0);
  });

  it("sorts authorization.approve before direction.decide", () => {
    const a = makeSuspendedAsk({ kind: KIND_AUTH_APPROVE });
    const b = makeSuspendedAsk({ kind: KIND_DIR_DECIDE });
    expect(compareAskPriority(a, b)).toBeLessThan(0);
  });

  it("sorts direction.decide before quality.review", () => {
    const a = makeSuspendedAsk({ kind: KIND_DIR_DECIDE });
    const b = makeSuspendedAsk({ kind: KIND_QUALITY_REVIEW });
    expect(compareAskPriority(a, b)).toBeLessThan(0);
  });

  it("sorts quality.review before coordination.notify", () => {
    const a = makeSuspendedAsk({ kind: KIND_QUALITY_REVIEW });
    const b = makeSuspendedAsk({ kind: KIND_COORD_NOTIFY });
    expect(compareAskPriority(a, b)).toBeLessThan(0);
  });

  it("sorts by deadline urgency within same kind (earlier deadline first)", () => {
    const earlyDeadline = new Date(BASE_NOW_MS + 30 * 60 * 1000).toISOString();
    const lateDeadline = new Date(BASE_NOW_MS + 4 * 60 * 60 * 1000).toISOString();

    const a = makeSuspendedAsk({ kind: KIND_DIR_DECIDE, deadline: earlyDeadline });
    const b = makeSuspendedAsk({ kind: KIND_DIR_DECIDE, deadline: lateDeadline });

    expect(compareAskPriority(a, b)).toBeLessThan(0);
  });

  it("sorts no-deadline after deadline (infinity sort)", () => {
    const withDeadline = makeSuspendedAsk({
      kind: KIND_DIR_DECIDE,
      deadline: new Date(BASE_NOW_MS + 2 * 60 * 60 * 1000).toISOString(),
    });
    const noDeadline = makeSuspendedAsk({
      kind: KIND_DIR_DECIDE,
      deadline: undefined,
    });

    expect(compareAskPriority(withDeadline, noDeadline)).toBeLessThan(0);
    expect(compareAskPriority(noDeadline, withDeadline)).toBeGreaterThan(0);
  });

  it("sorts by createdAt (FIFO) within same kind and deadline", () => {
    const older = makeSuspendedAsk({
      kind: KIND_DIR_DECIDE,
      createdAt: new Date(BASE_NOW_MS - 120_000).toISOString(), // 2min ago
    });
    const newer = makeSuspendedAsk({
      kind: KIND_DIR_DECIDE,
      createdAt: new Date(BASE_NOW_MS - 30_000).toISOString(), // 30sec ago
    });

    // Older (earlier) should sort first
    expect(compareAskPriority(older, newer)).toBeLessThan(0);
  });

  it("returns 0 for equal asks", () => {
    const ts = new Date(BASE_NOW_MS).toISOString();
    const a = makeSuspendedAsk({ kind: KIND_DIR_DECIDE, createdAt: ts, deadline: undefined });
    const b = { ...a, id: "other-id" }; // Different ID, same sort keys
    expect(compareAskPriority(a, b)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pendingAsksForWindow
// ---------------------------------------------------------------------------

describe("pendingAsksForWindow", () => {
  let repo: FakeAskRepository;

  beforeEach(() => {
    repo = new FakeAskRepository();
  });

  it("returns empty array when no suspended asks exist", async () => {
    const result = await pendingAsksForWindow(repo, WINDOW_KEY, BASE_NOW_MS);
    expect(result).toEqual([]);
  });

  it("returns scheduled Asks matching the window key", async () => {
    const ask = makeSuspendedAsk({
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      state: "suspended",
    });
    repo._seedAtState(ask);

    const result = await pendingAsksForWindow(repo, WINDOW_KEY, BASE_NOW_MS);
    expect(result.length).toBe(1);
    expect(result[0]?.id).toBe(ask.id);
  });

  it("does not return scheduled Asks for a different window", async () => {
    const ask = makeSuspendedAsk({
      serviceStrategy: "scheduled",
      windowKey: "weekly-review",
      state: "suspended",
    });
    repo._seedAtState(ask);

    const result = await pendingAsksForWindow(repo, WINDOW_KEY, BASE_NOW_MS);
    expect(result.length).toBe(0);
  });

  it("returns deadline-bound Asks within page-threshold", async () => {
    const ask = makeSuspendedAsk({
      serviceStrategy: "deadline-bound",
      windowKey: undefined,
      deadline: new Date(BASE_NOW_MS + 10 * 60 * 1000).toISOString(), // 10min
      state: "suspended",
    });
    repo._seedAtState(ask);

    const result = await pendingAsksForWindow(repo, WINDOW_KEY, BASE_NOW_MS);
    expect(result.length).toBe(1);
  });

  it("does not return deadline-bound Asks beyond page-threshold", async () => {
    const ask = makeSuspendedAsk({
      serviceStrategy: "deadline-bound",
      windowKey: undefined,
      deadline: new Date(BASE_NOW_MS + 2 * 60 * 60 * 1000).toISOString(), // 2 hours
      state: "suspended",
    });
    repo._seedAtState(ask);

    const result = await pendingAsksForWindow(repo, WINDOW_KEY, BASE_NOW_MS);
    expect(result.length).toBe(0);
  });

  it("returns asks pinned to this window via metadata", async () => {
    const ask = makeSuspendedAsk({
      serviceStrategy: "asap",
      windowKey: undefined,
      metadata: { pinnedToWindow: WINDOW_KEY },
      state: "suspended",
    });
    repo._seedAtState(ask);

    const result = await pendingAsksForWindow(repo, WINDOW_KEY, BASE_NOW_MS);
    expect(result.length).toBe(1);
  });

  it("does not return terminal (closed) Asks", async () => {
    const ask = makeSuspendedAsk({
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      state: "closed",
    });
    repo._seedAtState(ask);

    const result = await pendingAsksForWindow(repo, WINDOW_KEY, BASE_NOW_MS);
    expect(result.length).toBe(0);
  });

  it("returns results sorted by priority (stuck.unblock before direction.decide)", async () => {
    const ts = new Date(BASE_NOW_MS - 60_000).toISOString();

    const directionAsk = makeSuspendedAsk({
      id: "ask-direction",
      kind: KIND_DIR_DECIDE,
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      createdAt: ts,
      state: "suspended",
    });
    const stuckAsk = makeSuspendedAsk({
      id: "ask-stuck",
      kind: KIND_STUCK_UNBLOCK,
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      createdAt: ts,
      state: "suspended",
    });

    // Seed direction first (so insertion order would be wrong)
    repo._seedAtState(directionAsk);
    repo._seedAtState(stuckAsk);

    const result = await pendingAsksForWindow(repo, WINDOW_KEY, BASE_NOW_MS);
    expect(result.length).toBe(2);
    // stuck.unblock (priority 1) should come before direction.decide (priority 3)
    expect(result[0]?.kind).toBe(KIND_STUCK_UNBLOCK);
    expect(result[1]?.kind).toBe(KIND_DIR_DECIDE);
  });

  it("includes routed Asks in addition to suspended (edge case after restart)", async () => {
    const ask = makeSuspendedAsk({
      serviceStrategy: "scheduled",
      windowKey: WINDOW_KEY,
      state: "routed", // Routed state, not suspended
    });
    repo._seedAtState(ask);

    const result = await pendingAsksForWindow(repo, WINDOW_KEY, BASE_NOW_MS);
    expect(result.length).toBe(1);
  });
});
