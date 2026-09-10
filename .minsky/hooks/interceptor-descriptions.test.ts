// Tests for the per-interceptor description store — mt#4008.
//
// The three acceptance tests, in order:
//
//   AT1 — a sampled registry guard, standalone hook and pre-commit step each
//         resolve to a description + failure class by `guardName`.
//   AT2 — POPULATION CHECK: every distinct `guardName` in the declared
//         population resolves to a description or an explicit `undescribed`
//         marker. Zero silent drops.
//   AT3 — every provenance pointer resolves to the source it distills.
//
// AT2's population is derived from `known-guard-names.ts`'s four enumerations
// plus `GUARD_REGISTRY`, NOT from the registry alone — registry-derived
// authoring silently drops ~57% of the corpus (39 of 91), which is mt#3754's
// falsifier (6) and the reason this task exists.
//
// THIS SUITE IS HERMETIC. The two checks whose subject is the real repo — do
// the provenance paths resolve, does the ontology page document every class —
// are pure functions here, exercised with injected inputs. Their real-repo arm
// runs in `scripts/audit-interceptor-descriptions.ts`, which also carries the
// arm that reads the live 85MB fire log. A test that walked the disk would
// violate `custom/no-real-fs-in-tests` and would not run in a bare checkout.

import { describe, expect, test } from "bun:test";
import { GUARD_REGISTRY } from "./registry";
import {
  FIXTURE_GUARD_NAMES,
  PRECOMMIT_STEP_NAMES,
  RETIRED_GUARD_NAMES,
  STANDALONE_GUARD_NAMES,
} from "./known-guard-names";
import {
  FAILURE_CLASSES,
  INTERCEPTOR_DESCRIPTIONS,
  findMissingProvenance,
  findUndocumentedFailureClasses,
  interceptorsByFailureClass,
  resolveCanaryDisposition,
  resolveCatalog,
  resolveCatalogEntry,
  type CanaryDispositionInput,
  type CanaryDispositionRecord,
  type FailureClass,
  type RegistryFacts,
  type ResolveCatalogInput,
} from "./interceptor-descriptions";
// The settings-derived half of the population (mt#4129). Imported from
// `scripts/` because that is where the derivation lives and duplicating it here
// would recreate the two-oracles problem this union exists to close; a test file
// never runs as a hook, so the hook tree's self-containment target is unaffected.
import { readSettingsHookNames } from "../../scripts/interceptor-coordinate-input";

/** Sample entities, named once so a rename breaks the test rather than narrowing it. */
const SAMPLE_REGISTRY_GUARD = "check-guessed-session-path";
const SAMPLE_STANDALONE_HOOK = "block-git-gh-cli";
const SAMPLE_PRECOMMIT_STEP = "type-check";

/**
 * The declared population: every name any enumeration in the repo claims exists.
 *
 * `readSettingsHookNames()` is unioned in as of mt#4198, and it is the piece
 * that makes this the CATALOG's population rather than a second, older one.
 * mt#4129 moved the standalone population's definition from
 * `STANDALONE_GUARD_NAMES` to `.claude/settings.json` — that constant's own
 * docblock now says so and asks not to be grown — but this list was not
 * updated with it, so it kept composing the pre-mt#4129 oracle. The 28 hooks
 * mt#4129 admitted were absent from it, and authoring their descriptions in
 * mt#4198 surfaced all 28 as "orphans" against a population that no longer
 * matches what the catalog builds.
 *
 * Two tests below depend on this being the real population, not a subset: the
 * orphan check is meaningless against a stale oracle, and the majority-dropped
 * assertion sat exactly ON its boundary (53 of 106) because the missing names
 * are precisely the non-registry ones it counts.
 */
const DECLARED_POPULATION: readonly string[] = [
  ...new Set([
    ...GUARD_REGISTRY.map((r) => r.name),
    ...PRECOMMIT_STEP_NAMES,
    ...STANDALONE_GUARD_NAMES,
    ...(readSettingsHookNames() ?? []),
    ...RETIRED_GUARD_NAMES.keys(),
    ...FIXTURE_GUARD_NAMES.keys(),
  ]),
];

interface RegistryEntryShape {
  readonly tuningOwnership?: string;
  readonly attentionCost?: unknown;
  readonly canary?: unknown;
}

function buildInput(): ResolveCatalogInput {
  const registryFacts = new Map<string, RegistryFacts>();
  for (const r of GUARD_REGISTRY) {
    const entry = r as unknown as RegistryEntryShape;
    registryFacts.set(r.name, {
      tuningOwnership: entry.tuningOwnership,
      hasAttentionCost: entry.attentionCost !== undefined,
      hasCanary: entry.canary !== undefined,
    });
  }
  return { registryFacts };
}

describe("AT1 — a description + failure class is retrievable by guardName", () => {
  const samples: ReadonlyArray<readonly [string, string]> = [
    ["registry guard", SAMPLE_REGISTRY_GUARD],
    ["standalone hook", SAMPLE_STANDALONE_HOOK],
    ["pre-commit step", SAMPLE_PRECOMMIT_STEP],
  ];

  for (const [label, guardName] of samples) {
    test(`${label}: ${guardName}`, () => {
      const entry = resolveCatalogEntry(guardName, buildInput());

      expect(entry.undescribed).toBe(false);
      expect(entry.description).toBeTruthy();
      // "One to two sentences" — a real description, not a stub.
      expect((entry.description ?? "").length).toBeGreaterThan(40);
      expect(entry.failureClasses.length).toBeGreaterThanOrEqual(1);
      for (const fc of entry.failureClasses) {
        expect(FAILURE_CLASSES[fc]).toBeDefined();
      }
    });
  }

  test("the three samples span three different strata", () => {
    const input = buildInput();
    const strata = samples.map(([, name]) => resolveCatalogEntry(name, input).stratum);
    expect(new Set(strata).size).toBe(3);
  });
});

describe("AT2 — population check: zero silent drops", () => {
  test("every declared name resolves to a description or an explicit undescribed marker", () => {
    const entries = resolveCatalog(DECLARED_POPULATION, buildInput());

    // Nothing is filtered: one entry out per name in.
    expect(entries).toHaveLength(DECLARED_POPULATION.length);

    const undescribed = entries.filter((e) => e.undescribed).map((e) => e.guardName);
    expect(undescribed).toEqual([]);
  });

  test("an unknown name resolves to an explicit gap rather than undefined", () => {
    const entry = resolveCatalogEntry("a-name-that-exists-nowhere", buildInput());

    expect(entry).toBeDefined();
    expect(entry.undescribed).toBe(true);
    expect(entry.description).toBeNull();
    expect(entry.registered).toBe(false);
    // SC3: gaps are enumerated, never defaulted away.
    expect(entry.coverageGaps).toEqual(["tuningOwnership", "attentionCost", "canary"]);
  });

  test("the store describes no name the declared population does not contain", () => {
    const declared = new Set(DECLARED_POPULATION);
    const orphans = [...INTERCEPTOR_DESCRIPTIONS.keys()].filter((n) => !declared.has(n));
    expect(orphans).toEqual([]);
  });

  test("registry-derived authoring alone would drop the majority of the corpus", () => {
    // mt#3754 falsifier (6), asserted rather than narrated: this is why the
    // population is the fire-log name set and not GUARD_REGISTRY.
    const registryNames = new Set(GUARD_REGISTRY.map((r) => r.name));
    const dropped = DECLARED_POPULATION.filter((n) => !registryNames.has(n));
    expect(dropped.length).toBeGreaterThan(DECLARED_POPULATION.length / 2);
  });
});

describe("AT3 — provenance resolves to the source it distills", () => {
  test("no missing pointers when every path resolves", () => {
    expect(findMissingProvenance(() => true)).toEqual([]);
  });

  test("a pointer that does not resolve is reported with its guardName", () => {
    // The check must be capable of failing — a resolver that always returns
    // an empty list would pass the test above while proving nothing.
    const target = INTERCEPTOR_DESCRIPTIONS.get(SAMPLE_STANDALONE_HOOK);
    expect(target).toBeDefined();
    const brokenPath = target?.provenance[0] ?? "";

    const missing = findMissingProvenance((path) => path !== brokenPath);
    expect(missing).toContain(`${SAMPLE_STANDALONE_HOOK} -> ${brokenPath}`);
  });

  test("every entity carries at least one provenance pointer", () => {
    const bare = [...INTERCEPTOR_DESCRIPTIONS.entries()]
      .filter(([, d]) => d.provenance.length === 0)
      .map(([n]) => n);
    expect(bare).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // A pointer can RESOLVE and still not be the source it distills — which
  // is what SC4 actually asks for. These four tests close that gap.
  // ---------------------------------------------------------------------

  test("provenance[0] is never the registry", () => {
    // A registry pointer says "this entity is registered", not where the
    // described behavior lives, so a change to a guard's logic could never
    // invalidate it — defeating the drift-auditing purpose entirely.
    const registryLed = [...INTERCEPTOR_DESCRIPTIONS.entries()]
      .filter(([, d]) => d.provenance[0].endsWith("/registry.ts"))
      .map(([n]) => n);
    expect(registryLed).toEqual([]);
  });

  test("every registry-stratum entry points at the module the REGISTRY declares", () => {
    // Derived from the registry's own `module: () => import("./X")` rather
    // than a hand-maintained copy, so this cannot drift from the truth. This
    // is the check that catches a pointer aimed at a file which exists but is
    // not the implementing module.
    const mismatches: string[] = [];

    for (const r of GUARD_REGISTRY) {
      const described = INTERCEPTOR_DESCRIPTIONS.get(r.name);
      if (!described || described.stratum !== "registry") continue;

      const importPath = /import\(\s*["']\.\/([\w.-]+)["']\s*\)/.exec(String(r.module))?.[1];
      if (importPath === undefined) {
        mismatches.push(`${r.name} -> could not derive module from registry`);
        continue;
      }

      const expected = `.minsky/hooks/${importPath}.ts`;
      if (described.provenance[0] !== expected) {
        mismatches.push(`${r.name} -> expected ${expected}, got ${described.provenance[0]}`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  test("declaration-only provenance is marked and explained, never substituted", () => {
    // An entity with no source module keeps an honest pointer at its
    // declaration site plus a note saying so. Substituting the registry (or
    // any other plausible file) there would be fabricated provenance.
    for (const [name, desc] of INTERCEPTOR_DESCRIPTIONS) {
      if (desc.provenanceStatus !== "declaration-only") continue;
      expect(desc.note, `${name} must explain its declaration-only provenance`).toBeTruthy();
      expect(desc.note ?? "").toContain("No source module exists");
      expect(desc.provenance[0].endsWith("/registry.ts")).toBe(false);
    }
  });

  test("every retired and fixture entry is declaration-only", () => {
    // These strata have no implementation by construction, so an
    // implementation-status pointer would be a claim that cannot be true.
    const wrong = [...INTERCEPTOR_DESCRIPTIONS.entries()]
      .filter(
        ([, d]) =>
          (d.stratum === "retired" || d.stratum === "fixture") &&
          d.provenanceStatus !== "declaration-only"
      )
      .map(([n]) => n);
    expect(wrong).toEqual([]);
  });
});

describe("SC2 — the failure-class taxonomy", () => {
  test("every entity carries at least one failure class", () => {
    const classless = [...INTERCEPTOR_DESCRIPTIONS.entries()]
      .filter(([, d]) => d.failureClasses.length === 0)
      .map(([n]) => n);
    expect(classless).toEqual([]);
  });

  test("every declared class is used by at least one entity", () => {
    const unused = (Object.keys(FAILURE_CLASSES) as FailureClass[]).filter(
      (fc) => interceptorsByFailureClass(fc).length === 0
    );
    expect(unused).toEqual([]);
  });

  test("the class list stays a filter, not a per-entity restatement", () => {
    // Guard against the taxonomy drifting toward one class per entity as
    // entries are added: classes must stay coarse enough to filter by.
    const classCount = Object.keys(FAILURE_CLASSES).length;
    expect(classCount).toBeLessThanOrEqual(15);
    expect(INTERCEPTOR_DESCRIPTIONS.size / classCount).toBeGreaterThanOrEqual(4);
  });

  test("a class absent from the ontology page's table is reported", () => {
    // Pure-function arm; the real page is checked by
    // scripts/audit-interceptor-descriptions.ts.
    const everyClassDocumented = (Object.keys(FAILURE_CLASSES) as FailureClass[])
      .map((fc) => `| **\`${fc}\`** | ... | ... |`)
      .join("\n");
    expect(findUndocumentedFailureClasses(everyClassDocumented)).toEqual([]);

    const oneMissing = everyClassDocumented.replace("**`lost-signal`**", "lost-signal");
    expect(findUndocumentedFailureClasses(oneMissing)).toEqual(["lost-signal"]);
  });

  test("unreviewed-merge surfaces the merge gates — the taxonomy's motivating query", () => {
    const names = interceptorsByFailureClass("unreviewed-merge");
    expect(names).toContain("require-review-before-merge");
    expect(names).toContain("require-checks-on-bypass-merge");
    expect(names).toContain("block-subagent-bypass-merge");
  });
});

describe("SC3 — coverage gaps are content, not omissions", () => {
  test("an unregistered entity surfaces all three registry fields as gaps", () => {
    // A standalone hook: real enforcement point, no GuardRegistration.
    // No `standaloneCanaryNames` supplied, which is also the back-compat case:
    // absent means "no standalone canaries known", i.e. pre-mt#5072 behaviour.
    const entry = resolveCatalogEntry(SAMPLE_STANDALONE_HOOK, buildInput());

    expect(entry.undescribed).toBe(false);
    expect(entry.registered).toBe(false);
    expect(entry.coverageGaps).toEqual(["tuningOwnership", "attentionCost", "canary"]);
  });

  describe("standaloneCanaryNames — the second canary declaration surface (mt#5072)", () => {
    test("an unregistered entity with a standalone canary loses ONLY the canary gap", () => {
      const entry = resolveCatalogEntry(SAMPLE_STANDALONE_HOOK, {
        ...buildInput(),
        standaloneCanaryNames: new Set([SAMPLE_STANDALONE_HOOK]),
      });

      expect(entry.coverageGaps).toEqual(["tuningOwnership", "attentionCost"]);
    });

    test("...and is still NOT reported as registered", () => {
      // The whole reason this is a separate input rather than a synthetic
      // `registryFacts` entry: `registered` is derived from that map's
      // presence, so injecting there would silently assert a
      // `GuardRegistration` that does not exist.
      const entry = resolveCatalogEntry(SAMPLE_STANDALONE_HOOK, {
        ...buildInput(),
        standaloneCanaryNames: new Set([SAMPLE_STANDALONE_HOOK]),
      });

      expect(entry.registered).toBe(false);
    });

    test("a name absent from the set keeps its canary gap", () => {
      // The discriminating case: the set must be consulted per-name, not
      // treated as a global "standalone canaries exist" flag.
      const entry = resolveCatalogEntry(SAMPLE_STANDALONE_HOOK, {
        ...buildInput(),
        standaloneCanaryNames: new Set(["some-other-guard-entirely"]),
      });

      expect(entry.coverageGaps).toContain("canary");
    });

    test("an unknown name with a standalone canary still reports the other two gaps", () => {
      // `resolveCatalogEntry` never returns undefined; a name that exists
      // nowhere else must not become gap-free just because a canary is declared.
      const unknownName = "a-name-that-exists-nowhere";
      const entry = resolveCatalogEntry(unknownName, {
        ...buildInput(),
        standaloneCanaryNames: new Set([unknownName]),
      });

      expect(entry.undescribed).toBe(true);
      expect(entry.registered).toBe(false);
      expect(entry.coverageGaps).toEqual(["tuningOwnership", "attentionCost"]);
    });
  });

  test("a registered entity missing attentionCost/canary surfaces only those", () => {
    // Read from the registry rather than hardcoding which entity is missing
    // them, so this tracks the registry instead of drifting from it.
    const partial = GUARD_REGISTRY.find((r) => {
      const e = r as unknown as RegistryEntryShape;
      return e.attentionCost === undefined || e.canary === undefined;
    });
    if (!partial) throw new Error("expected at least one partially-annotated registry entry");

    const entry = resolveCatalogEntry(partial.name, buildInput());
    expect(entry.registered).toBe(true);
    expect(entry.coverageGaps.length).toBeGreaterThan(0);
    expect(entry.coverageGaps).not.toContain("tuningOwnership");
  });

  test("a fully-registered entity has no gaps", () => {
    const entry = resolveCatalogEntry(SAMPLE_REGISTRY_GUARD, buildInput());
    expect(entry.registered).toBe(true);
    expect(entry.coverageGaps).toEqual([]);
  });
});

describe("descriptions state axis-2 truth, not the filename", () => {
  // The spec's named trap: several `*-detector.ts` files inject rather than
  // record. Each must carry a filenameNote, and none may describe itself as
  // recording.
  const injectorsNamedDetector = [
    "skill-staleness-detector",
    "mcp-daemon-staleness-detector",
    "guard-health-escalation-detector",
    "calibration-review-cadence-detector",
  ];

  for (const name of injectorsNamedDetector) {
    test(`${name} is described as injecting`, () => {
      const desc = INTERCEPTOR_DESCRIPTIONS.get(name);
      expect(desc).toBeDefined();
      expect(desc?.filenameNote).toBeTruthy();
      expect(desc?.description.toLowerCase()).toContain("inject");
    });
  }

  test("meta-level entities carry subject: system (ontology amendment (d))", () => {
    const input = buildInput();
    expect(resolveCatalogEntry("guard-health-escalation-detector", input).subject).toBe("system");
    expect(resolveCatalogEntry("calibration-review-cadence-detector", input).subject).toBe(
      "system"
    );
    expect(resolveCatalogEntry(SAMPLE_STANDALONE_HOOK, input).subject).toBe("trajectory");
  });
});

describe("unverified content is marked, not invented", () => {
  test("rationalization-review is flagged UNVERIFIED rather than given a guessed description", () => {
    const desc = INTERCEPTOR_DESCRIPTIONS.get("rationalization-review");
    expect(desc).toBeDefined();
    expect(desc?.note).toContain("UNVERIFIED");
  });

  test("fixture names are described as non-interceptors", () => {
    for (const name of FIXTURE_GUARD_NAMES.keys()) {
      const desc = INTERCEPTOR_DESCRIPTIONS.get(name);
      expect(desc?.stratum).toBe("fixture");
      expect(desc?.description).toContain("Not an interceptor");
    }
  });
});

// ---------------------------------------------------------------------------
// mt#5079 — canary disposition precedence (mt#4606 SC2 / SC4)
// ---------------------------------------------------------------------------
//
// `resolveCanaryDisposition` is exported and pure precisely so this precedence
// can be exercised on synthetic inputs. Asserting it only through the real
// corpus would test today's DATA and leave the ORDER — which is the mechanism —
// unverified in every direction the current data does not happen to exercise.

describe("resolveCanaryDisposition (mt#5079)", () => {
  const INFEASIBLE_KIND = "canary-infeasible" as const;
  const INFEASIBLE: CanaryDispositionRecord = {
    disposition: INFEASIBLE_KIND,
    reason: "synthetic",
  };
  const PENDING: CanaryDispositionRecord = { disposition: "canary-pending", owner: "mt#5080" };

  const dispositions: CanaryDispositionInput = {
    byGuard: new Map([["ruled-guard", INFEASIBLE]]),
    byStratum: new Map([["precommit", PENDING]]),
  };

  test("a real canary outranks every authored ruling", () => {
    // Even with an explicit infeasible ruling on the same name: the declaration
    // is a fact and the ruling is an opinion about its absence, so a stale
    // ruling can never contradict a canary that exists.
    const result = resolveCanaryDisposition("ruled-guard", "standalone", true, dispositions);
    expect(result).toEqual({ disposition: "canary-declared", source: "derived" });
  });

  test("an entity's own ruling outranks its stratum's", () => {
    const result = resolveCanaryDisposition("ruled-guard", "precommit", false, dispositions);
    expect(result?.disposition).toBe(INFEASIBLE_KIND);
    expect(result?.source).toBe("entity");
  });

  test("an unruled entity inherits its stratum's ruling", () => {
    const result = resolveCanaryDisposition("unruled-guard", "precommit", false, dispositions);
    expect(result?.disposition).toBe("canary-pending");
    expect(result?.source).toBe("stratum");
    expect(result?.owner).toBe("mt#5080");
  });

  // THE negative control for the census gate. If this returned anything but
  // null the gate in `build-interceptor-catalog.test.ts` could never fail, and
  // a newly added interceptor would be silently absorbed — the exact drift
  // mt#4606 AT2 exists to stop.
  test("an entity with no ruling and no stratum ruling resolves to null", () => {
    const result = resolveCanaryDisposition("unruled-guard", "standalone", false, dispositions);
    expect(result).toBeNull();
  });

  test("a null stratum cannot inherit, and does not throw", () => {
    expect(resolveCanaryDisposition("unruled-guard", null, false, dispositions)).toBeNull();
  });

  test("absent disposition data resolves every gapped entity to null", () => {
    // The pre-mt#5079 behaviour, preserved so every existing caller and test
    // that omits the field keeps its previous result rather than silently
    // acquiring a verdict.
    expect(resolveCanaryDisposition("ruled-guard", "precommit", false, undefined)).toBeNull();
    // ...but a canary in hand still resolves without any authored data at all.
    expect(resolveCanaryDisposition("ruled-guard", "precommit", true, undefined)).toEqual({
      disposition: "canary-declared",
      source: "derived",
    });
  });

  test("an absent reason or owner stays absent rather than becoming an explicit undefined", () => {
    // `withSource` spreads conditionally for this: an explicit `undefined`
    // property serializes inconsistently into the generated catalog JSON.
    const result = resolveCanaryDisposition("unruled-guard", "precommit", false, dispositions);
    expect(Object.hasOwn(result as object, "reason")).toBe(false);
    expect(Object.hasOwn(result as object, "owner")).toBe(true);
  });

  test("resolveCatalogEntry surfaces the ruling on the entry", () => {
    // The wiring, not just the helper: an entry with no registry facts and no
    // canary carries the ruling its stratum supplies.
    const input: ResolveCatalogInput = {
      registryFacts: new Map<string, RegistryFacts>(),
      canaryDispositions: dispositions,
    };
    const entry = resolveCatalogEntry("ruled-guard", input);
    expect(entry.coverageGaps).toContain("canary");
    expect(entry.canaryDisposition?.disposition).toBe(INFEASIBLE_KIND);
    expect(entry.canaryDisposition?.source).toBe("entity");
  });
});
