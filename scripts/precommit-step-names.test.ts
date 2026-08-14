/**
 * Tests for the shared pre-commit-step-name derivation (mt#4071).
 *
 * Two layers, mirroring `build-interceptor-catalog.test.ts`:
 *   1. The parse and the derive-or-snapshot precedence. The parse is a pure
 *      function of a string, so this layer needs no fixture tree on disk — the
 *      read is exercised only through its failure branch, by pointing it at a
 *      path that does not exist.
 *   2. The REAL repo, pinning the two claims mt#4071 rests on: the derivation
 *      sees `interceptor-catalog-regen`, and the hand-maintained snapshot has
 *      not drifted from it.
 */
import { describe, test, expect } from "bun:test";
import {
  derivePrecommitStepNames,
  parsePrecommitStepNames,
  resolvePrecommitStepNames,
} from "./precommit-step-names";
import { PRECOMMIT_STEP_NAMES } from "../.minsky/hooks/known-guard-names";

/** A repo root that cannot exist, so the read fails and the parse never runs. */
const UNREADABLE_ROOT = "/nonexistent/mt4071-precommit-step-names";

describe("parsePrecommitStepNames", () => {
  test("extracts every instrumented step name, sorted and deduped", () => {
    const source = `
      await this.instrumented("zebra-check", () => this.a());
      await this.instrumented("alpha-check", () => this.b());
      // the same step referenced twice must not produce two names
      await this.instrumented("alpha-check", () => this.c());
    `;

    expect(parsePrecommitStepNames(source)).toEqual(["alpha-check", "zebra-check"]);
  });

  test("tolerates whitespace between the call and its name argument", () => {
    const source = 'await this.instrumented(\n  "wrapped-check",\n  () => this.a()\n);';

    expect(parsePrecommitStepNames(source)).toEqual(["wrapped-check"]);
  });

  test("returns null rather than an empty set when nothing matches", () => {
    // An empty set is the dangerous return: it would resolve as "no pre-commit
    // step is known", flagging every legitimate one at once.
    expect(parsePrecommitStepNames("export class PreCommitValidator {}")).toBeNull();
  });

  test("ignores a call whose name is not a plain lowercase step id", () => {
    expect(
      parsePrecommitStepNames("await this.instrumented(dynamicName, () => this.a());")
    ).toBeNull();
  });
});

describe("derivePrecommitStepNames", () => {
  test("returns null when pre-commit.ts cannot be read", () => {
    expect(derivePrecommitStepNames(UNREADABLE_ROOT)).toBeNull();
  });

  test("returns the real repo's steps, sorted and non-empty", () => {
    const derived = derivePrecommitStepNames();

    expect(derived).not.toBeNull();
    expect(derived?.length).toBeGreaterThan(0);
    expect(derived).toEqual([...(derived ?? [])].sort());
  });
});

describe("resolvePrecommitStepNames", () => {
  test("falls back to the snapshot when the parse fails", () => {
    expect(resolvePrecommitStepNames(UNREADABLE_ROOT)).toEqual(PRECOMMIT_STEP_NAMES);
  });

  test("returns the derived set, not the snapshot, when the parse succeeds", () => {
    // The precedence PR #2664 R1 misread: the derived set REPLACES the
    // snapshot rather than unioning with it, so a step deleted from
    // pre-commit.ts stops being known instead of staying known forever.
    expect(resolvePrecommitStepNames()).toEqual(derivePrecommitStepNames() ?? []);
  });
});

describe("the real repo", () => {
  test("the derivation sees interceptor-catalog-regen", () => {
    // The mt#4071 regression pin. This name is what the catalog omitted: it
    // fires on every commit, and resolving the population against the snapshot
    // left it out of the catalog with no divergence reported anywhere.
    expect(derivePrecommitStepNames()).toContain("interceptor-catalog-regen");
  });

  test("the snapshot has not drifted from the derivation", () => {
    // The snapshot is the documented parse-failure fallback, so it still has
    // to be correct — it was one entry stale for eight days before mt#4071.
    // If this fails after you add a pre-commit step, add the step's name to
    // PRECOMMIT_STEP_NAMES in .minsky/hooks/known-guard-names.ts.
    expect([...PRECOMMIT_STEP_NAMES]).toEqual(derivePrecommitStepNames() ?? []);
  });
});
