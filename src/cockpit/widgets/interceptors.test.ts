/**
 * Boundary-validation tests for the interceptors widget (mt#4010, PR #2930 R1).
 *
 * The envelope checks alone let a right-LENGTH `entries` array of malformed
 * rows through, and a malformed row is the shape that reads as a plausible
 * catalog: a nameless row whose detail link goes nowhere, or a
 * `failureClasses` that throws inside the render instead of degrading the
 * widget. These pin the row-level checks and, critically, assert the REAL
 * shipped artifact still passes — a validator nothing valid can satisfy is
 * just an outage.
 */
import { describe, test, expect } from "bun:test";
import { parseCatalog, type InterceptorEntry } from "./interceptors";
import catalogJson from "../../generated/interceptor-catalog.json";

function entry(overrides: Partial<InterceptorEntry> = {}): InterceptorEntry {
  return {
    guardName: "example-guard",
    description: "Blocks the example failure.",
    failureClasses: ["broken-main"],
    provenance: [".minsky/hooks/example-guard.ts"],
    stratum: "registry",
    subject: "trajectory",
    provenanceStatus: "implementation",
    coverageGaps: [],
    registered: true,
    undescribed: false,
    // Axis coordinates (mt#4056). The default is a fully-resolved `classified`
    // entry so each rejection test below can break exactly one field.
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

function catalog(entries: unknown[]): unknown {
  return {
    population: entries.length,
    divergence: { declaredButNotDescribed: [], describedButNotDeclared: [] },
    failureClasses: { "broken-main": { failure: "f", question: "q" } },
    entries,
  };
}

describe("parseCatalog — the real artifact", () => {
  test("the shipped catalog validates", () => {
    // The control on every rejection test below: these checks must admit the
    // artifact this repo actually ships, or they are an outage rather than a
    // guard.
    const parsed = parseCatalog(catalogJson);
    expect(parsed.entries.length).toBe(parsed.population);
    expect(parsed.entries.length).toBeGreaterThanOrEqual(92);
  });

  test("exactly the merge gates carry the authored delivery trajectory (mt#4011)", () => {
    // The artifact half of the spine's AT1 parity: the web placement model
    // sends `trajectory: "delivery"` to the merge station and everything else
    // to its point, so this list IS the merge station's membership. A merge
    // gate missing from it silently falls back into the PreToolUse cluster;
    // a non-gate carrying it is silently promoted to the merge station.
    const parsed = parseCatalog(catalogJson);
    const delivery = parsed.entries
      .filter((e) => e.trajectory === "delivery")
      .map((e) => e.guardName)
      .sort();
    expect(delivery).toEqual([
      "block-out-of-band-merge",
      "block-subagent-bypass-merge",
      "block-subagent-merge-without-grant",
      "require-checks-on-bypass-merge",
      "require-deploy-verification-before-merge",
      "require-execution-evidence-before-merge",
      "require-growth-justification-before-merge",
      "require-review-before-merge",
    ]);
    // Every delivery entry keeps its mechanism point — the marker never
    // overwrites axis-1 truth.
    for (const e of parsed.entries) {
      if (e.trajectory === "delivery") expect(e.point).toBe("PreToolUse");
    }
  });
});

describe("parseCatalog — envelope", () => {
  test("rejects a non-object", () => {
    expect(() => parseCatalog(null)).toThrow(/not an object/);
    expect(() => parseCatalog("nope")).toThrow(/not an object/);
  });

  test("rejects a missing entries array", () => {
    expect(() => parseCatalog({ population: 0 })).toThrow(/no `entries` array/);
  });

  test("rejects a population that disagrees with the entry count", () => {
    const bad = { ...(catalog([entry()]) as object), population: 7 };
    expect(() => parseCatalog(bad)).toThrow(/does not match/);
  });

  test("rejects a missing divergence report", () => {
    const bad = { ...(catalog([entry()]) as object), divergence: undefined };
    expect(() => parseCatalog(bad)).toThrow(/`divergence` report/);
  });
});

describe("parseCatalog — per-row shape (PR #2930 R1)", () => {
  test("rejects a row that is not an object", () => {
    expect(() => parseCatalog(catalog(["nope"]))).toThrow(/entry 0 is not an object/);
  });

  test("rejects a row with no guardName, naming its index", () => {
    expect(() => parseCatalog(catalog([entry({ guardName: undefined as never })]))).toThrow(
      /entry 0 \(unnamed\): missing `guardName`/
    );
  });

  test("names the offending row when it has a guardName", () => {
    expect(() =>
      parseCatalog(
        catalog([entry(), entry({ guardName: "bad-one", failureClasses: "x" as never })])
      )
    ).toThrow(/entry 1 \(bad-one\)/);
  });

  test("rejects failureClasses / provenance / coverageGaps that are not string arrays", () => {
    expect(() => parseCatalog(catalog([entry({ failureClasses: "x" as never })]))).toThrow(
      /`failureClasses` is not an array of strings/
    );
    expect(() => parseCatalog(catalog([entry({ provenance: [1] as never })]))).toThrow(
      /`provenance` is not an array of strings/
    );
    expect(() => parseCatalog(catalog([entry({ coverageGaps: [{}] as never })]))).toThrow(
      /`coverageGaps` is not an array of strings/
    );
  });

  test("rejects an unknown stratum, subject, or provenanceStatus", () => {
    expect(() => parseCatalog(catalog([entry({ stratum: "invented" as never })]))).toThrow(
      /unknown stratum/
    );
    expect(() => parseCatalog(catalog([entry({ subject: "other" as never })]))).toThrow(
      /unknown subject/
    );
    expect(() => parseCatalog(catalog([entry({ provenanceStatus: "maybe" as never })]))).toThrow(
      /unknown provenanceStatus/
    );
  });

  test("accepts a null stratum — that is a declared gap, not a malformation", () => {
    expect(() => parseCatalog(catalog([entry({ stratum: null })]))).not.toThrow();
  });

  test("rejects an unknown trajectory value, accepts delivery and null", () => {
    expect(() =>
      parseCatalog(catalog([entry({ trajectory: "repo" as unknown as "delivery" })]))
    ).toThrow(/unknown trajectory/);
    expect(() => parseCatalog(catalog([entry({ trajectory: "delivery" })]))).not.toThrow();
    expect(() => parseCatalog(catalog([entry({ trajectory: null })]))).not.toThrow();
  });

  test("enforces description-null <-> undescribed", () => {
    // The honesty invariant: a described row with a null description renders
    // as a blank cell, which is the conflation this whole surface avoids.
    expect(() => parseCatalog(catalog([entry({ description: null, undescribed: false })]))).toThrow(
      /null-ness disagrees/
    );
    expect(() =>
      parseCatalog(catalog([entry({ description: "text", undescribed: true })]))
    ).toThrow(/null-ness disagrees/);
    expect(() =>
      parseCatalog(catalog([entry({ description: null, undescribed: true })]))
    ).not.toThrow();
  });
});
