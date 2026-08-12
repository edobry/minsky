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

function sources(overrides: Partial<CatalogSources> = {}): CatalogSources {
  return {
    oracleNames: new Set<string>(),
    describedNames: new Set<string>(),
    input: { registryFacts: new Map<string, RegistryFacts>() },
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
});
