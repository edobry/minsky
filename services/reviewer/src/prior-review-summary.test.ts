/**
 * Tests for the prior-review summarizer.
 *
 * All tests are purely synchronous — summarizePriorReviews is a pure function
 * with no I/O.
 */

import { describe, expect, test } from "bun:test";
import {
  CHINESE_WALL_MARKER,
  countAcknowledgedFindings,
  countBlockingFindings,
  extractFindings,
  isBotReviewerEntry,
  summarizePriorReviews,
  type PriorReview,
} from "./prior-review-summary";
import { sanitizeReviewBody } from "./sanitize";

// Shared fixtures
const HEAD_SHA = "abc123def456789012345678901234567890abcd";
const OLD_SHA = "000000000000000000000000000000000000dead";

function makeReview(overrides: Partial<PriorReview> = {}): PriorReview {
  return {
    id: 1,
    state: "CHANGES_REQUESTED",
    submittedAt: "2026-04-01T10:00:00Z",
    commitId: HEAD_SHA,
    userLogin: "minsky-reviewer[bot]",
    body: "**Independent adversarial review (Chinese-wall)**\n\n### Findings\n\n- **[BLOCKING]** src/foo.ts:42 — bad thing\n- **[NON-BLOCKING]** src/bar.ts:10 — minor thing\n\nEvent: REQUEST_CHANGES",
    ...overrides,
  };
}

// ─── summarizePriorReviews ────────────────────────────────────────────────────

describe("summarizePriorReviews", () => {
  test("empty list → empty summary with iterationCount=0 and empty markdown", () => {
    const result = summarizePriorReviews([], HEAD_SHA);
    expect(result.iterationCount).toBe(0);
    expect(result.reviews).toHaveLength(0);
    expect(result.markdown).toBe("");
  });

  test("single review → iterationCount=1, iteration=1", () => {
    const review = makeReview();
    const result = summarizePriorReviews([review], HEAD_SHA);

    expect(result.iterationCount).toBe(1);
    expect(result.reviews).toHaveLength(1);
    const [first] = result.reviews;
    expect(first?.iteration).toBe(1);
  });

  test("single review on current HEAD → isStale=false", () => {
    const review = makeReview({ commitId: HEAD_SHA });
    const result = summarizePriorReviews([review], HEAD_SHA);

    const [first] = result.reviews;
    expect(first?.isStale).toBe(false);
  });

  test("single review on older commit → isStale=true", () => {
    const review = makeReview({ commitId: OLD_SHA });
    const result = summarizePriorReviews([review], HEAD_SHA);

    const [first] = result.reviews;
    expect(first?.isStale).toBe(true);
  });

  test("multiple reviews get sequential iteration numbers oldest-first", () => {
    const reviews: PriorReview[] = [
      makeReview({ id: 1, submittedAt: "2026-04-01T10:00:00Z", commitId: OLD_SHA }),
      makeReview({ id: 2, submittedAt: "2026-04-02T10:00:00Z", commitId: OLD_SHA }),
      makeReview({ id: 3, submittedAt: "2026-04-03T10:00:00Z", commitId: HEAD_SHA }),
    ];
    const result = summarizePriorReviews(reviews, HEAD_SHA);

    expect(result.iterationCount).toBe(3);
    const [r1, r2, r3] = result.reviews;
    expect(r1?.iteration).toBe(1);
    expect(r2?.iteration).toBe(2);
    expect(r3?.iteration).toBe(3);
    // First two are stale, last is current
    expect(r1?.isStale).toBe(true);
    expect(r2?.isStale).toBe(true);
    expect(r3?.isStale).toBe(false);
  });

  test("markdown includes the Prior Reviews header with correct iteration count", () => {
    const reviews = [makeReview(), makeReview({ id: 2 })];
    const result = summarizePriorReviews(reviews, HEAD_SHA);

    expect(result.markdown).toContain("## Prior Reviews (2 iterations)");
  });

  test("markdown is empty string for zero reviews", () => {
    const result = summarizePriorReviews([], HEAD_SHA);
    expect(result.markdown).toBe("");
  });

  test("truncation: when markdown exceeds 30000 chars, older iterations are omitted first", () => {
    // Create many reviews with large bodies so the total exceeds 30000 chars.
    // MAX_SUMMARY_CHARS was raised from 3000 to 30000 (mt#1465 substrate raise);
    // use a body of ~4000 chars per iteration so 10 iterations ≈ 40000+ chars total.
    const bigBody = `**[BLOCKING]** src/foo.ts:1 — ${"x".repeat(4000)}`;
    const reviews: PriorReview[] = Array.from({ length: 10 }, (_, i) =>
      makeReview({
        id: i + 1,
        submittedAt: `2026-04-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
        commitId: i === 9 ? HEAD_SHA : OLD_SHA,
        body: bigBody,
      })
    );

    const result = summarizePriorReviews(reviews, HEAD_SHA);

    // Summary must fit within budget
    expect(result.markdown.length).toBeLessThanOrEqual(30000);
    // iterationCount still reflects all 10 reviews
    expect(result.iterationCount).toBe(10);
    // The omit note should be present
    expect(result.markdown).toContain("omitted");
    // The markdown header still references the full count
    expect(result.markdown).toContain("10 iterations");
  });

  test("stale marker appears in markdown for stale reviews", () => {
    const review = makeReview({ commitId: OLD_SHA });
    const result = summarizePriorReviews([review], HEAD_SHA);

    expect(result.markdown).toContain("stale");
  });

  test("non-stale reviews do not have stale marker in markdown", () => {
    const review = makeReview({ commitId: HEAD_SHA });
    const result = summarizePriorReviews([review], HEAD_SHA);

    expect(result.markdown).not.toContain("stale");
  });
});

// ─── extractFindings ──────────────────────────────────────────────────────────

describe("extractFindings", () => {
  test("empty body → empty string", () => {
    expect(extractFindings("")).toBe("");
    expect(extractFindings("   ")).toBe("");
  });

  test("extracts content after ### Findings header", () => {
    const body = `**Independent adversarial review (Chinese-wall)**

Some preamble.

### Findings

- **[BLOCKING]** src/foo.ts:42 — critical bug
- **[NON-BLOCKING]** src/bar.ts:10 — style issue

### Spec Verification

| Criterion | Status |
| --- | --- |
| foo | Met |`;

    const result = extractFindings(body);
    expect(result).toContain("**[BLOCKING]** src/foo.ts:42");
    expect(result).toContain("**[NON-BLOCKING]** src/bar.ts:10");
    // Should not include the spec verification table
    expect(result).not.toContain("Spec Verification");
    expect(result).not.toContain("| Criterion |");
  });

  test("extracts severity-marked lines when no ### Findings header present", () => {
    const body = `Some intro text.

**[BLOCKING]** src/foo.ts:1 — bad thing
**[NON-BLOCKING]** src/bar.ts:5 — minor thing
**[PRE-EXISTING]** src/baz.ts:9 — pre-existing issue

Event: REQUEST_CHANGES`;

    const result = extractFindings(body);
    expect(result).toContain("**[BLOCKING]**");
    expect(result).toContain("**[NON-BLOCKING]**");
    expect(result).toContain("**[PRE-EXISTING]**");
  });

  test("handles Chinese-wall header format (the real bot review format)", () => {
    const body = `**Independent adversarial review (Chinese-wall)**
Reviewer: \`minsky-reviewer[bot]\` via \`openai:gpt-5\`
Tier: 3

---

### Findings

- **[BLOCKING]** src/worker.ts:120 — missing null check
- **[NON-BLOCKING]** src/config.ts:5 — could add comment

Event: REQUEST_CHANGES`;

    const result = extractFindings(body);
    expect(result).toContain("### Findings");
    expect(result).toContain("**[BLOCKING]** src/worker.ts:120");
    expect(result).toContain("**[NON-BLOCKING]** src/config.ts:5");
  });

  test("returns full body (truncated) when no findings structure found", () => {
    const body = "This is a review with no structured findings at all.";
    const result = extractFindings(body);
    expect(result).toBe(body);
  });

  test("truncates very long unstructured bodies at 1000 chars", () => {
    const longBody = "x".repeat(2000);
    const result = extractFindings(longBody);
    expect(result.length).toBeLessThanOrEqual(1020); // 1000 + truncation marker
    expect(result).toContain("truncated");
  });

  test("strategy 2 also matches bare [BLOCKING] without ** wrappers (mt#1486)", () => {
    // Real production reviewer-bot bodies (verified 2026-04-30 on PR #732
    // review #4165932343) emit `[BLOCKING]` without bold wrappers. Pre-mt#1486
    // the regex required `**[BLOCKING]**` and silently fell through to the
    // truncated-fallback branch on every production review.
    const body = `Findings\n\n[BLOCKING] src/foo.ts:42 — broken contract\n[NON-BLOCKING] src/bar.ts:10 — minor nit\n[PRE-EXISTING] src/baz.ts:5 — old issue\n`;
    const result = extractFindings(body);
    expect(result).toContain("[BLOCKING] src/foo.ts:42");
    expect(result).toContain("[NON-BLOCKING] src/bar.ts:10");
    expect(result).toContain("[PRE-EXISTING] src/baz.ts:5");
  });

  test("strategy 2 matches bare [BLOCKING] with line-range citations (mt#1486)", () => {
    // Production bodies cite line ranges (e.g. src/foo.ts:171-176), not just
    // single lines. The strategy-2 regex only triggers `inFinding`; downstream
    // capture is line-based, so the range itself is preserved verbatim.
    const body = "Findings\n\n[BLOCKING] src/foo.ts:171-176 — over-broad guard";
    const result = extractFindings(body);
    expect(result).toContain("[BLOCKING] src/foo.ts:171-176");
  });

  test("strategy 2 does NOT trigger on one-sided bold wrappers (PR #921 R1+R5)", () => {
    // Stray formatting like `**[BLOCKING]` (no closing) or `[BLOCKING]**`
    // (no opening) is not a valid finding marker. If extractFindings
    // triggered on these, it would over-capture the body to EOF.
    //
    // PR #921 R5 NON-BLOCKING -> R5 BLOCKING (self-reversal): the test
    // previously asserted toBe(oneSidedOpen) — exact equality. That
    // couples the test to the fallback policy (truncated-to-1000-chars),
    // which is implementation detail. R5 flagged this as brittle. Now we
    // assert SHAPE: (a) no severity-prefixed lines were extracted (i.e.,
    // strategy 2 did not trigger), (b) for inputs under the fallback
    // truncation threshold, the output equals the input length.
    const oneSidedOpen = "Findings\n\n**[BLOCKING] src/foo.ts:42 — stray open\n";
    const oneSidedClose = "Findings\n\n[BLOCKING]** src/foo.ts:42 — stray close\n";

    for (const body of [oneSidedOpen, oneSidedClose]) {
      const result = extractFindings(body);
      // Shape: result must NOT have a structurally-extracted findings prefix
      // (which would only appear if strategy 1 or strategy 2 had triggered).
      // Both strategies must miss on these inputs.
      expect(result.startsWith("### Findings")).toBe(false);
      // The bare/balanced finding line itself is permitted in the result
      // because the fallback returns the whole body — but it must NOT have
      // been the trigger for strategy 2. Length-based check confirms the
      // fallback path: under the 1000-char threshold, result length equals
      // input length (no truncation marker added).
      expect(body.length).toBeLessThan(1000);
      expect(result.length).toBe(body.length);
    }
  });
});

// ─── isBotReviewerEntry filter predicate (mt#1189) ───────────────────────────
//
// Tests for the pure filter predicate used by fetchPriorReviews. Kept here
// (not in github-client.test.ts) to avoid importing @octokit/auth-app which
// is not installed in the test environment.

const MINSKY_REVIEWER_LOGIN = "minsky-reviewer[bot]";
const STATE_CHANGES_REQUESTED = "CHANGES_REQUESTED";

describe("isBotReviewerEntry", () => {
  // A body that satisfies both conditions: allowlisted login AND contains the marker.
  const BOT_REVIEW_BODY = `**${CHINESE_WALL_MARKER} (Chinese-wall)**\n\n### Findings\n\n- **[BLOCKING]** foo.ts:1`;

  test("minsky-reviewer[bot] with Chinese-wall marker is included for all non-DISMISSED states", () => {
    for (const state of ["APPROVED", STATE_CHANGES_REQUESTED, "COMMENTED"]) {
      expect(
        isBotReviewerEntry({ state, userLogin: MINSKY_REVIEWER_LOGIN, body: BOT_REVIEW_BODY })
      ).toBe(true);
    }
  });

  test("DISMISSED reviews are excluded regardless of login or body", () => {
    expect(
      isBotReviewerEntry({
        state: "DISMISSED",
        userLogin: MINSKY_REVIEWER_LOGIN,
        body: BOT_REVIEW_BODY,
      })
    ).toBe(false);
  });

  test("PENDING reviews are excluded regardless of login or body", () => {
    expect(
      isBotReviewerEntry({
        state: "PENDING",
        userLogin: MINSKY_REVIEWER_LOGIN,
        body: BOT_REVIEW_BODY,
      })
    ).toBe(false);
  });

  test("non-bot human reviewers are excluded even if body has Chinese-wall marker", () => {
    expect(
      isBotReviewerEntry({
        state: STATE_CHANGES_REQUESTED,
        userLogin: "human-dev",
        body: BOT_REVIEW_BODY,
      })
    ).toBe(false);
  });

  test("unknown bot login excluded even with Chinese-wall marker (allowlist enforced)", () => {
    // Previously, any *[bot] with the marker was included. Now only the explicit
    // allowlist is trusted — unknown bots are excluded even if they spoof the marker.
    expect(
      isBotReviewerEntry({
        state: STATE_CHANGES_REQUESTED,
        userLogin: "future-reviewer[bot]",
        body: BOT_REVIEW_BODY,
      })
    ).toBe(false);
  });

  test("other bots NOT in allowlist are excluded regardless of body (e.g. dependabot)", () => {
    expect(
      isBotReviewerEntry({
        state: STATE_CHANGES_REQUESTED,
        userLogin: "dependabot[bot]",
        body: "Bumped lodash from 4.17.20 to 4.17.21",
      })
    ).toBe(false);
  });

  test("minsky-reviewer[bot] WITHOUT Chinese-wall marker is excluded (skip-notice guard)", () => {
    // The Chinese-wall marker is required for ALL inclusions, including the
    // primary minsky-reviewer[bot] identity. Operational notices (skip-notices,
    // CoT leakage notices) intentionally lack the marker and must not be ingested.
    expect(
      isBotReviewerEntry({
        state: "COMMENTED",
        userLogin: MINSKY_REVIEWER_LOGIN,
        body: "Short comment with no marker.",
      })
    ).toBe(false);
  });

  test("empty-output skip-notice from minsky-reviewer[bot] is excluded", () => {
    // buildEmptyOutputSkipNotice produces bodies starting with
    // "⚠️ **Automated review skipped**" — no Chinese-wall marker.
    const skipNoticeBody =
      `⚠️ **Automated review skipped** — the reviewer (openai:gpt-5) ` +
      `returned no content for this PR.\n\n` +
      `This is **not** an approval or a rejection. Manual review is recommended.`;
    expect(
      isBotReviewerEntry({
        state: "COMMENTED",
        userLogin: MINSKY_REVIEWER_LOGIN,
        body: skipNoticeBody,
      })
    ).toBe(false);
  });

  test("CoT leakage notice from minsky-reviewer[bot] is excluded", () => {
    // sanitize.ts produces bodies starting with "**reviewer-service error:**" — no marker.
    const leakageNoticeBody =
      "**reviewer-service error: chain-of-thought leakage detected**\n\n" +
      "The model's raw reasoning leaked into the review body.";
    expect(
      isBotReviewerEntry({
        state: "COMMENTED",
        userLogin: MINSKY_REVIEWER_LOGIN,
        body: leakageNoticeBody,
      })
    ).toBe(false);
  });

  test("null body does not crash isBotReviewerEntry and returns false (no marker)", () => {
    // GitHub Reviews API can return null for empty-body approvals.
    // The function accepts body: string | null and coalesces to "".
    // A null body cannot contain the marker, so it is always excluded.
    expect(
      isBotReviewerEntry({
        state: "APPROVED",
        userLogin: MINSKY_REVIEWER_LOGIN,
        body: null as unknown as string,
      })
    ).toBe(false); // null body → no marker → excluded
  });

  test("null body for non-allowlisted bot is excluded (both checks fail)", () => {
    expect(
      isBotReviewerEntry({
        state: "APPROVED",
        userLogin: "future-reviewer[bot]",
        body: null as unknown as string,
      })
    ).toBe(false); // not in allowlist + no marker → excluded
  });
});

// ─── countBlockingFindings ────────────────────────────────────────────────────
//
// String.prototype.match() does not throw — no try/catch needed.

describe("countBlockingFindings", () => {
  test("returns 0 for empty body", () => {
    expect(countBlockingFindings("")).toBe(0);
  });

  test("counts single BLOCKING marker", () => {
    expect(countBlockingFindings("**[BLOCKING]** src/foo.ts:1 — bad thing")).toBe(1);
  });

  test("counts multiple BLOCKING markers", () => {
    const body =
      "**[BLOCKING]** src/foo.ts:1 — bad\n**[BLOCKING]** src/bar.ts:5 — worse\n**[NON-BLOCKING]** misc";
    expect(countBlockingFindings(body)).toBe(2);
  });

  test("case-insensitive match (gi flag)", () => {
    expect(countBlockingFindings("**[blocking]** src/foo.ts:1 — bad")).toBe(1);
  });

  test("counts bare [BLOCKING] without ** wrappers (mt#1486)", () => {
    // Real production format. Pre-mt#1486 this returned 0 for every
    // production review and broke the convergence_metric priorBlockerCount.
    expect(countBlockingFindings("[BLOCKING] src/foo.ts:1 — bad thing")).toBe(1);
  });

  test("counts mixed bare and bold-wrapped BLOCKING markers (mt#1486)", () => {
    const body =
      "[BLOCKING] src/foo.ts:1 — bare\n**[BLOCKING]** src/bar.ts:5 — wrapped\n[NON-BLOCKING] src/baz.ts:10 — nit";
    expect(countBlockingFindings(body)).toBe(2);
  });

  test("counts bare [BLOCKING] with line-range citations (mt#1486)", () => {
    const body = "[BLOCKING] src/foo.ts:171-176 — over-broad guard";
    expect(countBlockingFindings(body)).toBe(1);
  });

  test("does NOT count one-sided bold wrappers as BLOCKING (PR #921 R1)", () => {
    // **[BLOCKING] (no close) and [BLOCKING]** (no open) are stray formatting
    // and must not count at all. The negative lookbehind/lookahead on the
    // bare branch prevents the embedded `[BLOCKING]` substring from matching
    // when adjacent to `*`. Result: 0 valid markers in either form.
    expect(countBlockingFindings("**[BLOCKING] missing close")).toBe(0);
    expect(countBlockingFindings("[BLOCKING]** missing open")).toBe(0);
  });

  test("counts balanced wrapper at line start (PR #921 R2)", () => {
    expect(countBlockingFindings("**[BLOCKING]**")).toBe(1);
  });

  test("counts markers at line start across multiple lines (PR #921 R2)", () => {
    // Multiline body with two findings on separate lines, one balanced one
    // bare, both at line start. Both must count.
    const body = "**[BLOCKING]** src/foo.ts:1 — bold\n[BLOCKING] src/bar.ts:5 — bare";
    expect(countBlockingFindings(body)).toBe(2);
  });

  test("counts markers with optional bullet prefix (PR #921 R2)", () => {
    const body =
      "- [BLOCKING] src/foo.ts:1 — bullet-prefixed\n* **[BLOCKING]** src/bar.ts:5 — asterisk bullet";
    expect(countBlockingFindings(body)).toBe(2);
  });

  test("does NOT count mid-line incidental [BLOCKING] mentions (PR #921 R2)", () => {
    // Pre-PR-#921-R2 the regex matched [BLOCKING] anywhere on the line,
    // including narrative prose mentions. New start-of-line anchor rejects
    // these.
    expect(countBlockingFindings("the string [BLOCKING] appears in the docs")).toBe(0);
    expect(countBlockingFindings("Conclusion: **[BLOCKING]** above are the issues.")).toBe(0);
  });

  test("counts numeric-ordered-list bullet prefix (PR #921 R3)", () => {
    // GitHub Markdown ordered lists use `1.`, `2.`, etc. The R3 reviewer
    // flagged the previous bullet class missed these.
    const body =
      "1. [BLOCKING] src/foo.ts:1 — first\n2. **[BLOCKING]** src/bar.ts:5 — second\n10. [BLOCKING] src/baz.ts:9 — multi-digit";
    expect(countBlockingFindings(body)).toBe(3);
  });

  test("counts plus-style bullet prefix (PR #921 R3)", () => {
    const body = "+ [BLOCKING] src/foo.ts:1 — plus bullet";
    expect(countBlockingFindings(body)).toBe(1);
  });

  test("strategy 1 returns header-only content when ### Findings is last line without newline (PR #921 R7)", () => {
    // Pre-fix this returned "" due to a slicing bug where indexOf("\n")
    // returned -1, the search began at offset 0 and matched the same header,
    // and slice(0, 0).trim() yielded an empty string.
    const body = "Some preamble text.\n\n### Findings";
    const result = extractFindings(body);
    expect(result).toContain("### Findings");
    expect(result).not.toBe("");
  });

  test("null-body coalescing: runtime null coalesced to string does not crash and returns 0", () => {
    // fetchPriorReviews maps null → "" via r.body ?? "". Simulate a caller
    // that received null at runtime and coalesced before calling countBlockingFindings.
    const nullableBody: string | null = null;
    expect(countBlockingFindings(nullableBody ?? "")).toBe(0);
  });
});

// ─── SC-2: sanitizeReviewBody pipeline (mt#1189) ──────────────────────────────
//
// Integration test verifying that CoT-leaked prior review bodies are stripped
// before being summarized. In review-worker.ts, each prior review body is
// passed through sanitizeReviewBody() before being fed to summarizePriorReviews.
// This test documents the expected pipeline behavior: leaked scratch in a prior
// review body must not appear in the summary injected into the next prompt.

// CoT-leaked review body: starts with scratch then has a real Findings section.
const COT_LEAKED_BODY =
  "Calling read_file on src/worker.ts.\n" +
  "Let me analyze the findings.\n" +
  "Go.\n\n" +
  "**Independent adversarial review (Chinese-wall)**\n" +
  `Reviewer: \`${MINSKY_REVIEWER_LOGIN}\` via \`openai:gpt-5\`\n\n` +
  "---\n\n" +
  "### Findings\n\n" +
  "- **[BLOCKING]** src/worker.ts:42 — missing null check\n" +
  "- **[NON-BLOCKING]** src/config.ts:5 — add a comment\n\n" +
  "Event: REQUEST_CHANGES";

describe("SC-2: sanitizeReviewBody before summarizePriorReviews", () => {
  test("sanitizeReviewBody strips CoT prefix, leaving only the Findings section", () => {
    const result = sanitizeReviewBody(COT_LEAKED_BODY);
    expect(result.action).toBe("stripped");
    expect(result.body).not.toContain("Calling read_file");
    expect(result.body).not.toContain("Let me analyze");
    expect(result.body).not.toContain("Go.");
    expect(result.body).toContain("**[BLOCKING]** src/worker.ts:42");
    expect(result.body).toContain("**[NON-BLOCKING]** src/config.ts:5");
  });

  test("pipeline: sanitized body injected into summarizePriorReviews excludes CoT scratch", () => {
    const reviewWithCoT: PriorReview = {
      id: 1,
      state: STATE_CHANGES_REQUESTED,
      submittedAt: "2026-04-01T10:00:00Z",
      commitId: HEAD_SHA,
      userLogin: MINSKY_REVIEWER_LOGIN,
      body: COT_LEAKED_BODY,
    };
    // Simulate the SC-2 pipeline: sanitize first, then summarize.
    const sanitizedBody = sanitizeReviewBody(reviewWithCoT.body).body;
    const sanitizedReview = { ...reviewWithCoT, body: sanitizedBody };
    const summary = summarizePriorReviews([sanitizedReview], HEAD_SHA);

    expect(summary.markdown).not.toContain("Calling read_file");
    expect(summary.markdown).not.toContain("Let me analyze");
    expect(summary.markdown).toContain("**[BLOCKING]** src/worker.ts:42");
  });

  test("passthrough body (no CoT) is unchanged after sanitize + summarize pipeline", () => {
    const cleanBody =
      "**Independent adversarial review (Chinese-wall)**\n" +
      `Reviewer: \`${MINSKY_REVIEWER_LOGIN}\` via \`openai:gpt-5\`\n\n` +
      "---\n\n" +
      "### Findings\n\n" +
      "- **[BLOCKING]** src/index.ts:10 — missing error handler\n\n" +
      "Event: REQUEST_CHANGES";

    const review: PriorReview = {
      id: 2,
      state: STATE_CHANGES_REQUESTED,
      submittedAt: "2026-04-02T10:00:00Z",
      commitId: HEAD_SHA,
      userLogin: MINSKY_REVIEWER_LOGIN,
      body: cleanBody,
    };

    const sanitized = sanitizeReviewBody(review.body);
    expect(sanitized.action).toBe("passthrough");

    const sanitizedReview = { ...review, body: sanitized.body };
    const summary = summarizePriorReviews([sanitizedReview], HEAD_SHA);
    expect(summary.markdown).toContain("**[BLOCKING]** src/index.ts:10");
  });
});

// ─── countAcknowledgedFindings ────────────────────────────────────────────────

describe("countAcknowledgedFindings", () => {
  test("returns 0 for empty body", () => {
    expect(countAcknowledgedFindings("")).toBe(0);
  });

  test("returns 0 for body with no acknowledgement phrases", () => {
    const body = "**[BLOCKING]** src/foo.ts:1 — bad thing\n**[NON-BLOCKING]** src/bar.ts:5 — minor";
    expect(countAcknowledgedFindings(body)).toBe(0);
  });

  test("detects 'acknowledged as addressed' phrase", () => {
    const body = "The previous concern about missing null check is acknowledged as addressed.";
    expect(countAcknowledgedFindings(body)).toBeGreaterThan(0);
  });

  test("detects 'prior finding now resolved' phrase", () => {
    const body = "Prior finding about error handling is now resolved in this commit.";
    expect(countAcknowledgedFindings(body)).toBeGreaterThan(0);
  });

  test("returns 0 for body with only non-blocking findings and no acknowledgements", () => {
    const body =
      "**Independent adversarial review (Chinese-wall)**\n\n" +
      "### Findings\n\n" +
      "- **[NON-BLOCKING]** src/foo.ts:1 — style issue\n\n" +
      "Event: COMMENT";
    expect(countAcknowledgedFindings(body)).toBe(0);
  });
});
