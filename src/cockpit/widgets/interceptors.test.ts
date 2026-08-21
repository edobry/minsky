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
    sourceFile: "example-guard",
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
    expect(parsed.entries.length).toBeGreaterThanOrEqual(92);
    // `population` is derived from `entries`, so it cannot disagree with what
    // it counts (mt#4208). This assertion is now true by construction — which
    // is the point, and is why the STRUCTURAL one below is the load-bearing
    // half: it asserts the second copy is gone from the ARTIFACT, not merely
    // that the two agree in memory.
    expect(parsed.population).toBe(parsed.entries.length);
    expect(catalogJson).not.toHaveProperty("population");
  });

  test("exactly the merge-seam interceptors carry the delivery trajectory (mt#4011)", () => {
    // The artifact half of the spine's AT1 parity: the web placement model
    // sends `trajectory: "delivery"` to the merge station and everything else
    // to its point, so this list IS the merge station's membership. A merge
    // interceptor missing from it silently falls back into the PreToolUse
    // cluster; one that does not run at the merge seam carrying it is silently
    // promoted to the merge station.
    //
    // MEMBERSHIP IS THE SEAM, NOT THE POSTURE (mt#1880). Every member was a
    // deny-capable gate until `gate-walk-provenance`, which is record-only —
    // so this test was named "exactly the merge gates" and is now named for
    // what the list actually selects. The operator question the station answers
    // is "what runs when I merge?", and a recorder at that seam runs there; its
    // deny-capability is a separate axis the catalog already carries. Reading
    // the marker as gates-only would have put it in the PreToolUse cluster,
    // which is the first failure mode this test's own comment names.
    const parsed = parseCatalog(catalogJson);
    const delivery = parsed.entries
      .filter((e) => e.trajectory === "delivery")
      .map((e) => e.guardName)
      .sort();
    expect(delivery).toEqual([
      "block-out-of-band-merge",
      "block-subagent-bypass-merge",
      "block-subagent-merge-without-grant",
      "gate-walk-provenance",
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

describe("parseCatalog — the stored-count merge race (mt#4208)", () => {
  /**
   * The exact three-way merge that broke main twice.
   *
   * Base has one entry. Two branches each APPEND one, and each bumps a stored
   * count from 1 to 2. Git unions the `entries` array — the additions sit at
   * different offsets, so both survive — and resolves the single count line
   * without a conflict, because both sides wrote the identical `2`. The result
   * is 3 entries labelled 2: individually consistent on every branch, broken
   * only after the merge, and invisible to a regen hook that keys on SOURCE
   * changes (a merge commit changes no source file).
   */
  function mergedCatalog(): Record<string, unknown> {
    return {
      // Both branches wrote 2; the merge kept one of them. The array has 3.
      population: 2,
      divergence: { declaredButNotDescribed: [], describedButNotDeclared: [] },
      failureClasses: {},
      entries: [
        entry({ guardName: "base-guard" }),
        entry({ guardName: "branch-a-guard" }),
        entry({ guardName: "branch-b-guard" }),
      ],
    };
  }

  test("a merge that unions two branches' entry additions is accepted", () => {
    // Under the stored-count implementation this threw
    // "population (2) does not match its 3 entries" and took CI on main down.
    const parsed = parseCatalog(mergedCatalog());
    expect(parsed.entries.length).toBe(3);
  });

  test("the derived count reflects the entries, not the stale stored number", () => {
    // The discriminating assertion: accepting the input is not enough — the
    // number handed to the UI has to be the RIGHT one. A parser that merely
    // dropped the check would pass the test above and still render "2 declared"
    // for 3 interceptors.
    expect(parseCatalog(mergedCatalog()).population).toBe(3);
  });

  test("a catalog with no stored count at all is accepted (the shipped shape)", () => {
    const { population: _dropped, ...withoutCount } = mergedCatalog();
    expect(parseCatalog(withoutCount).population).toBe(3);
  });

  test("removing the count check did not remove the other envelope checks", () => {
    // AT2: the guard was narrowed, not deleted. Each of these is a DIFFERENT
    // malformation, and each must still throw with the stored count absent —
    // otherwise this task traded one broken invariant for no invariant.
    const base = mergedCatalog();
    expect(() => parseCatalog({ ...base, entries: undefined })).toThrow(/no `entries` array/);
    expect(() => parseCatalog({ ...base, failureClasses: undefined })).toThrow(
      /no `failureClasses` map/
    );
    expect(() => parseCatalog({ ...base, divergence: undefined })).toThrow(
      /no `divergence` report/
    );
    expect(() => parseCatalog({ ...base, entries: [entry({ guardName: "" })] })).toThrow();
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

  test("IGNORES a stored population that disagrees with the entry count (mt#4208)", () => {
    // This assertion is INVERTED from what it was, deliberately. It used to
    // require a throw, and that requirement is what broke main twice: the
    // disagreement it detects is produced by git's line-merge, not by an
    // author, so throwing punished the merge rather than the mistake. The
    // count is now derived, so a stale stored value is simply not consulted.
    //
    // Kept rather than deleted, because the input shape still needs an
    // assertion — silently dropping the case would leave nothing pinning what
    // happens when the field is present and wrong, which is exactly the state
    // every catalog committed before this change is in.
    const stale = { ...(catalog([entry()]) as object), population: 7 };
    expect(parseCatalog(stale).population).toBe(1);
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
