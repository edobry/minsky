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
import { isActionCovered, isCovered } from "./policy";
import type { Ask } from "./types";

function coverage(content: string, tokens: string[]): boolean {
  return isActionCovered(tokens, [{ source: "TEST.md", content }]).covered;
}

function makeAsk(overrides: Partial<Ask> = {}): Ask {
  return {
    id: "test-ask",
    kind: "authorization.approve",
    title: "Operator authorization needed: one-shot merge override for PR #2640",
    question: "Approve a one-shot merge override?",
    state: "open",
    requestor: "test",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Ask;
}

/**
 * The CLAUDE.md statement that actually closed the originating asks, verbatim.
 * `override` sits inside "no override"; `allow` sits inside `intentional-swallow`.
 */
/** An affirmative, adjacent grant naming an action — the shape that SHOULD resolve. */
const COMMIT_GRANT = "- Commits to the session branch are auto-approved.\n";

const INCIDENT_STATEMENT = `  - \`custom/no-silent-catch\` (mt#3299) — every \`catch\` block must rethrow, log, or carry an
    \`// intentional-swallow: <reason>\` comment. Registered \`off\` (not yet active): this repo's
    zero-tolerance ESLint warning gate (mt#1097, no override) makes \`warn\` unshippable with 1462
    pre-existing violations across 560 files; bulk cleanup + flip to \`error\` tracked at mt#3312.
`;

describe("router path: an authorization ask is never auto-closed by a citation match", () => {
  test("the exact originating statement does not cover the originating ask", () => {
    // This is the reproduction of the incident, through the same entry point the
    // router uses (`isCovered`, title-derived tokens) rather than the
    // explicit-action path.
    const result = isCovered(makeAsk(), [{ source: "CLAUDE.md", content: INCIDENT_STATEMENT }]);
    expect(result.covered).toBe(false);
  });

  test("an on-topic, affirmative, adjacent grant DOES still auto-close", () => {
    // Documents the boundary this PR deliberately did NOT move. Spec criterion 1
    // asked for authorization.approve to be removed from policy auto-resolution
    // entirely; that is deferred, because it deletes ADR-008's phase-1
    // short-circuit (this is its last eligible kind) and 11 existing router
    // tests assert the capability. See the task's Outcome section.
    const result = isCovered(makeAsk(), [
      { source: "CLAUDE.md", content: "- A merge override is auto-approved.\n" },
    ]);
    expect(result.covered).toBe(true);
  });

  test("the explicit-action path is unaffected and still resolves a real grant", () => {
    // The capability is narrowed, not removed: session_commit's detection-time
    // check names its action explicitly and keeps working.
    expect(coverage(COMMIT_GRANT, ["commit"])).toBe(true);
  });
});

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
    expect(coverage(COMMIT_GRANT, ["commit"])).toBe(true);
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
    expect(coverage(COMMIT_GRANT, ["commit"])).toBe(true);
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
