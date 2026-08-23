/**
 * LifecycleSpine render tests (mt#4011).
 *
 * The assertions the spec's acceptance tests turn on: per-station membership
 * equals the shared placement model over the same payload (AT1), and a canary
 * state change recolors the affected dot on re-render (AT2). Plus the
 * absence-discipline cases: gap stations render their note, a pending
 * aggregates source renders placement-only, unplaced names are counted.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { InterceptorAggregateRow } from "@minsky/domain/guard-events/aggregates";
import type { InterceptorEntry } from "../hooks/useInterceptors";
import { spinePopulation, spineStationOf } from "../lib/spine-model";
import { LifecycleSpine } from "./LifecycleSpine";

afterEach(cleanup);

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

function aggregateRow(
  overrides: {
    guardName?: string;
    windowFires?: number;
    lifetimeFires?: number;
    canary?: InterceptorAggregateRow["canary"];
  } = {}
): InterceptorAggregateRow {
  return {
    guardName: overrides.guardName ?? "example-guard",
    fireLog: {
      window: {
        days: 7,
        fires: overrides.windowFires ?? 4,
        byDecision: { allow: overrides.windowFires ?? 4, warn: 0, deny: 0, other: 0 },
        overrides: { total: 0, byEnvVar: {} },
        duration: null,
      },
      lifetime: { totalFires: overrides.lifetimeFires ?? 40, firstFireAt: null, lastFireAt: null },
    },
    canary: overrides.canary === undefined ? { state: "passing" } : overrides.canary,
    health: null,
    calibration: null,
    registry: null,
  };
}

function rowMap(rows: InterceptorAggregateRow[]): Map<string, InterceptorAggregateRow> {
  return new Map(rows.map((r) => [r.guardName, r]));
}

/** Guard-scoped dot lookup — never assumes the spine renders exactly one dot. */
function dotFor(guardName: string): Element {
  const dot = document.querySelector(`[data-testid="spine-dot"][data-guard="${guardName}"]`);
  if (!dot) throw new Error(`no spine dot rendered for ${guardName}`);
  return dot;
}

function renderSpine(props: Parameters<typeof LifecycleSpine>[0]) {
  return render(
    <MemoryRouter>
      <LifecycleSpine {...props} />
    </MemoryRouter>
  );
}

const population: InterceptorEntry[] = [
  entry({ guardName: "prompt-hook", point: "UserPromptSubmit" }),
  entry({ guardName: "pre-gate", point: "PreToolUse" }),
  entry({ guardName: "merge-gate", point: "PreToolUse", trajectory: "delivery" }),
  entry({ guardName: "stop-scan", point: "Stop" }),
  entry({ guardName: "meta-scan", point: "UserPromptSubmit", subject: "system" }),
  entry({ guardName: "bare", point: null }),
  entry({ guardName: "fixture-x", stratum: "fixture" }),
];

describe("LifecycleSpine", () => {
  test("renders every station, and per-station membership equals the shared placement model (AT1)", () => {
    renderSpine({ entries: population, aggregateRows: rowMap([]), windowDays: 7 });

    const { placed } = spinePopulation(population);
    // Every station renders — including the ones with no members.
    for (const id of [
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "domain-command",
      "Stop",
      "SubagentStop",
      "SessionEnd",
      "MessageDisplay",
      "pre-commit",
      "merge-time",
      "ci",
      "review",
    ]) {
      expect(screen.getByTestId(`spine-station-${id}`)).toBeTruthy();
    }

    // Membership parity, station by station, against the ONE definition.
    for (const [stationId, members] of placed) {
      const station = screen.getByTestId(`spine-station-${stationId}`);
      const dots = station.querySelectorAll('[data-testid="spine-dot"]');
      expect([...dots].map((d) => d.getAttribute("data-guard")).sort()).toEqual(
        members.map((e) => e.guardName).sort()
      );
    }

    // The merge gate sits at merge-time, not at its mechanism point.
    expect(spineStationOf(population[2]!)).toBe("merge-time");
    const preStation = screen.getByTestId("spine-station-PreToolUse");
    expect(preStation.querySelector('[data-guard="merge-gate"]')).toBeNull();
  });

  test("recolors a dot when its canary state changes between snapshots (AT2)", () => {
    const passing = rowMap([aggregateRow({ guardName: "pre-gate", canary: { state: "passing" } })]);
    const { rerender } = renderSpine({
      entries: [entry({ guardName: "pre-gate" })],
      aggregateRows: passing,
      windowDays: 7,
    });
    expect(dotFor("pre-gate").getAttribute("data-state")).toBe("active");

    const broken = rowMap([
      aggregateRow({
        guardName: "pre-gate",
        canary: { state: "broken", brokenSinceAt: "2026-08-01T00:00:00Z" },
      }),
    ]);
    rerender(
      <MemoryRouter>
        <LifecycleSpine
          entries={[entry({ guardName: "pre-gate" })]}
          aggregateRows={broken}
          windowDays={7}
        />
      </MemoryRouter>
    );
    expect(dotFor("pre-gate").getAttribute("data-state")).toBe("broken");
  });

  test("each dot links to the catalog detail route (SC3)", () => {
    renderSpine({
      entries: [entry({ guardName: "pre-gate" })],
      aggregateRows: rowMap([aggregateRow({ guardName: "pre-gate" })]),
      windowDays: 7,
    });
    expect(dotFor("pre-gate").getAttribute("href")).toBe("/interceptors/pre-gate");
  });

  test("states the sizing window when the snapshot is ready (SC2), and pending otherwise", () => {
    renderSpine({
      entries: [entry()],
      aggregateRows: rowMap([aggregateRow()]),
      windowDays: 7,
    });
    expect(screen.getByTestId("spine-window-note").textContent).toContain("last 7 day(s)");
    cleanup();

    renderSpine({ entries: [entry()], aggregateRows: null, windowDays: null });
    expect(screen.getByTestId("spine-window-note").textContent).toContain("placement only");
    expect(dotFor("example-guard").getAttribute("data-state")).toBe("pending");
  });

  test("renders the domain-command, CI and review population gaps as text, never as entities", () => {
    renderSpine({ entries: [], aggregateRows: rowMap([]), windowDays: 7 });
    expect(screen.getByTestId("spine-gap-domain-command")).toBeTruthy();
    expect(screen.getByTestId("spine-gap-ci")).toBeTruthy();
    expect(screen.getByTestId("spine-gap-review")).toBeTruthy();
    const ci = screen.getByTestId("spine-station-ci");
    expect(ci.querySelectorAll('[data-testid="spine-dot"]')).toHaveLength(0);
  });

  test("marks system-subject entries distinctly and counts unplaced names", () => {
    renderSpine({ entries: population, aggregateRows: rowMap([]), windowDays: 7 });
    const meta = dotFor("meta-scan");
    expect(meta.getAttribute("data-subject")).toBe("system");
    // The marker must be a REAL utility, applied to the dot fill. `ring-dashed`
    // shipped once and rendered a solid ring — Tailwind's ring has no style
    // variant, so the dashed marker is an outline (PR #2989 R1).
    expect(meta.querySelector("span")?.className).toContain("outline-dashed");
    const trajectoryDot = dotFor("pre-gate");
    expect(trajectoryDot.querySelector("span")?.className).not.toContain("outline-dashed");
    const note = screen.getByTestId("spine-population-note").textContent ?? "";
    expect(note).toContain("bare");
    expect(note).toContain("fixture/retired");
  });
});
