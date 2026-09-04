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
 *   - OUTPUT_TOOL_DEFINITIONS length is 7 with the required structure.
 */

import { describe, expect, test } from "bun:test";
import {
  BATCHED_TOOL_EXPANSIONS,
  MAX_BATCHED_FINDINGS,
  OUTPUT_TOOL_DEFINITIONS,
  parseToolCall,
  parseToolCallExpanded,
  BATCHED_SPEC_VERIFICATION_TOOL,
  MAX_BATCHED_SPEC_VERIFICATIONS,
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

/** The singular tool name a batch expands into. */
const SINGULAR_SPEC_TOOL = "submit_spec_verification";

describe("parseToolCallExpanded — batched spec verifications (mt#3545)", () => {
  const entry = (criterion: string, status = "Met") => ({
    criterion,
    status,
    evidence: `evidence for ${criterion}`,
  });

  test("a batch expands to N singular calls, in spec order", () => {
    // The whole design rests on this: downstream consumers (compose-review,
    // provenance, severity-recovery) must see exactly what N singular calls
    // would have produced, or batching becomes a behavior change.
    const expanded = parseToolCallExpanded(
      BATCHED_SPEC_VERIFICATION_TOOL,
      JSON.stringify({
        verifications: [entry("SC1"), entry("SC2", "Not Met"), entry("SC3", "N/A")],
      })
    );

    expect(expanded).toHaveLength(3);
    expect(expanded.map((c) => c.name)).toEqual([
      SINGULAR_SPEC_TOOL,
      SINGULAR_SPEC_TOOL,
      SINGULAR_SPEC_TOOL,
    ]);
    expect(expanded.map((c) => (c.args as SubmitSpecVerificationArgs).criterion)).toEqual([
      "SC1",
      "SC2",
      "SC3",
    ]);
    expect(expanded.map((c) => (c.args as SubmitSpecVerificationArgs).status)).toEqual([
      "Met",
      "Not Met",
      "N/A",
    ]);
  });

  test("a batch accepts the Unverifiable status alongside the other three (mt#3919)", () => {
    const expanded = parseToolCallExpanded(
      BATCHED_SPEC_VERIFICATION_TOOL,
      JSON.stringify({
        verifications: [entry("SC1", "Met"), entry("SC2 — mt#3874's spec updated", "Unverifiable")],
      })
    );

    expect(expanded.map((c) => (c.args as SubmitSpecVerificationArgs).status)).toEqual([
      "Met",
      "Unverifiable",
    ]);
  });

  test("a batched entry is byte-identical to the singular call for the same entry", () => {
    const single = parseToolCall(SINGULAR_SPEC_TOOL, JSON.stringify(entry("SC1")));
    const [batched] = parseToolCallExpanded(
      BATCHED_SPEC_VERIFICATION_TOOL,
      JSON.stringify({ verifications: [entry("SC1")] })
    );

    expect(batched).toEqual(single);
  });

  test("per-entry validation still applies — one bad entry rejects the whole batch", () => {
    // SC3: batching must not weaken per-item validation. All-or-nothing is the
    // safe failure mode: a partial verdict set would look like a complete one.
    expect(() =>
      parseToolCallExpanded(
        BATCHED_SPEC_VERIFICATION_TOOL,
        JSON.stringify({
          verifications: [entry("SC1"), { criterion: "SC2", status: "Maybe", evidence: "x" }],
        })
      )
    ).toThrow(/verifications\.1\.status/);
  });

  test("an empty batch is rejected rather than silently recording nothing", () => {
    expect(() =>
      parseToolCallExpanded(BATCHED_SPEC_VERIFICATION_TOOL, JSON.stringify({ verifications: [] }))
    ).toThrow(/verifications/);
  });

  test("a batch beyond the cap is rejected", () => {
    const tooMany = Array.from({ length: MAX_BATCHED_SPEC_VERIFICATIONS + 1 }, (_, i) =>
      entry(`SC${i}`)
    );
    expect(() =>
      parseToolCallExpanded(
        BATCHED_SPEC_VERIFICATION_TOOL,
        JSON.stringify({ verifications: tooMany })
      )
    ).toThrow(/verifications/);
  });

  test("non-batched tools pass through unchanged, as a single-element array", () => {
    const expanded = parseToolCallExpanded(
      "conclude_review",
      JSON.stringify({ event: "APPROVE", summary: "Looks good to me, shipping it." })
    );

    expect(expanded).toHaveLength(1);
    expect(expanded[0]?.name).toBe("conclude_review");
  });

  test("the batched tool is exposed to the model", () => {
    const names = OUTPUT_TOOL_DEFINITIONS.map((d) => d.function.name);
    expect(names).toContain(BATCHED_SPEC_VERIFICATION_TOOL);
    // The singular form stays available for a late single correction.
    expect(names).toContain(SINGULAR_SPEC_TOOL);
  });
});

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

  test("parses with status Unverifiable (mt#3919)", () => {
    const args = {
      ...BASE_ARGS,
      status: "Unverifiable" as const,
      evidence: "mt#3874's spec could not be fetched: status=not-found",
    };
    const result = parseToolCall(TOOL_SUBMIT_SPEC_VERIFICATION, JSON.stringify(args));
    if (result.name !== TOOL_SUBMIT_SPEC_VERIFICATION) throw new Error("unreachable");
    expect(result.args.status).toBe("Unverifiable");
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
  test("has exactly 9 entries", () => {
    // 9 as of mt#4979, which added the batched `submit_findings` alongside the
    // singular form — the same move mt#3545 made for spec verifications (which
    // took this count to 8). This count is a deliberate guard: adding a tool
    // widens the model's option surface and should be a decision, not a
    // drive-by, so the number is asserted rather than derived.
    expect(OUTPUT_TOOL_DEFINITIONS).toHaveLength(9);
  });

  test("every batch tool in the expansion registry is a REGISTERED definition", () => {
    // A batch tool with an expansion but no definition is never offered to the
    // model (dead code); a definition with no expansion would fall through to
    // parseToolCall and throw on the batch shape. Both directions are silent
    // failures, so the census asserts the two sets agree.
    const registered = new Set(OUTPUT_TOOL_DEFINITIONS.map((d) => d.function.name));
    for (const batchName of Object.keys(BATCHED_TOOL_EXPANSIONS)) {
      expect(registered.has(batchName)).toBe(true);
    }
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

  test("tool names match the expected seven", () => {
    const names = OUTPUT_TOOL_DEFINITIONS.map((d) => d.function.name);
    expect(names).toContain(TOOL_SUBMIT_FINDING);
    expect(names).toContain(TOOL_SUBMIT_INLINE_COMMENT);
    expect(names).toContain(TOOL_SUBMIT_SPEC_VERIFICATION);
    expect(names).toContain(TOOL_SUBMIT_DOCUMENTATION_IMPACT);
    expect(names).toContain("submit_adoption_sweep");
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

// ---------------------------------------------------------------------------
// mt#4979 — the batched submit_findings tool
// ---------------------------------------------------------------------------

describe("parseToolCallExpanded — submit_findings (mt#4979)", () => {
  const finding = (file: string, summary: string) => ({
    severity: "BLOCKING" as const,
    file,
    line: 1,
    summary,
    details: "d",
  });

  test("expands N entries into N singular submit_finding calls, in order", () => {
    // Order matters: findings are rendered in emit order within a severity
    // (compose-review's sort is stable), so a reordering expansion would
    // silently shuffle the review body.
    const calls = parseToolCallExpanded(
      "submit_findings",
      JSON.stringify({
        findings: [finding("a.ts", "first"), finding("b.ts", "second"), finding("c.ts", "third")],
      })
    );

    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.name === "submit_finding")).toBe(true);
    expect(calls.map((c) => (c.args as { summary: string }).summary)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("a single-entry batch is valid and yields one call", () => {
    const calls = parseToolCallExpanded(
      "submit_findings",
      JSON.stringify({ findings: [finding("a.ts", "only")] })
    );
    expect(calls).toHaveLength(1);
  });

  test("rejects an empty batch", () => {
    // An empty findings array is not "no findings" — the model says that by not
    // calling the tool. Accepting it would let a forced pass report success
    // having recorded nothing.
    expect(() =>
      parseToolCallExpanded("submit_findings", JSON.stringify({ findings: [] }))
    ).toThrow(/Invalid args/);
  });

  test("rejects a batch over MAX_BATCHED_FINDINGS", () => {
    const oversized = Array.from({ length: MAX_BATCHED_FINDINGS + 1 }, (_, i) =>
      finding(`f${i}.ts`, `s${i}`)
    );
    expect(() =>
      parseToolCallExpanded("submit_findings", JSON.stringify({ findings: oversized }))
    ).toThrow(/Invalid args/);
  });

  test("one malformed entry rejects the WHOLE batch — all-or-nothing", () => {
    // Matching the batched-spec-verification contract: a partial verdict set is
    // worse than none, because the caller cannot tell which entries were lost.
    expect(() =>
      parseToolCallExpanded(
        "submit_findings",
        JSON.stringify({
          findings: [finding("a.ts", "good"), { severity: "BLOCKING", file: "b.ts" }],
        })
      )
    ).toThrow(/Invalid args/);
  });

  test("the singular tool is untouched by the batch path", () => {
    const calls = parseToolCallExpanded(
      "submit_finding",
      JSON.stringify(finding("a.ts", "singular"))
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("submit_finding");
  });
});
