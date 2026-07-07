/**
 * Session PR Drive Command (mt#2647)
 *
 * Adapter command exposing the convergence-tail driver
 * (`sessionPrDrive` / `sessionPrDrivePostMerge`) as a single MCP tool with a
 * `postMerge` mode flag. See `packages/domain/src/session/commands/pr-drive-subcommand.ts`
 * for the DESIGN DECISION note on why this tool never calls `session.pr.merge`
 * itself (harness-side merge-gate hooks match on the `session_pr_merge` tool
 * name — a server-side merge call here would bypass every one of them).
 */

import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { MinskyError, ResourceNotFoundError, getErrorMessage } from "@minsky/domain/errors/index";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { sessionPrDriveCommandParams } from "./session-parameters";
import {
  sessionPrDrive,
  type SessionPrDriveResult,
} from "@minsky/domain/session/commands/pr-drive-subcommand";
import { sessionPrDrivePostMerge } from "@minsky/domain/session/commands/pr-drive-post-merge-subcommand";

/**
 * Render the text-mode message for the convergence-tail mode's terminal
 * state. Exported for unit testing.
 */
export function formatDriveMessage(result: SessionPrDriveResult): string {
  switch (result.state) {
    case "READY_TO_MERGE": {
      const checksLine = result.checks
        ? `  Checks:   ${result.checks.summary.passed}/${result.checks.summary.total} passed`
        : "  Checks:   skipped (skipChecks)";
      return [
        `✓ READY_TO_MERGE`,
        `  Review:   APPROVED by ${result.review.reviewerLogin ?? "unknown"}`,
        checksLine,
        `  Elapsed:  ${Math.round(result.elapsedMs / 1000)}s`,
        "",
        "Next step: call session.pr.merge — this tool never merges for you " +
          "(so harness-side merge gates fire normally).",
      ].join("\n");
    }
    case "CHANGES_REQUESTED":
    case "COMMENT": {
      const label = result.state === "CHANGES_REQUESTED" ? "CHANGES_REQUESTED" : "COMMENT";
      return [
        `⏹ ${label} — stopping, not merging`,
        `  Reviewer: ${result.review.reviewerLogin ?? "unknown"}`,
        result.review.submittedAt ? `  Submitted: ${result.review.submittedAt}` : undefined,
        result.review.htmlUrl ? `  URL:       ${result.review.htmlUrl}` : undefined,
        "",
        result.review.body
          ? result.review.body.split("\n").slice(0, 40).join("\n")
          : "  (empty review body)",
        "",
        `Re-invoke with since: "${result.review.submittedAt ?? ""}" after pushing a fix.`,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    }
    case "UNRECOGNIZED_REVIEW_STATE": {
      return (
        `⏹ Review state "${result.review.state}" is not a recognized approval — stopping, not merging.\n` +
        `  Reviewer: ${result.review.reviewerLogin ?? "unknown"}`
      );
    }
    case "CHECKS_FAILED":
    case "CHECKS_TIMEOUT": {
      const label = result.state === "CHECKS_FAILED" ? "checks failed" : "checks timed out";
      return [
        `⏹ Review APPROVED but ${label} — stopping, not merging`,
        `  Checks: ${result.checks.summary.passed}/${result.checks.summary.total} passed, ` +
          `${result.checks.summary.failed} failed, ${result.checks.summary.pending} pending`,
      ].join("\n");
    }
    case "REVIEW_TIMEOUT": {
      return (
        `⏳ No matching review after ${Math.round(result.elapsedMs / 1000)}s ` +
        `(${result.pollCount} poll(s)). Threshold (since): ${result.sinceUsed}`
      );
    }
    default: {
      // Exhaustiveness guard — a new state added to the union without a
      // matching case here is a compile error, not a silent fallthrough.
      const _exhaustive: never = result;
      return `Unrecognized drive result: ${JSON.stringify(_exhaustive)}`;
    }
  }
}

export function createSessionPrDriveCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.pr.drive",
    category: CommandCategory.SESSION,
    name: "drive",
    description:
      "Drive an in-review session PR through the convergence tail (review-wait -> " +
      "checks-wait), returning a terminal state (READY_TO_MERGE / CHANGES_REQUESTED / " +
      "COMMENT / CHECKS_FAILED / CHECKS_TIMEOUT / REVIEW_TIMEOUT). Never merges — call " +
      "session.pr.merge yourself on READY_TO_MERGE so every merge-gate hook still fires. " +
      "Pass postMerge: true to instead run the post-merge deploy-watch mode (call this " +
      "AFTER your own merge succeeds).",
    parameters: sessionPrDriveCommandParams,
    execute: withErrorLogging("session.pr.drive", async (params: Record<string, unknown>) => {
      try {
        const deps = await getDeps();

        if (params.postMerge) {
          const result = await sessionPrDrivePostMerge(
            {
              sessionId: params.sessionId as string | undefined,
              task: params.task as string | undefined,
              repo: params.repo as string | undefined,
              services: params.services as string[] | undefined,
              deployTimeoutSeconds: params.deployTimeoutSeconds as number | undefined,
              deployIntervalSeconds: params.deployIntervalSeconds as number | undefined,
            },
            { sessionDB: deps.sessionProvider }
          );

          if (params.json) {
            return { success: true, ...result };
          }

          if (result.skipped) {
            return {
              success: true,
              message: `⏹ Nothing to watch — ${result.skipReason}.`,
            };
          }

          const lines = [
            `Watched ${result.watchedServices.length} service(s): ${result.watchedServices.join(", ")}`,
            "",
            ...result.results.map(
              (r) =>
                `  ${r.deployment.status === "SUCCESS" ? "✓" : "✗"} ${r.service}: ${r.deployment.status}${
                  r.deployment.url ? ` (${r.deployment.url})` : ""
                }`
            ),
          ];
          return { success: true, message: lines.join("\n") };
        }

        const result = await sessionPrDrive(
          {
            sessionId: params.sessionId as string | undefined,
            task: params.task as string | undefined,
            repo: params.repo as string | undefined,
            reviewer: params.reviewer as string | undefined,
            since: params.since as string | undefined,
            requireCurrentHead: params.requireCurrentHead as boolean | undefined,
            reviewTimeoutSeconds: params.reviewTimeoutSeconds as number | undefined,
            reviewIntervalSeconds: params.reviewIntervalSeconds as number | undefined,
            checksTimeoutSeconds: params.checksTimeoutSeconds as number | undefined,
            checksIntervalSeconds: params.checksIntervalSeconds as number | undefined,
            skipChecks: params.skipChecks as boolean | undefined,
          },
          { sessionDB: deps.sessionProvider }
        );

        if (params.json) {
          return { success: true, ...result };
        }
        return { success: true, message: formatDriveMessage(result) };
      } catch (error) {
        if (error instanceof ResourceNotFoundError || error instanceof MinskyError) {
          throw error;
        }
        throw new MinskyError(`Failed to drive session PR: ${getErrorMessage(error)}`);
      }
    }),
  };
}
