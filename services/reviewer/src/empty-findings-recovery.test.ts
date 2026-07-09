/**
 * Unit tests for the empty-findings coherence recovery pass (mt#2685).
 *
 * Pure function tests: no I/O, no async, inline literal inputs modeled on
 * the two originally-observed incidents (PR #1832 review 4650962079, PR
 * #1837 review 4651474893) and the two later fixtures (PR #1850 review
 * 4657981679, PR #1858 review 4658038353).
 */

import { describe, expect, test } from "bun:test";
import { applyEmptyFindingsRecovery, SYNTHESIZED_FINDING_FILE } from "./empty-findings-recovery";
import type { ReviewToolCall } from "./output-tools";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function finding(
  severity: "BLOCKING" | "NON-BLOCKING" | "PRE-EXISTING",
  file: string,
  line: number
): ReviewToolCall {
  return {
    name: "submit_finding",
    args: { severity, file, line, summary: "test finding", details: "test details" },
  };
}

function conclude(
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  summary: string
): ReviewToolCall {
  return { name: "conclude_review", args: { event, summary } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyEmptyFindingsRecovery (mt#2685)", () => {
  test("fires: REQUEST_CHANGES conclusion with zero submit_finding calls", () => {
    const toolCalls: ReviewToolCall[] = [
      conclude(
        "REQUEST_CHANGES",
        "This PR lacks an end-to-end test asserting that config.doctor emits the new " +
          "diagnostic, and is missing observability when the immediate boot sweep runs " +
          "under degraded boot."
      ),
    ];

    const result = applyEmptyFindingsRecovery(toolCalls);

    expect(result.applied).toBe(true);
    expect(result.synthesizedFinding).toBeDefined();
    expect(result.synthesizedFinding?.severity).toBe("BLOCKING");
    expect(result.synthesizedFinding?.file).toBe(SYNTHESIZED_FINDING_FILE);
    expect(result.synthesizedFinding?.details).toContain("config.doctor");
    // The returned toolCalls array carries the synthesized finding appended.
    expect(result.toolCalls).toHaveLength(2);
    const blockingCount = result.toolCalls.filter(
      (tc) => tc.name === "submit_finding" && tc.args.severity === "BLOCKING"
    ).length;
    expect(blockingCount).toBe(1);
  });

  test("second incident fixture: PR #1837 shape (inline comments present, no submit_finding)", () => {
    const toolCalls: ReviewToolCall[] = [
      { name: "submit_inline_comment", args: { file: "src/foo.ts", line: 10, body: "nit" } },
      conclude(
        "REQUEST_CHANGES",
        "Silently ignoring `description` in existing-task mode, and broadening the " +
          "PreToolUse matcher increases denial risk."
      ),
    ];

    const result = applyEmptyFindingsRecovery(toolCalls);

    expect(result.applied).toBe(true);
    expect(result.synthesizedFinding?.severity).toBe("BLOCKING");
    // Inline comments are untouched — only a submit_finding is appended.
    expect(result.toolCalls).toHaveLength(3);
  });

  test("no-op: REQUEST_CHANGES with a real BLOCKING finding already present", () => {
    const toolCalls: ReviewToolCall[] = [
      finding("BLOCKING", "src/foo.ts", 5),
      conclude("REQUEST_CHANGES", "Real blocking issue in src/foo.ts"),
    ];

    const result = applyEmptyFindingsRecovery(toolCalls);

    expect(result.applied).toBe(false);
    expect(result.synthesizedFinding).toBeUndefined();
    // Same reference back — no new array allocated when not applied.
    expect(result.toolCalls).toBe(toolCalls);
  });

  test("fires: REQUEST_CHANGES with findings present but none of them BLOCKING", () => {
    // Findings ARE present (channel not entirely empty), but zero are
    // BLOCKING. This pass keys on the coherence invariant "REQUEST_CHANGES
    // implies blockingCount > 0" (the converse of mt#2655's
    // reconcileEventWithBlockingCount, which enforces "blockingCount > 0
    // implies REQUEST_CHANGES") rather than on "zero findings total" — the
    // merge gate (mt#2233) reads BLOCKING count, so a REQUEST_CHANGES review
    // whose only findings are NON-BLOCKING is exactly as incoherent from the
    // merge gate's perspective as one with no findings at all.
    const toolCalls: ReviewToolCall[] = [
      finding("NON-BLOCKING", "src/foo.ts", 5),
      conclude("REQUEST_CHANGES", "Some minor issue"),
    ];

    const result = applyEmptyFindingsRecovery(toolCalls);
    expect(result.applied).toBe(true);
  });

  test("no-op: no conclude_review call at all", () => {
    const toolCalls: ReviewToolCall[] = [finding("NON-BLOCKING", "src/foo.ts", 5)];
    const result = applyEmptyFindingsRecovery(toolCalls);
    expect(result.applied).toBe(false);
    expect(result.toolCalls).toBe(toolCalls);
  });

  test("no-op: conclude_review event is APPROVE", () => {
    const toolCalls: ReviewToolCall[] = [conclude("APPROVE", "Looks good")];
    const result = applyEmptyFindingsRecovery(toolCalls);
    expect(result.applied).toBe(false);
  });

  test("no-op: conclude_review event is COMMENT", () => {
    const toolCalls: ReviewToolCall[] = [conclude("COMMENT", "Just observations")];
    const result = applyEmptyFindingsRecovery(toolCalls);
    expect(result.applied).toBe(false);
  });

  test("uses the LAST conclude_review call (model self-correction), matching composeReviewBody", () => {
    const toolCalls: ReviewToolCall[] = [
      conclude("REQUEST_CHANGES", "first draft — will revise"),
      conclude("APPROVE", "actually this is fine"),
    ];
    const result = applyEmptyFindingsRecovery(toolCalls);
    expect(result.applied).toBe(false);
  });

  test("empty toolCalls array: no-op", () => {
    const result = applyEmptyFindingsRecovery([]);
    expect(result.applied).toBe(false);
    expect(result.toolCalls).toHaveLength(0);
  });
});
