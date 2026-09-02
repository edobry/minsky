/**
 * Session PR Checks Command
 *
 * Adapter command that surfaces CI check-run status for a session PR.
 */

import { CommandCategory, type CommandDefinition } from "../../command-registry";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "@minsky/domain/errors/index";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { sessionPrChecksCommandParams } from "./session-parameters";
import { sessionPrChecks, trimChecksResult } from "@minsky/domain/session/commands/pr-subcommands";
import type { TrimmedChecksResult } from "@minsky/domain/session/commands/pr-subcommands";
import type { CheckRunResult, ChecksResult } from "@minsky/domain/repository/github-pr-checks";
import { McpErrorCode } from "@minsky/domain/errors/mcp-error-codes";
import { mcpStructuredError } from "@minsky/domain/errors/mcp-structured-errors";
import { classifyOctokitOriginReadError, withOriginalMessage } from "./merge-error-classification";

// ── Formatting helpers ───────────────────────────────────────────────────

const ICON_PASS = "✓";
const ICON_FAIL = "✗";
const ICON_PENDING = "⏳";

function checkIcon(check: CheckRunResult): string {
  if (check.status !== "completed") return ICON_PENDING;
  if (
    check.conclusion === "success" ||
    check.conclusion === "neutral" ||
    check.conclusion === "skipped"
  ) {
    return ICON_PASS;
  }
  return ICON_FAIL;
}

function formatCheckLine(check: CheckRunResult): string {
  const icon = checkIcon(check);
  const conclusion = check.conclusion ? ` (${check.conclusion})` : ` (${check.status})`;
  const url = check.url ? `  ${check.url}` : "";
  return `  ${icon} ${check.name}${conclusion}${url}`;
}

/**
 * The one-line verdict shown above the per-check breakdown.
 *
 * Extracted as a pure function (PR #3042 R1) so it can be tested without
 * patching the domain call the command reaches itself — the functional-core
 * shape `testing-standards.mdc §Testable Design` prescribes.
 *
 * What is load-bearing is that the `mergeBlocked` branch EXISTS at all, ahead
 * of the final fallthrough. Before R1 there was no such branch, so a
 * merge-blocked result — `allPassed` false, no timeout, both counts zero —
 * matched none of the others and landed on "0 check(s) pending", which reads
 * as "CI is still starting" for a PR whose CI can never start.
 *
 * Its POSITION among the first three is not load-bearing, and a negative
 * control proved it: demoting the branch to just above the fallthrough left
 * every test passing. Stated because the first draft of this comment claimed
 * the opposite, and running the control is what corrected it.
 */
export function formatChecksStatusLine(result: {
  allPassed: boolean;
  timedOut?: boolean;
  mergeBlocked?: string;
  summary: { failed: number; pending: number };
}): string {
  const { allPassed, timedOut, mergeBlocked, summary } = result;
  if (mergeBlocked) {
    return `${ICON_FAIL} Checks cannot be read as merge-readiness — ${mergeBlocked}`;
  }
  if (allPassed) return `${ICON_PASS} All checks passed`;
  if (timedOut) return `${ICON_PENDING} Timed out — ${summary.pending} check(s) still pending`;
  if (summary.failed > 0) return `${ICON_FAIL} ${summary.failed} check(s) failed`;
  return `${ICON_PENDING} ${summary.pending} check(s) pending`;
}

/**
 * Choose the structured (`json`) payload: trimmed by default, full on request.
 *
 * **Why trimmed (mt#4657).** Measured over the 387 real results this tool
 * produced into `agent_transcript_turns`: on the 324 all-green ones, 308
 * consuming turns called `session_pr_merge` next and NONE referenced an
 * individual check — the per-check array was read by nobody. On the 63
 * non-green ones the caller drills into a failing job with
 * `forge_ci_run_view_log`, taking its `runId` from a check URL; all 11 observed
 * drill-downs are recoverable from the non-passing entries alone (a workflow
 * run's id appears on its failing jobs too), so `failingChecks` preserves every
 * one. Effect: the green case goes from ~3,437 chars to a constant 155; overall
 * 3,497 -> 253, a 92.8% cut on a result paid 434 times in the corpus.
 *
 * **This reverses a deliberate earlier decision, on evidence that postdates
 * it.** mt#2656 built {@link trimChecksResult}, applied it to `session.pr.drive`
 * and recorded that `session.pr.checks` "keeps its existing full-detail
 * output". The corpus measurement above did not exist until mt#4418
 * (2026-08-26). Reusing that function rather than writing a second projection
 * is what keeps the two commands' trimmed shape one contract.
 *
 * **The CLI is unaffected.** Only the structured branch routes through here;
 * the text branch below still renders every check, so the CLI's DEFAULT path
 * loses nothing. Per ADR-039 the suppression is also DECLARED rather than
 * inferred — the trimmed payload names itself by carrying `failingChecks`
 * instead of `checks`, and `fullBody: true` restores the full breakdown
 * (the same opt-out `session_pr_wait-for-review` and `session_pr_drive` carry).
 *
 * Extracted as a pure function so the choice is observable without patching
 * the domain call the command reaches itself (`testing-standards.mdc
 * §Testable Design`), mirroring mt#4417's `shapeCommitResultForTransport`.
 */
export function shapeChecksResultForStructuredOutput(
  result: ChecksResult,
  fullBody: boolean | undefined
): ChecksResult | TrimmedChecksResult {
  return fullBody ? result : trimChecksResult(result);
}

// ── Command factory ──────────────────────────────────────────────────────

export function createSessionPrChecksCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.pr.checks",
    category: CommandCategory.SESSION,
    name: "checks",
    description: "Get CI check status for a session pull request",
    parameters: sessionPrChecksCommandParams,
    execute: withErrorLogging("session.pr.checks", async (params: Record<string, unknown>, ctx) => {
      try {
        const deps = await getDeps();
        const result = await sessionPrChecks(
          {
            sessionId: params.sessionId as string | undefined,
            task: params.task as string | undefined,
            repo: params.repo as string | undefined,
            wait: params.wait as boolean | undefined,
            timeoutSeconds: params.timeoutSeconds as number | undefined,
            intervalSeconds: params.intervalSeconds as number | undefined,
          },
          // mt#2677: thread the MCP progress reporter (when the caller
          // requested one) through to the checks-wait poll loop.
          { sessionDB: deps.sessionProvider, onProgress: ctx?.onProgress }
        );

        if (params.json) {
          return {
            success: true,
            ...shapeChecksResultForStructuredOutput(result, params.fullBody as boolean | undefined),
          };
        }

        // --- Text output ---
        const { summary, checks } = result;
        const statusLine = formatChecksStatusLine(result);

        const summaryLine =
          `Checks: ${summary.total} total, ` +
          `${summary.passed} passed, ` +
          `${summary.failed} failed, ` +
          `${summary.pending} pending`;

        const lines: string[] = [statusLine, summaryLine, ""];

        if (checks.length === 0) {
          lines.push("  (no checks reported)");
        } else {
          for (const check of checks) {
            lines.push(formatCheckLine(check));
          }
        }

        return { success: true, message: lines.join("\n") };
      } catch (error) {
        // ORDERING (mt#2888, fixed per PR #2018 R1): preserve already
        // domain-typed errors (ResourceNotFoundError — missing session/PR;
        // ValidationError) FIRST, unchanged — classification never runs on
        // them, so a domain error whose message happens to mention "rate
        // limit" for unrelated reasons can never be reclassified into a
        // transport-error shape. Then classify what's LEFT using a TIGHT
        // match on handleOctokitError's exact headline text
        // (classifyOctokitOriginReadError — see merge-error-
        // classification.ts's module doc for why this is narrower than
        // classifyMergeError). Anything that doesn't match either headline
        // falls through to the original generic MinskyError wrap, matching
        // this site's behavior before mt#2888 touched it.
        if (error instanceof ResourceNotFoundError || error instanceof ValidationError) {
          throw error;
        }

        const errorClass = classifyOctokitOriginReadError(error);
        const originalMessage = error instanceof Error ? error.message : String(error);

        if (errorClass.kind === "rate-limit") {
          throw mcpStructuredError({
            code: McpErrorCode.RATE_LIMITED,
            summary: withOriginalMessage(
              "GitHub API rate limit exceeded while fetching PR checks — wait a few minutes before retrying",
              originalMessage
            ),
            details: { originalMessage },
          });
        }
        if (errorClass.kind === "degraded") {
          const statusSuffix = errorClass.status ? ` (HTTP ${errorClass.status})` : "";
          throw mcpStructuredError({
            code: McpErrorCode.SERVICE_DEGRADED,
            summary: withOriginalMessage(
              `GitHub API degraded/unavailable while fetching PR checks${statusSuffix}`,
              originalMessage
            ),
            details: { originalMessage },
          });
        }

        throw new MinskyError(`Failed to get session PR checks: ${getErrorMessage(error)}`);
      }
    }),
  };
}
