/**
 * Tests for compose-review.ts
 *
 * Covers all 9 acceptance criteria from the task spec:
 *   1. Three findings (BLOCKING + NON-BLOCKING + PRE-EXISTING) + conclude APPROVE
 *   2. Two findings + inline_comment + spec_verification + conclude REQUEST_CHANGES
 *   3. No conclude_review → prepend warning, event COMMENT
 *   4. Empty toolCalls → "no findings" message, event COMMENT
 *   5. Multi-line range finding (lineEnd set)
 *   6. Severity ordering: stable sort
 *   7. Multiple conclude_review calls → use LAST one
 *   8. Pipe escaping in spec-verification table cells
 *   9. side: LEFT annotated; default RIGHT not annotated
 */

import { describe, test, expect } from "bun:test";
import { composeReviewBody } from "./compose-review";
import type { ReviewToolCall } from "./output-tools";

// Tool name constants — prevents magic-string-duplication lint warnings.
const TOOL_SUBMIT_FINDING = "submit_finding";
const TOOL_SUBMIT_INLINE_COMMENT = "submit_inline_comment";
const TOOL_SUBMIT_SPEC_VERIFICATION = "submit_spec_verification";
const TOOL_SUBMIT_DOCUMENTATION_IMPACT = "submit_documentation_impact";
const TOOL_CONCLUDE_REVIEW = "conclude_review";
const TOOL_SUBMIT_THREAD_RESOLVE = "submit_thread_resolve";

// Section heading constants — the merge gate text-matches these in the rendered
// body, so the literal strings are part of the contract.
const SECTION_DOCUMENTATION_IMPACT = "## Documentation impact";

// ---------------------------------------------------------------------------
// Test 1: Three findings + conclude APPROVE → body has summary, ordered
//         findings (BLOCKING, NON-BLOCKING, PRE-EXISTING), event APPROVE
// ---------------------------------------------------------------------------
describe("composeReviewBody", () => {
  test("1: three findings with different severities + conclude APPROVE", () => {
    const approvalSummary = "Overall the PR looks good.";
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "NON-BLOCKING",
          file: "src/foo.ts",
          line: 10,
          summary: "nit finding",
          details: "minor nit details",
        },
      },
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "PRE-EXISTING",
          file: "src/bar.ts",
          line: 20,
          summary: "pre-existing finding",
          details: "pre-existing details",
        },
      },
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "BLOCKING",
          file: "src/baz.ts",
          line: 30,
          summary: "blocking finding",
          details: "blocking details",
        },
      },
      {
        name: TOOL_CONCLUDE_REVIEW,
        args: {
          event: "APPROVE",
          summary: approvalSummary,
        },
      },
    ];

    const result = composeReviewBody(toolCalls);

    expect(result.event).toBe("APPROVE");
    expect(result.body).toContain(approvalSummary);
    expect(result.body).toContain("## Findings");

    // Check severity order in the output: BLOCKING must appear before NON-BLOCKING,
    // which must appear before PRE-EXISTING
    const blockingPos = result.body.indexOf("[BLOCKING]");
    const nonBlockingPos = result.body.indexOf("[NON-BLOCKING]");
    const preExistingPos = result.body.indexOf("[PRE-EXISTING]");

    expect(blockingPos).toBeLessThan(nonBlockingPos);
    expect(nonBlockingPos).toBeLessThan(preExistingPos);

    // Summary is the opening content
    const summaryPos = result.body.indexOf(approvalSummary);
    expect(summaryPos).toBeLessThan(blockingPos);
  });

  // -------------------------------------------------------------------------
  // Test 2: Two findings + inline_comment + spec_verification + REQUEST_CHANGES
  // -------------------------------------------------------------------------
  test("2: two findings + inline comment + spec verification + REQUEST_CHANGES", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "BLOCKING",
          file: "src/a.ts",
          line: 5,
          summary: "null pointer dereference",
          details: "The variable is not checked before use.",
        },
      },
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "NON-BLOCKING",
          file: "src/b.ts",
          line: 15,
          summary: "missing semicolon",
          details: "Style nit.",
        },
      },
      {
        name: TOOL_SUBMIT_INLINE_COMMENT,
        args: {
          file: "src/c.ts",
          line: 42,
          body: "Consider using a more descriptive variable name here.",
        },
      },
      {
        name: TOOL_SUBMIT_SPEC_VERIFICATION,
        args: {
          criterion: "Exports composeReviewBody",
          status: "Met",
          evidence: "src/compose-review.ts line 1",
        },
      },
      {
        name: TOOL_CONCLUDE_REVIEW,
        args: {
          event: "REQUEST_CHANGES",
          summary: "There is a blocking null pointer issue that must be fixed.",
        },
      },
    ];

    const result = composeReviewBody(toolCalls);

    expect(result.event).toBe("REQUEST_CHANGES");
    expect(result.body).toContain("## Findings");
    expect(result.body).toContain("## Inline comments");
    expect(result.body).toContain("## Spec verification");

    // Inline comment section
    expect(result.body).toContain("src/c.ts:42 — Consider using");

    // Spec verification table
    expect(result.body).toContain("| Criterion | Status | Evidence |");
    expect(result.body).toContain("Exports composeReviewBody");
    expect(result.body).toContain("Met");
    expect(result.body).toContain("src/compose-review.ts line 1");
  });

  // -------------------------------------------------------------------------
  // Test 3: No conclude_review → warning prepended, event derived from severity
  // (BLOCKING present → REQUEST_CHANGES)
  // -------------------------------------------------------------------------
  test("3: no conclude_review with BLOCKING finding → event REQUEST_CHANGES, warning with severity counts", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "BLOCKING",
          file: "src/x.ts",
          line: 1,
          summary: "some issue",
          details: "details here",
        },
      },
    ];

    const result = composeReviewBody(toolCalls);

    expect(result.event).toBe("REQUEST_CHANGES");
    expect(result.body).toContain("⚠️ **Reviewer did not emit a `conclude_review` call.**");
    expect(result.body).toContain("Event derived from severity counts: REQUEST_CHANGES");
    expect(result.body).toContain("1 BLOCKING");
    expect(result.body).toContain("0 NON-BLOCKING");
    expect(result.body).toContain("0 PRE-EXISTING");
    expect(result.body).toContain("Executive summary unavailable");

    // Warning should be at the start of the body
    const warningPos = result.body.indexOf("⚠️");
    const findingPos = result.body.indexOf("## Findings");
    expect(warningPos).toBeLessThan(findingPos);
  });

  // -------------------------------------------------------------------------
  // Test 3b: No conclude_review with only NON-BLOCKING findings → COMMENT
  // -------------------------------------------------------------------------
  test("3b: no conclude_review with only NON-BLOCKING findings → event COMMENT, warning with counts", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "NON-BLOCKING",
          file: "src/a.ts",
          line: 1,
          summary: "nit 1",
          details: "nit details",
        },
      },
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "NON-BLOCKING",
          file: "src/b.ts",
          line: 2,
          summary: "nit 2",
          details: "nit details 2",
        },
      },
    ];

    const result = composeReviewBody(toolCalls);

    expect(result.event).toBe("COMMENT");
    expect(result.body).toContain("⚠️ **Reviewer did not emit a `conclude_review` call.**");
    expect(result.body).toContain("Event derived from severity counts: COMMENT");
    expect(result.body).toContain("0 BLOCKING");
    expect(result.body).toContain("2 NON-BLOCKING");
    expect(result.body).toContain("Executive summary unavailable");
  });

  // -------------------------------------------------------------------------
  // Test 4: Empty toolCalls → "no findings" message, event COMMENT
  // -------------------------------------------------------------------------
  test("4: empty toolCalls → no-findings message, event COMMENT", () => {
    const result = composeReviewBody([]);

    expect(result.event).toBe("COMMENT");
    expect(result.body).toContain("The reviewer ran but produced no findings.");
    expect(result.body).toContain("This is not an approval");
    expect(result.body).not.toContain("## Findings");
    expect(result.body).not.toContain("## Inline comments");
  });

  // -------------------------------------------------------------------------
  // Test 5: Multi-line range finding (lineEnd set) → renders file:line-lineEnd
  // -------------------------------------------------------------------------
  test("5: multi-line range finding renders file:line-lineEnd", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "BLOCKING",
          file: "src/range.ts",
          line: 10,
          lineEnd: 20,
          summary: "long block",
          details: "This block should be refactored.",
        },
      },
      {
        name: TOOL_CONCLUDE_REVIEW,
        args: {
          event: "REQUEST_CHANGES",
          summary: "Refactoring needed.",
        },
      },
    ];

    const result = composeReviewBody(toolCalls);

    expect(result.body).toContain("src/range.ts:10-20");
  });

  // -------------------------------------------------------------------------
  // Test 6: Severity ordering — emit order BLOCKING→PRE-EXISTING→NON-BLOCKING→BLOCKING
  //         output order: BLOCKING, BLOCKING, NON-BLOCKING, PRE-EXISTING (stable)
  // -------------------------------------------------------------------------
  test("6: severity ordering — stable sort within severity buckets", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "BLOCKING",
          file: "a.ts",
          line: 1,
          summary: "first blocking",
          details: "first blocking details",
        },
      },
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "PRE-EXISTING",
          file: "b.ts",
          line: 2,
          summary: "pre-existing",
          details: "pre-existing details",
        },
      },
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "NON-BLOCKING",
          file: "c.ts",
          line: 3,
          summary: "non-blocking",
          details: "non-blocking details",
        },
      },
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "BLOCKING",
          file: "d.ts",
          line: 4,
          summary: "second blocking",
          details: "second blocking details",
        },
      },
      {
        name: TOOL_CONCLUDE_REVIEW,
        args: {
          event: "REQUEST_CHANGES",
          summary: "Multiple issues found.",
        },
      },
    ];

    const result = composeReviewBody(toolCalls);

    // Find the positions of each finding in the output
    const firstBlockingPos = result.body.indexOf("first blocking");
    const secondBlockingPos = result.body.indexOf("second blocking");
    const nonBlockingPos = result.body.indexOf("non-blocking");
    const preExistingPos = result.body.indexOf("pre-existing");

    // BLOCKING entries appear first (both before NON-BLOCKING and PRE-EXISTING)
    expect(firstBlockingPos).toBeLessThan(nonBlockingPos);
    expect(firstBlockingPos).toBeLessThan(preExistingPos);
    expect(secondBlockingPos).toBeLessThan(nonBlockingPos);
    expect(secondBlockingPos).toBeLessThan(preExistingPos);

    // Within BLOCKING bucket, original emit order is preserved (first before second)
    expect(firstBlockingPos).toBeLessThan(secondBlockingPos);

    // NON-BLOCKING appears before PRE-EXISTING
    expect(nonBlockingPos).toBeLessThan(preExistingPos);
  });

  // -------------------------------------------------------------------------
  // Test 7: Multiple conclude_review calls → uses the LAST one
  // -------------------------------------------------------------------------
  test("7: multiple conclude_review calls → uses last one", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_CONCLUDE_REVIEW,
        args: {
          event: "APPROVE",
          summary: "First summary — should be overridden.",
        },
      },
      {
        name: TOOL_CONCLUDE_REVIEW,
        args: {
          event: "REQUEST_CHANGES",
          summary: "Second summary — this is the final verdict.",
        },
      },
    ];

    const result = composeReviewBody(toolCalls);

    expect(result.event).toBe("REQUEST_CHANGES");
    expect(result.body).toContain("Second summary — this is the final verdict.");
    expect(result.body).not.toContain("First summary — should be overridden.");
  });

  // -------------------------------------------------------------------------
  // Test 8: Pipe escaping in spec-verification table cells
  // -------------------------------------------------------------------------
  test("8: pipe characters in spec-verification cells are escaped", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_SPEC_VERIFICATION,
        args: {
          criterion: "Handle A | B | C cases",
          status: "Met",
          evidence: "src/foo.ts line 10 | src/bar.ts line 20",
        },
      },
      {
        name: TOOL_CONCLUDE_REVIEW,
        args: {
          event: "APPROVE",
          summary: "All criteria met.",
        },
      },
    ];

    const result = composeReviewBody(toolCalls);

    expect(result.body).toContain("Handle A \\| B \\| C cases");
    expect(result.body).toContain("src/foo.ts line 10 \\| src/bar.ts line 20");
    // Raw unescaped pipes in those values should not appear (only the escaped form)
    // We can verify by checking that the table row doesn't have extra columns
    // The table has 3 columns, so we expect exactly 4 pipes per data row
    const tableRows = result.body.split("\n").filter((line) => line.startsWith("| Handle A"));
    expect(tableRows).toHaveLength(1);
    // Count unescaped pipes: a properly-escaped row should have exactly 4
    // (start, after criterion, after status, end)
    const tableRow = tableRows[0];
    if (tableRow === undefined) throw new Error("Expected one table row matching '| Handle A'");
    const unescapedPipeCount = (tableRow.match(/(?<!\\)\|/g) ?? []).length;
    expect(unescapedPipeCount).toBe(4);
  });

  // -------------------------------------------------------------------------
  // Test 3c: Empty toolCalls → still returns no-findings body and COMMENT
  //           (regression: severity-derived path must NOT fire on empty input)
  // -------------------------------------------------------------------------
  test("3c: empty toolCalls → no-findings body, event COMMENT (regression check)", () => {
    const result = composeReviewBody([]);

    expect(result.event).toBe("COMMENT");
    expect(result.body).toContain("The reviewer ran but produced no findings.");
    // Must NOT contain the severity-derived warning (empty fast-path only)
    expect(result.body).not.toContain("Event derived from severity counts");
    expect(result.body).not.toContain("## Findings");
  });

  // -------------------------------------------------------------------------
  // Test 3d: conclude_review present → derived path NOT taken; event from conclude_review
  // -------------------------------------------------------------------------
  test("3d: conclude_review present with BLOCKING findings → derived path not taken, conclude_review.event wins", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "BLOCKING",
          file: "src/y.ts",
          line: 5,
          summary: "a blocking issue",
          details: "blocking details",
        },
      },
      {
        name: TOOL_CONCLUDE_REVIEW,
        args: {
          event: "APPROVE",
          summary: "Reviewer explicitly approved despite findings.",
        },
      },
    ];

    const result = composeReviewBody(toolCalls);

    // conclude_review.event must win, NOT the derived REQUEST_CHANGES
    expect(result.event).toBe("APPROVE");
    expect(result.body).toContain("Reviewer explicitly approved despite findings.");
    // Must NOT contain the severity-derived warning
    expect(result.body).not.toContain("Event derived from severity counts");
    expect(result.body).not.toContain("⚠️ **Reviewer did not emit");
  });

  // -------------------------------------------------------------------------
  // Test 10: submit_thread_resolve calls → collected in threadResolves, NOT in body
  // -------------------------------------------------------------------------
  test("10: submit_thread_resolve tool calls are collected in threadResolves, not rendered in body", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_THREAD_RESOLVE,
        args: { threadId: "PRRT_kwABCD", reason: "fix verified — see commit abc123" },
      },
      {
        name: TOOL_SUBMIT_THREAD_RESOLVE,
        args: { threadId: "PRRT_kwEFGH", reason: "outdated — function was deleted" },
      },
      {
        name: TOOL_CONCLUDE_REVIEW,
        args: { event: "APPROVE", summary: "All prior findings resolved." },
      },
    ];

    const result = composeReviewBody(toolCalls);

    expect(result.threadResolves).toHaveLength(2);
    expect(result.threadResolves[0]).toEqual({
      threadId: "PRRT_kwABCD",
      reason: "fix verified — see commit abc123",
    });
    expect(result.threadResolves[1]).toEqual({
      threadId: "PRRT_kwEFGH",
      reason: "outdated — function was deleted",
    });
    // Thread resolve entries must NOT appear in the review body
    expect(result.body).not.toContain("PRRT_kwABCD");
    expect(result.body).not.toContain("PRRT_kwEFGH");
  });

  // -------------------------------------------------------------------------
  // Test 11: submit_inline_comment with inReplyTo → preserved in inlineComments
  // -------------------------------------------------------------------------
  test("11: inReplyTo on submit_inline_comment is preserved in composed inlineComments", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_INLINE_COMMENT,
        args: { file: "src/foo.ts", line: 5, body: "still applies", inReplyTo: 98765 },
      },
      {
        name: TOOL_SUBMIT_INLINE_COMMENT,
        args: { file: "src/bar.ts", line: 10, body: "new observation" },
      },
      {
        name: TOOL_CONCLUDE_REVIEW,
        args: { event: "COMMENT", summary: "Incremental review." },
      },
    ];

    const result = composeReviewBody(toolCalls);

    expect(result.inlineComments).toHaveLength(2);
    expect(result.inlineComments[0]).toEqual({
      file: "src/foo.ts",
      line: 5,
      body: "still applies",
      inReplyTo: 98765,
    });
    expect(result.inlineComments[1]).toEqual({
      file: "src/bar.ts",
      line: 10,
      body: "new observation",
    });
    // The inReplyTo field must NOT appear in the body text
    expect("inReplyTo" in (result.inlineComments[1] ?? {})).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 12: empty toolCalls → threadResolves and inlineComments are empty arrays
  // -------------------------------------------------------------------------
  test("12: empty toolCalls → threadResolves and inlineComments are empty arrays", () => {
    const result = composeReviewBody([]);

    expect(result.threadResolves).toEqual([]);
    expect(result.inlineComments).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 9: side: LEFT annotated; default RIGHT (or absent) not annotated
  // -------------------------------------------------------------------------
  test("9: side LEFT is annotated, RIGHT (or absent) is not", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "BLOCKING",
          file: "src/left.ts",
          line: 5,
          side: "LEFT",
          summary: "left-side finding",
          details: "On the deleted line.",
        },
      },
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "BLOCKING",
          file: "src/right.ts",
          line: 10,
          side: "RIGHT",
          summary: "right-side finding",
          details: "On the added line.",
        },
      },
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "NON-BLOCKING",
          file: "src/noside.ts",
          line: 15,
          summary: "no-side finding",
          details: "Not diff-position-specific.",
        },
      },
      {
        name: TOOL_CONCLUDE_REVIEW,
        args: {
          event: "REQUEST_CHANGES",
          summary: "Side annotation check.",
        },
      },
    ];

    const result = composeReviewBody(toolCalls);

    // LEFT must be annotated
    expect(result.body).toContain("src/left.ts:5 (LEFT)");

    // RIGHT must NOT be annotated
    expect(result.body).toContain("src/right.ts:10");
    expect(result.body).not.toContain("src/right.ts:10 (RIGHT)");

    // No side must NOT be annotated
    expect(result.body).toContain("src/noside.ts:15");
    expect(result.body).not.toContain("src/noside.ts:15 (");
  });

  // -------------------------------------------------------------------------
  // Test 13: submit_documentation_impact "no-update-needed" → section emitted,
  // affectedDocs omitted from output when not provided
  // -------------------------------------------------------------------------
  test("13: documentation impact no-update-needed renders section without affected docs", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_DOCUMENTATION_IMPACT,
        args: {
          kind: "no-update-needed",
          evidence: "Pure internal refactor — no documented behavior changed.",
        },
      },
      {
        name: TOOL_CONCLUDE_REVIEW,
        args: { event: "APPROVE", summary: "Clean refactor." },
      },
    ];

    const result = composeReviewBody(toolCalls);

    expect(result.body).toContain(SECTION_DOCUMENTATION_IMPACT);
    expect(result.body).toContain("**no-update-needed**");
    expect(result.body).toContain("Pure internal refactor");
    expect(result.body).not.toContain("Affected:");
  });

  // -------------------------------------------------------------------------
  // Test 14: submit_documentation_impact "updated-in-pr" with affectedDocs →
  // affected list rendered alongside kind + evidence
  // -------------------------------------------------------------------------
  test("14: documentation impact updated-in-pr with affectedDocs renders affected list", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_DOCUMENTATION_IMPACT,
        args: {
          kind: "updated-in-pr",
          evidence: "Added a new MINSKY_FOO env var; updated configuration guide.",
          affectedDocs: ["docs/configuration-guide.md", "CLAUDE.md"],
        },
      },
      {
        name: TOOL_CONCLUDE_REVIEW,
        args: { event: "APPROVE", summary: "Code and docs in sync." },
      },
    ];

    const result = composeReviewBody(toolCalls);

    expect(result.body).toContain(SECTION_DOCUMENTATION_IMPACT);
    expect(result.body).toContain("**updated-in-pr**");
    expect(result.body).toContain("Added a new MINSKY_FOO env var");
    expect(result.body).toContain("Affected: docs/configuration-guide.md, CLAUDE.md");
  });

  // -------------------------------------------------------------------------
  // Test 15: submit_documentation_impact "blocking-needs-update" → section
  // emitted; the reviewer is expected to ALSO emit a BLOCKING finding for the
  // same issue (this test verifies the section emission only, not the finding)
  // -------------------------------------------------------------------------
  test("15: documentation impact blocking-needs-update renders section with affected docs", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_DOCUMENTATION_IMPACT,
        args: {
          kind: "blocking-needs-update",
          evidence: "Adds a new MCP tool but does not update docs/architecture.md tool inventory.",
          affectedDocs: ["docs/architecture.md"],
        },
      },
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "BLOCKING",
          file: "docs/architecture.md",
          line: 1,
          summary: "Architecture doc missing new MCP tool",
          details:
            "The new tool registration is not reflected in docs/architecture.md tool inventory. Update before merge.",
        },
      },
      {
        name: TOOL_CONCLUDE_REVIEW,
        args: { event: "REQUEST_CHANGES", summary: "Docs out of sync." },
      },
    ];

    const result = composeReviewBody(toolCalls);

    expect(result.body).toContain(SECTION_DOCUMENTATION_IMPACT);
    expect(result.body).toContain("**blocking-needs-update**");
    expect(result.body).toContain("Affected: docs/architecture.md");
    // The companion BLOCKING finding is rendered in the Findings section
    expect(result.body).toContain("## Findings");
    expect(result.body).toContain("[BLOCKING] docs/architecture.md:1");
  });

  // -------------------------------------------------------------------------
  // Test 16: no submit_documentation_impact call → no Documentation impact
  // section in body (the merge gate will then deny — that's by design until
  // the structural restructure of mt#2055 ships)
  // -------------------------------------------------------------------------
  test("16: absent documentation impact tool call → no section emitted", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_FINDING,
        args: {
          severity: "NON-BLOCKING",
          file: "src/foo.ts",
          line: 1,
          summary: "minor nit",
          details: "trivial nit details",
        },
      },
      {
        name: TOOL_CONCLUDE_REVIEW,
        args: { event: "APPROVE", summary: "Fine." },
      },
    ];

    const result = composeReviewBody(toolCalls);

    expect(result.body).not.toContain(SECTION_DOCUMENTATION_IMPACT);
  });

  // -------------------------------------------------------------------------
  // Test 17: documentation impact section is rendered AFTER spec verification
  // section when both are present (gate-relevant section ordering)
  // -------------------------------------------------------------------------
  test("17: documentation impact follows spec verification in body section order", () => {
    const toolCalls: ReviewToolCall[] = [
      {
        name: TOOL_SUBMIT_SPEC_VERIFICATION,
        args: {
          criterion: "Tool registered",
          status: "Met",
          evidence: "output-tools.ts new entry",
        },
      },
      {
        name: TOOL_SUBMIT_DOCUMENTATION_IMPACT,
        args: {
          kind: "no-update-needed",
          evidence: "Adds an output tool; no end-user doc surface change.",
        },
      },
      {
        name: TOOL_CONCLUDE_REVIEW,
        args: { event: "APPROVE", summary: "Internal tool addition." },
      },
    ];

    const result = composeReviewBody(toolCalls);

    const specIndex = result.body.indexOf("## Spec verification");
    const docIndex = result.body.indexOf(SECTION_DOCUMENTATION_IMPACT);
    expect(specIndex).toBeGreaterThan(-1);
    expect(docIndex).toBeGreaterThan(-1);
    expect(docIndex).toBeGreaterThan(specIndex);
  });
});
