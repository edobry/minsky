#!/usr/bin/env bun
/**
 * Live verification for reviewer prompt-cache hygiene (mt#2722, lever 2 of mt#2718).
 *
 * Verifies the two mt#2722 changes against a LIVE OpenAI model:
 *
 *   AT 3 — cross-review prompt caching works. Runs the reviewer N times over an
 *   IDENTICAL prompt prefix (same systemPrompt + tools + userPrompt) and checks
 *   that `cached_tokens > 0` on runs after the first. The first run warms the
 *   cache (miss); later runs should hit it. This confirms `prompt_cache_key` +
 *   `prompt_cache_retention: "24h"` are actually producing cache hits.
 *
 *   AT 2b — forced-pass emission stays reliable after the tools-array widening.
 *   The mt#2722 change widened the two post-loop forced passes
 *   (forceConcludeReview / forceDocumentationImpact) from a single-tool array to
 *   the FULL ALL_TOOL_DEFINITIONS array (to preserve the cached prefix), keeping
 *   the pinned `tool_choice`. Memory c57a9479 records a POSITIVE prior that
 *   narrowing the array helps emission, so "quality-neutral" is a HYPOTHESIS, not
 *   settled. This script measures the end-to-end emission rate of conclude_review
 *   and submit_documentation_impact across N runs and asserts it stays at/above
 *   the mt#1471 baseline (>= 80%). If it regresses, the mt#2722 spec Contingency
 *   applies: revert the two `tools: ALL_TOOL_DEFINITIONS` lines (keep change (a),
 *   the cache_key + retention, which is quality-neutral) and accept the
 *   forced-pass cache-bust.
 *
 * The script does NOT touch GitHub — it synthesizes a small in-repo diff so the
 * only credential required is OPENAI_API_KEY. It writes results to
 * services/reviewer/scripts/verify-prompt-cache-results.json.
 *
 * Usage:
 *   bun services/reviewer/scripts/verify-prompt-cache.ts
 *   bun services/reviewer/scripts/verify-prompt-cache.ts --attempts=10 --model=gpt-5
 *
 * Skips gracefully (exit 0) when OPENAI_API_KEY is absent.
 *
 * CI posture: this is an on-demand OPERATOR verification tool, NOT a CI gate — it
 * makes real (paid) model calls and needs a provider secret, so wiring it into CI
 * is deliberately out of scope (same posture as the sibling
 * scripts/replay-structural-output.ts). The publishing path for its results is the
 * PR body's "Live verification" section (mirroring the mt#1399 / mt#1403
 * live-verification-gap pattern), plus the local verify-prompt-cache-results.json
 * for inspection.
 */

import OpenAI from "openai";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callOpenAIWithClient } from "../src/providers";
import { buildCriticConstitution, buildReviewPrompt } from "../src/prompt";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.log("SKIP: OPENAI_API_KEY not set; skipping live prompt-cache verification.");
  process.exit(0);
}

const DEFAULT_ATTEMPTS = 8;
const DEFAULT_MODEL = "gpt-5";
// mt#1471 forced-pass baseline; mt#2722 AT 2b must stay at/above this.
const EMISSION_BASELINE = 0.8;

function parseArgs(): { attempts: number; model: string } {
  let attempts = DEFAULT_ATTEMPTS;
  let model = DEFAULT_MODEL;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--attempts=")) {
      const parsed = parseInt(arg.slice("--attempts=".length).trim(), 10);
      if (!isNaN(parsed) && parsed > 0) attempts = parsed;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length).trim();
    }
  }
  return { attempts, model };
}

// A tiny, self-contained synthetic diff — enough to exercise a real review
// without needing GitHub. Identical across every attempt so the whole prompt
// prefix is stable (the precondition for cross-review cache hits).
const SYNTHETIC_DIFF = `diff --git a/src/util/add.ts b/src/util/add.ts
index 1111111..2222222 100644
--- a/src/util/add.ts
+++ b/src/util/add.ts
@@ -1,3 +1,3 @@
-export function add(a: number, b: number): number {
-  return a - b;
+export function add(a: number, b: number): number {
+  return a + b;
 }
`;

interface AttemptRecord {
  attempt: number;
  cachedTokens: number;
  promptTokens: number;
  emittedConclude: boolean;
  emittedDocImpact: boolean;
}

async function main() {
  const { attempts, model } = parseArgs();
  const runStartedAt = new Date().toISOString();

  // Stable prefix: tools active + output tools active, no prior reviews.
  const systemPrompt = buildCriticConstitution(true, "normal", true, false);
  const userPrompt = buildReviewPrompt({
    prNumber: 0,
    prTitle: "mt#2722 prompt-cache verification (synthetic)",
    prBody: "Synthetic PR used only to exercise the live review path.",
    taskSpec: null,
    diff: SYNTHETIC_DIFF,
    authorshipTier: 3,
    branchName: "verify/prompt-cache",
    baseBranch: "main",
  });

  const client = new OpenAI({ apiKey: OPENAI_API_KEY as string });
  const stubTools = {
    readFile: async (_path: string) => null,
    listDirectory: async (_path: string) => null,
  };

  console.log("=== Prompt-cache hygiene verification (mt#2722) ===");
  console.log(`Model: ${model}`);
  console.log(`Attempts: ${attempts} (identical prefix each attempt)`);
  console.log(`Total reviews: ${attempts} — consumes real API tokens.`);
  console.log("");

  const records: AttemptRecord[] = [];
  for (let i = 0; i < attempts; i++) {
    const attempt = i + 1;
    const output = await callOpenAIWithClient(client, model, systemPrompt, userPrompt, stubTools);
    const cachedTokens = output.usage?.cachedTokens ?? 0;
    const promptTokens = output.usage?.promptTokens ?? 0;
    const emittedConclude = output.toolCalls.some((tc) => tc.name === "conclude_review");
    const emittedDocImpact = output.toolCalls.some(
      (tc) => tc.name === "submit_documentation_impact"
    );
    records.push({ attempt, cachedTokens, promptTokens, emittedConclude, emittedDocImpact });
    console.log(
      `  attempt ${attempt}/${attempts}: cachedTokens=${cachedTokens} promptTokens=${promptTokens} ` +
        `conclude=${emittedConclude ? "Y" : "N"} docImpact=${emittedDocImpact ? "Y" : "N"}`
    );
  }

  // AT 3 — cross-review cache hit: at least one attempt AFTER the first shows
  // cached_tokens > 0.
  const laterAttempts = records.slice(1);
  const maxLaterCached = laterAttempts.reduce((m, r) => Math.max(m, r.cachedTokens), 0);
  const at3Pass = laterAttempts.some((r) => r.cachedTokens > 0);

  // AT 2b — forced-pass emission stays at/above the mt#1471 baseline.
  const concludeRate = records.filter((r) => r.emittedConclude).length / records.length;
  const docImpactRate = records.filter((r) => r.emittedDocImpact).length / records.length;
  const at2bPass = concludeRate >= EMISSION_BASELINE && docImpactRate >= EMISSION_BASELINE;

  const result = {
    runStartedAt,
    model,
    attempts,
    at3: { pass: at3Pass, maxCachedTokensAfterFirst: maxLaterCached },
    at2b: {
      pass: at2bPass,
      baseline: EMISSION_BASELINE,
      concludeRate,
      docImpactRate,
    },
    records,
  };

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const outputPath = join(scriptDir, "verify-prompt-cache-results.json");
  writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");

  console.log("\n=== Summary ===");
  console.log(
    `AT 3 (cross-review cache hit): ${at3Pass ? "PASS" : "FAIL"} ` +
      `(max cached_tokens after first attempt = ${maxLaterCached})`
  );
  console.log(
    `AT 2b (forced-pass emission >= ${EMISSION_BASELINE}): ${at2bPass ? "PASS" : "FAIL"} ` +
      `(conclude=${concludeRate.toFixed(2)} docImpact=${docImpactRate.toFixed(2)})`
  );
  console.log(`\nResults written to: ${outputPath}`);

  if (!at2bPass) {
    console.error(
      "\nFAIL: forced-pass emission regressed below baseline after the tools-array widening. " +
        "Apply the mt#2722 Contingency: revert the two `tools: ALL_TOOL_DEFINITIONS` lines in " +
        "forceConcludeReview / forceDocumentationImpact (keep change (a): cache_key + retention)."
    );
    process.exit(1);
  }
  if (!at3Pass) {
    console.error(
      "\nFAIL: no cross-review cache hit observed. Check that prompt_cache_key is stable across " +
        "attempts and that the prefix (systemPrompt + tools) is byte-identical."
    );
    process.exit(1);
  }

  console.log("\nPASS: cross-review caching works and forced-pass emission holds at baseline.");
  process.exit(0);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("verify-prompt-cache error:", message);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
