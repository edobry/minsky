/**
 * mt#3882 — the hooks-tree operator-escape-hatch list must EQUAL the canonical
 * registry filtered to `category === "operator-override"`.
 *
 * Why a test file may import `@minsky/domain` when the module it checks may
 * not: the dependency-free constraint in `SPEC.md` is about the hooks tree
 * staying RUNNABLE when the main codebase has type errors. A test is not on
 * that path — `self-containment.test.ts` walks the import closure from the
 * baseline hook ENTRY POINTS, so a `*.test.ts` is never in it. This is the
 * whole reason a derived contract is checkable at all; precedent:
 * `flakiness-control-detector.test.ts`, `output-label-tokens.test.ts`.
 *
 * The hand-sync this replaces failed at least six times (mt#3084, mt#2292,
 * mt#3673, mt#4004, mt#3658, mt#4167) and drifted in BOTH directions at once:
 * 63 canonical entries missing, and 45 entries present that were never escape
 * hatches, plus one whose detector had been retired.
 */
import { describe, test, expect } from "bun:test";
import {
  HOOK_ONLY_ENV_VAR_CATEGORIES,
  OPERATOR_OVERRIDE_ENV_VARS,
} from "@minsky/domain/configuration/sources/environment";
import { buildRegisteredSet } from "../../eslint-rules/no-unregistered-minsky-env-var.js";
import { KNOWN_OVERRIDE_ENV_VARS } from "./known-override-env-vars";

/**
 * The whole decision, as a pure function of two sets — so the failure modes
 * below can be exercised on synthetic input without touching either real file.
 *
 * `missing` is the direction every recorded hand-sync failure took. `extra` is
 * the one a superset contract cannot see, and the one that actually occurred:
 * `MINSKY_POLICY_COVERAGE_MODE` outlived its detector (retired by mt#4197).
 */
export function diffOverrideSets(
  canonical: ReadonlySet<string>,
  mirror: ReadonlySet<string>
): { missing: string[]; extra: string[] } {
  return {
    missing: [...canonical].filter((name) => !mirror.has(name)).sort(),
    extra: [...mirror].filter((name) => !canonical.has(name)).sort(),
  };
}

describe("KNOWN_OVERRIDE_ENV_VARS equals the operator-override slice (mt#3882)", () => {
  test("no operator-override is missing from the mirror", () => {
    const { missing } = diffOverrideSets(OPERATOR_OVERRIDE_ENV_VARS, KNOWN_OVERRIDE_ENV_VARS);
    expect(missing).toEqual([]);
  });

  test("the mirror carries nothing the canonical filter does not produce", () => {
    const { extra } = diffOverrideSets(OPERATOR_OVERRIDE_ENV_VARS, KNOWN_OVERRIDE_ENV_VARS);
    expect(extra).toEqual([]);
  });

  test("every registry entry carries a category", () => {
    const uncategorized = Object.entries(HOOK_ONLY_ENV_VAR_CATEGORIES)
      .filter(([, category]) => category === undefined)
      .map(([name]) => name);
    expect(uncategorized).toEqual([]);
  });
});

describe("diffOverrideSets — the failure modes the equality contract must catch", () => {
  test("AT1: a canonical operator-override absent from the mirror is reported by name", () => {
    const diff = diffOverrideSets(
      new Set(["MINSKY_SKIP_A", "MINSKY_SKIP_B"]),
      new Set(["MINSKY_SKIP_A"])
    );
    expect(diff.missing).toEqual(["MINSKY_SKIP_B"]);
    expect(diff.extra).toEqual([]);
  });

  test("AT2: a non-operator-override never enters the contract, so the mirror need not carry it", () => {
    // The canonical side is already FILTERED; a `tunable` or `test-fixture`
    // simply is not in it. This is what distinguishes mechanism (A) from the
    // plain-superset test this task's gate report falsified: under a superset
    // over the FULL registry, every one of these would demand a mirror entry.
    const filtered = new Set(
      Object.entries({
        MINSKY_SKIP_A: "operator-override",
        MINSKY_TEST_KNOB_MS: "tunable",
        MINSKY_CANARY_THING: "test-fixture",
      })
        .filter(([, category]) => category === "operator-override")
        .map(([name]) => name)
    );
    expect(diffOverrideSets(filtered, new Set(["MINSKY_SKIP_A"]))).toEqual({
      missing: [],
      extra: [],
    });
  });

  test("AT3: a mirror entry whose canonical entry was deleted is reported by name", () => {
    // The MINSKY_POLICY_COVERAGE_MODE case, in miniature. A superset contract
    // passes this input; equality does not.
    const diff = diffOverrideSets(
      new Set(["MINSKY_SKIP_A"]),
      new Set(["MINSKY_SKIP_A", "MINSKY_RETIRED"])
    );
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual(["MINSKY_RETIRED"]);
  });
});

describe("AT5: the ESLint registration rule still resolves the registry", () => {
  /**
   * `no-unregistered-minsky-env-var` cannot import `environment.ts` (ESLint
   * runs under Node), so it parses the SOURCE TEXT. That makes the registry's
   * literal shape a contract with it. Its read-failure branch returns an EMPTY
   * set, which by its own comment "will conservatively flag every MINSKY_*
   * read" — so a shape change that silently stops matching is a repo-wide
   * lint failure, and one that no other test in this file would notice.
   *
   * The REAL extractor is imported rather than reimplemented: a local copy of
   * its regexes would be one more hand-maintained mirror.
   */
  test("every categorized name is extracted by the rule's own parser", () => {
    const registered = buildRegisteredSet();
    const unseen = Object.keys(HOOK_ONLY_ENV_VAR_CATEGORIES).filter(
      (name) => !registered.has(name)
    );
    expect(unseen).toEqual([]);
  });
});
