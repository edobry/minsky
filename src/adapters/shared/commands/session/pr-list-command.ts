/**
 * Session PR List Command
 */

import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { MinskyError, getErrorMessage } from "@minsky/domain/errors/index";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { sessionPrListCommandParams } from "./session-parameters";
import { sessionPrList } from "@minsky/domain/session/commands/pr-subcommands";
import { formatPrTitleLine } from "./pr-shared-helpers";

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours === 0) {
      const diffMinutes = Math.floor(diffMs / (1000 * 60));
      return `${diffMinutes}m ago`;
    }
    return `${diffHours}h ago`;
  } else if (diffDays === 1) {
    return "1 day ago";
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    const diffWeeks = Math.floor(diffDays / 7);
    return `${diffWeeks} week${diffWeeks > 1 ? "s" : ""} ago`;
  }
}

/**
 * Maps the `session.pr.list` command params to the domain `sessionPrList` filter args.
 *
 * Extracted + exported for regression testing (mt#2516): the command's parameter
 * schema (`sessionPrListCommandParams`) exposes the identity key as `sessionId`, so
 * the handler MUST read `params.sessionId`. The prior code read `params.session`,
 * which is never populated — silently dropping the session filter.
 */
export function mapSessionPrListParams(params: Record<string, unknown>) {
  return {
    session: params.sessionId as string | undefined,
    task: params.task as string | undefined,
    status: params.status as string | undefined,
    backend: params.backend as "github" | undefined,
    since: params.since as string | undefined,
    until: params.until as string | undefined,
    repo: params.repo as string | undefined,
    json: params.json as boolean | undefined,
    verbose: params.verbose as boolean | undefined,
  };
}

/**
 * @param listFn injectable domain call — defaults to the real `sessionPrList`; the
 *   default keeps existing one-arg callers working, and lets tests stub the domain
 *   call to assert the command honors the `sessionId` filter at the execute boundary.
 */
export function createSessionPrListCommand(
  getDeps: LazySessionDeps,
  listFn: typeof sessionPrList = sessionPrList
): CommandDefinition {
  return {
    id: "session.pr.list",
    category: CommandCategory.SESSION,
    name: "list",
    description: "List all pull requests associated with sessions",
    parameters: sessionPrListCommandParams,
    execute: withErrorLogging("session.pr.list", async (params: Record<string, unknown>) => {
      try {
        const deps = await getDeps();
        const result = await listFn(mapSessionPrListParams(params), {
          sessionDB: deps.sessionProvider,
        });

        if (params.json) {
          return { success: true, ...result };
        }

        const { pullRequests } = result;

        if (pullRequests.length === 0) {
          return {
            success: true,
            message: "No pull requests found for the specified criteria.",
          };
        }

        const sorted = [...pullRequests].sort((a, b) => {
          const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return bt - at;
        });

        const lines: string[] = [];
        sorted.forEach((pr) => {
          const displayId = pr.taskId || pr.sessionId || "";
          const titleLine = formatPrTitleLine({
            status: pr.status,
            rawTitle: pr.title || "",
            prNumber: pr.prNumber !== undefined ? Number(pr.prNumber) : undefined,
            taskId: pr.taskId,
            sessionId: pr.sessionId,
          });
          lines.push(titleLine);

          const details: string[] = [];
          if (pr.sessionId) {
            const shouldShowSession =
              pr.sessionId !== displayId && !(pr.taskId && pr.sessionId.includes(pr.taskId));
            if (shouldShowSession) {
              details.push(`Session: ${pr.sessionId}`);
            }
          }
          if (pr.branch && pr.branch !== pr.sessionId) details.push(`Branch: ${pr.branch}`);
          if (pr.updatedAt) details.push(`Updated: ${formatRelativeTime(pr.updatedAt)}`);
          if (details.length > 0) lines.push(details.join("  "));

          if (pr.url) lines.push(pr.url);

          lines.push("");
        });

        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

        return { success: true, message: lines.join("\n") };
      } catch (error) {
        throw new MinskyError(`Failed to list session PRs: ${getErrorMessage(error)}`);
      }
    }),
  };
}
