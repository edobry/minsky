import { describe, test, expect } from "bun:test";
import {
  validateSpecContent,
  extractSpecContent,
  buildDenialReason,
  MIN_SPEC_LENGTH_FOR_VALIDATION,
  REQUIRED_HEADINGS,
} from "./validate-task-spec";

// Fixture aliases for the required-heading strings — avoids re-declaring the
// literal heading text at each test call site (custom/no-magic-string-duplication).
const SUCCESS_CRITERIA_HEADING = "## Success Criteria";
const ACCEPTANCE_TESTS_HEADING = "## Acceptance Tests";

// ---------------------------------------------------------------------------
// mt#2653: module import safety (mirrors sibling hooks' regression check)
// ---------------------------------------------------------------------------

describe("validate-task-spec — module import safety", () => {
  test("importing the module performs no I/O and does not exit", async () => {
    const mod = await import("./validate-task-spec");
    expect(typeof mod.validateSpecContent).toBe("function");
    expect(mod.REQUIRED_HEADINGS.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// validateSpecContent
// ---------------------------------------------------------------------------

describe("validateSpecContent", () => {
  test("short specs (under the length threshold) pass through unconditionally", () => {
    const shortSpec = "Fix the typo in the README.";
    expect(shortSpec.length).toBeLessThan(MIN_SPEC_LENGTH_FOR_VALIDATION);
    const result = validateSpecContent(shortSpec);
    expect(result.valid).toBe(true);
    expect(result.missingHeadings).toEqual([]);
  });

  test("long spec with both required headings is valid", () => {
    const spec = [
      "# Some Task",
      "",
      "## Summary",
      "A".repeat(120),
      "",
      SUCCESS_CRITERIA_HEADING,
      "- Criterion one",
      "",
      ACCEPTANCE_TESTS_HEADING,
      "- Test one",
    ].join("\n");
    const result = validateSpecContent(spec);
    expect(result.valid).toBe(true);
    expect(result.missingHeadings).toEqual([]);
  });

  test("long spec missing ## Success Criteria is invalid", () => {
    const spec = ["# Some Task", "A".repeat(120), "", ACCEPTANCE_TESTS_HEADING, "- Test one"].join(
      "\n"
    );
    const result = validateSpecContent(spec);
    expect(result.valid).toBe(false);
    expect(result.missingHeadings).toEqual([SUCCESS_CRITERIA_HEADING]);
  });

  test("long spec missing ## Acceptance Tests is invalid", () => {
    const spec = ["# Some Task", "A".repeat(120), "", SUCCESS_CRITERIA_HEADING, "- Crit one"].join(
      "\n"
    );
    const result = validateSpecContent(spec);
    expect(result.valid).toBe(false);
    expect(result.missingHeadings).toEqual([ACCEPTANCE_TESTS_HEADING]);
  });

  test("long spec missing both headings lists both as missing", () => {
    const spec = "A".repeat(150);
    const result = validateSpecContent(spec);
    expect(result.valid).toBe(false);
    expect(result.missingHeadings).toEqual([...REQUIRED_HEADINGS]);
  });
});

// ---------------------------------------------------------------------------
// extractSpecContent
// ---------------------------------------------------------------------------

describe("extractSpecContent", () => {
  test("reads the `spec` field", () => {
    expect(extractSpecContent({ spec: "content here" })).toBe("content here");
  });

  test("falls back to the deprecated `description` alias", () => {
    expect(extractSpecContent({ description: "legacy content" })).toBe("legacy content");
  });

  test("prefers `spec` over `description` when both are present", () => {
    expect(extractSpecContent({ spec: "new", description: "legacy" })).toBe("new");
  });

  test("returns empty string when tool_input is undefined", () => {
    expect(extractSpecContent(undefined)).toBe("");
  });

  test("returns empty string when neither field is present", () => {
    expect(extractSpecContent({ title: "Some Title" })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildDenialReason
// ---------------------------------------------------------------------------

describe("buildDenialReason", () => {
  test("names the task title and the missing headings", () => {
    const reason = buildDenialReason("My Task", [
      SUCCESS_CRITERIA_HEADING,
      ACCEPTANCE_TESTS_HEADING,
    ]);
    expect(reason).toContain('Task "My Task"');
    expect(reason).toContain(SUCCESS_CRITERIA_HEADING);
    expect(reason).toContain(ACCEPTANCE_TESTS_HEADING);
  });
});
