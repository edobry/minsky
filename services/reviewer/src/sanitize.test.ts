import { describe, expect, test } from "bun:test";
import { sanitizeReviewBody, redactForLog } from "./sanitize";

// Shared test constants — extracted to satisfy the no-magic-string-duplication
// lint rule and to keep scratch-signal names in sync with sanitize.ts.
const CALLING_READ_FILE = "Calling read_file on src/foo.ts.";
const SIGNAL_TOOL_CALL = "scratch:tool-call-narration";
const SIGNAL_LONG_NARRATIVE = "long-narrative-prefix";
// Narrative intro string used by mt#1264 boundary tests. 31 chars including trailing space.
const NARRATIVE_INTRO = "I will quickly check the diff. ";

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
    // Notice points readers at the architecture doc, not an internal tracker ID.
    expect(result.body).toContain("docs/architecture/critic-constitution-reliability.md");
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
    expect(result.meta.reason).toContain(SIGNAL_TOOL_CALL);
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
    expect(result.meta.reason).toContain(SIGNAL_LONG_NARRATIVE);
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

  // R3 reviewer findings regression tests (mt#1212 second-pass hardening).

  test("H5 and H6 Markdown headings are recognised as structural", () => {
    for (const prefix of ["#####", "######"]) {
      const body = [
        CALLING_READ_FILE,
        "Go.",
        "",
        `${prefix} Findings`,
        "",
        "- [BLOCKING] src/foo.ts:1 — bad.",
      ].join("\n");
      const result = sanitizeReviewBody(body);
      expect(result.action).toBe("stripped");
      expect(result.body.startsWith(`${prefix} Findings`)).toBe(true);
    }
  });

  test("Unicode curly apostrophe (U+2019) in I’ll triggers narrative detection", () => {
    const longNarrative =
      "I’ll think about this carefully. ".repeat(15) +
      "But before I start, let me lay out my plan in detail. ".repeat(3);
    const body = `${longNarrative}\n\n## Findings\n\n- ok`;
    const result = sanitizeReviewBody(body);
    expect(result.action).toBe("stripped");
    expect(result.meta.reason).toContain(SIGNAL_LONG_NARRATIVE);
  });

  test("Unicode curly apostrophe in Let’s try again / I’ll just proceed triggers strong patterns", () => {
    const body1 = ["Let’s try again.", "## Findings", "- ok"].join("\n");
    const r1 = sanitizeReviewBody(body1);
    expect(r1.action).toBe("stripped");
    expect(r1.meta.reason).toContain("scratch:lets-try-again");

    const body2 = ["I’ll just proceed.", "## Findings", "- ok"].join("\n");
    const r2 = sanitizeReviewBody(body2);
    expect(r2.action).toBe("stripped");
    expect(r2.meta.reason).toContain("scratch:ill-just-proceed");
  });

  test("Calling-tool regex no longer false-positives on prose like 'Calling maintainers,'", () => {
    // A review body that naturally mentions "Calling" without any other CoT
    // signal must pass through.
    const body =
      "## Findings\n\n" +
      "- [NON-BLOCKING] src/foo.ts:1 — the maintenance note reads 'Calling maintainers,' but this is a pre-existing comment.\n\n" +
      "## Spec verification\n\n" +
      "- Criterion 1: Met.\n\n" +
      "APPROVE";
    const result = sanitizeReviewBody(body);
    expect(result.action).toBe("passthrough");
  });

  test("Calling-tool regex still matches real tool-call narration (snake_case or on-path)", () => {
    // snake_case tool name alone is enough
    const r1 = sanitizeReviewBody("Calling list_directory.\n## Findings\n- ok");
    expect(r1.action).toBe("stripped");
    expect(r1.meta.reason).toContain(SIGNAL_TOOL_CALL);

    // bare tool name + on-path segment is also enough
    const r2 = sanitizeReviewBody("Calling getContent on src/foo.ts.\n## Findings\n- ok");
    expect(r2.action).toBe("stripped");
    expect(r2.meta.reason).toContain(SIGNAL_TOOL_CALL);
  });

  test("Calling-tool regex matches without trailing punctuation (R5 recall gap)", () => {
    // The R5 reviewer's specific failing scenario: no period after the path.
    const r1 = sanitizeReviewBody("Calling read_file on src/foo.ts\n## Findings\n- ok");
    expect(r1.action).toBe("stripped");
    expect(r1.meta.reason).toContain(SIGNAL_TOOL_CALL);

    // snake_case tool name alone, no punctuation either.
    const r2 = sanitizeReviewBody("Calling read_file\n## Findings\n- ok");
    expect(r2.action).toBe("stripped");
    expect(r2.meta.reason).toContain(SIGNAL_TOOL_CALL);
  });

  test("CRLF line endings in a blank-line run are still detected", () => {
    const body = ["Some intro.", ...Array(30).fill(""), "## Findings", "- ok"].join("\r\n");
    const result = sanitizeReviewBody(body);
    expect(result.action).toBe("stripped");
    expect(result.meta.reason).toContain("blank-line-run");
  });

  test("## Summary heading is recognised as structural", () => {
    const body = [CALLING_READ_FILE, "", "## Summary", "", "Clean change, minor nits."].join("\n");
    const result = sanitizeReviewBody(body);
    expect(result.action).toBe("stripped");
    expect(result.body.startsWith("## Summary")).toBe(true);
  });

  test("ERROR_NOTICE_BODY does not leak internal tracker IDs", () => {
    // Force the errored branch by providing a leak-without-heading body.
    const body = ["I'll just proceed.", CALLING_READ_FILE, "[invoking]", "Go."].join("\n");
    const result = sanitizeReviewBody(body);
    expect(result.action).toBe("errored");
    expect(result.body).not.toMatch(/mt#\d+/);
    // But it should still point readers at the docs for operator context.
    expect(result.body).toContain("docs/architecture/critic-constitution-reliability.md");
  });

  // mt#1264 — boundary fixtures around NARRATIVE_TOLERANCE_CHARS = 300.
  // Calibration via replay corpus (see docs/architecture/critic-constitution-reliability.md)
  // showed 0 samples in the at-risk zone; these fixtures lock the threshold behavior.
  test("narrative phrase + 250-char prefix → passthrough (below threshold)", () => {
    const padding = "x".repeat(220);
    const body = `I will quickly check the diff. ${padding}\n## Findings\n- ok`;
    const result = sanitizeReviewBody(body);
    expect(result.action).toBe("passthrough");
  });

  test("narrative phrase + 310-char prefix → stripped (sole long-narrative-prefix signal)", () => {
    const padding = "x".repeat(280);
    const body = `I will quickly check the diff. ${padding}\n## Findings\n- ok`;
    const result = sanitizeReviewBody(body);
    expect(result.action).toBe("stripped");
    expect(result.meta.reason).toContain(SIGNAL_LONG_NARRATIVE);
    // Should be the only signal (boundary behavior)
    expect(result.meta.reason).toBe(`cot-leak:${SIGNAL_LONG_NARRATIVE}`);
  });

  test("narrative phrase + 450-char prefix → stripped", () => {
    const padding = "x".repeat(420);
    const body = `I will quickly check the diff. ${padding}\n## Findings\n- ok`;
    const result = sanitizeReviewBody(body);
    expect(result.action).toBe("stripped");
    expect(result.meta.reason).toContain(SIGNAL_LONG_NARRATIVE);
  });

  test("narrative phrase + long prefix + no heading → errored", () => {
    const padding = "x".repeat(400);
    const body = `I will quickly check the diff. ${padding}`;
    const result = sanitizeReviewBody(body);
    expect(result.action).toBe("errored");
    expect(result.meta.reason).toContain(SIGNAL_LONG_NARRATIVE);
  });

  // mt#1264 R3 NON-BLOCKING: lock the strict `>` boundary at the canonical
  // threshold. Sanitize uses `prefix.length > NARRATIVE_TOLERANCE_CHARS`
  // (strict greater-than), so 299 and 300 are passthrough; 301 trips.
  // Helper builds a prefix of EXACTLY targetLen chars followed by a heading.
  function makeBoundaryBody(targetLen: number): string {
    const padding = "x".repeat(targetLen - NARRATIVE_INTRO.length - 1);
    return `${NARRATIVE_INTRO}${padding}\n## Findings\n- ok`;
  }

  test("narrative phrase at exactly threshold-1 (299 chars) → passthrough (boundary lock)", () => {
    const result = sanitizeReviewBody(makeBoundaryBody(299));
    expect(result.action).toBe("passthrough");
  });

  test("narrative phrase at exactly threshold (300 chars) → passthrough (boundary lock)", () => {
    const result = sanitizeReviewBody(makeBoundaryBody(300));
    expect(result.action).toBe("passthrough");
  });

  test("narrative phrase at exactly threshold+1 (301 chars) → stripped (boundary lock)", () => {
    const result = sanitizeReviewBody(makeBoundaryBody(301));
    expect(result.action).toBe("stripped");
    expect(result.meta.reason).toContain(SIGNAL_LONG_NARRATIVE);
  });
});

// mt#1264 — redactForLog tests
describe("redactForLog", () => {
  test("redacts URLs", () => {
    const text = "See https://example.com/secret and http://internal.local/x for details.";
    const out = redactForLog(text);
    expect(out).toContain("[url]");
    expect(out).not.toContain("example.com");
    expect(out).not.toContain("internal.local");
  });

  test("redacts email addresses", () => {
    const text = "Contact alice@example.com or bob.smith+tag@company.co.uk for access.";
    const out = redactForLog(text);
    expect(out).toContain("[email]");
    expect(out).not.toContain("alice@");
    expect(out).not.toContain("bob.smith");
  });

  test("truncates to default 200 chars", () => {
    const text = "a".repeat(500);
    const out = redactForLog(text);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  test("truncates to custom maxChars", () => {
    const text = "a".repeat(500);
    const out = redactForLog(text, 50);
    expect(out.length).toBeLessThanOrEqual(50);
  });

  test("plain text passes through unchanged below threshold", () => {
    const text = "Some plain text without urls or emails.";
    const out = redactForLog(text);
    expect(out).toBe(text);
  });
});
