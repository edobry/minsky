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
import { sessionPrChecks } from "@minsky/domain/session/commands/pr-subcommands";
import type { CheckRunResult } from "@minsky/domain/repository/github-pr-checks";
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
          return { success: true, ...result };
        }

        // --- Text output ---
        const { summary, checks, allPassed, timedOut } = result;

        const statusLine = allPassed
          ? `${ICON_PASS} All checks passed`
          : timedOut
            ? `${ICON_PENDING} Timed out — ${summary.pending} check(s) still pending`
            : summary.failed > 0
              ? `${ICON_FAIL} ${summary.failed} check(s) failed`
              : `${ICON_PENDING} ${summary.pending} check(s) pending`;

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
