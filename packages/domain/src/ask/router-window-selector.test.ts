/**
 * Tests for the router Phase 3 service-window selector (mt#1490).
 *
 * Covers:
 *   - asap strategy → immediate dispatch (unchanged behavior)
 *   - scheduled strategy → SuspendedAsk with correct windowKey
 *   - deadline-bound, beyond threshold → SuspendedAsk
 *   - deadline-bound, within threshold → immediate dispatch
 *   - forceImmediate=true → immediate dispatch regardless of strategy
 *   - Type guards: isSuspendedAsk, isRoutedAsk
 */

import { describe, it, expect } from "bun:test";
import { policyFirstRoute, isSuspendedAsk, isRoutedAsk, PAGE_THRESHOLD_MS } from "./router";
import type { Ask } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A workspace root that has no CLAUDE.md — guarantees no policy coverage. */
const NO_POLICY_WORKSPACE = "/tmp/nonexistent-ask-window-test-workspace";

/** Base time for deadline calculations (can be injected via nowMs). */
const BASE_NOW_MS = new Date("2025-01-15T12:00:00.000Z").getTime();

function makeAsk(overrides: Partial<Ask> = {}): Ask {
  return {
    id: "window-test-ask-001",
    kind: "direction.decide",
    classifierVersion: "v1",
    requestor: "test-agent:proc:abc123",
    state: "classified",
    title: "Window selector test ask",
    question: "Which direction should we go?",
    createdAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Phase 3: asap strategy (default behavior unchanged)
// ---------------------------------------------------------------------------

describe("Phase 3: asap strategy", () => {
  it("routes immediately when serviceStrategy is 'asap'", async () => {
    const ask = makeAsk({ serviceStrategy: "asap" });
    const result = await policyFirstRoute(ask, {
      workspaceRoot: NO_POLICY_WORKSPACE,
      nowMs: BASE_NOW_MS,
    });

    expect(result.state).toBe("routed");
    expect(isRoutedAsk(result)).toBe(true);
    expect(isSuspendedAsk(result)).toBe(false);
  });

  it("routes immediately when serviceStrategy is absent (defaults to asap)", async () => {
    const ask = makeAsk(); // no serviceStrategy
    const result = await policyFirstRoute(ask, {
      workspaceRoot: NO_POLICY_WORKSPACE,
      nowMs: BASE_NOW_MS,
    });

    expect(result.state).toBe("routed");
    expect(isRoutedAsk(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: scheduled strategy → suspend
// ---------------------------------------------------------------------------

describe("Phase 3: scheduled strategy", () => {
  it("suspends a scheduled Ask with the correct windowKey", async () => {
    const ask = makeAsk({
      serviceStrategy: "scheduled",
      windowKey: "ask-hours",
    });

    const result = await policyFirstRoute(ask, {
      workspaceRoot: NO_POLICY_WORKSPACE,
      nowMs: BASE_NOW_MS,
    });

    expect(result.state).toBe("suspended");
    expect(isSuspendedAsk(result)).toBe(true);
    expect(isRoutedAsk(result)).toBe(false);
  });

  it("carries the transport binding on the SuspendedAsk (for reaper dispatch)", async () => {
    const ask = makeAsk({
      serviceStrategy: "scheduled",
      windowKey: "weekly-review",
      kind: "direction.decide",
    });

    const result = await policyFirstRoute(ask, {
      workspaceRoot: NO_POLICY_WORKSPACE,
      nowMs: BASE_NOW_MS,
    });

    expect(isSuspendedAsk(result)).toBe(true);
    if (isSuspendedAsk(result)) {
      expect(result.transport.kind).toBe("inbox"); // direction.decide default
      expect(result.routingTarget).toBe("operator");
      expect(result.suspendedForWindowKey).toBe("weekly-review");
    }
  });

  it("suspends with suspendedForWindowKey matching windowKey", async () => {
    const ask = makeAsk({
      serviceStrategy: "scheduled",
      windowKey: "ask-hours",
    });

    const result = await policyFirstRoute(ask, {
      workspaceRoot: NO_POLICY_WORKSPACE,
      nowMs: BASE_NOW_MS,
    });

    if (isSuspendedAsk(result)) {
      expect(result.suspendedForWindowKey).toBe("ask-hours");
    }
  });

  it("sets suspendedAt on a SuspendedAsk", async () => {
    const ask = makeAsk({
      serviceStrategy: "scheduled",
      windowKey: "ask-hours",
    });

    const result = await policyFirstRoute(ask, {
      workspaceRoot: NO_POLICY_WORKSPACE,
      nowMs: BASE_NOW_MS,
    });

    if (isSuspendedAsk(result)) {
      expect(result.suspendedAt).toBeDefined();
      const ts = result.suspendedAt ? new Date(result.suspendedAt).getTime() : 0;
      expect(ts).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3: deadline-bound strategy
// ---------------------------------------------------------------------------

describe("Phase 3: deadline-bound strategy", () => {
  it("suspends a deadline-bound Ask when deadline is far in the future", async () => {
    // Deadline 2 hours from now — well beyond PAGE_THRESHOLD (15min).
    const deadline = new Date(BASE_NOW_MS + 2 * 60 * 60 * 1000).toISOString();

    const ask = makeAsk({
      serviceStrategy: "deadline-bound",
      deadline,
    });

    const result = await policyFirstRoute(ask, {
      workspaceRoot: NO_POLICY_WORKSPACE,
      nowMs: BASE_NOW_MS,
    });

    expect(result.state).toBe("suspended");
    expect(isSuspendedAsk(result)).toBe(true);
  });

  it("dispatches immediately when deadline is within page-threshold (14min)", async () => {
    // Deadline 14 minutes from now — within PAGE_THRESHOLD (15min).
    const deadline = new Date(BASE_NOW_MS + 14 * 60 * 1000).toISOString();

    const ask = makeAsk({
      serviceStrategy: "deadline-bound",
      deadline,
    });

    const result = await policyFirstRoute(ask, {
      workspaceRoot: NO_POLICY_WORKSPACE,
      nowMs: BASE_NOW_MS,
    });

    expect(result.state).toBe("routed");
    expect(isRoutedAsk(result)).toBe(true);
  });

  it("dispatches immediately when deadline is exactly at page-threshold boundary", async () => {
    // Deadline exactly PAGE_THRESHOLD_MS from now.
    const deadline = new Date(BASE_NOW_MS + PAGE_THRESHOLD_MS).toISOString();

    const ask = makeAsk({
      serviceStrategy: "deadline-bound",
      deadline,
    });

    const result = await policyFirstRoute(ask, {
      workspaceRoot: NO_POLICY_WORKSPACE,
      nowMs: BASE_NOW_MS,
    });

    expect(result.state).toBe("routed");
    expect(isRoutedAsk(result)).toBe(true);
  });

  it("suspends when deadline is just beyond page-threshold (16min)", async () => {
    // Deadline 16 minutes from now — just over PAGE_THRESHOLD (15min).
    const deadline = new Date(BASE_NOW_MS + 16 * 60 * 1000).toISOString();

    const ask = makeAsk({
      serviceStrategy: "deadline-bound",
      deadline,
    });

    const result = await policyFirstRoute(ask, {
      workspaceRoot: NO_POLICY_WORKSPACE,
      nowMs: BASE_NOW_MS,
    });

    expect(result.state).toBe("suspended");
    expect(isSuspendedAsk(result)).toBe(true);
  });

  it("suspends when deadline is absent (no deadline = never within threshold)", async () => {
    const ask = makeAsk({
      serviceStrategy: "deadline-bound",
      // No deadline field
    });

    const result = await policyFirstRoute(ask, {
      workspaceRoot: NO_POLICY_WORKSPACE,
      nowMs: BASE_NOW_MS,
    });

    // No deadline → withinThreshold is false → suspend
    expect(result.state).toBe("suspended");
    expect(isSuspendedAsk(result)).toBe(true);
  });

  it("deadline-bound SuspendedAsk has no suspendedForWindowKey (not window-bound)", async () => {
    const deadline = new Date(BASE_NOW_MS + 60 * 60 * 1000).toISOString(); // 1 hour

    const ask = makeAsk({
      serviceStrategy: "deadline-bound",
      deadline,
    });

    const result = await policyFirstRoute(ask, {
      workspaceRoot: NO_POLICY_WORKSPACE,
      nowMs: BASE_NOW_MS,
    });

    if (isSuspendedAsk(result)) {
      expect(result.suspendedForWindowKey).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3: forceImmediate bypass
// ---------------------------------------------------------------------------

describe("Phase 3: forceImmediate bypass", () => {
  it("bypasses scheduling when forceImmediate=true with scheduled strategy", async () => {
    const ask = makeAsk({
      serviceStrategy: "scheduled",
      windowKey: "ask-hours",
      forceImmediate: true,
    });

    const result = await policyFirstRoute(ask, {
      workspaceRoot: NO_POLICY_WORKSPACE,
      nowMs: BASE_NOW_MS,
    });

    expect(result.state).toBe("routed");
    expect(isRoutedAsk(result)).toBe(true);
    expect(isSuspendedAsk(result)).toBe(false);
  });

  it("bypasses deadline-bound suspension when forceImmediate=true", async () => {
    // Deadline far in the future — would normally suspend.
    const deadline = new Date(BASE_NOW_MS + 24 * 60 * 60 * 1000).toISOString();

    const ask = makeAsk({
      serviceStrategy: "deadline-bound",
      deadline,
      forceImmediate: true,
    });

    const result = await policyFirstRoute(ask, {
      workspaceRoot: NO_POLICY_WORKSPACE,
      nowMs: BASE_NOW_MS,
    });

    expect(result.state).toBe("routed");
    expect(isRoutedAsk(result)).toBe(true);
  });

  it("forceImmediate is a no-op when strategy is already asap", async () => {
    const ask = makeAsk({
      serviceStrategy: "asap",
      forceImmediate: true,
    });

    const result = await policyFirstRoute(ask, {
      workspaceRoot: NO_POLICY_WORKSPACE,
      nowMs: BASE_NOW_MS,
    });

    expect(result.state).toBe("routed");
    expect(isRoutedAsk(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

describe("Type guards: isSuspendedAsk / isRoutedAsk", () => {
  it("isSuspendedAsk returns true for suspended state", async () => {
    const ask = makeAsk({ serviceStrategy: "scheduled", windowKey: "ask-hours" });
    const result = await policyFirstRoute(ask, {
      workspaceRoot: NO_POLICY_WORKSPACE,
      nowMs: BASE_NOW_MS,
    });
    expect(isSuspendedAsk(result)).toBe(true);
    expect(isRoutedAsk(result)).toBe(false);
  });

  it("isRoutedAsk returns true for routed state", async () => {
    const ask = makeAsk({ serviceStrategy: "asap" });
    const result = await policyFirstRoute(ask, {
      workspaceRoot: NO_POLICY_WORKSPACE,
      nowMs: BASE_NOW_MS,
    });
    expect(isRoutedAsk(result)).toBe(true);
    expect(isSuspendedAsk(result)).toBe(false);
  });
});
