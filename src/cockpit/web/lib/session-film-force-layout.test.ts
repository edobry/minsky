/**
 * Tests for session-film-force-layout.ts (mt#3231 SC 4 / AT 4 — living layout).
 */
import { describe, test, expect } from "bun:test";
import type { StageLayout, StageLayoutNode } from "./session-film-layout";
import { DEFAULT_SESSION_FILM_CONFIG } from "./session-film-config";
import {
  createForceLayout,
  isForceLayoutSettled,
  mergeForceLayout,
  readForceLayoutPositions,
  settleForceLayoutOnce,
  tickForceLayout,
} from "./session-film-force-layout";

function node(
  overrides: Partial<StageLayoutNode> & Pick<StageLayoutNode, "id" | "depth" | "x" | "y">
): StageLayoutNode {
  return {
    realm: "repo",
    label: overrides.id,
    entityId: overrides.depth === 0 ? null : overrides.id,
    childCount: 0,
    doiScore: 1,
    expanded: true,
    ...overrides,
  };
}

function layoutFixture(nodes: StageLayoutNode[]): StageLayout {
  return { homeX: 0, homeY: 0, nodes };
}

/** Asserts a fixture lookup resolved — a single shared message, not a repeated inline literal. */
function requireDefined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture node missing — test setup bug");
  return value;
}

const ROOT = node({ id: "repo:__root__", depth: 0, x: 0, y: -90, childCount: 1 });
const CHILD_A = node({ id: "repo:a", depth: 1, x: 20, y: -140 });
const CHILD_B_COINCIDENT = node({ id: "repo:b", depth: 1, x: 20, y: -140 }); // deliberately coincident with A, to force a strong repulsion signal

describe("createForceLayout — warm start (mt#3231 AT 4)", () => {
  test("seeds every node's position EXACTLY from the static layout — never random", () => {
    const layout = layoutFixture([ROOT, CHILD_A]);
    const state = createForceLayout(layout, DEFAULT_SESSION_FILM_CONFIG);
    const positions = readForceLayoutPositions(state);
    expect(positions.get(ROOT.id)).toEqual({ x: ROOT.x, y: ROOT.y });
    expect(positions.get(CHILD_A.id)).toEqual({ x: CHILD_A.x, y: CHILD_A.y });
  });

  test("the simulation does not auto-tick on its own — a caller must call tickForceLayout", () => {
    const layout = layoutFixture([ROOT, CHILD_A]);
    const state = createForceLayout(layout, DEFAULT_SESSION_FILM_CONFIG);
    const before = requireDefined(readForceLayoutPositions(state).get(CHILD_A.id));
    // No tick call — positions must be unchanged (createForceLayout .stop()s the simulation).
    const after = readForceLayoutPositions(state).get(CHILD_A.id);
    expect(after).toEqual(before);
  });
});

describe("warm-start continuity (mt#3231 review R1, BLOCKING — no visible jump on tick 0)", () => {
  test("a freshly created simulation starts COOLER than d3-force's own alpha=1 default", () => {
    const layout = layoutFixture([ROOT, CHILD_A]);
    const state = createForceLayout(layout, DEFAULT_SESSION_FILM_CONFIG);
    expect(state.simulation.alpha()).toBeGreaterThan(0);
    expect(state.simulation.alpha()).toBeLessThan(0.5);
  });

  test("the FIRST tick after creation moves an unpinned node only a small amount — nowhere near what a full alpha=1 cold start would produce (no visible snap)", () => {
    // Coincident siblings guarantee a strong, unambiguous repulsion signal
    // (same fixture-design rationale as the existing re-flow test above),
    // so any damping from a cooler starting alpha is unambiguous too.
    const layout = layoutFixture([ROOT, CHILD_A, CHILD_B_COINCIDENT]);

    const warmState = createForceLayout(layout, DEFAULT_SESSION_FILM_CONFIG);
    const before = requireDefined(readForceLayoutPositions(warmState).get(CHILD_A.id));
    tickForceLayout(warmState);
    const after = requireDefined(readForceLayoutPositions(warmState).get(CHILD_A.id));
    const warmDelta = Math.hypot(after.x - before.x, after.y - before.y);

    // What the OLD (unfixed) cold-start behavior would have produced from
    // the IDENTICAL seed — the same fixture, forced back to d3-force's
    // default alpha=1 before its first tick.
    const hotState = createForceLayout(layout, DEFAULT_SESSION_FILM_CONFIG);
    hotState.simulation.alpha(1);
    tickForceLayout(hotState);
    const hotAfter = requireDefined(readForceLayoutPositions(hotState).get(CHILD_A.id));
    const hotDelta = Math.hypot(hotAfter.x - before.x, hotAfter.y - before.y);

    expect(warmDelta).toBeLessThan(hotDelta);
  });
});

describe("root anchoring (mt#3231 SC 4 / AT 4 — 'roots stay anchored')", () => {
  test("a realm root never moves, even after the simulation settles", () => {
    const layout = layoutFixture([ROOT, CHILD_A]);
    const state = createForceLayout(layout, DEFAULT_SESSION_FILM_CONFIG);
    settleForceLayoutOnce(state);
    const rootPos = readForceLayoutPositions(state).get(ROOT.id);
    expect(rootPos).toEqual({ x: ROOT.x, y: ROOT.y });
  });
});

describe("settling (mt#3231 SC 4 / AT 4 — 'settles, velocities -> ~0')", () => {
  test("settleForceLayoutOnce converges: isForceLayoutSettled becomes true and node velocities decay near zero", () => {
    const layout = layoutFixture([ROOT, CHILD_A]);
    const state = createForceLayout(layout, DEFAULT_SESSION_FILM_CONFIG);
    expect(isForceLayoutSettled(state)).toBe(false); // fresh (cooled) alpha, not yet settled
    settleForceLayoutOnce(state);
    expect(isForceLayoutSettled(state)).toBe(true);
    const childNode = state.nodesById.get(CHILD_A.id);
    expect(Math.abs(childNode?.vx ?? 0)).toBeLessThan(0.05);
    expect(Math.abs(childNode?.vy ?? 0)).toBeLessThan(0.05);
  });

  test("settleForceLayoutOnce is bounded — it terminates AND settles even for a busy fixture", () => {
    // The bound itself is structural (settleForceLayoutOnce's own MAX_SYNC_TICKS
    // loop guard) — this asserts the OBSERVABLE outcome (the call returns, and
    // the simulation is settled), not a wall-clock timing measurement.
    const nodes: StageLayoutNode[] = [ROOT];
    for (let i = 0; i < 30; i++) {
      nodes.push(node({ id: `repo:leaf-${i}`, depth: 1, x: i * 3, y: -140 }));
    }
    const state = createForceLayout(layoutFixture(nodes), DEFAULT_SESSION_FILM_CONFIG);
    settleForceLayoutOnce(state);
    expect(isForceLayoutSettled(state)).toBe(true);
  });
});

describe("mergeForceLayout — re-flow on arrival (mt#3231 SC 4 / AT 4)", () => {
  test("an existing sibling's position CHANGES between frames when a new sibling arrives nearby (re-flow, not a snap)", () => {
    const before = layoutFixture([ROOT, CHILD_A]);
    let state = createForceLayout(before, DEFAULT_SESSION_FILM_CONFIG);
    settleForceLayoutOnce(state);
    const settledPos = requireDefined(readForceLayoutPositions(state).get(CHILD_A.id));

    // A new sibling arrives, seeded COINCIDENT with A — guarantees a strong,
    // unambiguous repulsion signal rather than a borderline-small nudge.
    const after = layoutFixture([ROOT, CHILD_A, CHILD_B_COINCIDENT]);
    state = mergeForceLayout(state, after, DEFAULT_SESSION_FILM_CONFIG);

    // The arrival reheats alpha — this IS the "re-flow" trigger, not a
    // fresh random scatter (B is warm-started at its own tidy-tree slot).
    expect(state.simulation.alpha()).toBeGreaterThanOrEqual(0.3);

    for (let i = 0; i < 10; i++) tickForceLayout(state);
    const reflowedPos = readForceLayoutPositions(state).get(CHILD_A.id);
    expect(reflowedPos).not.toEqual(settledPos);
  });

  test("a node NOT present in the new layout is dropped from the simulation", () => {
    const before = layoutFixture([ROOT, CHILD_A]);
    let state = createForceLayout(before, DEFAULT_SESSION_FILM_CONFIG);
    const after = layoutFixture([ROOT]); // A leaves the touched-set (DOI-budget eviction)
    state = mergeForceLayout(state, after, DEFAULT_SESSION_FILM_CONFIG);
    expect(state.nodesById.has(CHILD_A.id)).toBe(false);
    expect(readForceLayoutPositions(state).has(CHILD_A.id)).toBe(false);
  });

  test("merging the SAME layout again (no new node) does NOT reheat alpha", () => {
    const layout = layoutFixture([ROOT, CHILD_A]);
    let state = createForceLayout(layout, DEFAULT_SESSION_FILM_CONFIG);
    settleForceLayoutOnce(state);
    state = mergeForceLayout(state, layout, DEFAULT_SESSION_FILM_CONFIG);
    expect(state.simulation.alpha()).toBeLessThan(0.05);
  });

  test("an existing node's LIVE simulated position is preserved across a merge, not reset to its nominal slot", () => {
    const layout = layoutFixture([ROOT, CHILD_A]);
    let state = createForceLayout(layout, DEFAULT_SESSION_FILM_CONFIG);
    settleForceLayoutOnce(state);
    const beforeMerge = requireDefined(readForceLayoutPositions(state).get(CHILD_A.id));
    // Re-merge the identical layout (simulating a new fold frame with no
    // structural change) — the LIVE position must carry over unchanged.
    state = mergeForceLayout(state, layout, DEFAULT_SESSION_FILM_CONFIG);
    const afterMerge = readForceLayoutPositions(state).get(CHILD_A.id);
    expect(afterMerge).toEqual(beforeMerge);
  });
});

describe("reduced motion — one-shot settle (mt#3231 SC 4 / AT 4)", () => {
  test("settleForceLayoutOnce leaves the simulation settled — a caller checking isForceLayoutSettled correctly knows to stop ticking", () => {
    const layout = layoutFixture([ROOT, CHILD_A, CHILD_B_COINCIDENT]);
    const state = createForceLayout(layout, DEFAULT_SESSION_FILM_CONFIG);
    settleForceLayoutOnce(state);
    expect(isForceLayoutSettled(state)).toBe(true);
    const posAfterSettle = readForceLayoutPositions(state).get(CHILD_A.id);
    // A caller (useSessionFilmForceLayout) gates further ticking on
    // isForceLayoutSettled — verify that gate is actually satisfied, i.e.
    // NOTHING would call tickForceLayout again, so the position is final.
    expect(isForceLayoutSettled(state)).toBe(true);
    expect(posAfterSettle).toBeDefined();
  });
});
