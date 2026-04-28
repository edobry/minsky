#!/usr/bin/env bun
/**
 * Smoke test for output tool accumulation (mt#1399).
 *
 * Sends a synthetic review request to the actual OpenAI API and verifies that
 * the model emits at least one output-tool call when instructed to use them.
 *
 * Skip gracefully when OPENAI_API_KEY is not set.
 *
 * Usage:
 *   bun services/reviewer/scripts/smoke-output-tools.ts
 */

import OpenAI from "openai";
import { callOpenAIWithClient } from "../src/providers";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.log("SKIP: OPENAI_API_KEY not set; skipping live smoke test.");
  process.exit(0);
}

const MODEL = process.env.SMOKE_MODEL ?? "gpt-4o";

// A synthetic diff with one obvious BLOCKING issue (wrong expected value in a
// test assertion) and one obvious non-blocking nit (missing type annotation).
const SYNTHETIC_DIFF = `
diff --git a/src/math.test.ts b/src/math.test.ts
index 000000..111111 100644
--- a/src/math.test.ts
+++ b/src/math.test.ts
@@ -1,6 +1,6 @@
 test("add returns correct sum", () => {
-  expect(add(2, 3)).toBe(5);
+  expect(add(2, 3)).toBe(6);  // WRONG: 2+3=5, not 6
 });
`.trim();

const SYSTEM_PROMPT = `
You are a code reviewer. Review the provided diff carefully.

You have four structured output tools available:
- submit_finding: for discrete review findings tied to a file/line
- submit_inline_comment: for targeted inline annotations
- submit_spec_verification: for verifying spec criteria
- conclude_review: to signal the end of the review

Use these tools to compose your review. Call submit_finding for any issues
you find, then call conclude_review to finish. Do NOT write a prose review —
use ONLY the structured tools.
`.trim();

const USER_PROMPT = `
Review this diff:

\`\`\`diff
${SYNTHETIC_DIFF}
\`\`\`

Find any issues and submit them using the output tools.
`.trim();

async function main() {
  const client = new OpenAI({ apiKey });

  console.log(`Running smoke test against model: ${MODEL}`);
  console.log("Sending synthetic diff with one obvious BLOCKING issue...");

  const result = await callOpenAIWithClient(client, MODEL, SYSTEM_PROMPT, USER_PROMPT, {
    readFile: async () => null,
    listDirectory: async () => null,
  });

  const toolCallCount = result.toolCalls.length;
  const toolCallNames = result.toolCalls.map((tc) => tc.name);

  console.log("\n=== Smoke Test Result ===");
  console.log(`Tool calls emitted: ${toolCallCount}`);
  console.log(`Tool call names: ${toolCallNames.join(", ") || "(none)"}`);
  console.log(`Output text length: ${result.text.length} chars`);

  if (toolCallCount === 0) {
    console.error(
      "\nFAIL: Model emitted zero output-tool calls. " +
        "This may indicate a prompt-engineering gap or model-compliance issue. " +
        "Do NOT mark mt#1399 complete — escalate to prompt-engineering (mt#1401 territory)."
    );
    process.exit(1);
  }

  const hasSubmitFinding = toolCallNames.includes("submit_finding");
  const hasConcludeReview = toolCallNames.includes("conclude_review");

  console.log(`\nPass: model emitted ${toolCallCount} output-tool call(s)`);
  console.log(`  submit_finding present: ${hasSubmitFinding}`);
  console.log(`  conclude_review present: ${hasConcludeReview}`);

  if (!hasSubmitFinding) {
    console.warn(
      "WARN: no submit_finding call — model may not have identified the obvious BLOCKING issue."
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Smoke test error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
