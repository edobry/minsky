import { describe, expect, test } from "bun:test";
import { sanitizeReviewBody } from "./sanitize";

const CLEAN_REVIEW = `## Findings

- [BLOCKING] src/foo.ts:42 — the condition excludes x=0.

## Spec verification

- Criterion 1: Met.

APPROVE
`;

// Reconstruction of the PR #743 (2026-04-24) pattern: model scratch leaked
// before the actual Findings section, followed by hundreds of blank lines.
const LEAKED_WITH_HEADING = [
  "I will review AI types now.",
  "Calling read_file on src/domain/ai/types.ts.",
  "Go.",
  "This time for sure.",
  "",
  ...Array(40).fill(""),
  "## Findings",
  "",
  "- [BLOCKING] src/domain/ai/types.ts:12 — unguarded JSON.stringify.",
  "",
  "## Spec verification",
  "",
  "- Criterion 1: Met.",
  "",
  "Event: REQUEST_CHANGES",
].join("\n");

// Same scratch but no structural heading ever arrives — the whole body is leak.
const LEAKED_WITHOUT_HEADING = [
  "I will review AI types now.",
  "Calling read_file on src/domain/ai/types.ts.",
  "Go.",
  "This time for sure.",
  "[invoking]",
  ...Array(40).fill(""),
  "Opening the file now.",
  "Let's try again.",
  "Sorry, executing now.",
].join("\n");

// Legitimate intro prose — a reviewer might naturally write a sentence or two
// before Findings. Within tolerance, so the heuristic must not fire.
const CLEAN_WITH_SHORT_NARRATIVE = `I will focus on the DI seam first since that is where the spec is most specific.

On first read, the diff looks minimal and consistent with the stated scope.

## Findings

- [NON-BLOCKING] src/foo.ts:80 — copy-pasted docstring.

APPROVE
`;

describe("sanitizeReviewBody", () => {
  test("leaked body with Findings heading is stripped to the heading", () => {
    const result = sanitizeReviewBody(LEAKED_WITH_HEADING);
    expect(result.action).toBe("stripped");
    expect(result.body.startsWith("## Findings")).toBe(true);
    expect(result.body).toContain("Event: REQUEST_CHANGES");
    // The leaked prefix must be gone.
    expect(result.body).not.toContain("This time for sure");
    expect(result.body).not.toContain("Calling read_file");
    // Structured reason records which signals fired.
    expect(result.meta.reason).toBeDefined();
    expect(result.meta.reason).toContain("cot-leak:");
    expect(result.meta.reason).toContain("blank-line-run");
    expect(result.meta.cleanedLength).toBeLessThan(result.meta.originalLength);
  });

  test("leaked body without structural heading is replaced with error notice", () => {
    const result = sanitizeReviewBody(LEAKED_WITHOUT_HEADING);
    expect(result.action).toBe("errored");
    expect(result.body).toContain("reviewer-service error: chain-of-thought leakage detected");
    expect(result.body).toContain("mt#1212");
    // The leaked scratch content must not appear in the replacement body.
    expect(result.body).not.toContain("This time for sure");
    expect(result.body).not.toContain("Calling read_file");
    expect(result.meta.reason).toBeDefined();
    expect(result.meta.reason).toContain("cot-leak:");
  });

  test("clean review body passes through unchanged", () => {
    const result = sanitizeReviewBody(CLEAN_REVIEW);
    expect(result.action).toBe("passthrough");
    expect(result.body).toBe(CLEAN_REVIEW);
    expect(result.meta.reason).toBeUndefined();
    expect(result.meta.cleanedLength).toBe(result.meta.originalLength);
  });

  test("short legitimate narrative prefix before Findings is not a false positive", () => {
    const result = sanitizeReviewBody(CLEAN_WITH_SHORT_NARRATIVE);
    expect(result.action).toBe("passthrough");
    expect(result.body).toBe(CLEAN_WITH_SHORT_NARRATIVE);
  });

  test("blank-line run alone triggers detection (no scratch phrases needed)", () => {
    const body = [
      "Some narrative intro that by itself would be fine.",
      ...Array(30).fill(""),
      "## Findings",
      "",
      "- [NON-BLOCKING] trivial.",
    ].join("\n");
    const result = sanitizeReviewBody(body);
    expect(result.action).toBe("stripped");
    expect(result.body.startsWith("## Findings")).toBe(true);
    expect(result.meta.reason).toContain("blank-line-run");
  });

  test("strong scratch pattern alone triggers detection even without blank run", () => {
    const body = [
      "Calling list_directory on src/.",
      "[invoking]",
      "## Findings",
      "- [BLOCKING] src/x.ts:1",
    ].join("\n");
    const result = sanitizeReviewBody(body);
    expect(result.action).toBe("stripped");
    expect(result.body.startsWith("## Findings")).toBe(true);
    expect(result.meta.reason).toContain("scratch:tool-call-narration");
    expect(result.meta.reason).toContain("scratch:invoking-bracket");
  });

  test("bold-heading variant (**Findings**) is recognised as structural", () => {
    const body = [
      "Calling read_file on src/foo.ts.",
      "Go.",
      "",
      "**Findings**",
      "",
      "- [BLOCKING] bar.",
    ].join("\n");
    const result = sanitizeReviewBody(body);
    expect(result.action).toBe("stripped");
    expect(result.body.startsWith("**Findings**")).toBe(true);
  });

  test("long narrative prefix (>300 chars with I will/I'll) is flagged", () => {
    const longNarrative =
      "I will think about this carefully. ".repeat(15) +
      "But before I start, let me lay out my plan in detail. ".repeat(3);
    const body = `${longNarrative}\n\n## Findings\n\n- ok`;
    const result = sanitizeReviewBody(body);
    expect(result.action).toBe("stripped");
    expect(result.meta.reason).toContain("long-narrative-prefix");
  });

  // Regression: live bot review on PR #758 itself exhibited the exact
  // tool-loop-fallback CoT-leak pattern this module is meant to catch.
  // Body contained `to=functions.read_file` routing tokens, raw tool-call
  // JSON, non-ASCII garbage, and iterative "I'll retry / I'll list /
  // I'll try again" narration. No structural heading → should error out.
  test("live PR #758 bot-review variant is detected and errored", () => {
    const body = [
      'I\'ll open services/reviewer/src/server.ts to see how ReviewResult.status and reason are used, ensuring the new "error" path integrates correctly.',
      '{"id":"services/reviewer/src/server.ts"}',
      "It seems I attempted to open a file by ID, which isn't supported. I'll use read_file with the path instead.",
      '{"path":"services/reviewer/src/server.ts"} to=functions.read_file  ჯერ',
      "The read_file call returned an error earlier due to a tool glitch. I'll retry reading services/reviewer/src/server.ts.",
      '{"path":"services/reviewer/src/server.ts"} to=functions.read_file ыц',
      "The tool seems to be glitching with repeated attempts. I'll list the directory to confirm the file exists, then attempt again.",
      '{"path":"services/reviewer/src"} to=functions.list_directory  இச',
      "The tool returned non-ASCII artifacts. I'll try again to list the directory to stabilize the tool output.",
      '{"path":"services/reviewer/src"} to=functions.list_directory ',
    ].join("\n");

    const result = sanitizeReviewBody(body);
    expect(result.action).toBe("errored");
    expect(result.body).toContain("reviewer-service error: chain-of-thought leakage detected");
    // None of the original leak content must survive.
    expect(result.body).not.toContain("to=functions.read_file");
    expect(result.body).not.toContain('{"path"');
    // Structured reason fires.
    expect(result.meta.reason).toContain("cot-leak:");
  });
});
