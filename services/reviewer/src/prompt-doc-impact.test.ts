/**
 * Documentation-impact instruction coverage (mt#3527).
 *
 * The doc-impact check historically asked one question — "do the docs mention
 * what this PR added?" — and so missed the case where a diff makes existing doc
 * prose FALSE. All four production reviews on PR #2508 returned
 * `no-update-needed` while `docs/principal-channel.md` opened with a sentence
 * the PR had just falsified; three of them justified it with a variant of "no
 * docs reference these new internals."
 *
 * These tests pin the instruction that closes that gap. They assert on the
 * built prompt and the tool description because those two strings ARE the
 * mechanism — there is no other place the check's semantics live.
 *
 * Lives in its own file rather than appended to `prompt.test.ts`, which is
 * already 1664 lines.
 */

import { describe, expect, test } from "bun:test";

import { buildCriticConstitution } from "./prompt";
import { OUTPUT_TOOL_DEFINITIONS } from "./output-tools";

const TOOLS_PROMPT = buildCriticConstitution(true, "normal", true);
const NO_OUTPUT_TOOLS_PROMPT = buildCriticConstitution(true, "normal", false);

function docImpactToolDescription(): string {
  const def = OUTPUT_TOOL_DEFINITIONS.find(
    (t) => t.function.name === "submit_documentation_impact"
  );
  if (!def) throw new Error("submit_documentation_impact tool definition is missing");
  return def.function.description;
}

describe("doc-impact instruction — invalidation is asked for, not just omission", () => {
  test("names invalidation as a distinct failure mode from omission", () => {
    expect(TOOLS_PROMPT).toContain("Invalidation");
    expect(TOOLS_PROMPT).toContain("Omission");
  });

  test("states that a changed-behavior doc is WRONG, not merely silent", () => {
    expect(TOOLS_PROMPT).toContain(
      "CHANGES or REMOVES behavior that existing documentation still asserts"
    );
  });

  test("rejects the exact reasoning that produced the PR #2508 miss", () => {
    // "do the docs mention what this PR added?" was the whole of the question the
    // model answered on #2508. The prompt must name that as incomplete.
    expect(TOOLS_PROMPT).toContain("do the docs mention what this PR added?");
    expect(TOOLS_PROMPT).toContain("incomplete documentation-impact check");
  });

  test("forbids an unread 'docs remain accurate' claim", () => {
    expect(TOOLS_PROMPT).toContain(
      'Never assert that existing docs "remain accurate" unless you actually read them'
    );
  });

  test("requires the falsified sentence to be quoted, not just the file named", () => {
    expect(TOOLS_PROMPT).toContain("quote that sentence verbatim");
    expect(TOOLS_PROMPT).toContain("naming the file alone does not tell the author what to fix");
  });
});

describe("doc-impact instruction — bounded, so a hit still carries information", () => {
  test("explicitly forbids sweeping the whole docs tree", () => {
    expect(TOOLS_PROMPT).toContain("Do NOT read all of");
    expect(TOOLS_PROMPT).toContain("without sweeping the whole docs tree");
  });

  test("scopes the invalidation search to behavior the diff CHANGES, not adds", () => {
    expect(TOOLS_PROMPT).toContain("CHANGES or REMOVES (as opposed to adds)");
  });

  test("keeps the anti-speculation rule that predates this change", () => {
    // The affectedDocs constraint is what stops topic-area guessing; widening it to
    // admit invalidation must not delete it. The rule survives in rewritten words,
    // so assert the surviving constraint rather than the old sentence.
    expect(TOOLS_PROMPT).toContain("topic-area speculation");
    expect(TOOLS_PROMPT).toContain("unless it specifically describes the changed surface");
  });

  test("the widened bar admits a doc that names no new identifier", () => {
    // docs/principal-channel.md mentioned none of PR #2508's added identifiers.
    // Under the old wording ("references the symbols, routes, commands...") a
    // literal reader could exclude it; this sentence is what admits it.
    expect(TOOLS_PROMPT).toContain("even if it never mentions a single identifier the diff adds");
  });
});

describe("doc-impact instruction — parity across the surfaces that carry it", () => {
  test("the tool description itself asks for both cases", () => {
    const description = docImpactToolDescription();
    expect(description).toContain("TWO cases, not one");
    expect(description).toContain("CHANGES or REMOVES behavior that existing doc prose still");
    expect(description).toContain("quote the specific sentence the diff");
  });

  test("the affectedDocs SCHEMA field agrees with the tool description", () => {
    // PR #2532 R1 BLOCKING: the top-level description was widened to admit a doc
    // naming no new identifier while this field-level description still said
    // "only list docs that actually reference the changed symbols, routes, or
    // behavior". Both strings reach the model, and the narrower one would have
    // excluded exactly the invalidation case the change exists to catch.
    const def = OUTPUT_TOOL_DEFINITIONS.find(
      (t) => t.function.name === "submit_documentation_impact"
    );
    if (!def) throw new Error("submit_documentation_impact tool definition is missing");
    // Assert against the serialized `parameters` schema rather than casting into it:
    // the tool's top-level description lives outside `parameters`, so a hit here can
    // only come from the field description — and this is the payload the model is sent.
    const schema = JSON.stringify(def.function.parameters);

    expect(schema).toContain("even if it never mentions a single identifier the diff adds");
    expect(schema).toContain("topic-area speculation");
  });

  test("the prose output-format variant asks for both halves too", () => {
    // Reviews without output tools compose from prose; the instruction must not
    // silently apply to only one of the two composition paths.
    expect(NO_OUTPUT_TOOLS_PROMPT).toContain("Answer BOTH halves");
    expect(NO_OUTPUT_TOOLS_PROMPT).toContain("makes false");
  });
});
