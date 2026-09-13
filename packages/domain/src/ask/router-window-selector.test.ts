/**
 * Tests for the router's Phase 3 — the retired service-window selector (mt#4427).
 *
 * Until mt#4427, Phase 3 held two suspend branches: `scheduled` suspended until
 * a window opened, and `deadline-bound` suspended until the deadline came within
 * `PAGE_THRESHOLD_MS`. Both waited on the service-window reaper, which mt#4410
 * retired — and the verdict never reached disk anyway: `routeResultToOutcomeWrite`
 * persists an operator-bound `routed` result as `suspended` exactly as it does a
 * `SuspendedAsk`. This file pins the replacement contract:
 *
 *   - every `serviceStrategy` value dispatches immediately
 *   - `deadline` and `windowKey` ride through on the record but do not route
 *   - `forceImmediate` is a no-op (there is nothing left to bypass)
 *   - the router no longer produces a `SuspendedAsk`; the type guards still
 *     discriminate a hand-built one, because `createAsk` still returns that shape
 *     from the persisted row
 */

import { describe, it, expect } from "bun:test";
import { policyFirstRoute, isSuspendedAsk, isRoutedAsk, PAGE_THRESHOLD_MS } from "./router";
import type { SuspendedAsk } from "./router";
import type { Ask } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A workspace root that has no CLAUDE.md — guarantees no policy coverage. */
const NO_POLICY_WORKSPACE = "/tmp/nonexistent-ask-window-test-workspace";

/** Base time for deadline calculations (injected via nowMs). */
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
    createdAt: new Date(BASE_NOW_MS).toISOString(),
    metadata: {},
    ...overrides,
  };
}

async function route(ask: Ask) {
  return policyFirstRoute(ask, {
    workspaceRoot: NO_POLICY_WORKSPACE,
    nowMs: BASE_NOW_MS,
  });
}

// ---------------------------------------------------------------------------
// Phase 3: asap strategy (unchanged)
// ---------------------------------------------------------------------------

describe("Phase 3: asap strategy", () => {
  it("routes immediately when serviceStrategy is 'asap'", async () => {
    const result = await route(makeAsk({ serviceStrategy: "asap" }));

    expect(result.state).toBe("routed");
    expect(isRoutedAsk(result)).toBe(true);
    expect(isSuspendedAsk(result)).toBe(false);
  });

  it("routes immediately when serviceStrategy is absent", async () => {
    const result = await route(makeAsk());

    expect(result.state).toBe("routed");
    expect(isRoutedAsk(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: scheduled strategy no longer suspends (mt#4427)
// ---------------------------------------------------------------------------

describe("Phase 3: scheduled strategy", () => {
  it("routes a scheduled Ask immediately instead of suspending it against a window", async () => {
    const result = await route(makeAsk({ serviceStrategy: "scheduled", windowKey: "ask-hours" }));

    expect(result.state).toBe("routed");
    expect(isRoutedAsk(result)).toBe(true);
    expect(isSuspendedAsk(result)).toBe(false);
  });

  it("keeps the transport binding and the window fields on the routed record", async () => {
    const result = await route(
      makeAsk({ serviceStrategy: "scheduled", windowKey: "weekly-review" })
    );

    expect(isRoutedAsk(result)).toBe(true);
    if (isRoutedAsk(result)) {
      expect(result.transport.kind).toBe("inbox"); // direction.decide default
      expect(result.routingTarget).toBe("operator");
      // The strategy and key are record fields, not routing inputs, so they
      // survive unchanged for whoever reads the row later.
      expect(result.serviceStrategy).toBe("scheduled");
      expect(result.windowKey).toBe("weekly-review");
      expect(result.routedAt).toBe(new Date(BASE_NOW_MS).toISOString());
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3: deadline-bound strategy no longer suspends (mt#4427)
// ---------------------------------------------------------------------------

describe("Phase 3: deadline-bound strategy", () => {
  it("routes immediately when the deadline is far in the future", async () => {
    // 2 hours out — the case the old branch suspended, waiting for a reaper
    // that no longer runs. Negative control for mt#4427: against the pre-fix
    // router this expects `routed` and observes `suspended`.
    const deadline = new Date(BASE_NOW_MS + 2 * 60 * 60 * 1000).toISOString();
    const result = await route(makeAsk({ serviceStrategy: "deadline-bound", deadline }));

    expect(result.state).toBe("routed");
    expect(isRoutedAsk(result)).toBe(true);
    expect(isSuspendedAsk(result)).toBe(false);
  });

  it("routes immediately when the deadline is absent", async () => {
    // The live population's shape: every deadline-bound ask in the production
    // record on 2026-09-13 carried no deadline at all, and the old branch
    // suspended each one through `deadline === null`.
    const result = await route(makeAsk({ serviceStrategy: "deadline-bound" }));

    expect(result.state).toBe("routed");
    expect(isRoutedAsk(result)).toBe(true);
    if (isRoutedAsk(result)) {
      expect(result.deadline).toBeUndefined();
    }
  });

  it("routes immediately when the deadline is within the old page threshold", async () => {
    const deadline = new Date(BASE_NOW_MS + 14 * 60 * 1000).toISOString();
    const result = await route(makeAsk({ serviceStrategy: "deadline-bound", deadline }));

    expect(result.state).toBe("routed");
    expect(isRoutedAsk(result)).toBe(true);
  });

  it("routes immediately when the deadline is just beyond the old page threshold", async () => {
    // The boundary the old branch split on; PAGE_THRESHOLD_MS stays exported for
    // the retired reaper, so pin that it no longer partitions routing here.
    const deadline = new Date(BASE_NOW_MS + PAGE_THRESHOLD_MS + 60 * 1000).toISOString();
    const result = await route(makeAsk({ serviceStrategy: "deadline-bound", deadline }));

    expect(result.state).toBe("routed");
    expect(isRoutedAsk(result)).toBe(true);
  });

  it("carries the deadline through on the routed record", async () => {
    const deadline = new Date(BASE_NOW_MS + 60 * 60 * 1000).toISOString();
    const result = await route(makeAsk({ serviceStrategy: "deadline-bound", deadline }));

    expect(isRoutedAsk(result)).toBe(true);
    if (isRoutedAsk(result)) {
      expect(result.deadline).toBe(deadline);
      expect(result.serviceStrategy).toBe("deadline-bound");
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3: forceImmediate is a no-op
// ---------------------------------------------------------------------------

describe("Phase 3: forceImmediate", () => {
  it("routes the same with forceImmediate=true on a scheduled Ask", async () => {
    const result = await route(
      makeAsk({ serviceStrategy: "scheduled", windowKey: "ask-hours", forceImmediate: true })
    );

    expect(result.state).toBe("routed");
    expect(isRoutedAsk(result)).toBe(true);
  });

  it("routes the same with forceImmediate=true on a deadline-bound Ask", async () => {
    const deadline = new Date(BASE_NOW_MS + 24 * 60 * 60 * 1000).toISOString();
    const result = await route(
      makeAsk({ serviceStrategy: "deadline-bound", deadline, forceImmediate: true })
    );

    expect(result.state).toBe("routed");
    expect(isRoutedAsk(result)).toBe(true);
  });

  it("routes the same with forceImmediate=true on an asap Ask", async () => {
    const result = await route(makeAsk({ serviceStrategy: "asap", forceImmediate: true }));

    expect(result.state).toBe("routed");
    expect(isRoutedAsk(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

describe("Type guards: isSuspendedAsk / isRoutedAsk", () => {
  it("isRoutedAsk is true and isSuspendedAsk false for every routed strategy", async () => {
    const strategies: Ask["serviceStrategy"][] = ["asap", "scheduled", "deadline-bound"];
    for (const serviceStrategy of strategies) {
      const result = await route(makeAsk({ serviceStrategy, windowKey: "ask-hours" }));
      expect(isRoutedAsk(result)).toBe(true);
      expect(isSuspendedAsk(result)).toBe(false);
    }
  });

  it("isSuspendedAsk still discriminates the shape createAsk returns from a persisted row", () => {
    // The router no longer builds one, but `createAsk` reconciles its return
    // value from the persisted `suspended` row in this shape, so the guard has
    // to keep telling the two apart.
    const suspended: SuspendedAsk = {
      ...makeAsk(),
      state: "suspended",
      routingTarget: "operator",
      transport: { kind: "inbox" },
      packagedPayload: { question: "Which direction should we go?" },
      routedAt: new Date(BASE_NOW_MS).toISOString(),
      suspendedAt: new Date(BASE_NOW_MS).toISOString(),
    };

    expect(isSuspendedAsk(suspended)).toBe(true);
    expect(isRoutedAsk(suspended)).toBe(false);
  });
});
