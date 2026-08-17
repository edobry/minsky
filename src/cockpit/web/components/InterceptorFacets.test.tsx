/**
 * Facet-filter and axis-chip tests (mt#4056 slice 1b).
 *
 * Two things are pinned here, and they are the two the slice turns on:
 *
 *   1. Family filtering computes over the intervention SET rather than reading
 *      a stored kind, and membership is not exclusive (AT2).
 *   2. The two zero-family states render as DIFFERENT markers (AT3). The
 *      assertion deliberately compares the two rendered strings to each other
 *      rather than checking that each is non-empty — "neither is blank" is
 *      satisfied by rendering the same word twice, which is exactly the
 *      conflation this slice exists to prevent.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup, screen } from "@testing-library/react";
import {
  ANY,
  AxisChips,
  FamilyChips,
  NO_FACETS,
  matchesFacets,
  type InterceptorFacets,
} from "./InterceptorFacets";
import type { InterceptorEntry } from "../hooks/useInterceptors";

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

/** An entity with authored coordinates that land in NO family — the 8-name class. */
function outOfModelEntry(): InterceptorEntry {
  return entry({
    guardName: "completion-manifest-regen",
    interventions: [{ type: "mutate" }],
    role: "infrastructure",
    families: [],
    familyState: "out-of-model",
  });
}

/** An entity whose coordinates were never authored — the 6-name class. */
function unclassifiedEntry(): InterceptorEntry {
  return entry({
    guardName: "rationalization-review",
    point: null,
    pointSource: "none",
    interventions: [],
    mechanism: null,
    role: null,
    coordinateGaps: ["point", "interventions", "mechanism", "role"],
    families: [],
    familyState: "unclassified",
    deliberatelyUnauthored: true,
  });
}

describe("matchesFacets — family filtering computes over axis 2 (AT2)", () => {
  test("no active facet admits everything", () => {
    expect(matchesFacets(entry(), NO_FACETS)).toBe(true);
    expect(matchesFacets(unclassifiedEntry(), NO_FACETS)).toBe(true);
  });

  test("a family facet admits only entries whose computed set contains it", () => {
    const guard: InterceptorFacets = { ...NO_FACETS, family: "guard" };
    expect(matchesFacets(entry({ families: ["guard"] }), guard)).toBe(true);
    expect(matchesFacets(entry({ families: ["detector"] }), guard)).toBe(false);
  });

  test("membership is NOT exclusive — one entry satisfies two family facets", () => {
    // `policy-coverage` is both a guard and a detector by ontology amendment
    // (a). This is why the per-family counts do not sum to the population, and
    // why a filter is a set predicate rather than an equality test.
    const both = entry({
      guardName: "policy-coverage",
      interventions: [{ type: "deny" }, { type: "record", audience: "review" }],
      families: ["guard", "detector"],
    });
    expect(matchesFacets(both, { ...NO_FACETS, family: "guard" })).toBe(true);
    expect(matchesFacets(both, { ...NO_FACETS, family: "detector" })).toBe(true);
    expect(matchesFacets(both, { ...NO_FACETS, family: "injector" })).toBe(false);
  });

  test("neither zero-family state matches any family facet", () => {
    for (const e of [outOfModelEntry(), unclassifiedEntry()]) {
      for (const family of ["guard", "detector", "injector"]) {
        expect(matchesFacets(e, { ...NO_FACETS, family })).toBe(false);
      }
    }
  });

  test("point, mechanism and intervention facets each constrain independently", () => {
    const e = entry({
      point: "Stop",
      mechanism: "lexical",
      interventions: [{ type: "record", audience: "review" }],
    });
    expect(matchesFacets(e, { ...NO_FACETS, point: "Stop" })).toBe(true);
    expect(matchesFacets(e, { ...NO_FACETS, point: "PreToolUse" })).toBe(false);
    expect(matchesFacets(e, { ...NO_FACETS, mechanism: "lexical" })).toBe(true);
    expect(matchesFacets(e, { ...NO_FACETS, mechanism: "constant" })).toBe(false);
    expect(matchesFacets(e, { ...NO_FACETS, intervention: "record" })).toBe(true);
    expect(matchesFacets(e, { ...NO_FACETS, intervention: "deny" })).toBe(false);
  });

  test("the role facet constrains on the entity-strata axis (SC1)", () => {
    const feeder = entry({ role: "feeder" });
    expect(matchesFacets(feeder, { ...NO_FACETS, role: "feeder" })).toBe(true);
    expect(matchesFacets(feeder, { ...NO_FACETS, role: "judge" })).toBe(false);
    // An entity with no authored role matches no role facet — it must not fall
    // into an arbitrary bucket.
    expect(matchesFacets(unclassifiedEntry(), { ...NO_FACETS, role: "judge" })).toBe(false);
    expect(matchesFacets(unclassifiedEntry(), { ...NO_FACETS, role: "infrastructure" })).toBe(false);
  });

  test("facets combine conjunctively", () => {
    const e = entry({ point: "Stop", families: ["detector"] });
    expect(matchesFacets(e, { ...NO_FACETS, point: "Stop", family: "detector" })).toBe(true);
    expect(matchesFacets(e, { ...NO_FACETS, point: "Stop", family: "guard" })).toBe(false);
  });

  test("the ANY sentinel is not matched against real data", () => {
    // A regression guard on the sentinel itself: if ANY ever collided with a
    // real axis value, every filter would silently admit that one value.
    expect(entry().point).not.toBe(ANY);
    expect(entry().mechanism).not.toBe(ANY);
  });
});

describe("FamilyChips — the two zero-family states are DIFFERENT markers (AT3)", () => {
  test("out-of-model and unclassified render distinguishable markers", () => {
    const { container: outOfModel } = render(<FamilyChips entry={outOfModelEntry()} />);
    const outOfModelText = outOfModel.textContent ?? "";
    cleanup();

    // The unclassified side is deliberately the PLAIN one — `deliberatelyUnauthored:
    // false`. Comparing against the by-decision variant would let its
    // "(by decision)" suffix do the discriminating work, so the two STATES
    // could render identically and this test would still pass. Caught by the
    // negative control: collapsing both markers to "unclassified" left the
    // original version of this test green.
    const { container: unclassified } = render(
      <FamilyChips entry={{ ...unclassifiedEntry(), deliberatelyUnauthored: false }} />
    );
    const unclassifiedText = unclassified.textContent ?? "";

    // Each says something...
    expect(outOfModelText.trim()).not.toBe("");
    expect(unclassifiedText.trim()).not.toBe("");
    // ...and, the actual requirement, they do not say the SAME thing. A test
    // that only asserted "neither is blank" passes when both render the same
    // word, which is the exact defect AT3 names.
    expect(outOfModelText).not.toBe(unclassifiedText);
  });

  test("each state renders its own marker element", () => {
    render(<FamilyChips entry={outOfModelEntry()} />);
    expect(screen.getByTestId("interceptor-family-out-of-model")).toBeTruthy();
    expect(screen.queryByTestId("interceptor-family-unclassified")).toBeNull();
    cleanup();

    render(<FamilyChips entry={unclassifiedEntry()} />);
    expect(screen.getByTestId("interceptor-family-unclassified")).toBeTruthy();
    expect(screen.queryByTestId("interceptor-family-out-of-model")).toBeNull();
  });

  test("out-of-model is NOT rendered as a gap — it is a finding, not missing data", () => {
    render(<FamilyChips entry={outOfModelEntry()} />);
    const marker = screen.getByTestId("interceptor-family-out-of-model");
    // The amber register is reserved for missing data. An authored entity that
    // lands outside the three family words is a fact about the ontology, and
    // colouring it as a gap would invite someone to "fix" it by widening a
    // capability set until something matched.
    expect(marker.className).not.toContain("warn-amber");
    cleanup();

    render(<FamilyChips entry={unclassifiedEntry()} />);
    expect(screen.getByTestId("interceptor-family-unclassified").className).toContain("warn-amber");
  });

  test("a deliberately-unauthored name says so, separating it from a plain omission", () => {
    render(<FamilyChips entry={unclassifiedEntry()} />);
    const byDecision = screen.getByTestId("interceptor-family-unclassified").textContent ?? "";
    cleanup();

    render(<FamilyChips entry={{ ...unclassifiedEntry(), deliberatelyUnauthored: false }} />);
    const plain = screen.getByTestId("interceptor-family-unclassified").textContent ?? "";

    expect(byDecision).not.toBe(plain);
  });

  test("a classified entry lists its families", () => {
    render(<FamilyChips entry={entry({ families: ["guard", "detector"] })} />);
    const text = screen.getByTestId("interceptor-family-classified").textContent ?? "";
    expect(text).toContain("guard");
    expect(text).toContain("detector");
  });
});

describe("AxisChips — every axis renders a value or an explicit gap marker (AT1)", () => {
  test("a fully-resolved entry renders all three axes", () => {
    render(<AxisChips entry={entry({ point: "Stop", mechanism: "lexical" })} />);
    const text = screen.getByTestId("interceptor-axes").textContent ?? "";
    expect(text).toContain("Stop");
    expect(text).toContain("deny");
    expect(text).toContain("lexical");
    // The entity-strata axis rides the same strip (SC1).
    expect(text).toContain("judge");
  });

  test("an unresolved axis renders a gap marker rather than an empty slot", () => {
    render(<AxisChips entry={unclassifiedEntry()} />);
    expect(screen.getByTestId("interceptor-point-gap")).toBeTruthy();
    expect(screen.getByTestId("interceptor-interventions-gap")).toBeTruthy();
    expect(screen.getByTestId("interceptor-mechanism-gap")).toBeTruthy();
    expect(screen.getByTestId("interceptor-role-gap")).toBeTruthy();
  });

  test("an intervention's audience is rendered, not dropped", () => {
    // `record(review)` is a calibration detector and `record(framework)` is a
    // state writer; ontology amendment (c) exists because collapsing them under
    // one word hid the difference, so the audience has to survive to the UI.
    render(
      <AxisChips
        entry={entry({
          interventions: [
            { type: "record", audience: "review" },
            { type: "inject", audience: "agent" },
          ],
        })}
      />
    );
    const text = screen.getByTestId("interceptor-axes").textContent ?? "";
    expect(text).toContain("record(review)");
    expect(text).toContain("inject(agent)");
  });
});
