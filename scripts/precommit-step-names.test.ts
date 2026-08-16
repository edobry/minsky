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

  test("returns null when NO call site yields a name", () => {
    expect(
      parsePrecommitStepNames("await this.instrumented(dynamicName, () => this.a());")
    ).toBeNull();
  });

  test("returns null on a PARTIAL parse rather than the names it did find", () => {
    // PR #3002 R1. Returning ["readable-check"] here would hand the catalog a
    // population silently missing a real enforcement point, with no divergence
    // reported anywhere — the mt#4071 defect, reintroduced through its own fix.
    const source = `
      await this.instrumented("readable-check", () => this.a());
      await this.instrumented(NAME_FROM_A_CONSTANT, () => this.b());
    `;

    expect(parsePrecommitStepNames(source)).toBeNull();
  });

  test("accepts single quotes and backticks, not just double quotes", () => {
    const source = `
      await this.instrumented('single-check', () => this.a());
      await this.instrumented(\`backtick-check\`, () => this.b());
    `;

    expect(parsePrecommitStepNames(source)).toEqual(["backtick-check", "single-check"]);
  });

  test("accepts a comment between the paren and the name", () => {
    const source = `
      await this.instrumented(/* mt#0000 */ "block-comment-check", () => this.a());
      await this.instrumented(
        // why this step runs here
        "line-comment-check",
        () => this.b()
      );
    `;

    expect(parsePrecommitStepNames(source)).toEqual(["block-comment-check", "line-comment-check"]);
  });

  test("a step instrumented twice accounts for both call sites", () => {
    // The count check compares MATCHES to call sites, not the deduped set — a
    // repeated name must not read as an unaccounted-for call site.
    const source = `
      await this.instrumented("repeated-check", () => this.a());
      await this.instrumented("repeated-check", () => this.b());
    `;

    expect(parsePrecommitStepNames(source)).toEqual(["repeated-check"]);
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

  // The snapshot is checked in BOTH directions, as two tests rather than one
  // equality assertion, because the directions fail for different reasons and
  // have different one-line fixes (PR #3002 R1).

  test("the snapshot carries no name the derivation does not (no stale leftovers)", () => {
    // A step deleted from pre-commit.ts must stop being "known".
    // `known-guard-names.ts` is explicit that a union would keep a deleted step
    // known forever, and that retired names belong in RETIRED_GUARD_NAMES with
    // their last-seen date — not left sitting in the live snapshot.
    // FIX: delete the name below from PRECOMMIT_STEP_NAMES, and add it to
    // RETIRED_GUARD_NAMES if it has fire-log history.
    const derived = new Set(derivePrecommitStepNames() ?? []);
    expect([...PRECOMMIT_STEP_NAMES].filter((n) => !derived.has(n))).toEqual([]);
  });

  test("the snapshot is missing no name the derivation finds (fallback stays complete)", () => {
    // The snapshot is not decoration: it is what `resolvePrecommitStepNames`
    // returns when the parse fails — including the PARTIAL-parse case added in
    // this same round. A snapshot that lags a newly-added step therefore
    // reproduces mt#4071 exactly on the fallback path: the catalog omits a real
    // enforcement point and nothing reports it. It was one entry stale for
    // eight days, which is how mt#4071 happened in the first place.
    // FIX: add the name below to PRECOMMIT_STEP_NAMES in
    // .minsky/hooks/known-guard-names.ts — one line, in the same PR that added
    // the step.
    const snapshot = new Set(PRECOMMIT_STEP_NAMES);
    expect((derivePrecommitStepNames() ?? []).filter((n) => !snapshot.has(n))).toEqual([]);
  });
});
