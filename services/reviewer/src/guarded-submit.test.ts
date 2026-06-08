/**
 * Tests for the composed→submitReview inline-comment mapping (mt#2350).
 *
 * Focuses on the field-preservation contract flagged in PR #1621 R1: `side`
 * must survive the mapping so partitionInlineComments' LEFT-side demotion stays
 * coherent end-to-end. (The submit/circuit-breaker side of submitReviewWithGuards
 * is covered by review-worker.test.ts and the smoke artifact.)
 */

import { describe, test, expect } from "bun:test";
import { mapComposedToReviewInlineComments } from "./guarded-submit";
import type { ComposedInlineComment } from "./compose-review";
import { partitionInlineComments, parseRightSideAnchorableLines } from "./anchor-validation";

describe("mapComposedToReviewInlineComments", () => {
  test("maps file→path and preserves body", () => {
    const composed: ComposedInlineComment[] = [{ file: "src/a.ts", line: 10, body: "hi" }];
    const [mapped] = mapComposedToReviewInlineComments(composed);
    expect(mapped).toEqual({ path: "src/a.ts", line: 10, body: "hi" });
  });

  test("preserves side when present (PR #1621 R1)", () => {
    const composed: ComposedInlineComment[] = [
      { file: "src/a.ts", line: 10, body: "left", side: "LEFT" },
      { file: "src/a.ts", line: 11, body: "right", side: "RIGHT" },
    ];
    const mapped = mapComposedToReviewInlineComments(composed);
    expect(mapped[0]?.side).toBe("LEFT");
    expect(mapped[1]?.side).toBe("RIGHT");
  });

  test("omits side when absent (defaults to RIGHT downstream)", () => {
    const composed: ComposedInlineComment[] = [{ file: "src/a.ts", line: 10, body: "x" }];
    const [mapped] = mapComposedToReviewInlineComments(composed);
    expect(mapped !== undefined && "side" in mapped).toBe(false);
  });

  test("preserves inReplyTo", () => {
    const composed: ComposedInlineComment[] = [
      { file: "src/a.ts", line: 10, body: "reply", inReplyTo: 999 },
    ];
    const [mapped] = mapComposedToReviewInlineComments(composed);
    expect(mapped?.inReplyTo).toBe(999);
  });

  test("end-to-end: a preserved LEFT side causes conservative demotion (not RIGHT mis-anchoring)", () => {
    // A diff where line 41 IS a valid RIGHT anchor.
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -40,1 +40,2 @@
 ctx
+added
`;
    const anchorable = parseRightSideAnchorableLines(diff);
    // Same line, but marked LEFT — must be demoted, not anchored to RIGHT 41.
    const mapped = mapComposedToReviewInlineComments([
      { file: "src/a.ts", line: 41, body: "removed-line note", side: "LEFT" },
    ]);
    const { anchored, unanchored } = partitionInlineComments(mapped, anchorable);
    expect(anchored).toHaveLength(0);
    expect(unanchored).toHaveLength(1);
  });
});
