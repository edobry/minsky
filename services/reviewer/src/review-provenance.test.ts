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

describe("extractProvenance", () => {
  test("extracts spec verification entries", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: "submit_spec_verification",
        args: { criterion: "SC1: foo", status: "Met", evidence: "Found in bar.ts" },
      },
      {
        name: "submit_spec_verification",
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
        name: "submit_documentation_impact",
        args: { kind: DOC_IMPACT_NO_UPDATE, evidence: "Internal refactor" },
      },
      {
        name: "submit_documentation_impact",
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
        name: "submit_finding",
        args: {
          severity: "BLOCKING",
          file: "a.ts",
          line: 1,
          summary: "Bug",
          details: "Details",
        },
      },
      {
        name: "submit_finding",
        args: {
          severity: "NON-BLOCKING",
          file: "b.ts",
          line: 2,
          summary: "Nit",
          details: "Details",
        },
      },
      {
        name: "submit_finding",
        args: {
          severity: "BLOCKING",
          file: "c.ts",
          line: 3,
          summary: "Bug2",
          details: "Details",
        },
      },
      {
        name: "submit_finding",
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
        name: "conclude_review",
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

  test("roundtrips correctly", () => {
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
});
