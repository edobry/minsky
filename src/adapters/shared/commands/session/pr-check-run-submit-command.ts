/**
 * Session PR Check Run Submit Command
 *
 * Adapter command that exposes session.pr.check_run.submit as an MCP tool
 * (mcp__minsky__session_pr_check_run_submit). Posts a GitHub Check Run for
 * the session's PR, compiling the reviewer's findings list into check-run
 * annotations through Minsky, using the bot / service-account identity.
 *
 * @see mt#1346
 */

import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { MinskyError, getErrorMessage } from "@minsky/domain/errors/index";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { sessionPrCheckRunSubmitCommandParams } from "./session-parameters";
import { sessionPrCheckRunSubmit } from "@minsky/domain/session/commands/pr-check-run-submit-subcommand";
import type { ReviewFinding } from "@minsky/domain/session/commands/pr-check-run-submit-subcommand";

export function createSessionPrCheckRunSubmitCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.pr.check_run.submit",
    category: CommandCategory.SESSION,
    name: "check-run-submit",
    description:
      "Submit a GitHub Check Run for a session's PR, compiling reviewer findings into " +
      "check-run annotations (machine-shaped, branch-protection-eligible surface). " +
      "Severity mapping: BLOCKING → failure, NON-BLOCKING → warning, other → notice. " +
      "Conclusion: failure if any BLOCKING; neutral if only NON-BLOCKING; success if empty.",
    parameters: sessionPrCheckRunSubmitCommandParams,
    mutating: true,
    execute: withErrorLogging(
      "session.pr.check_run.submit",
      async (params: Record<string, unknown>) => {
        try {
          const deps = await getDeps();

          const result = await sessionPrCheckRunSubmit(
            {
              sessionId: params.sessionId as string | undefined,
              task: params.task as string | undefined,
              repo: params.repo as string | undefined,
              findings: params.findings as ReviewFinding[],
              checkRunName: params.checkRunName as string | undefined,
            },
            { sessionDB: deps.sessionProvider }
          );

          return {
            success: true,
            checkRunId: result.checkRunId,
            htmlUrl: result.htmlUrl,
            conclusion: result.conclusion,
            annotationCount: result.annotationCount,
            prNumber: result.prNumber,
            sessionId: result.sessionId,
          };
        } catch (error) {
          throw new MinskyError(`Failed to submit PR check run: ${getErrorMessage(error)}`);
        }
      }
    ),
  };
}
