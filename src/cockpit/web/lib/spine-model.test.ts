/**
 * Spine placement tests (mt#4011).
 *
 * The load-bearing assertion is AT1's single-definition property: placement is
 * the entry's interception point with exactly one exception — an authored
 * `trajectory: "delivery"` places at the merge station — so the spine can
 * never diverge from the catalog's own point grouping for the same data. The
 * artifact side of that parity (exactly the eight merge gates carry the
 * marker) is pinned in `src/cockpit/widgets/interceptors.test.ts`, which
 * already imports the generated artifact.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect } from "bun:test";
import type { InterceptorEntry } from "../hooks/useInterceptors";
import { INTERCEPTION_POINT_ORDER } from "../hooks/useInterceptors";
import {
  MAX_DOT_PX,
  MIN_DOT_PX,
  SPINE_STATIONS,
  dotSizePx,
  spinePopulation,
  spineStationOf,
} from "./spine-model";

function entry(overrides: Partial<InterceptorEntry> = {}): InterceptorEntry {
  return {
    guardName: "example-guard",
    description: "Blocks the example failure.",
    failureClasses: [],
    provenance: [],
    sourceFile: null,
    stratum: "registry",
    subject: "trajectory",
    provenanceStatus: "implementation",
    coverageGaps: [],
    registered: true,
    undescribed: false,
    point: "PreToolUse",
    pointSource: "registry",
    trajectory: null,
    interventions: [{ type: "deny" }],
    mechanism: "structural",
    role: "judge",
    coordinateGaps: [],
    families: ["guard"],
    familyState: "classified",
    deliberatelyUnauthored: false,
    ...overrides,
  };
}

describe("spineStationOf", () => {
  test("places every entry at its interception point when no trajectory is authored", () => {
    for (const point of INTERCEPTION_POINT_ORDER) {
      expect(spineStationOf(entry({ point }))).toBe(point);
    }
  });

  test("places an authored delivery entry at the merge station, keeping its mechanism point", () => {
    const gate = entry({ guardName: "require-review-before-merge", trajectory: "delivery" });
    expect(gate.point).toBe("PreToolUse");
    expect(spineStationOf(gate)).toBe("merge-time");
  });

  test("returns null for an entry with no point and no trajectory", () => {
    expect(spineStationOf(entry({ point: null }))).toBeNull();
  });
});

describe("SPINE_STATIONS", () => {
  test("keeps the canonical point order, with the uncataloged strata interleaved at their positions", () => {
    // The nine points appear in INTERCEPTION_POINT_ORDER exactly (SC1's
    // "trajectory order" is that constant); the gap stations sit where their
    // stratum lives on the trajectory — domain commands inside tool calls,
    // CI and review at the delivery tail.
    const ids = SPINE_STATIONS.map((s) => s.id);
    expect(ids.filter((id) => id !== "domain-command" && id !== "ci" && id !== "review")).toEqual([
      ...INTERCEPTION_POINT_ORDER,
    ]);
    expect(ids.indexOf("domain-command")).toBe(ids.indexOf("PostToolUse") + 1);
    expect(ids.slice(-2)).toEqual(["ci", "review"]);
  });

  test("flags exactly the domain-command, CI and review stations as population gaps, each with a note", () => {
    const gaps = SPINE_STATIONS.filter((s) => s.populationGap);
    expect(gaps.map((s) => s.id)).toEqual(["domain-command", "ci", "review"]);
    for (const s of gaps) expect(s.gapNote).toBeTruthy();
  });
});

describe("spinePopulation", () => {
  test("groups by station, collects unplaced, and excludes fire-log-history strata", () => {
    const gate = entry({ guardName: "gate", trajectory: "delivery" });
    const stop = entry({ guardName: "stop-scan", point: "Stop" });
    const bare = entry({ guardName: "bare", point: null });
    const fixture = entry({ guardName: "fixture-x", stratum: "fixture" });
    const retired = entry({ guardName: "old-x", stratum: "retired" });

    const { placed, unplaced, excluded } = spinePopulation([gate, stop, bare, fixture, retired]);

    expect(placed.get("merge-time")?.map((e) => e.guardName)).toEqual(["gate"]);
    expect(placed.get("Stop")?.map((e) => e.guardName)).toEqual(["stop-scan"]);
    expect(unplaced.map((e) => e.guardName)).toEqual(["bare"]);
    expect(excluded.map((e) => e.guardName)).toEqual(["fixture-x", "old-x"]);
  });

  test("a fixture entry with a point is still excluded — stratum wins", () => {
    const { placed, excluded } = spinePopulation([
      entry({ guardName: "fixture-y", stratum: "fixture", point: "Stop" }),
    ]);
    expect(placed.size).toBe(0);
    expect(excluded).toHaveLength(1);
  });
});

describe("dotSizePx", () => {
  test("clamps to the readable range and grows monotonically with volume", () => {
    expect(dotSizePx(0, 100)).toBe(MIN_DOT_PX);
    expect(dotSizePx(0, 0)).toBe(MIN_DOT_PX);
    expect(dotSizePx(100, 100)).toBe(MAX_DOT_PX);
    const small = dotSizePx(1, 100);
    const mid = dotSizePx(25, 100);
    expect(small).toBeGreaterThanOrEqual(MIN_DOT_PX);
    expect(mid).toBeGreaterThan(small);
    expect(dotSizePx(200, 100)).toBe(MAX_DOT_PX);
  });
});
