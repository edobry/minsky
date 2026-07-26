/**
 * Tests for session-film-layout.ts (mt#3184 — spec SC 5 / AT 2).
 */
import { describe, test, expect } from "bun:test";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import { foldEvents } from "./session-film-fold";
import { computeStageLayout } from "./session-film-layout";
import { DEFAULT_SESSION_FILM_CONFIG, type SessionFilmConfig } from "./session-film-config";

/** Shared realm-literal constant — avoids repeating the "minsky-substrate" string across fixtures. */
const MINSKY_SUBSTRATE = "minsky-substrate" as const;

function ev(overrides: Partial<SemanticEvent> = {}): SemanticEvent {
  return {
    schemaVersion: "v0",
    tStart: "2026-07-24T00:00:00.000Z",
    actor: { kind: "agent", agentSessionId: "a1" },
    verb: "read",
    target: { realm: "repo", id: "file:workspace:foo.ts" },
    outcome: "ok",
    weight: 1,
    adapterVersion: "test",
    ...overrides,
  };
}

describe("computeStageLayout — realm roots always present", () => {
  test("all 7 realm roots render even with no events at all", () => {
    const layout = computeStageLayout(
      foldEvents([], -1),
      "2026-07-24T00:00:00.000Z",
      DEFAULT_SESSION_FILM_CONFIG
    );
    const roots = layout.nodes.filter((n) => n.depth === 0);
    expect(roots).toHaveLength(7); // repo, minsky-substrate, web, notion, shell, agents, unknown
  });
});

describe("computeStageLayout — DOI expand/collapse (AT2)", () => {
  test("a JUST-touched deep repo path auto-expands its full root-to-leaf ancestry", () => {
    const events: SemanticEvent[] = [
      ev({ target: { realm: "repo", id: "file:ws:src/cockpit/web/pages/DeepPage.tsx" } }),
    ];
    const world = foldEvents(events, 0);
    const nowIso = events[0]?.tStart as string; // elapsed = 0 -> max recency
    const layout = computeStageLayout(world, nowIso, DEFAULT_SESSION_FILM_CONFIG);

    const repoNodes = layout.nodes.filter((n) => n.realm === "repo");
    const labels = repoNodes.map((n) => n.label);
    expect(labels).toContain("src");
    expect(labels).toContain("cockpit");
    expect(labels).toContain("web");
    expect(labels).toContain("pages");
    expect(labels).toContain("DeepPage.tsx");
  });

  test("a touch that happened LONG ago (relative to the playhead) collapses out of view", () => {
    const events: SemanticEvent[] = [
      ev({
        target: { realm: "repo", id: "file:ws:old/stale/file.ts" },
        tStart: "2026-07-24T00:00:00.000Z",
      }),
    ];
    const world = foldEvents(events, 0);
    // "now" is 2 hours later — recency term should have decayed to ~0, and
    // a-priori-only score at depth 3 (0.8 - 3*0.15 = 0.35) sits right at the
    // default threshold, so push it just under with a deeper path.
    const config: SessionFilmConfig = {
      ...DEFAULT_SESSION_FILM_CONFIG,
      doi: { ...DEFAULT_SESSION_FILM_CONFIG.doi, expandThreshold: 0.4 },
    };
    const nowIso = "2026-07-24T02:00:00.000Z";
    const layout = computeStageLayout(world, nowIso, config);
    const repoLabels = layout.nodes.filter((n) => n.realm === "repo").map((n) => n.label);
    expect(repoLabels).not.toContain("file.ts");
  });
});

describe("computeStageLayout — visible-node budget", () => {
  test("caps total expanded nodes at the configured budget", () => {
    const events: SemanticEvent[] = [];
    for (let i = 0; i < 200; i++) {
      events.push(
        ev({
          target: { realm: MINSKY_SUBSTRATE, id: `minsky:task:mt#${i}` },
          tStart: `2026-07-24T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        })
      );
    }
    const world = foldEvents(events, events.length - 1);
    const config: SessionFilmConfig = {
      ...DEFAULT_SESSION_FILM_CONFIG,
      doi: { ...DEFAULT_SESSION_FILM_CONFIG.doi, visibleNodeBudget: 30, expandThreshold: -1 },
    };
    const layout = computeStageLayout(world, "2026-07-24T00:00:00.000Z", config);
    expect(layout.nodes.length).toBeLessThanOrEqual(30);
  });
});

describe("computeStageLayout — deterministic radial placement", () => {
  test("realm roots sit at their configured compass bearing, not at random positions", () => {
    const layout = computeStageLayout(
      foldEvents([], -1),
      "2026-07-24T00:00:00.000Z",
      DEFAULT_SESSION_FILM_CONFIG,
      {
        homeX: 0,
        homeY: 0,
      }
    );
    const repoRoot = layout.nodes.find((n) => n.realm === "repo" && n.depth === 0);
    // repo bearing = 315deg (northwest): negative x, negative y in screen space.
    if (!repoRoot) throw new Error("repo root missing — test setup bug");
    expect(repoRoot.x).toBeLessThan(0);
    expect(repoRoot.y).toBeLessThan(0);

    const webRoot = layout.nodes.find((n) => n.realm === "web" && n.depth === 0);
    // web bearing = 90deg (east): positive x, ~0 y.
    if (!webRoot) throw new Error("web root missing — test setup bug");
    expect(webRoot.x).toBeGreaterThan(0);
  });

  test("re-computing the layout twice with the same inputs is deterministic (no force simulation)", () => {
    const events: SemanticEvent[] = [ev({ target: { realm: "repo", id: "file:ws:a/b.ts" } })];
    const world = foldEvents(events, 0);
    const a = computeStageLayout(world, "2026-07-24T00:00:00.000Z", DEFAULT_SESSION_FILM_CONFIG);
    const b = computeStageLayout(world, "2026-07-24T00:00:00.000Z", DEFAULT_SESSION_FILM_CONFIG);
    expect(a.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }))).toEqual(
      b.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }))
    );
  });
});

describe("computeStageLayout — UNKNOWN realm label fix (mt#3226 SC 5)", () => {
  test("the unknown realm root never renders the internal name 'unknown' verbatim", () => {
    const events: SemanticEvent[] = [
      ev({ target: { realm: "unknown", id: "unknown:Skill" }, tStart: "2026-07-24T00:00:00.000Z" }),
    ];
    const world = foldEvents(events, 0);
    const layout = computeStageLayout(
      world,
      "2026-07-24T00:00:00.000Z",
      DEFAULT_SESSION_FILM_CONFIG
    );
    const unknownRoot = layout.nodes.find((n) => n.realm === "unknown" && n.depth === 0);
    expect(unknownRoot?.label).toBe("other");
    expect(unknownRoot?.label.toUpperCase()).not.toBe("UNKNOWN");
  });
});

// ── Organic child layout (mt#3226 SC 5 / AT 4) ───────────────────────────────

/** Cross-product-based collinearity deviation: 0 for perfectly collinear points; grows with curvature. */
function collinearityDeviation(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number }
): number {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
}

describe("computeStageLayout — organic radial-arc distribution (mt#3226 SC 5 / AT 4)", () => {
  function thirtyChildEvents(realm: typeof MINSKY_SUBSTRATE | "shell"): SemanticEvent[] {
    const events: SemanticEvent[] = [];
    for (let i = 0; i < 30; i++) {
      const id = realm === MINSKY_SUBSTRATE ? `minsky:task:mt#${1000 + i}` : `shell:command-${i}`;
      events.push(
        ev({
          target: { realm, id },
          tStart: `2026-07-24T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        })
      );
    }
    return events;
  }

  test("30 single-depth children fan out along a CURVE, not a straight-line comb", () => {
    const events = thirtyChildEvents(MINSKY_SUBSTRATE);
    const world = foldEvents(events, events.length - 1);
    const config: SessionFilmConfig = {
      ...DEFAULT_SESSION_FILM_CONFIG,
      doi: { ...DEFAULT_SESSION_FILM_CONFIG.doi, expandThreshold: -1, visibleNodeBudget: 100 },
    };
    const layout = computeStageLayout(world, "2026-07-24T00:00:29.000Z", config);
    const children = layout.nodes.filter((n) => n.realm === MINSKY_SUBSTRATE && n.depth === 1);
    expect(children.length).toBe(30);

    // At least one triple of consecutive (by DOI-independent array order —
    // d3 preserves sibling order) children must show real curvature: a
    // perfectly straight comb/fan has EVERY triple's cross-product deviation
    // at (or extremely near) zero.
    let maxDeviation = 0;
    for (let i = 0; i + 2 < children.length; i++) {
      const a = children[i];
      const b = children[i + 1];
      const c = children[i + 2];
      if (!a || !b || !c) continue;
      maxDeviation = Math.max(maxDeviation, collinearityDeviation(a, b, c));
    }
    expect(maxDeviation).toBeGreaterThan(1);
  });

  test("all 30 children stay within reasonable viewport bounds regardless of fanout (no unbounded spread)", () => {
    const events = thirtyChildEvents("shell");
    const world = foldEvents(events, events.length - 1);
    const config: SessionFilmConfig = {
      ...DEFAULT_SESSION_FILM_CONFIG,
      doi: { ...DEFAULT_SESSION_FILM_CONFIG.doi, expandThreshold: -1, visibleNodeBudget: 100 },
    };
    const layout = computeStageLayout(world, "2026-07-24T00:00:29.000Z", config);
    const children = layout.nodes.filter((n) => n.realm === "shell" && n.depth === 1);
    expect(children.length).toBe(30);
    // Matches SessionFilmStage.tsx's STAGE_BOARD_WIDTH/HEIGHT (900x700) —
    // every node must stay comfortably inside half-board bounds.
    for (const node of children) {
      expect(Math.abs(node.x)).toBeLessThan(450);
      expect(Math.abs(node.y)).toBeLessThan(350);
    }
  });

  test("the arc distribution is deterministic across two computations (seeded jitter, not Math.random)", () => {
    const events = thirtyChildEvents(MINSKY_SUBSTRATE);
    const world = foldEvents(events, events.length - 1);
    const config: SessionFilmConfig = {
      ...DEFAULT_SESSION_FILM_CONFIG,
      doi: { ...DEFAULT_SESSION_FILM_CONFIG.doi, expandThreshold: -1, visibleNodeBudget: 100 },
    };
    const a = computeStageLayout(world, "2026-07-24T00:00:29.000Z", config);
    const b = computeStageLayout(world, "2026-07-24T00:00:29.000Z", config);
    expect(a.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }))).toEqual(
      b.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }))
    );
  });

  test("no two children share the exact same position (stagger + jitter actually vary distinct nodes)", () => {
    const events = thirtyChildEvents(MINSKY_SUBSTRATE);
    const world = foldEvents(events, events.length - 1);
    const config: SessionFilmConfig = {
      ...DEFAULT_SESSION_FILM_CONFIG,
      doi: { ...DEFAULT_SESSION_FILM_CONFIG.doi, expandThreshold: -1, visibleNodeBudget: 100 },
    };
    const layout = computeStageLayout(world, "2026-07-24T00:00:29.000Z", config);
    const children = layout.nodes.filter((n) => n.realm === MINSKY_SUBSTRATE && n.depth === 1);
    const positions = new Set(children.map((n) => `${n.x.toFixed(3)},${n.y.toFixed(3)}`));
    expect(positions.size).toBe(children.length);
  });
});
