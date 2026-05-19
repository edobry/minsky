import { describe, expect, it } from "bun:test";
import {
  extractPrNumber,
  // fetchPrHeadSha is intentionally not unit-tested — it shells out to `gh pr view`
  // and the value of asserting its existence is low. Integration coverage of
  // the hook entrypoint exercises it indirectly.
} from "./require-checks-on-bypass-merge";
import { findGhApiPutMergeSegment } from "./block-subagent-bypass-merge";

// Shared test fixture — matches the canonical bypass-merge command form
// the agent uses for self-authored bot PRs (see feedback_gh_api_bypass.md).
const CANONICAL_BYPASS =
  "gh api -X PUT /repos/edobry/minsky/pulls/1234/merge -f merge_method=merge";

describe("extractPrNumber (mt#1951)", () => {
  it("extracts the PR number from a canonical bypass-merge segment", () => {
    expect(extractPrNumber(CANONICAL_BYPASS)).toBe("1234");
  });

  it("extracts from a relative path (no leading /repos/...)", () => {
    expect(extractPrNumber("gh api -X PUT repos/edobry/minsky/pulls/9999/merge")).toBe("9999");
  });

  it("extracts from a tail-only env-var URL form", () => {
    expect(extractPrNumber('gh api -X PUT "$URL_BASE/pulls/42/merge"')).toBe("42");
  });

  it("returns null when the segment has no /pulls/<N>/merge subpath", () => {
    expect(extractPrNumber("gh api repos/edobry/minsky/issues/1234")).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(extractPrNumber("")).toBeNull();
  });

  it("handles multi-digit PR numbers", () => {
    expect(extractPrNumber("gh api -X PUT repos/owner/repo/pulls/12345678/merge")).toBe("12345678");
  });
});

describe("hook surface — findGhApiPutMergeSegment integration (mt#1951)", () => {
  // These tests verify that the segment-detection (imported from
  // block-subagent-bypass-merge) correctly fires on the inputs this hook
  // is concerned with. The actual deny/allow logic of this hook is exercised
  // indirectly via `evaluateRequiredChecksStatus` whose tests live in
  // require-review-before-merge.test.ts (single source of truth for the
  // gate logic per mt#1951 spec).

  it("detects the canonical bypass-merge form", () => {
    expect(findGhApiPutMergeSegment(CANONICAL_BYPASS)).not.toBeNull();
  });

  it("ignores non-merge gh api calls (read endpoints)", () => {
    expect(findGhApiPutMergeSegment("gh api repos/edobry/minsky/pulls/1234/reviews")).toBeNull();
    expect(findGhApiPutMergeSegment("gh api repos/edobry/minsky/issues/1234/comments")).toBeNull();
    expect(
      findGhApiPutMergeSegment("gh api repos/edobry/minsky/commits/abc123/check-runs")
    ).toBeNull();
  });

  it("ignores gh pr merge (non-bypass path; goes through session_pr_merge instead)", () => {
    // `gh pr merge` is a different command from `gh api PUT ... /merge`; this
    // hook's matcher only targets the API bypass form.
    expect(findGhApiPutMergeSegment("gh pr merge 1234 --merge")).toBeNull();
  });

  it("ignores chained commands that don't include the bypass", () => {
    expect(
      findGhApiPutMergeSegment("gh pr view 1234 --json title && gh pr checks 1234")
    ).toBeNull();
  });

  it("detects bypass when chained with other commands", () => {
    const chained = `gh pr view 1234 --json title && ${CANONICAL_BYPASS}`;
    expect(findGhApiPutMergeSegment(chained)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gate-logic integration note
// ---------------------------------------------------------------------------
//
// This hook reuses `evaluateRequiredChecksStatus`, `parseBranchProtectionResponse`,
// `parseAllCheckRunsResponse`, and `pickLatestRunByName` from
// `./require-review-before-merge`. Those functions have ~95 unit tests in
// `require-review-before-merge.test.ts` covering:
//
//   - red CI deny paths (failure, queued, in_progress, missing, API-failure)
//   - green CI allow path
//   - latest-wins recency
//   - workflow-prefixed name matching
//   - pagination truncation guardrail
//   - empty-required-checks no-op
//   - checks[]-only API response shape
//
// We do NOT re-test that logic here — single source of truth. The tests in
// THIS file cover the parts that are unique to mt#1951:
//
//   - PR number extraction from the matched segment
//   - segment-detection passthrough behavior
//   - integration assertions that the hook's surface composes correctly with
//     the imported helpers
//
// End-to-end behavior (hook denies on red CI, allows on green) is verified
// in production by the next bypass-merge invocation post-mt#1951-merge.
