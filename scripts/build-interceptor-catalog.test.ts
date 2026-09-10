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
import {
  buildCatalog,
  buildResolveInput,
  collectOracleNames,
  type CatalogSources,
} from "./build-interceptor-catalog";
import { STANDALONE_GUARD_CANARIES } from "./lib/standalone-guard-canaries";
import {
  INTERCEPTOR_DESCRIPTIONS,
  resolveCatalogEntry,
} from "../.minsky/hooks/interceptor-descriptions";
import { GUARD_REGISTRY } from "../.minsky/hooks/registry";
import type { RegistryFacts } from "../.minsky/hooks/interceptor-descriptions";
import {
  DELIBERATELY_UNAUTHORED_NAMES,
  OUT_OF_MODEL_NAMES,
  type CoordinateResolutionInput,
} from "../.minsky/hooks/interceptor-coordinates";
import { buildCoordinateResolutionInput } from "./interceptor-coordinate-input";
import { derivePrecommitStepNames } from "./precommit-step-names";
import { readSettingsHookNames } from "./interceptor-coordinate-input";

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

    expect(catalog.entries.length).toBe(1);
    expect(catalog.entries[0]?.guardName).toBe("orphan-guard");
    // The load-bearing assertion: it is PRESENT with an explicit marker, not
    // dropped. Dropping it is the absence-vs-declaration conflation.
    expect(catalog.entries[0]?.undescribed).toBe(true);
    expect(catalog.entries[0]?.description).toBeNull();
    expect(catalog.divergence.declaredButNotDescribed).toEqual(["orphan-guard"]);
  });

  test("a described name absent from the oracle is reported in the other direction", () => {
    const catalog = buildCatalog(sources({ describedNames: new Set(["parallel-work-guard"]) }));

    expect(catalog.entries.length).toBe(1);
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
  // mt#5072: `buildResolveInput()` rather than a hand-built copy of it. This
  // block used to reconstruct the resolver input inline, which made it a
  // DUPLICATE of the generator's own construction — so it asserted a catalog
  // the generator does not produce. It went stale the moment a second canary
  // declaration surface was added: the inline copy still reported 93 canary
  // gaps while the real generator reported 81.
  const real = buildCatalog({
    oracleNames: collectOracleNames(),
    describedNames: new Set(INTERCEPTOR_DESCRIPTIONS.keys()),
    input: buildResolveInput(),
    coordinateInput: buildCoordinateResolutionInput(),
  });

  test("no description exists for a name outside the population", () => {
    // `describedButNotDeclared` must stay empty in this direction: a described
    // name the oracle does not declare is a stale description, and nothing
    // downstream would ever surface it.
    expect(real.divergence.describedButNotDeclared).toEqual([]);
  });

  test("the undescribed names are exactly the settings-registered ones (mt#4129)", () => {
    // The OTHER direction is no longer required to be empty, and that is the
    // point of mt#4129 rather than a relaxation. Until it, the oracle admitted a
    // non-registry hook only if it FIRE-LOGGED, so a hook that decides quietly
    // was in neither set this divergence compares — both lists stayed empty
    // while the catalog omitted 30 registered hooks. Widening the population
    // makes them appear, and they appear as what they are: declared, not yet
    // described. Authoring them is mt#4198.
    //
    // Still pinned, tightly: every undescribed name must be settings-registered.
    // A name undescribed for any OTHER reason is the stale-corpus case the
    // original assertion caught, and it still fails here.
    const registered = new Set(readSettingsHookNames() ?? []);
    expect(registered.size).toBeGreaterThan(0);
    for (const name of real.divergence.declaredButNotDescribed) {
      expect(registered.has(name), `${name} is undescribed but not settings-registered`).toBe(true);
    }
  });

  test("population covers the described set and every registered hook (mt#4129)", () => {
    // Was `population === INTERCEPTOR_DESCRIPTIONS.size`, an equality that held
    // only because the oracle excluded everything undescribed — it measured the
    // descriptions against themselves.
    expect(real.entries.length).toBeGreaterThanOrEqual(INTERCEPTOR_DESCRIPTIONS.size);
    const names = new Set(real.entries.map((e) => e.guardName));
    for (const registered of readSettingsHookNames() ?? []) {
      expect(names.has(registered), `${registered} is registered but not in the catalog`).toBe(
        true
      );
    }
    // A floor rather than an exact figure: the corpus grows with every guard
    // added. 130 was the measured population when mt#4129 widened it (102 before).
    expect(real.entries.length).toBeGreaterThanOrEqual(102);
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

  test("every DESCRIBED entry carries a stratum and at least one failure class", () => {
    // Scoped to described entries by mt#4129. Stratum and failure classes come
    // from the description, so an entry admitted by registration and not yet
    // described has neither — by construction, not by defect. It carries
    // `undescribed: true` instead, which the next assertion pins.
    for (const entry of real.entries) {
      if (entry.undescribed) continue;
      expect(entry.stratum).not.toBeNull();
      expect(entry.failureClasses.length).toBeGreaterThan(0);
    }
  });

  test("an undescribed entry says so explicitly rather than defaulting (mt#4129)", () => {
    // The gap markers are the whole reason a registration-admitted entry is
    // honest: present in the population, and visibly missing its authored half.
    // An entry that rendered a plausible default here would be worse than the
    // omission mt#4129 fixed.
    //
    // Exercised against a SYNTHETIC name, not against the live corpus. As
    // written for mt#4129 this asserted `undescribed.length > 0` over the real
    // entries, which held only while the 28 names mt#4129 admitted were still
    // unauthored — so finishing that authoring in mt#4198 falsified it. A test
    // that passes only while the corpus is incomplete measures the backlog, not
    // the mechanism, and inverts precisely when the work it is watching is done.
    const entry = resolveCatalogEntry("no-such-interceptor-exists", { registryFacts: new Map() });
    expect(entry.undescribed).toBe(true);
    expect(entry.description).toBeNull();
    expect(entry.stratum).toBeNull();
    expect(entry.failureClasses).toEqual([]);

    // The live corpus keeps the consistency half: whatever IS undescribed at any
    // moment carries the same markers. Zero such entries is a passing state.
    for (const live of real.entries.filter((e) => e.undescribed)) {
      expect(live.description).toBeNull();
      expect(live.stratum).toBeNull();
      expect(live.failureClasses).toEqual([]);
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
      real.entries.length
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

  test("the unclassified set is the deliberately-unauthored plus the not-yet-authored (mt#4129)", () => {
    // Was "exactly DELIBERATELY_UNAUTHORED_NAMES". mt#4129 admitted 28
    // registration-declared hooks whose coordinates nobody has written yet, and
    // `unclassified` is the model's own word for that state — its docblock
    // distinguishes it from `out-of-model` precisely so the two are not rendered
    // alike. Authoring them is mt#4198; until then they belong here.
    //
    // The invariant this preserves is the one that mattered: every unclassified
    // name is unclassified for a KNOWN reason. A name that is neither
    // deliberately unauthored nor settings-registered means a real interceptor
    // lost its coordinates, which is the case the catalog must not render as an
    // ordinary blank — and it still fails here.
    const registered = new Set(readSettingsHookNames() ?? []);
    const unclassified = real.entries.filter((e) => e.familyState === "unclassified");
    expect(unclassified.length).toBeGreaterThan(0);

    for (const entry of unclassified) {
      const known = entry.deliberatelyUnauthored || registered.has(entry.guardName);
      expect(known, `${entry.guardName} is unclassified for no declared reason`).toBe(true);
    }

    // Every deliberately-unauthored name still lands here, and still says so.
    const names = new Set(unclassified.map((e) => e.guardName));
    for (const name of DELIBERATELY_UNAUTHORED_NAMES) {
      expect(names.has(name), `${name} is deliberately unauthored but not unclassified`).toBe(true);
    }
    for (const entry of unclassified) {
      if (!registered.has(entry.guardName)) {
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

  // -------------------------------------------------------------------------
  // mt#5072 — canary coverage counts BOTH declaration surfaces
  // -------------------------------------------------------------------------

  describe("canary coverage counts both declaration surfaces (mt#5072)", () => {
    const byName = new Map(real.entries.map((e) => [e.guardName, e]));

    // The load-bearing assertion, and deliberately an INVARIANT rather than a
    // number. The population drifts constantly — 149 -> 154 entries in 16 days,
    // with the false-gap set itself changing membership as guards are added and
    // retired — so "the count is 81" would go stale on the next merge while this
    // stays true for any corpus.
    test("no guard with a declared standalone canary is reported as canary-gapped", () => {
      const declared = STANDALONE_GUARD_CANARIES.map((c) => c.guardName);
      expect(declared.length).toBeGreaterThan(0);

      const wronglyGapped = declared.filter((name) =>
        byName.get(name)?.coverageGaps.includes("canary")
      );
      expect(wronglyGapped).toEqual([]);
    });

    test("every declared standalone canary names a real catalog entity", () => {
      // Guards the other direction: a canary declared for a name the catalog
      // does not carry would make the assertion above vacuously true.
      const missing = STANDALONE_GUARD_CANARIES.map((c) => c.guardName).filter(
        (name) => !byName.has(name)
      );
      expect(missing).toEqual([]);
    });

    test("a standalone canary does NOT make the guard look registered", () => {
      // The trap this fix had to avoid. Injecting these names into
      // `registryFacts` would clear the canary gap and also flip `registered`
      // to true, because `resolveCatalogEntry` derives it from the presence of
      // that map entry. A standalone guard has no `GuardRegistration`, so
      // `registered` must stay false — and nothing else in the corpus compares
      // that field, which is what would have made the corruption silent.
      for (const { guardName } of STANDALONE_GUARD_CANARIES) {
        const entry = byName.get(guardName);
        if (entry === undefined || GUARD_REGISTRY.some((r) => r.name === guardName)) continue;
        expect(entry.registered).toBe(false);
      }
    });

    test("clearing the canary gap leaves the other two coverage gaps alone", () => {
      // A standalone guard has no registry entry at all, so it genuinely lacks
      // `tuningOwnership` and `attentionCost`. Only the canary claim changed.
      for (const { guardName } of STANDALONE_GUARD_CANARIES) {
        const entry = byName.get(guardName);
        if (entry === undefined || GUARD_REGISTRY.some((r) => r.name === guardName)) continue;
        expect([...entry.coverageGaps].sort()).toEqual(["attentionCost", "tuningOwnership"]);
      }
    });
  });
});
