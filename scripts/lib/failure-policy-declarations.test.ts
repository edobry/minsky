import { describe, test, expect } from "bun:test";
import { getDeclaredGuardPostures, getPostureCoverage } from "./failure-policy-declarations";
import { GUARD_REGISTRY } from "../../.minsky/hooks/registry";
import { STANDALONE_GUARD_CANARIES } from "./standalone-guard-canaries";

describe("getDeclaredGuardPostures", () => {
  test("includes every GUARD_REGISTRY entry, source=registry, with its effects", () => {
    const declared = getDeclaredGuardPostures();
    for (const reg of GUARD_REGISTRY) {
      const posture = declared.get(reg.name);
      if (!posture) throw new Error(`no declared posture for ${reg.name}`);
      expect(posture.source).toBe("registry");
      expect(posture.event).toBe(reg.event);
      expect(posture.matcher ?? null).toBe(reg.matcher ?? null);
      expect(posture.timeoutMs ?? null).toBe(reg.timeoutMs ?? null);
      expect(posture.effects).toEqual(reg.effects);
    }
  });

  test("includes every STANDALONE_GUARD_CANARIES entry, source=standalone, with its effects", () => {
    const declared = getDeclaredGuardPostures();
    for (const canary of STANDALONE_GUARD_CANARIES) {
      const posture = declared.get(canary.guardName);
      if (!posture) throw new Error(`no declared posture for ${canary.guardName}`);
      expect(posture.source).toBe("standalone");
      expect(posture.event).toBeUndefined();
      expect(posture.effects).toEqual(canary.effects);
    }
  });

  test("declared population size equals GUARD_REGISTRY + STANDALONE_GUARD_CANARIES (no name collision today)", () => {
    const declared = getDeclaredGuardPostures();
    expect(declared.size).toBe(GUARD_REGISTRY.length + STANDALONE_GUARD_CANARIES.length);
  });

  test("every declared posture's effects array is non-empty (SC1)", () => {
    const declared = getDeclaredGuardPostures();
    for (const [name, posture] of declared) {
      expect(posture.effects.length, `${name} declares zero effects`).toBeGreaterThan(0);
    }
  });
});

describe("getPostureCoverage (SC2/AT2 — registered population + explicit not-covered listing)", () => {
  test("covered is exactly the declared guard-name set, sorted", () => {
    const declared = getDeclaredGuardPostures();
    const { covered } = getPostureCoverage();
    expect(covered).toEqual([...declared.keys()].sort());
  });

  test("notCovered never contains a name that IS declared", () => {
    const declared = getDeclaredGuardPostures();
    const { notCovered } = getPostureCoverage();
    for (const name of notCovered) {
      expect(declared.has(name)).toBe(false);
    }
  });

  test("notCovered is sorted and has no duplicates", () => {
    const { notCovered } = getPostureCoverage();
    expect(notCovered).toEqual([...new Set(notCovered)].sort());
  });
});

describe("SC5 — posture-default-or-rationale (enforcement closed, advisory open, recorders spool)", () => {
  test("every effect either matches its verdict shape's SC5 default posture, or carries a rationale", () => {
    const declared = getDeclaredGuardPostures();
    const DEFAULTS: Record<string, { failurePolicy: string; degradedPolicy: string } | undefined> =
      {
        validator: { failurePolicy: "closed", degradedPolicy: "closed" },
        injector: { failurePolicy: "open", degradedPolicy: "open" },
        recorder: { failurePolicy: "spool", degradedPolicy: "spool" },
        // mutator has no SC5 default — always exempt from this check.
        mutator: undefined,
      };
    const undocumentedDeviations: string[] = [];
    for (const [name, posture] of declared) {
      for (const effect of posture.effects) {
        const expected = DEFAULTS[effect.verdictShape];
        if (!expected) continue;
        const matches =
          effect.failurePolicy.failurePolicy === expected.failurePolicy &&
          effect.failurePolicy.degradedPolicy === expected.degradedPolicy;
        if (!matches && !effect.rationale) {
          undocumentedDeviations.push(`${name}/${effect.effect}`);
        }
      }
    }
    expect(undocumentedDeviations).toEqual([]);
  });
});
