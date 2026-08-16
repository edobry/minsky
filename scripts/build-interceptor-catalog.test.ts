/**
 * Tests for the interceptor-catalog generator (mt#4010).
 *
 * Two layers:
 *   1. `buildCatalog` as a pure function, driven with fixtures — the union
 *      semantics, the divergence report, and the undescribed marker.
 *   2. The REAL corpus, asserting the two independent declarations agree. This
 *      is the check the spec's population claim rests on; it is measured here
 *      rather than hard-coded, so it stays true as the corpus grows.
 */
import { describe, test, expect } from "bun:test";
import { buildCatalog, collectOracleNames, type CatalogSources } from "./build-interceptor-catalog";
import { INTERCEPTOR_DESCRIPTIONS } from "../.minsky/hooks/interceptor-descriptions";
import { GUARD_REGISTRY } from "../.minsky/hooks/registry";
import type { RegistryFacts } from "../.minsky/hooks/interceptor-descriptions";
import {
  DELIBERATELY_UNAUTHORED_NAMES,
  OUT_OF_MODEL_NAMES,
  type CoordinateResolutionInput,
} from "../.minsky/hooks/interceptor-coordinates";
import { buildCoordinateResolutionInput } from "./interceptor-coordinate-input";
import { derivePrecommitStepNames } from "./precommit-step-names";

/**
 * An EMPTY coordinate input, so a fixture name resolves to all-gaps.
 *
 * That is the honest default for an invented name: nothing declares it, so
 * every axis is a gap and the family state is `unclassified`. A fixture that
 * silently resolved a point would be testing against data the resolver made up.
 */
function emptyCoordinateInput(): CoordinateResolutionInput {
  return {
    registryEvents: new Map<string, string>(),
    settingsEvents: new Map<string, string>(),
    strata: new Map<string, string>(),
  };
}

function sources(overrides: Partial<CatalogSources> = {}): CatalogSources {
  return {
    oracleNames: new Set<string>(),
    describedNames: new Set<string>(),
    input: { registryFacts: new Map<string, RegistryFacts>() },
    coordinateInput: emptyCoordinateInput(),
    ...overrides,
  };
}

describe("buildCatalog — population is the UNION of both declarations", () => {
  test("a name in only the oracle is still rendered, marked undescribed", () => {
    const catalog = buildCatalog(sources({ oracleNames: new Set(["orphan-guard"]) }));

    expect(catalog.population).toBe(1);
    expect(catalog.entries[0]?.guardName).toBe("orphan-guard");
    // The load-bearing assertion: it is PRESENT with an explicit marker, not
    // dropped. Dropping it is the absence-vs-declaration conflation.
    expect(catalog.entries[0]?.undescribed).toBe(true);
    expect(catalog.entries[0]?.description).toBeNull();
    expect(catalog.divergence.declaredButNotDescribed).toEqual(["orphan-guard"]);
  });

  test("a described name absent from the oracle is reported in the other direction", () => {
    const catalog = buildCatalog(sources({ describedNames: new Set(["parallel-work-guard"]) }));

    expect(catalog.population).toBe(1);
    expect(catalog.divergence.describedButNotDeclared).toEqual(["parallel-work-guard"]);
    expect(catalog.divergence.declaredButNotDescribed).toEqual([]);
  });

  test("a name in both is counted once and reported in neither direction", () => {
    const catalog = buildCatalog(
      sources({
        oracleNames: new Set(["a", "b"]),
        describedNames: new Set(["b", "c"]),
      })
    );

    expect(catalog.entries.map((e) => e.guardName)).toEqual(["a", "b", "c"]);
    expect(catalog.divergence.declaredButNotDescribed).toEqual(["a"]);
    expect(catalog.divergence.describedButNotDeclared).toEqual(["c"]);
  });

  test("entries are sorted by name, so the artifact's byte output is stable", () => {
    const catalog = buildCatalog(sources({ oracleNames: new Set(["zeta", "alpha", "mid"]) }));
    expect(catalog.entries.map((e) => e.guardName)).toEqual(["alpha", "mid", "zeta"]);
  });

  test("coverage gaps are enumerated, never defaulted", () => {
    // A name with NO registry entry is missing every registry-sourced field —
    // all three must be listed rather than silently treated as satisfied.
    const catalog = buildCatalog(sources({ oracleNames: new Set(["unregistered"]) }));
    expect(catalog.entries[0]?.coverageGaps).toEqual([
      "tuningOwnership",
      "attentionCost",
      "canary",
    ]);
    expect(catalog.entries[0]?.registered).toBe(false);
  });

  test("carries the failure-class taxonomy so the cockpit needs no second copy", () => {
    const catalog = buildCatalog(sources());
    expect(Object.keys(catalog.failureClasses).length).toBeGreaterThan(0);
    for (const def of Object.values(catalog.failureClasses)) {
      expect(typeof def.failure).toBe("string");
      expect(typeof def.question).toBe("string");
    }
  });

  test("emits the generated banner the generated-file-edit guard matches", () => {
    expect(buildCatalog(sources())._generated).toContain("do not edit directly");
  });
});

describe("the real corpus", () => {
  const real = buildCatalog({
    oracleNames: collectOracleNames(),
    describedNames: new Set(INTERCEPTOR_DESCRIPTIONS.keys()),
    input: {
      registryFacts: new Map(
        GUARD_REGISTRY.map((r) => [
          r.name,
          {
            tuningOwnership: r.tuningOwnership,
            hasAttentionCost: r.attentionCost !== undefined,
            hasCanary: r.canary !== undefined,
          },
        ])
      ),
    },
    coordinateInput: buildCoordinateResolutionInput(),
  });

  test("the oracle and the descriptions agree on the population", () => {
    // Zero divergence in EITHER direction is what lets the catalog claim to
    // render "the declared population" rather than one source's opinion of it.
    // If this fails, the corpus moved: author the missing description (or
    // retire the stale one) rather than relaxing the assertion.
    expect(real.divergence.declaredButNotDescribed).toEqual([]);
    expect(real.divergence.describedButNotDeclared).toEqual([]);
  });

  test("population equals the described set — measured, not hard-coded", () => {
    expect(real.population).toBe(INTERCEPTOR_DESCRIPTIONS.size);
    // A floor rather than an exact figure: the corpus grows with every guard
    // added, and pinning the count would make this test a chore instead of a
    // check. The spec's measured figure at authoring time was 92.
    expect(real.population).toBeGreaterThanOrEqual(92);
  });

  test("every pre-commit step the hook actually runs is in the population (mt#4071)", () => {
    // The oracle resolves pre-commit names by DERIVING them from
    // `src/hooks/pre-commit.ts`, not by reading the hand-maintained snapshot.
    // When it read the snapshot, a step added without a matching snapshot edit
    // was absent from the catalog and reported by nothing: the divergence
    // lists above compare descriptions against the oracle, and such a name is
    // in neither, so both stay empty while the catalog is incomplete.
    const oracle = collectOracleNames();
    for (const step of derivePrecommitStepNames() ?? []) {
      expect(oracle.has(step)).toBe(true);
    }

    // The originating instance, pinned by name — a step this generator's own
    // pre-commit hook runs, missing from the catalog it builds.
    expect(oracle.has("interceptor-catalog-regen")).toBe(true);
    expect(real.entries.some((e) => e.guardName === "interceptor-catalog-regen")).toBe(true);
  });

  test("every entry carries a stratum and at least one failure class", () => {
    for (const entry of real.entries) {
      expect(entry.stratum).not.toBeNull();
      expect(entry.failureClasses.length).toBeGreaterThan(0);
    }
  });

  test("every declared failure class is defined in the taxonomy", () => {
    const defined = new Set(Object.keys(real.failureClasses));
    for (const entry of real.entries) {
      for (const c of entry.failureClasses) {
        expect(defined.has(c)).toBe(true);
      }
    }
  });

  // --- Axis coordinates (mt#4056 slice 1b) ---

  test("every entry resolves an interception point OR enumerates it as a gap (AT1)", () => {
    // Never a silent null: the resolver's contract is that an underivable axis
    // is REPORTED, and the UI's gap markers are only trustworthy if that holds
    // for the real corpus rather than for a fixture.
    for (const entry of real.entries) {
      expect(entry.point === null).toBe(entry.coordinateGaps.includes("point"));
    }
  });

  test("family states partition the population (AT2)", () => {
    // The per-family counts deliberately do NOT sum to the population —
    // membership is not exclusive — so the STATE breakdown is the one that has
    // to add up, and it is what the page renders as a sum.
    const byState = (s: string): number => real.entries.filter((e) => e.familyState === s).length;
    expect(byState("classified") + byState("out-of-model") + byState("unclassified")).toBe(
      real.population
    );
  });

  test("a classified entry has families; neither zero-family state does", () => {
    for (const entry of real.entries) {
      expect(entry.families.length > 0).toBe(entry.familyState === "classified");
    }
  });

  test("the out-of-model set is exactly OUT_OF_MODEL_NAMES", () => {
    // Pinned against the constant the coordinate module asserts as an exact
    // set, so an entity joining or leaving this class is a visible diff here
    // too rather than a quiet shift in what the catalog renders.
    const computed = real.entries
      .filter((e) => e.familyState === "out-of-model")
      .map((e) => e.guardName)
      .sort();
    expect(computed).toEqual([...OUT_OF_MODEL_NAMES].sort());
  });

  test("the unclassified set is exactly the deliberately-unauthored names", () => {
    // If this fails, a REAL interceptor lost its coordinates — the case the
    // catalog must not render as an ordinary blank.
    const computed = real.entries
      .filter((e) => e.familyState === "unclassified")
      .map((e) => e.guardName)
      .sort();
    expect(computed).toEqual([...DELIBERATELY_UNAUTHORED_NAMES].sort());
    for (const entry of real.entries) {
      if (entry.familyState === "unclassified") {
        expect(entry.deliberatelyUnauthored).toBe(true);
      }
    }
  });

  test("every computed family is derivable from the entry's own intervention set", () => {
    // The family words are FILTERS over axis 2, never stored kinds. This
    // asserts the generator did not invent membership from anything else.
    for (const entry of real.entries) {
      const types = new Set(entry.interventions.map((i) => i.type));
      if (entry.families.includes("guard")) {
        expect(types.has("deny") || types.has("allow")).toBe(true);
      }
      if (entry.families.includes("injector")) {
        expect(types.has("inject")).toBe(true);
      }
      if (entry.families.includes("detector")) {
        expect(
          entry.interventions.some((i) => i.type === "record" && i.audience === "review")
        ).toBe(true);
      }
    }
  });
});
