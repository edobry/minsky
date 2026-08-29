/**
 * Regression tests for the variable-naming checker's reference detection (mt#4719).
 *
 * The checker is a line-based regex scanner with no parser. Before mt#4719 it
 * tested each following line with a bare `\bname\b`, which counted three things
 * that are not reads of the binding. On 2026-08-29 that produced FOUR false
 * positives on `main` and ZERO true positives — and because the check runs
 * whole-repo from the pre-commit hook, it blocked every commit in the repo.
 *
 * It had no tests at all, which is how three distinct defects survived. Each
 * case below is anchored on one of the four real hits, so a regression
 * reproduces the outage rather than merely failing an abstract assertion.
 *
 * The `still detects` block is the load-bearing half: without it, deleting the
 * check entirely would satisfy every other test here.
 */

import { describe, test, expect } from "bun:test";
import { stripNonCode, referencesIdentifier, declaresParameter } from "./check-variable-naming";

describe("stripNonCode", () => {
  test("removes line comments", () => {
    expect(stripNonCode("const a = 1; // a text here")).not.toContain("text");
  });

  test("removes string and template literals", () => {
    expect(stripNonCode('const a = "some text";')).not.toContain("text");
    expect(stripNonCode("const a = 'some text';")).not.toContain("text");
    expect(stripNonCode("const a = `some text`;")).not.toContain("text");
  });

  test("strips literals BEFORE comments, so a URL is not truncated at its slashes", () => {
    // If comments were stripped first, `//x` inside the string would cut the line.
    expect(stripNonCode('const u = "http://x"; const kept = 1;')).toContain("kept");
  });

  test("leaves ordinary code intact", () => {
    expect(stripNonCode("return value.length;")).toContain("value");
  });
});

describe("referencesIdentifier", () => {
  // Anchored on cockpit.test.ts:589 — `type: "depends" as const`.
  test("an object-literal KEY is not a reference", () => {
    expect(referencesIdentifier('    type: "depends" as const,', "type")).toBe(false);
  });

  // Anchored on cockpit.test.ts:1608 — `(provider: string, _token: string)`.
  test("a TypeScript type annotation is not a reference", () => {
    expect(referencesIdentifier(": async (provider: string) => ({", "provider")).toBe(false);
  });

  // Anchored on principal-channel-poller.test.ts:1280.
  test("English prose in a comment is not a reference", () => {
    expect(referencesIdentifier("// Defaults to a text that EXTENDS what streamed", "text")).toBe(
      false
    );
  });

  test("a property access is not a reference to the enclosing binding", () => {
    expect(referencesIdentifier("fromTaskId: r.type,", "type")).toBe(false);
  });

  // PR #3454 R1 BLOCKING: `?.` was missed, reintroducing the property-access class.
  test("optional chaining is not a reference either", () => {
    expect(referencesIdentifier("const x = r?.type;", "type")).toBe(false);
    expect(referencesIdentifier("const x = opts?.provider;", "provider")).toBe(false);
  });

  // PR #3454 R1 NON-BLOCKING: `$` is a legal identifier char and an unescaped
  // `$` in the pattern acts as an end-anchor, changing what matches.
  test("an identifier containing regex metacharacters is matched literally", () => {
    // `a$b` is a legal JS identifier. Unescaped, `\ba$b\b` reads the `$` as an
    // end-anchor and can never match; escaped, it matches literally.
    // (A LEADING `$` is out of reach either way — `\b` needs a word char beside
    // it and `$` is not one. That is a limitation of the line-based approach,
    // not of the escaping.)
    expect(referencesIdentifier("return a$b.length;", "a$b")).toBe(true);
    expect(referencesIdentifier("return other.length;", "a$b")).toBe(false);
  });

  test("shorthand property IS a reference", () => {
    expect(referencesIdentifier("      provider,", "provider")).toBe(true);
  });

  test("an ordinary read IS a reference", () => {
    expect(referencesIdentifier("  return value.length;", "value")).toBe(true);
  });

  test("a ternary branch IS a reference, despite the nearby colon", () => {
    expect(referencesIdentifier("const x = flag ? value : other;", "value")).toBe(true);
  });
});

describe("declaresParameter", () => {
  // Anchored on cockpit.test.ts:1608 — the sibling lambda across a ternary.
  test("detects a sibling lambda re-declaring the name", () => {
    expect(declaresParameter(": async (provider: string, _token: string) => ({", "provider")).toBe(
      true
    );
  });

  test("does not fire on a line that merely uses the name", () => {
    expect(declaresParameter("      provider,", "provider")).toBe(false);
  });

  test("does not fire for an unrelated parameter name", () => {
    expect(declaresParameter("async (other: string) => 1", "provider")).toBe(false);
  });
});

describe("still detects genuine violations (the control)", () => {
  test("an underscore-declared param read on a later line is a reference", () => {
    // `_value` declared unused, then read as `value` — the real thing the check exists for.
    expect(referencesIdentifier("  return value.length;", "value")).toBe(true);
  });

  test("a caught error read after `catch (_err)` is a reference", () => {
    expect(referencesIdentifier("    console.log(err);", "err")).toBe(true);
  });
});
