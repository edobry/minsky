import { describe, expect, test } from "bun:test";
import {
  extractProvenance,
  serializeProvenance,
  parseProvenance,
  PROVENANCE_MARKER_START,
  PROVENANCE_MARKER_END,
  type ReviewProvenance,
} from "./review-provenance";
import type { ReviewToolCall } from "./output-tools";

const DOC_IMPACT_NO_UPDATE = "no-update-needed" as const;

// Tool name constants — prevents magic-string-duplication lint warnings.
const TOOL_SUBMIT_SPEC_VERIFICATION = "submit_spec_verification";
const TOOL_SUBMIT_DOCUMENTATION_IMPACT = "submit_documentation_impact";
const TOOL_SUBMIT_FINDING = "submit_finding";
const TOOL_SUBMIT_ADOPTION_SWEEP = "submit_adoption_sweep";
const TOOL_CONCLUDE_REVIEW = "conclude_review";

// Adoption-sweep classification constants.
const ADOPTION_MISSING_CONSUMERS = "Missing consumers";

describe("extractProvenance", () => {
  test("extracts spec verification entries", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_SPEC_VERIFICATION,
        args: { criterion: "SC1: foo", status: "Met", evidence: "Found in bar.ts" },
      },
      {
        name: TOOL_SUBMIT_SPEC_VERIFICATION,
        args: { criterion: "SC2: baz", status: "Not Met", evidence: "Missing from qux.ts" },
      },
    ];

    const result = extractProvenance(toolCalls);
    expect(result.specVerification).toHaveLength(2);
    expect(result.specVerification[0]).toEqual({
      criterion: "SC1: foo",
      status: "Met",
      evidence: "Found in bar.ts",
    });
    expect(result.specVerification[1]).toEqual({
      criterion: "SC2: baz",
      status: "Not Met",
      evidence: "Missing from qux.ts",
    });
  });

  test("extracts documentation impact (uses last call)", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_DOCUMENTATION_IMPACT,
        args: { kind: DOC_IMPACT_NO_UPDATE, evidence: "Internal refactor" },
      },
      {
        name: TOOL_SUBMIT_DOCUMENTATION_IMPACT,
        args: {
          kind: "updated-in-pr",
          evidence: "Updated docs/foo.md",
          affectedDocs: ["docs/foo.md"],
        },
      },
    ];

    const result = extractProvenance(toolCalls);
    expect(result.docImpact).toEqual({
      kind: "updated-in-pr",
      evidence: "Updated docs/foo.md",
      affectedDocs: ["docs/foo.md"],
    });
  });

  test("counts findings by severity", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "BLOCKING",
          file: "a.ts",
          line: 1,
          summary: "Bug",
          details: "Details",
        },
      },
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "NON-BLOCKING",
          file: "b.ts",
          line: 2,
          summary: "Nit",
          details: "Details",
        },
      },
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "BLOCKING",
          file: "c.ts",
          line: 3,
          summary: "Bug2",
          details: "Details",
        },
      },
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "PRE-EXISTING",
          file: "d.ts",
          line: 4,
          summary: "Old",
          details: "Details",
        },
      },
    ];

    const result = extractProvenance(toolCalls);
    expect(result.findings.blocking).toBe(2);
    expect(result.findings.nonBlocking).toBe(2);
  });

  test("extracts conclusion", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_CONCLUDE_REVIEW,
        args: { event: "APPROVE", summary: "Looks good" },
      },
    ];

    const result = extractProvenance(toolCalls);
    expect(result.conclusion).toEqual({ event: "APPROVE", summary: "Looks good" });
  });

  test("returns nulls for missing tool calls", () => {
    const result = extractProvenance([]);
    expect(result.specVerification).toEqual([]);
    expect(result.docImpact).toBeNull();
    expect(result.findings).toEqual({ blocking: 0, nonBlocking: 0 });
    expect(result.conclusion).toBeNull();
    expect(result.adoptionSweep).toBeNull();
  });

  test("ignores non-output tool calls", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: "submit_inline_comment",
        args: { file: "a.ts", line: 1, body: "Comment" },
      },
      {
        name: "submit_thread_resolve",
        args: { threadId: "PRT_123", reason: "Fixed" },
      },
    ];

    const result = extractProvenance(toolCalls);
    expect(result.specVerification).toEqual([]);
    expect(result.docImpact).toBeNull();
    expect(result.findings).toEqual({ blocking: 0, nonBlocking: 0 });
    expect(result.conclusion).toBeNull();
  });

  test("adoptionSweep is null when no submit_adoption_sweep calls", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_SPEC_VERIFICATION,
        args: { criterion: "SC1", status: "Met", evidence: "OK" },
      },
    ];

    const result = extractProvenance(toolCalls);
    expect(result.adoptionSweep).toBeNull();
  });

  test("extracts single Adopted adoption sweep entry", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_ADOPTION_SWEEP,
        args: {
          symbol: TOOL_SUBMIT_ADOPTION_SWEEP,
          kind: "mcp-tool",
          consumersFound: ["services/reviewer/src/providers.ts:276"],
          classification: "Adopted",
          notes: "Registered in OUTPUT_TOOL_NAMES.",
        },
      },
    ];

    const result = extractProvenance(toolCalls);
    expect(result.adoptionSweep).not.toBeNull();
    expect(result.adoptionSweep).toHaveLength(1);
    const entry = result.adoptionSweep?.[0];
    expect(entry?.symbol).toBe(TOOL_SUBMIT_ADOPTION_SWEEP);
    expect(entry?.kind).toBe("mcp-tool");
    expect(entry?.consumersFound).toEqual(["services/reviewer/src/providers.ts:276"]);
    expect(entry?.classification).toBe("Adopted");
    expect(entry?.notes).toBe("Registered in OUTPUT_TOOL_NAMES.");
  });

  test("extracts Missing consumers adoption sweep entry", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_ADOPTION_SWEEP,
        args: {
          symbol: "newMcpTool",
          kind: "mcp-tool",
          consumersFound: [],
          classification: ADOPTION_MISSING_CONSUMERS,
        },
      },
    ];

    const result = extractProvenance(toolCalls);
    expect(result.adoptionSweep).not.toBeNull();
    expect(result.adoptionSweep).toHaveLength(1);
    const entry = result.adoptionSweep?.[0];
    expect(entry?.symbol).toBe("newMcpTool");
    expect(entry?.classification).toBe(ADOPTION_MISSING_CONSUMERS);
    expect(entry?.consumersFound).toEqual([]);
    expect(entry?.notes).toBeUndefined();
  });

  test("extracts multiple adoption sweep entries", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_ADOPTION_SWEEP,
        args: {
          symbol: "toolA",
          kind: "function",
          consumersFound: ["src/a.ts:10"],
          classification: "Adopted",
        },
      },
      {
        name: TOOL_SUBMIT_ADOPTION_SWEEP,
        args: {
          symbol: "toolB",
          kind: "mcp-tool",
          consumersFound: [],
          classification: ADOPTION_MISSING_CONSUMERS,
        },
      },
    ];

    const result = extractProvenance(toolCalls);
    expect(result.adoptionSweep).not.toBeNull();
    expect(result.adoptionSweep).toHaveLength(2);
    expect(result.adoptionSweep?.[0]?.symbol).toBe("toolA");
    expect(result.adoptionSweep?.[1]?.symbol).toBe("toolB");
  });
});

describe("serializeProvenance", () => {
  test("produces valid HTML comment with JSON", () => {
    const provenance: ReviewProvenance = {
      specVerification: [{ criterion: "SC1", status: "Met", evidence: "OK" }],
      docImpact: { kind: DOC_IMPACT_NO_UPDATE, evidence: "Internal" },
      findings: { blocking: 0, nonBlocking: 1 },
      conclusion: { event: "APPROVE", summary: "Good" },
      adoptionSweep: null,
    };

    const result = serializeProvenance(provenance);
    expect(result).toStartWith(PROVENANCE_MARKER_START);
    expect(result).toEndWith(PROVENANCE_MARKER_END);

    const jsonStr = result.slice(
      PROVENANCE_MARKER_START.length,
      result.length - PROVENANCE_MARKER_END.length
    );
    const parsed = JSON.parse(jsonStr);
    expect(parsed.specVerification).toHaveLength(1);
    expect(parsed.conclusion.event).toBe("APPROVE");
  });
});

describe("parseProvenance", () => {
  test("parses provenance from a review body", () => {
    const provenance: ReviewProvenance = {
      specVerification: [{ criterion: "SC1", status: "Met", evidence: "OK" }],
      docImpact: { kind: DOC_IMPACT_NO_UPDATE, evidence: "Internal" },
      findings: { blocking: 0, nonBlocking: 0 },
      conclusion: { event: "APPROVE", summary: "Good" },
      adoptionSweep: null,
    };

    const body = `## Review\n\nSome review text\n\n${serializeProvenance(provenance)}`;
    const result = parseProvenance(body);
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected provenance");
    expect(result.specVerification).toHaveLength(1);
    expect(result.docImpact?.kind).toBe(DOC_IMPACT_NO_UPDATE);
    expect(result.conclusion?.event).toBe("APPROVE");
  });

  test("returns null for body without provenance", () => {
    const result = parseProvenance("## Review\n\nJust text");
    expect(result).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    const result = parseProvenance(
      `${PROVENANCE_MARKER_START}{broken json${PROVENANCE_MARKER_END}`
    );
    expect(result).toBeNull();
  });

  test("returns null for incomplete marker", () => {
    const result = parseProvenance(`${PROVENANCE_MARKER_START}{"valid": true}`);
    expect(result).toBeNull();
  });

  test("returns null for invalid schema (missing required fields)", () => {
    const result = parseProvenance(
      `${PROVENANCE_MARKER_START}{"specVerification": "not-an-array"}${PROVENANCE_MARKER_END}`
    );
    expect(result).toBeNull();
  });

  test("roundtrips correctly with null adoptionSweep (legacy)", () => {
    const original: ReviewProvenance = {
      specVerification: [
        { criterion: "SC1: test", status: "Met", evidence: "Found" },
        { criterion: "SC2: other", status: "N/A", evidence: "Not applicable" },
      ],
      docImpact: {
        kind: "updated-in-pr",
        evidence: "Updated docs",
        affectedDocs: ["docs/a.md", "docs/b.md"],
      },
      findings: { blocking: 1, nonBlocking: 3 },
      conclusion: { event: "REQUEST_CHANGES", summary: "One blocker" },
      adoptionSweep: null,
    };

    const serialized = serializeProvenance(original);
    const parsed = parseProvenance(`Header text\n\n${serialized}`);
    expect(parsed).toEqual(original);
  });

  test("roundtrips correctly with adoptionSweep array (mt#2059)", () => {
    const original: ReviewProvenance = {
      specVerification: [{ criterion: "SC1", status: "Met", evidence: "OK" }],
      docImpact: { kind: DOC_IMPACT_NO_UPDATE, evidence: "Internal" },
      findings: { blocking: 0, nonBlocking: 0 },
      conclusion: { event: "APPROVE", summary: "Good" },
      adoptionSweep: [
        {
          symbol: "newMcpTool",
          kind: "mcp-tool",
          consumersFound: ["src/adapters/mcp/tools.ts:99"],
          classification: "Adopted",
          notes: "Wired in tools registry.",
        },
        {
          symbol: "missingExport",
          kind: "function",
          consumersFound: [],
          classification: ADOPTION_MISSING_CONSUMERS,
        },
      ],
    };

    const serialized = serializeProvenance(original);
    const parsed = parseProvenance(`Header text\n\n${serialized}`);
    expect(parsed).toEqual(original);
    expect(parsed?.adoptionSweep).toHaveLength(2);
    expect(parsed?.adoptionSweep?.[0]?.symbol).toBe("newMcpTool");
    expect(parsed?.adoptionSweep?.[1]?.classification).toBe(ADOPTION_MISSING_CONSUMERS);
  });
});
