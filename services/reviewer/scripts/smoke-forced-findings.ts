#!/usr/bin/env bun
/**
 * Live smoke for the mt#2926 post-loop forced-findings pass.
 *
 * ## What only a live run can answer
 *
 * `forced-findings-guard.test.ts` pins the trigger predicate and
 * `providers.test.ts` pins the wiring against a fake client — between them the
 * pass provably fires on the right shape and appends what the model returns.
 * Neither can answer the question the design actually rests on:
 *
 *   **Given a `tool_choice` pinned to `submit_finding` and a conclusion
 *   summary describing issues in prose, does gpt-5 return a parseable
 *   `submit_finding` call with a REAL file and line?**
 *
 * That is a property of the model, not of our code. mem#614 established the
 * same question for the two existing forced passes empirically
 * (`verify-prompt-cache.ts`, 6/6 emission on gpt-5 with the full tools array
 * plus a pinned tool_choice) rather than by assumption, and this script is the
 * same measurement for the third pass.
 *
 * ## What it deliberately does NOT cover
 *
 * It mirrors `forceFindings`'s request construction — same reminder builder,
 * same full tools array, same pin — but calls the API directly rather than
 * driving `callOpenAIWithClient`. So it exercises the MODEL's half, not
 * providers.ts's own wiring; the six tests in `providers.test.ts` cover that
 * half. Stated rather than implied, because a smoke that looks end-to-end and
 * is not is worse than one whose bound is written down.
 *
 * ## Usage
 *
 *   OPENAI_API_KEY=<key> bun services/reviewer/scripts/smoke-forced-findings.ts [--attempts=3]
 *
 * Exits 0 when every attempt emitted at least one parseable finding, 2 when
 * any attempt did not, and 0 with a SKIP notice when no key is present (so it
 * is safe in an unkeyed CI job). Writes
 * `services/reviewer/scripts/smoke-forced-findings-results.json`.
 */

import OpenAI from "openai";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseToolCall } from "../src/output-tools";
import { ALL_TOOL_DEFINITIONS } from "../src/providers";
import { buildForcedFindingsUserMessage } from "../src/forced-findings-guard";

const MODEL = process.env["SMOKE_MODEL"] ?? "gpt-5";

/**
 * A conclusion summary in the exact shape the incident produced: prose naming
 * concrete, file-level defects with no structured finding behind them. Taken
 * from review 5116536812 on PR #3623 (2026-09-04), lightly trimmed.
 */
const CONCLUSION_SUMMARY =
  "Request changes. While the PR addresses SC1-SC6 with coherent code and tests, two risks " +
  "should be resolved before merge: (1) Pre-commit target gating in src/hooks/pre-commit.ts now " +
  "depends on the recorded harness; when no harness is recorded, behavior diverges from " +
  "claude-code expectations, and nothing warns. (2) packages/domain/src/init.ts's merge fallback " +
  "on an unreadable config proceeds to overwrite with only a log warning; introduce a stronger " +
  "signal or fail with a flag to prevent silent data loss in non-interactive/CI contexts.";

/**
 * A minimal prior turn so the forced call has a review-shaped conversation to
 * sit on, mirroring what the real loop leaves behind.
 */
const SYSTEM_PROMPT =
  "You are an adversarial code reviewer. You emit findings through structured tool calls.";
const USER_PROMPT =
  "Review this PR. It changes src/hooks/pre-commit.ts (harness-gated compile targets) and " +
  "packages/domain/src/init.ts (init --overwrite now merges config instead of replacing it).";

interface AttemptResult {
  attempt: number;
  toolCallsReturned: number;
  findingsParsed: number;
  /** Every finding's location, so a reader can see whether they are real paths. */
  locations: Array<{ file: string; line: number; severity: string }>;
  sentinelLocations: number;
  error?: string;
}

function parseAttempts(argv: string[]): number {
  const arg = argv.find((a) => a.startsWith("--attempts="));
  if (!arg) return 3;
  const n = Number.parseInt(arg.slice("--attempts=".length), 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

async function runAttempt(client: OpenAI, attempt: number): Promise<AttemptResult> {
  const result: AttemptResult = {
    attempt,
    toolCallsReturned: 0,
    findingsParsed: 0,
    locations: [],
    sentinelLocations: 0,
  };

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 4000,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: USER_PROMPT },
        { role: "assistant", content: "I have finished reviewing." },
        { role: "user", content: buildForcedFindingsUserMessage(CONCLUSION_SUMMARY) },
      ],
      tools: ALL_TOOL_DEFINITIONS,
      tool_choice: { type: "function", function: { name: "submit_finding" } },
    });

    const toolCalls = response.choices[0]?.message?.tool_calls ?? [];
    result.toolCallsReturned = toolCalls.length;

    for (const toolCall of toolCalls) {
      if (toolCall.type !== "function") continue;
      if (toolCall.function.name !== "submit_finding") continue;
      try {
        const parsed = parseToolCall("submit_finding", toolCall.function.arguments);
        if (parsed.name !== "submit_finding") continue;
        result.findingsParsed += 1;
        result.locations.push({
          file: parsed.args.file,
          line: parsed.args.line,
          severity: parsed.args.severity,
        });
        // The whole point of the pass is a REAL location rather than the
        // mt#2685 placeholder's "(review summary)" sentinel. Counted so a
        // regression to sentinel-shaped output is visible in the artifact
        // rather than hiding inside a passing findingsParsed count.
        if (parsed.args.file === "(review summary)") result.sentinelLocations += 1;
      } catch (err: unknown) {
        result.error = `parse_error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

async function main(): Promise<void> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    console.log("SKIP: OPENAI_API_KEY not set — live forced-findings smoke not run.");
    process.exit(0);
  }

  const attempts = parseAttempts(process.argv.slice(2));
  const client = new OpenAI({ apiKey });

  console.log(`=== mt#2926 forced-findings live smoke (${MODEL}, ${attempts} attempts) ===`);

  const results: AttemptResult[] = [];
  for (let i = 1; i <= attempts; i++) {
    const result = await runAttempt(client, i);
    results.push(result);
    const verdict = result.findingsParsed > 0 ? "PASS" : "FAIL";
    console.log(
      `attempt ${i}: ${verdict} — ${result.findingsParsed} finding(s) parsed from ` +
        `${result.toolCallsReturned} tool call(s)${result.error ? ` [${result.error}]` : ""}`
    );
    for (const loc of result.locations) {
      console.log(`    ${loc.severity} ${loc.file}:${loc.line}`);
    }
  }

  const passed = results.filter((r) => r.findingsParsed > 0).length;
  const sentinel = results.reduce((n, r) => n + r.sentinelLocations, 0);

  console.log(`\n=== Result: ${passed}/${attempts} attempts emitted >= 1 parseable finding ===`);
  if (sentinel > 0) {
    console.log(`WARNING: ${sentinel} finding(s) used the "(review summary)" sentinel location.`);
  }

  const outPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "smoke-forced-findings-results.json"
  );
  writeFileSync(
    outPath,
    JSON.stringify(
      { model: MODEL, attempts, passed, sentinelLocations: sentinel, results },
      null,
      2
    )
  );
  console.log(`Results written to: ${outPath}`);

  process.exit(passed === attempts ? 0 : 2);
}

if (import.meta.main) {
  await main();
}
