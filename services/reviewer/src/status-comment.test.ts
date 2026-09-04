import { describe, test, expect } from "bun:test";
import {
  buildPendingBody,
  buildInProgressBody,
  buildCompletedBody,
  buildErrorBody,
  buildSkippedBody,
  buildResolvedBody,
} from "./status-comment";
import type { ReviewResult } from "./review-worker";

const MARKER = "<!-- minsky-reviewer-status -->";

/**
 * The text `sanitizeReason` falls back to for any reason its allowlist does not
 * recognise. Named once because several tests assert both its presence (the
 * fallback fired) and its absence (a recognised reason passed through), and the
 * two readings must refer to the same string to mean anything.
 */
const GENERIC_FALLBACK = "an internal error occurred";

describe("status-comment body builders", () => {
  test("buildPendingBody includes marker and pending message", () => {
    const body = buildPendingBody();
    expect(body).toContain(MARKER);
    expect(body).toContain("Review requested — awaiting processing");
    expect(body).toContain("## Minsky Reviewer Status");
  });

  test("buildInProgressBody without chunk info", () => {
    const body = buildInProgressBody();
    expect(body).toContain(MARKER);
    expect(body).toContain("Review in progress...");
  });

  test("buildInProgressBody with chunk info", () => {
    const body = buildInProgressBody({ current: 2, total: 3 });
    expect(body).toContain(MARKER);
    expect(body).toContain("Reviewing chunk 2/3...");
  });

  test("buildCompletedBody with APPROVED verdict (no blocking findings)", () => {
    const result: ReviewResult = {
      status: "reviewed",
      reason: "Posted APPROVE review",
      tier: 3 as never,
      blockingCount: 0,
      review: { id: 123, htmlUrl: "https://github.com/edobry/minsky/pull/1#pullrequestreview-123" },
      providerUsed: "openai",
      providerModel: "gpt-5",
      usage: { promptTokens: 95000, completionTokens: 4000, cachedTokens: 0 },
      scope: "standard" as never,
    };

    const body = buildCompletedBody(result, 47000);
    expect(body).toContain(MARKER);
    expect(body).toContain("APPROVED");
    expect(body).toContain("no blocking findings");
    expect(body).toContain(
      "[View review](https://github.com/edobry/minsky/pull/1#pullrequestreview-123)"
    );
    expect(body).toContain("openai/gpt-5");
    expect(body).toContain("95K prompt");
    expect(body).toContain("4K completion");
    expect(body).toContain("47s");
    expect(body).toContain("`/review`");
  });

  test("buildCompletedBody with CHANGES_REQUESTED verdict", () => {
    const result: ReviewResult = {
      status: "reviewed",
      reason: "Posted CHANGES_REQUESTED review",
      tier: 3 as never,
      blockingCount: 2,
      review: { id: 456, htmlUrl: "https://github.com/edobry/minsky/pull/2#pullrequestreview-456" },
      providerUsed: "openai",
      providerModel: "gpt-5",
    };

    const body = buildCompletedBody(result);
    expect(body).toContain("CHANGES_REQUESTED");
    expect(body).toContain("2 blocking finding(s)");
  });

  test("buildCompletedBody with null blockingCount shows APPROVED", () => {
    const result: ReviewResult = {
      status: "reviewed",
      reason: "Posted APPROVE review",
      tier: 3 as never,
      blockingCount: null,
    };

    const body = buildCompletedBody(result);
    expect(body).toContain("APPROVED");
  });

  test("buildErrorBody with safe reason passes through", () => {
    const body = buildErrorBody("timeout after 120s");
    expect(body).toContain(MARKER);
    expect(body).toContain("Review failed — timeout after 120s");
    expect(body).toContain("`/review`");
  });

  test("buildErrorBody sanitizes unsafe error messages", () => {
    const body = buildErrorBody("ECONNREFUSED 127.0.0.1:5432 password=secret");
    expect(body).toContain(MARKER);
    expect(body).toContain(GENERIC_FALLBACK);
    expect(body).not.toContain("ECONNREFUSED");
    expect(body).not.toContain("secret");
  });

  test("a size refusal names its real reason instead of collapsing (mt#4434)", () => {
    // Before mt#4434 this reason hit the generic fallback, so an operator saw
    // "an internal error occurred. Use `/review` to retry." — advice that
    // cannot work, because the cap is deterministic in the PR's size. Four
    // delivery paths retried PR #3253 and all four failed identically.
    // Reason text matches what github-client.ts throws, actionable part FIRST:
    // sanitizeReason truncates to 200 chars head-first, so advice placed after
    // the diagnostic detail is cut out of the rendered comment. This test
    // caught exactly that on the first draft.
    const body = buildErrorBody(
      "too large to review — split the PR or review it locally; retrying will not help. " +
        "GitHub refused the whole-PR diff for edobry/minsky#3253 and no per-file patches are " +
        "available (0 file entries)."
    );
    expect(body).toContain("too large to review");
    // The actionable sentence must SURVIVE truncation, not merely be present in
    // the input string.
    expect(body).toContain("split the PR or review it locally");
    expect(body).not.toContain(GENERIC_FALLBACK);
  });

  test("the size allowlist does NOT swallow an unrelated reason — control", () => {
    // Without this, the assertion above would pass for an allowlist that had
    // been widened to accept everything.
    const body = buildErrorBody("ECONNREFUSED 127.0.0.1:5432 password=secret");
    expect(body).toContain(GENERIC_FALLBACK);
    expect(body).not.toContain("secret");
  });

  test("buildSkippedBody with safe reason passes through", () => {
    const body = buildSkippedBody("tier 1 — human-authored PR");
    expect(body).toContain(MARKER);
    expect(body).toContain("Review skipped — tier 1 — human-authored PR");
  });

  test("buildSkippedBody sanitizes unsafe reasons", () => {
    const body = buildSkippedBody("unexpected stack trace at Object.foo");
    expect(body).toContain(GENERIC_FALLBACK);
    expect(body).not.toContain("stack trace");
  });

  test("buildResolvedBody shows resolve counts with plural form", () => {
    const body = buildResolvedBody({ threadsResolved: 3, reviewsDismissed: 2 });
    expect(body).toContain(MARKER);
    expect(body).toContain("Findings resolved");
    expect(body).toContain("3 threads resolved");
    expect(body).toContain("2 stale reviews dismissed");
    expect(body).toContain("`/review`");
  });

  test("buildResolvedBody uses singular for count == 1", () => {
    const body = buildResolvedBody({ threadsResolved: 1, reviewsDismissed: 1 });
    expect(body).toContain("1 thread resolved");
    expect(body).toContain("1 stale review dismissed");
    expect(body).not.toContain("threads");
    expect(body).not.toContain("reviews");
  });

  test("buildResolvedBody omits zero counts", () => {
    const body = buildResolvedBody({ threadsResolved: 0, reviewsDismissed: 2 });
    expect(body).toContain("2 stale reviews dismissed");
    expect(body).not.toContain("0 threads");
    expect(body).not.toContain("0 thread");
  });

  test("buildResolvedBody shows nothing-to-resolve when both zero", () => {
    const body = buildResolvedBody({ threadsResolved: 0, reviewsDismissed: 0 });
    expect(body).toContain("nothing to resolve");
  });
});
