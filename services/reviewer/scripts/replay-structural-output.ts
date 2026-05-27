#!/usr/bin/env bun
/**
 * Replay-verification script for the structural-output CoT leak fix (mt#1395/mt#1403).
 *
 * Replays a set of PRs that historically leaked chain-of-thought into the posted review
 * body (mt#1264 corpus), verifies that the new structural-output path (composeReviewBody)
 * prevents CoT from reaching the posted body.
 *
 * Key claim under test:
 *   - output.text (the scratch channel) may still contain CoT → sanitizer may fire
 *   - composeReviewBody(output.toolCalls) MUST NOT contain CoT → sanitizer must NOT fire
 *
 * The script does NOT post anything to GitHub. It only:
 *   - Fetches PR diffs via the GitHub API (read-only, uses GITHUB_TOKEN)
 *   - Calls the OpenAI API to run the reviewer (uses OPENAI_API_KEY)
 *   - Writes results to services/reviewer/scripts/replay-results.json
 *
 * Usage:
 *   bun services/reviewer/scripts/replay-structural-output.ts
 *   bun services/reviewer/scripts/replay-structural-output.ts --prs=793,794
 *   bun services/reviewer/scripts/replay-structural-output.ts --attempts=5 --model=gpt-4o
 *
 * Skip gracefully when OPENAI_API_KEY or GITHUB_TOKEN is absent.
 *
 * mt#1403 context: These PRs (793, 794, 800, 743, 758) cover both skill-PR and code-PR
 * CoT leak patterns observed in the minsky-reviewer[bot] corpus.
 */

import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callOpenAIWithClient } from "../src/providers";
import { composeReviewBody } from "../src/compose-review";
import { sanitizeReviewBody } from "../src/sanitize";
import { buildCriticConstitution, buildReviewPrompt } from "../src/prompt";
import {
  buildAttemptResult,
  aggregateSummary,
  type PerPrResult,
  type ReplayRunResult,
} from "../src/replay-summary";

// ---------------------------------------------------------------------------
// Environment gating
// ---------------------------------------------------------------------------

import { resolveGitHubTokenOrSkip } from "./harness-auth";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.log("SKIP: OPENAI_API_KEY not set; skipping live replay test.");
  process.exit(0);
}

const GITHUB_TOKEN = resolveGitHubTokenOrSkip();

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

// Default: the canonical mt#1264 + mt#1333 CoT leak corpus
const DEFAULT_PR_NUMBERS = [793, 794, 800, 743, 758];
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MODEL = "gpt-5";

function parseArgs(): { prNumbers: number[]; attemptsPerPR: number; model: string } {
  const args = process.argv.slice(2);
  let prNumbers = DEFAULT_PR_NUMBERS;
  let attemptsPerPR = DEFAULT_ATTEMPTS;
  let model = DEFAULT_MODEL;

  for (const arg of args) {
    if (arg.startsWith("--prs=")) {
      const raw = arg.slice("--prs=".length);
      prNumbers = raw
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));
    } else if (arg.startsWith("--attempts=")) {
      const raw = arg.slice("--attempts=".length);
      const parsed = parseInt(raw.trim(), 10);
      if (!isNaN(parsed) && parsed > 0) attemptsPerPR = parsed;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length).trim();
    }
  }

  return { prNumbers, attemptsPerPR, model };
}

// ---------------------------------------------------------------------------
// GitHub fetch helpers
// ---------------------------------------------------------------------------

const OWNER = "edobry";
const REPO = "minsky";

interface FetchedPRContext {
  prNumber: number;
  title: string;
  body: string;
  branchName: string;
  baseBranch: string;
  diff: string;
}

async function fetchPRForReplay(octokit: Octokit, prNumber: number): Promise<FetchedPRContext> {
  const [prResponse, diffResponse] = await Promise.all([
    octokit.rest.pulls.get({ owner: OWNER, repo: REPO, pull_number: prNumber }),
    octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: OWNER,
      repo: REPO,
      pull_number: prNumber,
      mediaType: { format: "diff" },
    }),
  ]);

  const pr = prResponse.data;
  const diff = String(diffResponse.data);

  return {
    prNumber,
    title: pr.title,
    body: pr.body ?? "",
    branchName: pr.head.ref,
    baseBranch: pr.base.ref,
    diff,
  };
}

// ---------------------------------------------------------------------------
// Main replay logic
// ---------------------------------------------------------------------------

async function replayPR(
  openaiClient: OpenAI,
  model: string,
  ctx: FetchedPRContext,
  attemptsPerPR: number,
  failures: Array<{ prNumber: number; attempt: number; composedBody: string; reason: string }>
): Promise<PerPrResult> {
  const systemPrompt = buildCriticConstitution(true, "normal", true);

  const userPrompt = buildReviewPrompt({
    prNumber: ctx.prNumber,
    prTitle: ctx.title,
    prBody: ctx.body,
    taskSpec: null,
    diff: ctx.diff,
    authorshipTier: 3, // All corpus PRs were agent-authored
    branchName: ctx.branchName,
    baseBranch: ctx.baseBranch,
  });

  const attempts = [];

  for (let i = 0; i < attemptsPerPR; i++) {
    const attemptNum = i + 1;
    console.log(`  Attempt ${attemptNum}/${attemptsPerPR}...`);

    const output = await callOpenAIWithClient(openaiClient, model, systemPrompt, userPrompt, {
      // Provide stub tool context (no actual file read capability in replay)
      readFile: async (_path: string) => null,
      listDirectory: async (_path: string) => null,
    });

    const composed = composeReviewBody(output.toolCalls);
    const scratchSanitized = sanitizeReviewBody(output.text);
    const postedBodySanitized = sanitizeReviewBody(composed.body);

    const attemptResult = buildAttemptResult(
      attemptNum,
      output.toolCalls,
      output.text,
      scratchSanitized.action,
      postedBodySanitized.action
    );

    attempts.push(attemptResult);

    // Log per-attempt summary
    console.log(
      `    toolCalls=${output.toolCalls.length} scratchSanitize=${scratchSanitized.action} postedBodySanitize=${postedBodySanitized.action} blockingCount=${attemptResult.blockingFindingCount} concludeEvent=${attemptResult.concludeEvent}`
    );

    // Record failures (this is the verification signal)
    if (postedBodySanitized.action !== "passthrough") {
      console.error(
        `    FAIL: PR #${ctx.prNumber} attempt ${attemptNum}: postedBodySanitize=${postedBodySanitized.action} (reason: ${postedBodySanitized.meta.reason})`
      );
      failures.push({
        prNumber: ctx.prNumber,
        attempt: attemptNum,
        composedBody: composed.body,
        reason: postedBodySanitized.meta.reason ?? "unknown",
      });
    }

    // Log scratch sanitizer fires for calibration (not a failure)
    if (scratchSanitized.action !== "passthrough") {
      console.log(
        `    INFO: scratch channel CoT detected (expected; does not affect posted body): ${scratchSanitized.meta.reason}`
      );
    }

    // Log token usage
    if (output.usage) {
      const u = output.usage;
      console.log(
        `    tokens: prompt=${u.promptTokens ?? "?"} completion=${u.completionTokens ?? "?"} reasoning=${u.reasoningTokens ?? "?"} total=${u.totalTokens ?? "?"}`
      );
    }
  }

  return { prNumber: ctx.prNumber, attempts };
}

async function main() {
  const { prNumbers, attemptsPerPR, model } = parseArgs();

  const runStartedAt = new Date().toISOString();

  console.log("=== Structural Output CoT Leak Replay Verification ===");
  console.log(`Model: ${model}`);
  console.log(`PRs: ${prNumbers.join(", ")}`);
  console.log(`Attempts per PR: ${attemptsPerPR}`);
  console.log(`Total API calls: ${prNumbers.length * attemptsPerPR}`);
  console.log("");
  console.log(
    "NOTE: This replay will consume real API tokens. Estimated cost varies by model and diff size."
  );
  console.log("");

  // Both env vars were checked above (process.exit on missing), so they are
  // non-null here. Assign to typed locals to avoid non-null assertions.
  const openaiApiKey: string = OPENAI_API_KEY;
  const openaiClient = new OpenAI({ apiKey: openaiApiKey });
  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  const perPR: PerPrResult[] = [];
  const failures: Array<{
    prNumber: number;
    attempt: number;
    composedBody: string;
    reason: string;
  }> = [];

  for (const prNumber of prNumbers) {
    console.log(`\nPR #${prNumber}:`);

    let ctx: FetchedPRContext;
    try {
      ctx = await fetchPRForReplay(octokit, prNumber);
      console.log(`  Title: ${ctx.title}`);
      console.log(`  Diff length: ${ctx.diff.length} chars`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR fetching PR #${prNumber}: ${message}`);
      // Skip this PR but continue with others
      perPR.push({ prNumber, attempts: [] });
      continue;
    }

    const prResult = await replayPR(openaiClient, model, ctx, attemptsPerPR, failures);
    perPR.push(prResult);
  }

  const summary = aggregateSummary(perPR, attemptsPerPR);

  // Build the full run result
  const runResult: ReplayRunResult = {
    runStartedAt,
    model,
    summary,
    perPR,
  };

  // Write JSON output
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const outputPath = join(scriptDir, "replay-results.json");
  writeFileSync(outputPath, JSON.stringify(runResult, null, 2), "utf-8");

  // Print summary
  console.log("\n=== Replay Summary ===");
  console.log(`PRs tested: ${summary.prsTested}`);
  console.log(`Attempts per PR: ${summary.attemptsPerPR}`);
  console.log(`Total attempts: ${summary.totalAttempts}`);
  console.log(`Scratch sanitizer fires: ${summary.scratchSanitizerFires}`);
  console.log(`Posted-body sanitizer fires: ${summary.postedBodySanitizerFires}`);
  console.log(
    `Structural fix verified: ${summary.structuralFixVerified ? "YES" : "NO (FAILURES DETECTED)"}`
  );
  console.log(`\nResults written to: ${outputPath}`);

  if (failures.length > 0) {
    console.error(`\n=== FAILURES (${failures.length}) ===`);
    for (const f of failures) {
      console.error(
        `  PR #${f.prNumber} attempt ${f.attempt}: postedBodySanitize fired (${f.reason})`
      );
      console.error(`  Composed body excerpt (first 300 chars):`);
      console.error(`    ${f.composedBody.slice(0, 300)}`);
    }
    console.error("\nFAIL: The structural fix did NOT prevent all CoT leaks into the posted body.");
    console.error(
      "Review the failures above and investigate `compose-review.ts` and `output-tools.ts`."
    );
    process.exit(1);
  }

  console.log(
    "\nPASS: All attempts passed. The structural fix successfully prevents CoT from reaching the posted body."
  );
  process.exit(0);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Replay script error:", message);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
