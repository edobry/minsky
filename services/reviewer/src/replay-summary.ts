/**
 * Pure helper functions for aggregating replay-verification results.
 *
 * Extracted from `scripts/replay-structural-output.ts` to enable unit testing
 * of the summarization logic without real API calls.
 *
 * See mt#1403 for context. The replay script (scripts/replay-structural-output.ts)
 * is the consumer; this module contains only the pure aggregate helpers.
 */

import type { ReviewToolCall } from "./output-tools";
import type { SanitizeAction } from "./sanitize";

// ---------------------------------------------------------------------------
// Per-attempt result shape
// ---------------------------------------------------------------------------

export interface AttemptResult {
  attempt: number;
  toolCallCount: number;
  scratchTextLength: number;
  scratchSanitize: SanitizeAction;
  postedBodySanitize: SanitizeAction;
  blockingFindingCount: number;
  concludeEvent: string;
}

// ---------------------------------------------------------------------------
// Per-PR result shape
// ---------------------------------------------------------------------------

export interface PerPrResult {
  prNumber: number;
  attempts: AttemptResult[];
}

// ---------------------------------------------------------------------------
// Top-level summary shape
// ---------------------------------------------------------------------------

export interface ReplaySummary {
  prsTested: number;
  attemptsPerPR: number;
  totalAttempts: number;
  scratchSanitizerFires: number;
  postedBodySanitizerFires: number;
  structuralFixVerified: boolean;
}

// ---------------------------------------------------------------------------
// Full run result (written to JSON file and stdout)
// ---------------------------------------------------------------------------

export interface ReplayRunResult {
  runStartedAt: string;
  model: string;
  summary: ReplaySummary;
  perPR: PerPrResult[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build one `AttemptResult` from raw per-attempt data.
 *
 * @param attemptIndex - 1-based attempt number
 * @param toolCalls - accumulated tool calls from the model response
 * @param scratchText - the free-text output.text (scratch channel)
 * @param scratchSanitize - result of running sanitizeReviewBody on output.text
 * @param postedBodySanitize - result of running sanitizeReviewBody on the composed body
 */
export function buildAttemptResult(
  attemptIndex: number,
  toolCalls: ReviewToolCall[],
  scratchText: string,
  scratchSanitize: SanitizeAction,
  postedBodySanitize: SanitizeAction
): AttemptResult {
  const blockingFindingCount = toolCalls.filter(
    (tc) => tc.name === "submit_finding" && tc.args.severity === "BLOCKING"
  ).length;

  const concludeCall = toolCalls.filter((tc) => tc.name === "conclude_review").at(-1);

  const concludeEvent = concludeCall ? concludeCall.args.event : "NONE";

  return {
    attempt: attemptIndex,
    toolCallCount: toolCalls.length,
    scratchTextLength: scratchText.length,
    scratchSanitize,
    postedBodySanitize,
    blockingFindingCount,
    concludeEvent,
  };
}

/**
 * Aggregate per-PR results into a summary.
 *
 * @param perPR - list of per-PR results (each with an attempts array)
 * @param attemptsPerPR - expected number of attempts per PR (for summary fields)
 */
export function aggregateSummary(perPR: PerPrResult[], attemptsPerPR: number): ReplaySummary {
  const prsTested = perPR.length;
  const totalAttempts = perPR.reduce((sum, pr) => sum + pr.attempts.length, 0);

  let scratchSanitizerFires = 0;
  let postedBodySanitizerFires = 0;

  for (const pr of perPR) {
    for (const attempt of pr.attempts) {
      if (attempt.scratchSanitize !== "passthrough") {
        scratchSanitizerFires += 1;
      }
      if (attempt.postedBodySanitize !== "passthrough") {
        postedBodySanitizerFires += 1;
      }
    }
  }

  return {
    prsTested,
    attemptsPerPR,
    totalAttempts,
    scratchSanitizerFires,
    postedBodySanitizerFires,
    structuralFixVerified: postedBodySanitizerFires === 0,
  };
}
