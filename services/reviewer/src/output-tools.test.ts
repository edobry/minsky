/**
 * Unit tests for output-tools.ts.
 *
 * Covers:
 *   - Each tool's args parse correctly with all required fields.
 *   - Optional fields (lineEnd, side) work: absent → no error.
 *   - Invalid enum values throw.
 *   - Missing required fields throw.
 *   - Invalid JSON in argsJson throws.
 *   - Unknown tool name throws.
 *   - OUTPUT_TOOL_DEFINITIONS length is 6 with the required structure.
 */

import { describe, expect, test } from "bun:test";
import {
  OUTPUT_TOOL_DEFINITIONS,
  parseToolCall,
  type ConcludeReviewArgs,
  type ReviewToolCall,
  type SubmitDocumentationImpactArgs,
  type SubmitFindingArgs,
  type SubmitInlineCommentArgs,
  type SubmitSpecVerificationArgs,
  type SubmitThreadResolveArgs,
} from "./output-tools";

// Tool name constants — used throughout tests to satisfy the
// no-magic-string-duplication lint rule.
const TOOL_SUBMIT_FINDING = "submit_finding";
const TOOL_SUBMIT_INLINE_COMMENT = "submit_inline_comment";
const TOOL_SUBMIT_SPEC_VERIFICATION = "submit_spec_verification";
const TOOL_SUBMIT_DOCUMENTATION_IMPACT = "submit_documentation_impact";
const TOOL_CONCLUDE_REVIEW = "conclude_review";
const TOOL_SUBMIT_THREAD_RESOLVE = "submit_thread_resolve";

// ---------------------------------------------------------------------------
// submit_finding
// ---------------------------------------------------------------------------

describe("parseToolCall — submit_finding", () => {
  const BASE_ARGS: SubmitFindingArgs = {
    severity: "BLOCKING",
    file: "src/foo.ts",
    line: 42,
    summary: "Missing null check",
    details: "The value can be null here, causing a runtime crash.",
  };

  test("parses with all required fields", () => {
    const result = parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify(BASE_ARGS));
    expect(result.name).toBe(TOOL_SUBMIT_FINDING);
    expect(result.args).toEqual(BASE_ARGS);
  });

  test("parses with optional lineEnd and side", () => {
    const args = { ...BASE_ARGS, lineEnd: 48, side: "RIGHT" as const };
    const result = parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify(args));
    expect(result.name).toBe(TOOL_SUBMIT_FINDING);
    if (result.name !== TOOL_SUBMIT_FINDING) throw new Error("unreachable");
    expect(result.args.lineEnd).toBe(48);
    expect(result.args.side).toBe("RIGHT");
  });

  test("parses with severity NON-BLOCKING", () => {
    const args = { ...BASE_ARGS, severity: "NON-BLOCKING" as const };
    const result = parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify(args));
    if (result.name !== TOOL_SUBMIT_FINDING) throw new Error("unreachable");
    expect(result.args.severity).toBe("NON-BLOCKING");
  });

  test("parses with severity PRE-EXISTING", () => {
    const args = { ...BASE_ARGS, severity: "PRE-EXISTING" as const };
    const result = parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify(args));
    if (result.name !== TOOL_SUBMIT_FINDING) throw new Error("unreachable");
    expect(result.args.severity).toBe("PRE-EXISTING");
  });

  test("parses with side LEFT", () => {
    const args = { ...BASE_ARGS, side: "LEFT" as const };
    const result = parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify(args));
    if (result.name !== TOOL_SUBMIT_FINDING) throw new Error("unreachable");
    expect(result.args.side).toBe("LEFT");
  });

  test("omitting lineEnd and side does not error", () => {
    const args: SubmitFindingArgs = {
      severity: "BLOCKING",
      file: "src/bar.ts",
      line: 10,
      summary: "x",
      details: "y",
    };
    expect(() => parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify(args))).not.toThrow();
  });

  test("throws on invalid severity enum", () => {
    const args = { ...BASE_ARGS, severity: "URGENT" };
    expect(() => parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify(args))).toThrow();
  });

  test("throws on missing summary", () => {
    const { summary: _omit, ...args } = BASE_ARGS;
    expect(() => parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify(args))).toThrow();
  });

  test("throws on missing details", () => {
    const { details: _omit, ...args } = BASE_ARGS;
    expect(() => parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify(args))).toThrow();
  });

  test("throws on missing file", () => {
    const { file: _omit, ...args } = BASE_ARGS;
    expect(() => parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify(args))).toThrow();
  });

  test("throws on missing line", () => {
    const { line: _omit, ...args } = BASE_ARGS;
    expect(() => parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify(args))).toThrow();
  });

  test("throws on non-positive line (zero)", () => {
    const args = { ...BASE_ARGS, line: 0 };
    expect(() => parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify(args))).toThrow();
  });

  test("throws on non-integer line", () => {
    const args = { ...BASE_ARGS, line: 1.5 };
    expect(() => parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify(args))).toThrow();
  });

  test("throws on empty summary", () => {
    const args = { ...BASE_ARGS, summary: "" };
    expect(() => parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify(args))).toThrow();
  });

  test("throws on empty details", () => {
    const args = { ...BASE_ARGS, details: "" };
    expect(() => parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify(args))).toThrow();
  });

  test("throws on invalid side enum", () => {
    const args = { ...BASE_ARGS, side: "CENTER" };
    expect(() => parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify(args))).toThrow();
  });

  test("error message names the tool when severity is invalid", () => {
    const args = { ...BASE_ARGS, severity: "URGENT" };
    expect(() => parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify(args))).toThrow(
      /submit_finding/
    );
  });
});

// ---------------------------------------------------------------------------
// submit_inline_comment
// ---------------------------------------------------------------------------

describe("parseToolCall — submit_inline_comment", () => {
  const BASE_ARGS: SubmitInlineCommentArgs = {
    file: "src/utils.ts",
    line: 7,
    body: "Consider renaming this variable for clarity.",
  };

  test("parses with all required fields", () => {
    const result = parseToolCall(TOOL_SUBMIT_INLINE_COMMENT, JSON.stringify(BASE_ARGS));
    expect(result.name).toBe(TOOL_SUBMIT_INLINE_COMMENT);
    expect(result.args).toEqual(BASE_ARGS);
  });

  test("throws on missing file", () => {
    const { file: _omit, ...args } = BASE_ARGS;
    expect(() => parseToolCall(TOOL_SUBMIT_INLINE_COMMENT, JSON.stringify(args))).toThrow();
  });

  test("throws on missing line", () => {
    const { line: _omit, ...args } = BASE_ARGS;
    expect(() => parseToolCall(TOOL_SUBMIT_INLINE_COMMENT, JSON.stringify(args))).toThrow();
  });

  test("throws on missing body", () => {
    const { body: _omit, ...args } = BASE_ARGS;
    expect(() => parseToolCall(TOOL_SUBMIT_INLINE_COMMENT, JSON.stringify(args))).toThrow();
  });

  test("throws on empty body", () => {
    const args = { ...BASE_ARGS, body: "" };
    expect(() => parseToolCall(TOOL_SUBMIT_INLINE_COMMENT, JSON.stringify(args))).toThrow();
  });

  test("throws on non-positive line", () => {
    const args = { ...BASE_ARGS, line: -1 };
    expect(() => parseToolCall(TOOL_SUBMIT_INLINE_COMMENT, JSON.stringify(args))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// submit_spec_verification
// ---------------------------------------------------------------------------

describe("parseToolCall — submit_spec_verification", () => {
  const BASE_ARGS: SubmitSpecVerificationArgs = {
    criterion: "Output tools are defined with correct JSON schema",
    status: "Met",
    evidence: "output-tools.ts exports OUTPUT_TOOL_DEFINITIONS with 4 entries",
  };

  test("parses with status Met", () => {
    const result = parseToolCall(TOOL_SUBMIT_SPEC_VERIFICATION, JSON.stringify(BASE_ARGS));
    expect(result.name).toBe(TOOL_SUBMIT_SPEC_VERIFICATION);
    expect(result.args).toEqual(BASE_ARGS);
  });

  test("parses with status Not Met", () => {
    const args = { ...BASE_ARGS, status: "Not Met" as const };
    const result = parseToolCall(TOOL_SUBMIT_SPEC_VERIFICATION, JSON.stringify(args));
    if (result.name !== TOOL_SUBMIT_SPEC_VERIFICATION) throw new Error("unreachable");
    expect(result.args.status).toBe("Not Met");
  });

  test("parses with status N/A", () => {
    const args = { ...BASE_ARGS, status: "N/A" as const };
    const result = parseToolCall(TOOL_SUBMIT_SPEC_VERIFICATION, JSON.stringify(args));
    if (result.name !== TOOL_SUBMIT_SPEC_VERIFICATION) throw new Error("unreachable");
    expect(result.args.status).toBe("N/A");
  });

  test("throws on invalid status enum", () => {
    const args = { ...BASE_ARGS, status: "Partial" };
    expect(() => parseToolCall(TOOL_SUBMIT_SPEC_VERIFICATION, JSON.stringify(args))).toThrow();
  });

  test("throws on missing criterion", () => {
    const { criterion: _omit, ...args } = BASE_ARGS;
    expect(() => parseToolCall(TOOL_SUBMIT_SPEC_VERIFICATION, JSON.stringify(args))).toThrow();
  });

  test("throws on missing evidence", () => {
    const { evidence: _omit, ...args } = BASE_ARGS;
    expect(() => parseToolCall(TOOL_SUBMIT_SPEC_VERIFICATION, JSON.stringify(args))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// submit_documentation_impact
// ---------------------------------------------------------------------------

describe("parseToolCall — submit_documentation_impact", () => {
  const BASE_ARGS: SubmitDocumentationImpactArgs = {
    kind: "no-update-needed",
    evidence: "Pure internal refactor — no documented behavior changed.",
  };

  test("parses with kind no-update-needed and no affectedDocs", () => {
    const result = parseToolCall(TOOL_SUBMIT_DOCUMENTATION_IMPACT, JSON.stringify(BASE_ARGS));
    expect(result.name).toBe(TOOL_SUBMIT_DOCUMENTATION_IMPACT);
    expect(result.args).toEqual(BASE_ARGS);
  });

  test("parses with kind updated-in-pr and affectedDocs", () => {
    const args: SubmitDocumentationImpactArgs = {
      kind: "updated-in-pr",
      evidence: "Updated configuration guide for new env var.",
      affectedDocs: ["docs/configuration-guide.md", "CLAUDE.md"],
    };
    const result = parseToolCall(TOOL_SUBMIT_DOCUMENTATION_IMPACT, JSON.stringify(args));
    if (result.name !== TOOL_SUBMIT_DOCUMENTATION_IMPACT) throw new Error("unreachable");
    expect(result.args.kind).toBe("updated-in-pr");
    expect(result.args.affectedDocs).toEqual(["docs/configuration-guide.md", "CLAUDE.md"]);
  });

  test("parses with kind blocking-needs-update", () => {
    const args: SubmitDocumentationImpactArgs = {
      kind: "blocking-needs-update",
      evidence: "Adds a new MCP tool but does not update docs/architecture.md tool inventory.",
      affectedDocs: ["docs/architecture.md"],
    };
    const result = parseToolCall(TOOL_SUBMIT_DOCUMENTATION_IMPACT, JSON.stringify(args));
    if (result.name !== TOOL_SUBMIT_DOCUMENTATION_IMPACT) throw new Error("unreachable");
    expect(result.args.kind).toBe("blocking-needs-update");
  });

  test("throws on invalid kind enum", () => {
    const args = { ...BASE_ARGS, kind: "needs-clarification" };
    expect(() => parseToolCall(TOOL_SUBMIT_DOCUMENTATION_IMPACT, JSON.stringify(args))).toThrow();
  });

  test("throws on missing evidence", () => {
    const { evidence: _omit, ...args } = BASE_ARGS;
    expect(() => parseToolCall(TOOL_SUBMIT_DOCUMENTATION_IMPACT, JSON.stringify(args))).toThrow();
  });

  test("throws on empty evidence", () => {
    const args = { ...BASE_ARGS, evidence: "" };
    expect(() => parseToolCall(TOOL_SUBMIT_DOCUMENTATION_IMPACT, JSON.stringify(args))).toThrow();
  });

  test("throws on affectedDocs containing an empty string", () => {
    const args = { ...BASE_ARGS, kind: "updated-in-pr" as const, affectedDocs: [""] };
    expect(() => parseToolCall(TOOL_SUBMIT_DOCUMENTATION_IMPACT, JSON.stringify(args))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// conclude_review
// ---------------------------------------------------------------------------

describe("parseToolCall — conclude_review", () => {
  const BASE_ARGS: ConcludeReviewArgs = {
    event: "APPROVE",
    summary: "The PR looks good. No blocking issues found.",
  };

  test("parses with event APPROVE", () => {
    const result = parseToolCall(TOOL_CONCLUDE_REVIEW, JSON.stringify(BASE_ARGS));
    expect(result.name).toBe(TOOL_CONCLUDE_REVIEW);
    expect(result.args).toEqual(BASE_ARGS);
  });

  test("parses with event REQUEST_CHANGES", () => {
    const args = { ...BASE_ARGS, event: "REQUEST_CHANGES" as const };
    const result = parseToolCall(TOOL_CONCLUDE_REVIEW, JSON.stringify(args));
    if (result.name !== TOOL_CONCLUDE_REVIEW) throw new Error("unreachable");
    expect(result.args.event).toBe("REQUEST_CHANGES");
  });

  test("parses with event COMMENT", () => {
    const args = { ...BASE_ARGS, event: "COMMENT" as const };
    const result = parseToolCall(TOOL_CONCLUDE_REVIEW, JSON.stringify(args));
    if (result.name !== TOOL_CONCLUDE_REVIEW) throw new Error("unreachable");
    expect(result.args.event).toBe("COMMENT");
  });

  test("throws on invalid event enum", () => {
    const args = { ...BASE_ARGS, event: "REJECT" };
    expect(() => parseToolCall(TOOL_CONCLUDE_REVIEW, JSON.stringify(args))).toThrow();
  });

  test("throws on missing event", () => {
    const { event: _omit, ...args } = BASE_ARGS;
    expect(() => parseToolCall(TOOL_CONCLUDE_REVIEW, JSON.stringify(args))).toThrow();
  });

  test("throws on missing summary", () => {
    const { summary: _omit, ...args } = BASE_ARGS;
    expect(() => parseToolCall(TOOL_CONCLUDE_REVIEW, JSON.stringify(args))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Error handling — unknown tool and invalid JSON
// ---------------------------------------------------------------------------

describe("parseToolCall — error handling", () => {
  test("throws on unknown tool name", () => {
    expect(() => parseToolCall("submit_unknown_thing", "{}")).toThrow(/Unknown output tool name/);
  });

  test("error message includes the unknown tool name", () => {
    expect(() => parseToolCall("my_tool", "{}")).toThrow(/my_tool/);
  });

  test("throws on invalid JSON in argsJson", () => {
    expect(() => parseToolCall(TOOL_SUBMIT_FINDING, "not-json-{")).toThrow(
      /Failed to parse argsJson/
    );
  });

  test("throws on empty string argsJson", () => {
    expect(() => parseToolCall(TOOL_SUBMIT_FINDING, "")).toThrow();
  });

  test("throws on null argsJson (stringified)", () => {
    // "null" is valid JSON, but not a valid object — zod will reject it.
    expect(() => parseToolCall(TOOL_CONCLUDE_REVIEW, "null")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Acceptance tests from the spec
// ---------------------------------------------------------------------------

describe("acceptance tests (spec §Acceptance Tests)", () => {
  test("BLOCKING submit_finding round-trips correctly", () => {
    const call = parseToolCall(
      TOOL_SUBMIT_FINDING,
      JSON.stringify({
        severity: "BLOCKING",
        file: "src/foo.ts",
        line: 42,
        summary: "x",
        details: "y",
      })
    );
    expect(call.name).toBe(TOOL_SUBMIT_FINDING);
    if (call.name !== TOOL_SUBMIT_FINDING) throw new Error("unreachable");
    expect(call.args.severity).toBe("BLOCKING");
    expect(call.args.file).toBe("src/foo.ts");
    expect(call.args.line).toBe(42);
  });

  test("invalid severity throws", () => {
    expect(() =>
      parseToolCall(
        TOOL_SUBMIT_FINDING,
        JSON.stringify({
          severity: "URGENT",
          file: "src/foo.ts",
          line: 42,
          summary: "x",
          details: "y",
        })
      )
    ).toThrow();
  });

  test("missing required fields throw", () => {
    expect(() =>
      parseToolCall(TOOL_SUBMIT_FINDING, JSON.stringify({ file: "x", line: 1 }))
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// submit_thread_resolve (mt#1345)
// ---------------------------------------------------------------------------

describe("parseToolCall — submit_thread_resolve", () => {
  const BASE_ARGS: SubmitThreadResolveArgs = {
    threadId: "PRRT_kwDOABcde12345",
    reason: "Fix verified in updated implementation.",
  };

  test("parses with threadId and reason", () => {
    const result = parseToolCall(TOOL_SUBMIT_THREAD_RESOLVE, JSON.stringify(BASE_ARGS));
    expect(result.name).toBe(TOOL_SUBMIT_THREAD_RESOLVE);
    expect(result.args).toEqual(BASE_ARGS);
  });

  test("throws on missing threadId", () => {
    const { threadId: _omit, ...args } = BASE_ARGS;
    expect(() => parseToolCall(TOOL_SUBMIT_THREAD_RESOLVE, JSON.stringify(args))).toThrow();
  });

  test("throws on missing reason", () => {
    const { reason: _omit, ...args } = BASE_ARGS;
    expect(() => parseToolCall(TOOL_SUBMIT_THREAD_RESOLVE, JSON.stringify(args))).toThrow();
  });

  test("throws on empty threadId", () => {
    const args = { ...BASE_ARGS, threadId: "" };
    expect(() => parseToolCall(TOOL_SUBMIT_THREAD_RESOLVE, JSON.stringify(args))).toThrow();
  });

  test("throws on empty reason", () => {
    const args = { ...BASE_ARGS, reason: "" };
    expect(() => parseToolCall(TOOL_SUBMIT_THREAD_RESOLVE, JSON.stringify(args))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// submit_inline_comment — inReplyTo (mt#1345)
// ---------------------------------------------------------------------------

describe("parseToolCall — submit_inline_comment — inReplyTo", () => {
  const BASE_ARGS: SubmitInlineCommentArgs = {
    file: "src/utils.ts",
    line: 7,
    body: "Consider renaming this variable for clarity.",
  };

  test("parses with optional inReplyTo present", () => {
    const args = { ...BASE_ARGS, inReplyTo: 123456 };
    const result = parseToolCall(TOOL_SUBMIT_INLINE_COMMENT, JSON.stringify(args));
    expect(result.name).toBe(TOOL_SUBMIT_INLINE_COMMENT);
    if (result.name !== TOOL_SUBMIT_INLINE_COMMENT) throw new Error("unreachable");
    expect(result.args.inReplyTo).toBe(123456);
  });

  test("parses without inReplyTo — field is absent", () => {
    const result = parseToolCall(TOOL_SUBMIT_INLINE_COMMENT, JSON.stringify(BASE_ARGS));
    if (result.name !== TOOL_SUBMIT_INLINE_COMMENT) throw new Error("unreachable");
    expect(result.args.inReplyTo).toBeUndefined();
  });

  test("throws on non-positive inReplyTo (zero)", () => {
    const args = { ...BASE_ARGS, inReplyTo: 0 };
    expect(() => parseToolCall(TOOL_SUBMIT_INLINE_COMMENT, JSON.stringify(args))).toThrow();
  });

  test("throws on non-integer inReplyTo", () => {
    const args = { ...BASE_ARGS, inReplyTo: 1.5 };
    expect(() => parseToolCall(TOOL_SUBMIT_INLINE_COMMENT, JSON.stringify(args))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// OUTPUT_TOOL_DEFINITIONS shape
// ---------------------------------------------------------------------------

describe("OUTPUT_TOOL_DEFINITIONS", () => {
  test("has exactly 6 entries", () => {
    expect(OUTPUT_TOOL_DEFINITIONS).toHaveLength(6);
  });

  test("each entry has type: function", () => {
    for (const def of OUTPUT_TOOL_DEFINITIONS) {
      expect(def.type).toBe("function");
    }
  });

  test("each entry has function.name", () => {
    for (const def of OUTPUT_TOOL_DEFINITIONS) {
      expect(typeof def.function.name).toBe("string");
      expect(def.function.name.length).toBeGreaterThan(0);
    }
  });

  test("each entry has function.description", () => {
    for (const def of OUTPUT_TOOL_DEFINITIONS) {
      expect(typeof def.function.description).toBe("string");
      expect(def.function.description.length).toBeGreaterThan(0);
    }
  });

  test("each entry has function.parameters with type: object", () => {
    for (const def of OUTPUT_TOOL_DEFINITIONS) {
      expect(def.function.parameters).toBeDefined();
      expect(def.function.parameters.type).toBe("object");
    }
  });

  test("each entry has function.parameters.properties", () => {
    for (const def of OUTPUT_TOOL_DEFINITIONS) {
      expect(def.function.parameters.properties).toBeDefined();
      expect(typeof def.function.parameters.properties).toBe("object");
    }
  });

  test("each entry has function.parameters.required as an array", () => {
    for (const def of OUTPUT_TOOL_DEFINITIONS) {
      expect(Array.isArray(def.function.parameters.required)).toBe(true);
    }
  });

  test("tool names match the expected six", () => {
    const names = OUTPUT_TOOL_DEFINITIONS.map((d) => d.function.name);
    expect(names).toContain(TOOL_SUBMIT_FINDING);
    expect(names).toContain(TOOL_SUBMIT_INLINE_COMMENT);
    expect(names).toContain(TOOL_SUBMIT_SPEC_VERIFICATION);
    expect(names).toContain(TOOL_SUBMIT_DOCUMENTATION_IMPACT);
    expect(names).toContain(TOOL_CONCLUDE_REVIEW);
    expect(names).toContain(TOOL_SUBMIT_THREAD_RESOLVE);
  });

  test("submit_documentation_impact requires kind and evidence", () => {
    const def = OUTPUT_TOOL_DEFINITIONS.find(
      (d) => d.function.name === TOOL_SUBMIT_DOCUMENTATION_IMPACT
    );
    if (!def) throw new Error(`${TOOL_SUBMIT_DOCUMENTATION_IMPACT} not found`);
    const required = def.function.parameters.required ?? [];
    expect(required).toContain("kind");
    expect(required).toContain("evidence");
  });

  test("submit_documentation_impact does NOT require affectedDocs (optional)", () => {
    const def = OUTPUT_TOOL_DEFINITIONS.find(
      (d) => d.function.name === TOOL_SUBMIT_DOCUMENTATION_IMPACT
    );
    if (!def) throw new Error(`${TOOL_SUBMIT_DOCUMENTATION_IMPACT} not found`);
    const required = def.function.parameters.required ?? [];
    expect(required).not.toContain("affectedDocs");
  });

  test("submit_finding requires severity, file, line, summary, details", () => {
    const def = OUTPUT_TOOL_DEFINITIONS.find((d) => d.function.name === TOOL_SUBMIT_FINDING);
    if (!def) throw new Error(`${TOOL_SUBMIT_FINDING} not found`);
    const required = def.function.parameters.required ?? [];
    expect(required).toContain("severity");
    expect(required).toContain("file");
    expect(required).toContain("line");
    expect(required).toContain("summary");
    expect(required).toContain("details");
  });

  test("submit_finding does NOT require lineEnd or side (they are optional)", () => {
    const def = OUTPUT_TOOL_DEFINITIONS.find((d) => d.function.name === TOOL_SUBMIT_FINDING);
    if (!def) throw new Error(`${TOOL_SUBMIT_FINDING} not found`);
    const required = def.function.parameters.required ?? [];
    expect(required).not.toContain("lineEnd");
    expect(required).not.toContain("side");
  });

  test("submit_inline_comment requires file, line, body", () => {
    const def = OUTPUT_TOOL_DEFINITIONS.find((d) => d.function.name === TOOL_SUBMIT_INLINE_COMMENT);
    if (!def) throw new Error(`${TOOL_SUBMIT_INLINE_COMMENT} not found`);
    const required = def.function.parameters.required ?? [];
    expect(required).toContain("file");
    expect(required).toContain("line");
    expect(required).toContain("body");
  });

  test("submit_spec_verification requires criterion, status, evidence", () => {
    const def = OUTPUT_TOOL_DEFINITIONS.find(
      (d) => d.function.name === TOOL_SUBMIT_SPEC_VERIFICATION
    );
    if (!def) throw new Error(`${TOOL_SUBMIT_SPEC_VERIFICATION} not found`);
    const required = def.function.parameters.required ?? [];
    expect(required).toContain("criterion");
    expect(required).toContain("status");
    expect(required).toContain("evidence");
  });

  test("conclude_review requires event and summary", () => {
    const def = OUTPUT_TOOL_DEFINITIONS.find((d) => d.function.name === TOOL_CONCLUDE_REVIEW);
    if (!def) throw new Error(`${TOOL_CONCLUDE_REVIEW} not found`);
    const required = def.function.parameters.required ?? [];
    expect(required).toContain("event");
    expect(required).toContain("summary");
  });

  test("submit_thread_resolve requires threadId and reason", () => {
    const def = OUTPUT_TOOL_DEFINITIONS.find((d) => d.function.name === TOOL_SUBMIT_THREAD_RESOLVE);
    if (!def) throw new Error(`${TOOL_SUBMIT_THREAD_RESOLVE} not found`);
    const required = def.function.parameters.required ?? [];
    expect(required).toContain("threadId");
    expect(required).toContain("reason");
  });

  test("submit_inline_comment does NOT require inReplyTo (it is optional)", () => {
    const def = OUTPUT_TOOL_DEFINITIONS.find((d) => d.function.name === TOOL_SUBMIT_INLINE_COMMENT);
    if (!def) throw new Error(`${TOOL_SUBMIT_INLINE_COMMENT} not found`);
    const required = def.function.parameters.required ?? [];
    expect(required).not.toContain("inReplyTo");
  });
});

// ---------------------------------------------------------------------------
// String min-length enforcement (mt#1404)
// ---------------------------------------------------------------------------

describe("string min-length enforcement (mt#1404)", () => {
  test("submit_finding throws when file is empty", () => {
    expect(() =>
      parseToolCall(
        TOOL_SUBMIT_FINDING,
        JSON.stringify({
          severity: "BLOCKING",
          file: "",
          line: 1,
          summary: "x",
          details: "y",
        })
      )
    ).toThrow();
  });

  test("submit_inline_comment throws when file is empty", () => {
    expect(() =>
      parseToolCall(
        TOOL_SUBMIT_INLINE_COMMENT,
        JSON.stringify({
          file: "",
          line: 1,
          body: "some comment",
        })
      )
    ).toThrow();
  });

  test("submit_spec_verification throws when criterion is empty", () => {
    expect(() =>
      parseToolCall(
        TOOL_SUBMIT_SPEC_VERIFICATION,
        JSON.stringify({
          criterion: "",
          status: "Met",
          evidence: "some evidence",
        })
      )
    ).toThrow();
  });

  test("submit_spec_verification throws when evidence is empty", () => {
    expect(() =>
      parseToolCall(
        TOOL_SUBMIT_SPEC_VERIFICATION,
        JSON.stringify({
          criterion: "some criterion",
          status: "Met",
          evidence: "",
        })
      )
    ).toThrow();
  });

  test("conclude_review throws when summary is empty", () => {
    expect(() =>
      parseToolCall(
        TOOL_CONCLUDE_REVIEW,
        JSON.stringify({
          event: "APPROVE",
          summary: "",
        })
      )
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Type-level check — ReviewToolCall is a discriminated union
// ---------------------------------------------------------------------------

// This test verifies at runtime that the shape of the returned union is correct.
describe("ReviewToolCall discriminated union", () => {
  test("name field narrows to specific tool name", () => {
    const call: ReviewToolCall = parseToolCall(
      TOOL_CONCLUDE_REVIEW,
      JSON.stringify({ event: "COMMENT", summary: "Observations only." })
    );

    if (call.name === TOOL_CONCLUDE_REVIEW) {
      // TypeScript ensures call.args is ConcludeReviewArgs here.
      expect(call.args.event).toBe("COMMENT");
    } else {
      throw new Error("Expected conclude_review");
    }
  });
});
