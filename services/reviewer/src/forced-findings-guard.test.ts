/**
 * Tests for the mt#2926 post-loop forced-findings pass decision function.
 *
 * The predicate is the whole safety story for this pass: it decides when the
 * service spends an extra model call, and — because the pass pins
 * `tool_choice` to `submit_finding` — when the model is COMPELLED to file a
 * finding. So the negative cases below are load-bearing in a way the positive
 * one is not: a false positive here manufactures a finding on a review that
 * had nothing to report.
 */

import { describe, test, expect } from "bun:test";
import {
  evaluateForcedFindingsPass,
  buildForcedFindingsUserMessage,
} from "./forced-findings-guard";
import { MAX_SYNTHESIZED_SUMMARY_CHARS } from "./empty-findings-recovery";
import type { ReviewToolCall } from "./output-tools";

/** Skip reason asserted by more than one case — named once, per custom/no-magic-string-duplication. */
const SKIP_NOT_REQUEST_CHANGES = "not-request-changes";

function conclude(
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  summary: string
): ReviewToolCall {
  return { name: "conclude_review", args: { event, summary } };
}

function finding(severity: "BLOCKING" | "NON-BLOCKING" | "PRE-EXISTING"): ReviewToolCall {
  return {
    name: "submit_finding",
    args: {
      severity,
      file: "src/foo.ts",
      line: 42,
      summary: "Missing null check",
      details: "The variable may be null here.",
    },
  };
}

const specVerifications: ReviewToolCall = {
  name: "submit_spec_verification",
  args: { criterion: "SC1 — does the thing", status: "Met", evidence: "src/foo.ts:1-10" },
};

const docImpact: ReviewToolCall = {
  name: "submit_documentation_impact",
  args: { kind: "blocking-needs-update", evidence: "docs/foo.md is now false" },
};

describe("evaluateForcedFindingsPass", () => {
  test("runs on the shape the 2026-09-04 incident produced: spec verifications + doc impact + REQUEST_CHANGES, zero findings", () => {
    // The exact accumulated state of review 5116536812 on PR #3623: the main
    // loop emitted only spec verifications, the forced doc-impact pass added
    // its verdict, and the forced conclude pass supplied REQUEST_CHANGES.
    const result = evaluateForcedFindingsPass({
      accumulatedToolCalls: [
        specVerifications,
        docImpact,
        conclude("REQUEST_CHANGES", "Request changes. Two risks should be resolved before merge."),
      ],
    });

    expect(result.decision).toBe("run");
    if (result.decision !== "run") throw new Error("unreachable");
    expect(result.conclusionSummary).toBe(
      "Request changes. Two risks should be resolved before merge."
    );
  });

  test("runs on the bound-exhausted shape too — conclude_review present with no forced pass involved", () => {
    // Residual path 2: the in-loop guard rejected twice, then accepted. The
    // accumulated state is indistinguishable from path 1's, which is exactly
    // why the predicate reads final state rather than the gate branch.
    const result = evaluateForcedFindingsPass({
      accumulatedToolCalls: [conclude("REQUEST_CHANGES", "Blocking issues found.")],
    });

    expect(result.decision).toBe("run");
  });

  test("skips when a BLOCKING finding is already present", () => {
    const result = evaluateForcedFindingsPass({
      accumulatedToolCalls: [finding("BLOCKING"), conclude("REQUEST_CHANGES", "Found issues.")],
    });

    expect(result).toEqual({ decision: "skip", reason: "blocking-finding-present" });
  });

  test("skips on APPROVE with zero findings — a clean review is a legitimate shape, not an incoherence", () => {
    const result = evaluateForcedFindingsPass({
      accumulatedToolCalls: [conclude("APPROVE", "Nothing to flag.")],
    });

    expect(result).toEqual({ decision: "skip", reason: SKIP_NOT_REQUEST_CHANGES });
  });

  test("skips on COMMENT with zero findings", () => {
    const result = evaluateForcedFindingsPass({
      accumulatedToolCalls: [conclude("COMMENT", "A couple of observations.")],
    });

    expect(result).toEqual({ decision: "skip", reason: SKIP_NOT_REQUEST_CHANGES });
  });

  test("skips when no conclude_review was emitted at all", () => {
    // The forced conclude pass failed or was disabled. mt#1413's
    // composition-side severity-derived recovery owns this case; forcing a
    // finding here would file one against a review with no verdict.
    const result = evaluateForcedFindingsPass({
      accumulatedToolCalls: [specVerifications, docImpact],
    });

    expect(result).toEqual({ decision: "skip", reason: "no-conclude-review" });
  });

  test("skips on an empty accumulated set", () => {
    const result = evaluateForcedFindingsPass({ accumulatedToolCalls: [] });

    expect(result).toEqual({ decision: "skip", reason: "no-conclude-review" });
  });

  test("NON-BLOCKING and PRE-EXISTING findings do not satisfy the check", () => {
    // Matching conclude-review-guard.ts and empty-findings-recovery.ts: a
    // REQUEST_CHANGES verdict is justified by BLOCKING evidence specifically.
    const result = evaluateForcedFindingsPass({
      accumulatedToolCalls: [
        finding("NON-BLOCKING"),
        finding("PRE-EXISTING"),
        conclude("REQUEST_CHANGES", "Found issues."),
      ],
    });

    expect(result.decision).toBe("run");
  });

  test("uses the LAST conclude_review, matching composeReviewBody's self-correction rule", () => {
    // Model self-correction: an earlier REQUEST_CHANGES superseded by APPROVE
    // must not trigger the pass, or the service would force a finding onto a
    // review the model deliberately cleared.
    const superseded = evaluateForcedFindingsPass({
      accumulatedToolCalls: [
        conclude("REQUEST_CHANGES", "Found issues."),
        conclude("APPROVE", "On reflection, nothing blocking."),
      ],
    });
    expect(superseded).toEqual({ decision: "skip", reason: SKIP_NOT_REQUEST_CHANGES });

    // And the reverse direction: the last call wins there too.
    const escalated = evaluateForcedFindingsPass({
      accumulatedToolCalls: [
        conclude("APPROVE", "Looks fine."),
        conclude("REQUEST_CHANGES", "Actually, this is broken."),
      ],
    });
    expect(escalated.decision).toBe("run");
    if (escalated.decision !== "run") throw new Error("unreachable");
    expect(escalated.conclusionSummary).toBe("Actually, this is broken.");
  });

  test("a finding appended AFTER the conclusion still counts — order-independence", () => {
    // The pass appends its findings after conclude_review in the accumulated
    // array, so a second evaluation of the same review (defensive, or a
    // future caller) must see them and not fire again.
    const result = evaluateForcedFindingsPass({
      accumulatedToolCalls: [conclude("REQUEST_CHANGES", "Found issues."), finding("BLOCKING")],
    });

    expect(result).toEqual({ decision: "skip", reason: "blocking-finding-present" });
  });
});

describe("buildForcedFindingsUserMessage", () => {
  test("names the tool, the required args, and the no-file-reads constraint", () => {
    const msg = buildForcedFindingsUserMessage("Two risks should be resolved before merge.");

    expect(msg).toContain("submit_finding");
    expect(msg).toContain("BLOCKING");
    expect(msg).toContain("severity");
    expect(msg).toContain("file");
    expect(msg).toContain("line");
    expect(msg).toContain("details");
    // The pinned tool_choice makes read_file unreachable on this call, so the
    // message must say so — otherwise the model can assert a location it
    // never checked, which is the mt#3527 failure shape on the doc-impact
    // forced pass.
    expect(msg).toContain("cannot read files on this call");
    expect(msg).toContain("do NOT invent a location");
  });

  test("carries the conclusion summary verbatim", () => {
    const summary = "Init's merge fallback on unreadable config proceeds to overwrite.";
    expect(buildForcedFindingsUserMessage(summary)).toContain(summary);
  });

  test("bounds an oversized summary at the same cap the mt#2685 synthesis uses", () => {
    // Reused rather than re-declared so the two paths that embed this same
    // unbounded model output cannot drift to different budgets.
    const oversized = "x".repeat(MAX_SYNTHESIZED_SUMMARY_CHARS + 500);
    const msg = buildForcedFindingsUserMessage(oversized);

    expect(msg).toContain("truncated — original summary was");
    expect(msg).not.toContain(oversized);
  });
});
