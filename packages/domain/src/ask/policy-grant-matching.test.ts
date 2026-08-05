/**
 * Regression tests for policy grant matching (mt#3714).
 *
 * Originating incident: two `authorization.approve` asks requesting a merge-gate
 * override were auto-closed by the router against a CLAUDE.md paragraph about an
 * ESLint rule. The action token `override` matched inside the phrase "no
 * override" — text DENYING the thing being asked — and the authority keyword
 * `allow` matched inside `intentional-swallow`. Neither signal was anchored, and
 * neither was checked for negation or proximity.
 *
 * An authorization ask is the one kind that exists precisely because the agent
 * lacks standing to decide, so a false grant here silently removes the human
 * from a decision they own.
 *
 * @see mt#3714
 */

import { describe, test, expect } from "bun:test";
import { isActionCovered } from "./policy";

function coverage(content: string, tokens: string[]): boolean {
  return isActionCovered(tokens, [{ source: "TEST.md", content }]).covered;
}

describe("authority keywords must match as whole words", () => {
  test("`allow` does not match inside `intentional-swallow`", () => {
    // The exact shape of the originating incident.
    expect(
      coverage("- Every catch must carry an intentional-swallow comment when you override it.\n", [
        "override",
      ])
    ).toBe(false);
  });

  test("a real `allowed` still grants", () => {
    // Note the wording: "overriding" is deliberately NOT used. English drops the
    // trailing `e` before `-ing`, so "overriding" is not a prefix-extension of
    // "override" and never matched — on this matcher or its predecessor.
    expect(coverage("- An override of this gate is allowed.\n", ["override"])).toBe(true);
  });

  test("`auto-approved` still grants", () => {
    expect(coverage("- Commits to the session branch are auto-approved.\n", ["commit"])).toBe(true);
  });
});

describe("negated authority does not grant", () => {
  test("`not permitted` is not a grant", () => {
    expect(coverage("- Rebase of the session branch is not permitted.\n", ["rebase"])).toBe(false);
  });

  test("`never allowed` is not a grant", () => {
    expect(coverage("- Force-push to main is never allowed.\n", ["force-push"])).toBe(false);
  });

  test("a contraction negation is not a grant", () => {
    // "the spec hasn't authorized" was an observed false grant after the
    // word-boundary fix but before contractions were added as cues.
    expect(coverage("- Proceed only when the spec hasn't authorized a rebase.\n", ["rebase"])).toBe(
      false
    );
  });

  test("an unrelated `no` elsewhere does not veto a real grant", () => {
    expect(
      coverage("- Rebase is auto-approved; there is no need to ask first.\n", ["rebase"])
    ).toBe(true);
  });
});

describe("the grant must sit near the action it grants", () => {
  test("co-occurrence at opposite ends of a long statement is not a grant", () => {
    const statement = `- An override of the gate is the subject here ${"padding word ".repeat(
      14
    )} and only much later is something unrelated authorized.\n`;
    expect(coverage(statement, ["override"])).toBe(false);
  });

  test("a grant in the same clause is a grant", () => {
    expect(coverage("- An override of the merge gate is authorized.\n", ["override"])).toBe(true);
  });
});

describe("action tokens still match inflections", () => {
  // The pre-mt#3714 matcher got this from bare `includes`. Tightening BOTH
  // signals to exact words would silently break real grants, so only the
  // authority side is strict; action tokens match as a prefix.
  test("`commit` matches `Commits`", () => {
    expect(coverage("- Commits to the session branch are auto-approved.\n", ["commit"])).toBe(true);
  });

  test("`commit` matches `auto-commit` across a hyphen", () => {
    expect(coverage("- The auto-commit step is pre-approved.\n", ["commit"])).toBe(true);
  });

  test("a suffix is still not a match", () => {
    // `mit` must not match `commit` — that is the suffix class the incident came from.
    expect(coverage("- The commit step is pre-approved.\n", ["mitigate"])).toBe(false);
  });
});

describe("no action token means no coverage", () => {
  test("an authority keyword alone does not grant", () => {
    expect(coverage("- This action is auto-approved.\n", ["rebase"])).toBe(false);
  });
});
