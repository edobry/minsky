/**
 * Tests for the Critic Constitution builder.
 *
 * The tool-access section must only appear when the caller asserts tools are
 * available — mt#1126 minsky-reviewer finding #3 surfaced that including it
 * unconditionally lies to providers that can't call tools (Gemini, Anthropic).
 */

import { describe, expect, test } from "bun:test";
import { buildCriticConstitution, CRITIC_CONSTITUTION } from "./prompt";

describe("buildCriticConstitution", () => {
  test("includes the Tool access section when toolsAvailable=true", () => {
    const prompt = buildCriticConstitution(true);
    expect(prompt).toContain("## Tool access");
    expect(prompt).toContain("read_file(path)");
    expect(prompt).toContain("list_directory(path)");
    expect(prompt).not.toContain("## Cross-file claims without tool access");
  });

  test("omits the Tool access section and substitutes no-tools guidance when toolsAvailable=false", () => {
    const prompt = buildCriticConstitution(false);
    expect(prompt).not.toContain("## Tool access");
    expect(prompt).not.toContain("read_file(path)");
    expect(prompt).not.toContain("list_directory(path)");
    expect(prompt).toContain("## Cross-file claims without tool access");
    expect(prompt).toContain("You do NOT have file-reading tools");
  });

  test("both variants include the preamble, principles, failure modes, and output format", () => {
    for (const toolsAvailable of [true, false]) {
      const prompt = buildCriticConstitution(toolsAvailable);
      expect(prompt).toContain("adversarial reviewer");
      expect(prompt).toContain("## Principles");
      expect(prompt).toContain("## Failure modes to watch for specifically");
      expect(prompt).toContain("## Output format");
      expect(prompt).toContain("REQUEST_CHANGES");
    }
  });

  test("NEEDS VERIFICATION guidance appears in both variants", () => {
    // Both contexts steer the model toward marking cross-file claims as
    // NEEDS VERIFICATION — the prompt just differs on WHY (tools available
    // but not yet used vs. no tools at all).
    expect(buildCriticConstitution(true)).toContain("NEEDS VERIFICATION");
    expect(buildCriticConstitution(false)).toContain("NEEDS VERIFICATION");
  });
});

describe("CRITIC_CONSTITUTION legacy export", () => {
  test("matches buildCriticConstitution(true) for backwards compatibility", () => {
    expect(CRITIC_CONSTITUTION).toBe(buildCriticConstitution(true));
  });
});
