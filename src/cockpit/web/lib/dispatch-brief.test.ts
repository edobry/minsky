/**
 * mt#4354 — splitting a generated dispatch prompt into body + folded sections.
 *
 * The property under test throughout: the split is TOTAL and CONSERVATIVE.
 * Nothing is dropped, and anything not on the fold allow-list stays visible —
 * because hiding a dispatch-specific instruction is the failure this task
 * exists to prevent, and showing one section too many is not.
 */
import { describe, test, expect } from "bun:test";
import { splitDispatchBrief, FOLDED_SECTION_HEADINGS } from "./dispatch-brief";

const STAMP = "<!-- minsky:dispatch:v1 parent=397c46b7-23d4 tool_use=toolu_019WF6 -->";

/**
 * The heading these cases exercise, taken from the module's own allow-list
 * rather than retyped.
 *
 * Not circular: what the LITERAL should be is pinned separately, on the domain
 * side, by `prompt-generation.dispatch-brief-headings.test.ts` against the
 * generator's exported constants. These cases test the SPLITTING behavior, so
 * they should follow the allow-list wherever it points.
 */
const ENVELOPE = FOLDED_SECTION_HEADINGS[0];

describe("splitDispatchBrief", () => {
  test("folds the generated boilerplate and keeps the instructions in the body", () => {
    const parts = splitDispatchBrief(
      ["You are working on mt#4351.", "", ENVELOPE, "Do not push to main."].join("\n")
    );
    expect(parts.body).toBe("You are working on mt#4351.");
    expect(parts.sections).toEqual([{ heading: ENVELOPE, content: "Do not push to main." }]);
  });

  test("a folded section does NOT swallow the dispatch-specific section after it", () => {
    // The bug this branch exists to prevent: without an explicit end, the
    // envelope would absorb every later heading and hide real instructions.
    const parts = splitDispatchBrief(
      [ENVELOPE, "envelope text", "## Your task", "the actual work"].join("\n")
    );
    expect(parts.sections).toEqual([{ heading: ENVELOPE, content: "envelope text" }]);
    expect(parts.body).toContain("## Your task");
    expect(parts.body).toContain("the actual work");
  });

  test("an unrecognized section stays in the body rather than being hidden", () => {
    const parts = splitDispatchBrief(["## Some New Section", "important"].join("\n"));
    expect(parts.sections).toEqual([]);
    expect(parts.body).toContain("important");
  });

  test("Minsky's own watermarks are stripped from the rendered body", () => {
    const parts = splitDispatchBrief(
      ["Do the thing.", "", "<!-- minsky:prompt:v1 -->", STAMP].join("\n")
    );
    expect(parts.body).toBe("Do the thing.");
    expect(parts.body).not.toContain("minsky:prompt:v1");
    expect(parts.body).not.toContain("minsky:dispatch:v1");
  });

  test("the stamp is recovered from the text it was stripped from", () => {
    // Stripping and parsing read the same bytes; the marker leaves the prose
    // but its CONTENT survives as the header's ascent link.
    const parts = splitDispatchBrief(`Do the thing.\n${STAMP}`);
    expect(parts.stamp).toEqual({
      parentAgentSessionId: "397c46b7-23d4",
      parentToolUseId: "toolu_019WF6",
    });
  });

  test("an unstamped prompt still splits, with no stamp", () => {
    // Ordinary, not broken: a dispatch predating mt#2292, or one the guard did
    // not rewrite. It must render without an ascent link rather than not render.
    const parts = splitDispatchBrief("Do the thing.\n\n## Operating Envelope\nrules");
    expect(parts.stamp).toBeUndefined();
    expect(parts.body).toBe("Do the thing.");
    expect(parts.sections).toHaveLength(1);
  });

  test("prose that MENTIONS a folded heading mid-sentence is not folded", () => {
    const parts = splitDispatchBrief("Read the ## Operating Envelope section before starting.");
    expect(parts.sections).toEqual([]);
    expect(parts.body).toContain("Read the ## Operating Envelope section");
  });

  test("the split is total — every line lands somewhere", () => {
    const input = [
      "line one",
      ENVELOPE,
      "envelope",
      "## Embedded Skills",
      "skills",
      "## Real Section",
      "real",
    ].join("\n");
    const parts = splitDispatchBrief(input);
    const recovered = [parts.body, ...parts.sections.map((s) => s.content)].join("\n");
    for (const needle of ["line one", "envelope", "skills", "real"]) {
      expect(recovered).toContain(needle);
    }
  });
});
