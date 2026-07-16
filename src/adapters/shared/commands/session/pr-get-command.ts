/**
 * Session PR Get Command
 */

import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { MinskyError, getErrorMessage } from "@minsky/domain/errors/index";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { sessionPrGetCommandParams } from "./session-parameters";
import { sessionPrGet } from "@minsky/domain/session/commands/pr-subcommands";
import { formatPrTitleLine } from "./pr-shared-helpers";

export function createSessionPrGetCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.pr.get",
    category: CommandCategory.SESSION,
    name: "get",
    description: "Get detailed information about a session pull request",
    parameters: sessionPrGetCommandParams,
    execute: withErrorLogging("session.pr.get", async (params: Record<string, unknown>) => {
      try {
        const deps = await getDeps();
        const result = await sessionPrGet(
          {
            sessionId: params.sessionId as string | undefined,
            task: params.task as string | undefined,
            repo: params.repo as string | undefined,
            json: params.json as boolean | undefined,
            status: params.status as string | undefined,
            since: params.since as string | undefined,
            until: params.until as string | undefined,
            content: params.content as boolean | undefined,
            reviews: params.reviews as boolean | undefined,
          },
          { sessionDB: deps.sessionProvider }
        );

        if (params.json) {
          return { success: true, ...result };
        }

        const { pullRequest, reviews, reviewsFetchError } = result;

        const titleLine = formatPrTitleLine({
          status: pullRequest.status,
          rawTitle: pullRequest.title,
          prNumber: pullRequest.number,
          taskId: pullRequest.taskId,
          sessionId: pullRequest.sessionId,
        });

        const output = [
          titleLine,
          "",
          `Session:     ${pullRequest.sessionId}`,
          `Task:        ${pullRequest.taskId || "none"}`,
          `Status:      ${pullRequest.status}`,
          `Created:     ${pullRequest.createdAt || "unknown"}`,
          `Updated:     ${pullRequest.updatedAt || "unknown"}`,
        ];

        if (pullRequest.branch && pullRequest.branch !== pullRequest.sessionId) {
          output.splice(4, 0, `Branch:      ${pullRequest.branch}`);
        }

        if (pullRequest.url) {
          output.push(`URL:         ${pullRequest.url}`);
        }

        if ((pullRequest as { description?: string }).description) {
          output.push("", "Description:");
          output.push((pullRequest as { description?: string }).description ?? "");
        }

        if (pullRequest.filesChanged) {
          output.push("", `Files Changed: ${pullRequest.filesChanged}`);
        }

        if (reviewsFetchError) {
          // mt#2829 PR #1970 R1: never render this as "Reviews (0)" — that
          // would be indistinguishable from a confirmed-zero-reviews PR.
          output.push("", `Reviews: COULD NOT FETCH — ${reviewsFetchError}`);
        }

        if (reviews) {
          output.push("", `Reviews (${reviews.length}):`);
          if (reviews.length === 0) {
            output.push("  (none posted)");
          }
          for (const review of reviews) {
            output.push(
              "",
              `  [${review.state}] ${review.reviewerLogin ?? "(unknown)"} — ${review.submittedAt ?? "unknown time"}`
            );
            if (review.htmlUrl) {
              output.push(`  ${review.htmlUrl}`);
            }
            if (review.body) {
              output.push(...review.body.split("\n").map((line) => `    ${line}`));
            }
            for (const comment of review.comments) {
              output.push(
                `    - ${comment.path}:${comment.line ?? comment.originalLine ?? "?"} — ${comment.body}`
              );
            }
          }
        }

        return { success: true, message: output.join("\n") };
      } catch (error) {
        throw new MinskyError(`Failed to get session PR: ${getErrorMessage(error)}`);
      }
    }),
  };
}
