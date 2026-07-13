#!/usr/bin/env bun
/**
 * Smoke verification for mt#2350 — inline-comment anchor pre-validation and the
 * submission-failure circuit-breaker decision logic.
 *
 * Exercises the pure logic end-to-end against a synthetic diff + comments and a
 * synthetic 422 error, asserting:
 *   1. A comment anchored to a line OUTSIDE the diff hunks is DEMOTED into the
 *      review body instead of being sent as a comment[] (which would 422 the
 *      whole review with "Line could not be resolved").
 *   2. A 422 submission error is classified NON-RETRYABLE.
 *   3. The circuit-breaker threshold opens at N consecutive failures, not before.
 *
 * This is the structural-change verification artifact (implement-task §7a). It
 * needs NO env vars and NO network — it asserts the in-process decision logic.
 * The live-verification gap (the new migration applying on Railway and a real
 * PR's class either submitting a review or tripping the breaker) is verified
 * post-merge via deployment_wait-for-latest; see the PR "## Live verification".
 *
 * Usage:
 *   bun run services/reviewer/scripts/smoke-anchor-circuit.ts
 * Exit 0 = all assertions pass; non-zero = a failure (printed).
 */

import {
  parseRightSideAnchorableLines,
  partitionInlineComments,
  formatUnanchoredFindings,
} from "../src/anchor-validation";
import {
  classifySubmissionError,
  shouldOpenCircuit,
  CIRCUIT_BREAKER_THRESHOLD,
} from "../src/submission-failure-tracker";
import type { ReviewInlineComment } from "../src/github-client";

const failures: string[] = [];
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}`);
    failures.push(label);
  }
}

const DIFF = `diff --git a/src/widget.ts b/src/widget.ts
--- a/src/widget.ts
+++ b/src/widget.ts
@@ -40,4 +40,6 @@ export function widget() {
   const before = compute();
+  const added = transform(before);
+  log(added);
   const mid = 1;
+  return added;
   const after = 2;
`;

console.log("mt#2350 smoke: anchor pre-validation");
const anchorable = parseRightSideAnchorableLines(DIFF);
// New-file lines in the hunk: 40 (before), 41 (added), 42 (log), 43 (mid),
// 44 (return), 45 (after).
const widgetLines = [...(anchorable.get("src/widget.ts") ?? [])].sort((a, b) => a - b);
check("hunk lines parsed as RIGHT-side anchorable", widgetLines.join(",") === "40,41,42,43,44,45");

const comments: ReviewInlineComment[] = [
  { path: "src/widget.ts", line: 41, body: "anchored on an added line" },
  { path: "src/widget.ts", line: 9999, body: "anchored OUTSIDE the diff — would 422" },
  { path: "src/widget.ts", line: 7, body: "reply, line irrelevant", inReplyTo: 555 },
];
const { anchored, unanchored } = partitionInlineComments(comments, anchorable);
check(
  "good anchor kept",
  anchored.some((c) => c.line === 41)
);
check(
  "reply comment kept",
  anchored.some((c) => c.inReplyTo === 555)
);
check(
  "out-of-hunk anchor demoted (would otherwise 422 the whole review)",
  unanchored.length === 1 && unanchored[0]?.line === 9999
);

const body = `## Review\n\nLooks fine.${formatUnanchoredFindings(unanchored)}`;
check(
  "demoted finding surfaces in the review body",
  body.includes("## Unanchored findings") && body.includes("src/widget.ts:9999")
);

console.log("\nmt#2350 smoke: circuit-breaker classification");
function http422(): Error {
  const e = new Error('Unprocessable Entity: "Line could not be resolved"') as Error & {
    status: number;
  };
  e.status = 422;
  return e;
}
const c = classifySubmissionError(http422());
check(
  "422 classified non-retryable",
  c !== null && c.retryable === false && c.class === "non_retryable_4xx"
);
check(
  "503 classified retryable",
  classifySubmissionError(Object.assign(new Error("x"), { status: 503 }))?.retryable === true
);
check(
  "network error (no status) → null (does not trip breaker)",
  classifySubmissionError(new Error("ECONNRESET")) === null
);

console.log("\nmt#2350 smoke: circuit-breaker threshold (N =", CIRCUIT_BREAKER_THRESHOLD, ")");
check("does not open below threshold", shouldOpenCircuit(CIRCUIT_BREAKER_THRESHOLD - 1) === false);
check("opens at threshold", shouldOpenCircuit(CIRCUIT_BREAKER_THRESHOLD) === true);

console.log("");
if (failures.length > 0) {
  console.error(`SMOKE FAILED: ${failures.length} assertion(s) failed`);
  process.exit(1);
}
console.log("SMOKE PASSED: all assertions green");
process.exit(0);
