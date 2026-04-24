/**
 * Session PR Checks Command
 *
 * Adapter command that surfaces CI check-run status for a session PR.
 */

import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { sessionPrChecksCommandParams } from "./session-parameters";
import { sessionPrChecks } from "../../../../domain/session/commands/pr-subcommands";
import type { CheckRunResult } from "../../../../domain/repository/github-pr-checks";

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
    execute: withErrorLogging("session.pr.checks", async (params: Record<string, unknown>) => {
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
          { sessionDB: deps.sessionProvider }
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
        throw new MinskyError(`Failed to get session PR checks: ${getErrorMessage(error)}`);
      }
    }),
  };
}
