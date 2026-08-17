// Tests for the per-interceptor coordinate data — mt#4038.
//
// The load-bearing arm is the LIVE-POPULATION one: every name the descriptions
// module knows resolves to coordinates, or is on a pinned list of deliberate
// exceptions. A test over a fixture population would pass forever while the
// real corpus drifted, which is the failure `known-guard-names.ts` and
// `interceptor-descriptions.ts` both already guard against for their own data.

import { describe, expect, test } from "bun:test";
import { INTERCEPTOR_DESCRIPTIONS } from "./interceptor-descriptions";
import { GUARD_REGISTRY } from "./registry";
import {
  DELIBERATELY_UNAUTHORED_NAMES,
  EFFECT_TO_INTERVENTION,
  INTERCEPTOR_COORDINATES,
  OUT_OF_MODEL_NAMES,
  STANDALONE_SCRIPT_ALIASES,
  classifyFamilies,
  familiesOf,
  familylessAuthoredNames,
  resolveAllCoordinates,
  resolveCoordinates,
  unmappedEffects,
  type CoordinateResolutionInput,
} from "./interceptor-coordinates";

/**
 * The module's own exception list, asserted against the data below.
 *
 * Imported rather than restated: a second hand-maintained copy drifts, and the
 * first symptom is a real interceptor exempted in one surface while the other
 * still checks it (PR #2914 R1).
 */
const DELIBERATELY_UNAUTHORED = [...DELIBERATELY_UNAUTHORED_NAMES].sort();

/**
 * Inputs built from the two sources that are plain module imports.
 *
 * `.claude/settings.json` is deliberately NOT read here. Reading it would make
 * these tests filesystem-dependent (`custom/no-real-fs-in-tests`), and copying
 * its contents into a fixture would create exactly the hand-maintained mirror
 * this module exists to avoid. The settings-derived branch is covered two ways
 * instead: by injected fixtures in the "point derivation" block below, and
 * against the real file by `scripts/audit-interceptor-coordinates.ts`, which is
 * the surface that owns live-world claims — the same hermetic-test /
 * live-audit split `interceptor-descriptions.ts` already uses.
 */
function importedInput(): CoordinateResolutionInput {
  const registryEvents = new Map<string, string>();
  for (const reg of GUARD_REGISTRY) registryEvents.set(reg.name, reg.event);

  const strata = new Map<string, string>();
  for (const [name, desc] of INTERCEPTOR_DESCRIPTIONS) strata.set(name, desc.stratum);

  return { registryEvents, settingsEvents: new Map(), strata };
}

describe("coordinate coverage over the live population", () => {
  const input = importedInput();
  const population = [...INTERCEPTOR_DESCRIPTIONS.keys()];

  test("every described interceptor has authored coordinates, except the pinned exceptions", () => {
    const unauthored = population.filter((n) => !INTERCEPTOR_COORDINATES.has(n)).sort();
    expect(unauthored).toEqual(DELIBERATELY_UNAUTHORED);
  });

  test("no authored coordinates for a name outside the population", () => {
    const orphans = [...INTERCEPTOR_COORDINATES.keys()].filter(
      (n) => !INTERCEPTOR_DESCRIPTIONS.has(n)
    );
    expect(orphans).toEqual([]);
  });

  test("every authored entity carries a non-empty capability set, a mechanism and a role", () => {
    // Point is excluded here on purpose: with no settings map injected, the
    // standalone stratum has no declaring source, and asserting it would be
    // asserting the fixture rather than the data. The live point arm is the
    // audit script's (AT1).
    const authored = population.filter((n) => INTERCEPTOR_COORDINATES.has(n));
    const incomplete = resolveAllCoordinates(authored, input)
      .filter((r) => r.gaps.some((g) => g !== "point"))
      .map((r) => `${r.guardName}: ${r.gaps.join(",")}`);
    expect(incomplete).toEqual([]);
  });

  test("an unauthored name reports EVERY coordinate as a gap rather than defaulting", () => {
    for (const name of DELIBERATELY_UNAUTHORED) {
      const resolved = resolveCoordinates(name, input);
      expect(resolved.interventions).toEqual([]);
      expect(resolved.mechanism).toBeNull();
      expect(resolved.role).toBeNull();
      expect(resolved.gaps).toContain("interventions");
      expect(resolved.gaps).toContain("mechanism");
      expect(resolved.gaps).toContain("role");
    }
  });

  test("an authored point stays the rare exception, and every one is justified", () => {
    const authored = population.filter((n) => INTERCEPTOR_COORDINATES.has(n));
    const authoredPoints = resolveAllCoordinates(authored, input)
      .filter((r) => r.pointSource === "authored")
      .map((r) => r.guardName)
      .sort();
    // The only four entities whose point no source declares: three retired
    // interceptors (two pre-commit steps plus `policy-coverage`, whose
    // settings.json registration was removed when mt#4197 deleted it), and one
    // decision path hosted inside another hook.
    // Anything else appearing here is a point that should have been DERIVED.
    expect(authoredPoints).toEqual([
      "migration-guard-and-duplicate-content-check",
      "policy-coverage",
      "standalone-duplicate-matcher",
      "unit-tests",
    ]);
    // Every one carries a note saying why it is authored rather than derived.
    for (const name of authoredPoints) {
      expect(INTERCEPTOR_COORDINATES.get(name)?.note ?? "", name).not.toBe("");
    }
  });

  test("the registry supplies the point for every registered guard", () => {
    const derived = resolveAllCoordinates(
      GUARD_REGISTRY.map((r) => r.name),
      input
    );
    expect(derived.every((r) => r.pointSource === "registry")).toBe(true);
    expect(derived.every((r) => r.point !== null)).toBe(true);
  });

  test("the pre-commit stratum supplies the point for every pre-commit step", () => {
    const precommit = population.filter(
      (n) => INTERCEPTOR_DESCRIPTIONS.get(n)?.stratum === "precommit"
    );
    expect(precommit.length).toBeGreaterThan(20);
    for (const r of resolveAllCoordinates(precommit, input)) {
      expect(r.point, r.guardName).toBe("pre-commit");
      expect(r.pointSource, r.guardName).toBe("stratum");
    }
  });
});

describe("the effect -> intervention mapping (SC2)", () => {
  test("every effect the registry declares is mapped", () => {
    const declared = GUARD_REGISTRY.flatMap((reg) => reg.effects.map((e) => e.effect));
    expect(unmappedEffects(declared)).toEqual([]);
  });

  test("an unknown effect is REPORTED, never silently dropped", () => {
    expect(unmappedEffects(["deny", "someFutureEffect"])).toEqual(["someFutureEffect"]);
  });

  test("the three record senses stay distinguishable by audience", () => {
    expect(EFFECT_TO_INTERVENTION.calibration).toEqual({ type: "record", audience: "review" });
    expect(EFFECT_TO_INTERVENTION.sessionTitle).toEqual({ type: "record", audience: "framework" });
    expect(EFFECT_TO_INTERVENTION.turnAnchorWrite).toEqual({
      type: "record",
      audience: "framework",
    });
  });
});

describe("point derivation", () => {
  const base: CoordinateResolutionInput = {
    registryEvents: new Map([["from-registry", "Stop"]]),
    settingsEvents: new Map([
      ["from-settings", "PreToolUse"],
      ["warn-bare-prohibition-dispatch", "PreToolUse"],
    ]),
    strata: new Map([["a-precommit-step", "precommit"]]),
  };

  test("registry wins for a registered guard", () => {
    expect(resolveCoordinates("from-registry", base).point).toBe("Stop");
    expect(resolveCoordinates("from-registry", base).pointSource).toBe("registry");
  });

  test("settings.json resolves a standalone hook", () => {
    expect(resolveCoordinates("from-settings", base).pointSource).toBe("settings");
  });

  test("the alias map resolves a name that differs from its script basename", () => {
    // `bare-prohibition` is registered as warn-bare-prohibition-dispatch.ts.
    const resolved = resolveCoordinates("bare-prohibition", base);
    expect(resolved.point).toBe("PreToolUse");
    expect(resolved.pointSource).toBe("settings");
    expect(STANDALONE_SCRIPT_ALIASES["bare-prohibition"]).toBe("warn-bare-prohibition-dispatch");
  });

  test("the pre-commit stratum supplies the point when nothing declares it", () => {
    const resolved = resolveCoordinates("a-precommit-step", base);
    expect(resolved.point).toBe("pre-commit");
    expect(resolved.pointSource).toBe("stratum");
  });

  test("a name no source covers reports the gap instead of a plausible default", () => {
    const resolved = resolveCoordinates("nothing-knows-me", base);
    expect(resolved.point).toBeNull();
    expect(resolved.pointSource).toBe("none");
    expect(resolved.gaps).toContain("point");
  });

  test("an event outside the ontology's axis-1 values is refused, not passed through", () => {
    const rogue: CoordinateResolutionInput = {
      ...base,
      registryEvents: new Map([["from-registry", "SomeFutureEvent"]]),
    };
    expect(resolveCoordinates("from-registry", rogue).point).toBeNull();
  });
});

describe("the computed families (ontology §4)", () => {
  test("policy-coverage carries a capability SET, not a primary — and is both guard and detector", () => {
    const coords = INTERCEPTOR_COORDINATES.get("policy-coverage");
    if (!coords) throw new Error("policy-coverage has no authored coordinates");
    const types = new Set(coords.interventions.map((i) => i.type));
    expect(types.size).toBeGreaterThan(1);
    const families = familiesOf(coords.interventions);
    expect(families).toContain("guard");
    expect(families).toContain("detector");
  });

  test("detector membership requires record FOR REVIEW, not any record", () => {
    expect(familiesOf([{ type: "record", audience: "framework" }])).toEqual([]);
    expect(familiesOf([{ type: "record", audience: "review" }])).toEqual(["detector"]);
  });

  test("allow counts as a guard, per the ontology's definition", () => {
    expect(familiesOf([{ type: "allow" }])).toEqual(["guard"]);
  });

  test("the out-of-model set is exactly what the data computes", () => {
    expect(familylessAuthoredNames()).toEqual([...OUT_OF_MODEL_NAMES]);
  });

  test("out-of-model and unclassified are kept apart", () => {
    const outOfModel = classifyFamilies({ interventions: [{ type: "mutate" }], gaps: [] });
    expect(outOfModel.outOfModel).toBe(true);
    expect(outOfModel.unclassified).toBe(false);

    const unclassified = classifyFamilies({
      interventions: [],
      gaps: ["interventions", "mechanism", "role"],
    });
    expect(unclassified.unclassified).toBe(true);
    expect(unclassified.outOfModel).toBe(false);
  });

  test("every authored entity is either in a family or explicitly out of model", () => {
    const input = importedInput();
    for (const name of INTERCEPTOR_COORDINATES.keys()) {
      const classification = classifyFamilies(resolveCoordinates(name, input));
      const accounted = classification.families.length > 0 || classification.outOfModel === true;
      expect(accounted).toBe(true);
    }
  });
});

describe("authored values stay inside the declared vocabularies", () => {
  const POINTS = new Set([
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SubagentStop",
    "UserPromptSubmit",
    "SessionEnd",
    "MessageDisplay",
    "pre-commit",
    "merge-time",
  ]);
  const TYPES = new Set([
    "deny",
    "allow",
    "inject",
    "mutate",
    "record",
    "notify-escalate",
    "delegate",
    "ask-and-pause",
  ]);
  const MECHANISMS = new Set(["constant", "structural", "lexical", "embedding", "model"]);
  const ROLES = new Set(["judge", "feeder", "infrastructure"]);

  test("no authored coordinate uses a value outside its union", () => {
    for (const [name, coords] of INTERCEPTOR_COORDINATES) {
      expect(MECHANISMS.has(coords.mechanism), `${name} mechanism`).toBe(true);
      expect(ROLES.has(coords.role), `${name} role`).toBe(true);
      expect(coords.interventions.length, `${name} interventions`).toBeGreaterThan(0);
      for (const intervention of coords.interventions) {
        expect(TYPES.has(intervention.type), `${name} intervention type`).toBe(true);
      }
      if (coords.point) expect(POINTS.has(coords.point), `${name} point`).toBe(true);
    }
  });

  test("a deny/allow/mutate intervention carries no audience", () => {
    for (const [name, coords] of INTERCEPTOR_COORDINATES) {
      for (const intervention of coords.interventions) {
        if (["deny", "allow", "mutate"].includes(intervention.type)) {
          expect(intervention.audience, `${name} ${intervention.type}`).toBeUndefined();
        }
      }
    }
  });
});
