/**
 * Session PR List Command
 */

import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import { type SessionCommandDependencies, withErrorLogging } from "./types";
import { sessionPrListCommandParams } from "./session-parameters";
import { sessionPrList } from "../../../../domain/session/commands/pr-subcommands";
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

export function createSessionPrListCommand(deps: SessionCommandDependencies): CommandDefinition {
  return {
    id: "session.pr.list",
    category: CommandCategory.SESSION,
    name: "list",
    description: "List all pull requests associated with sessions",
    parameters: sessionPrListCommandParams,
    execute: withErrorLogging("session.pr.list", async (params: Record<string, unknown>) => {
      try {
        const result = await sessionPrList(
          {
            session: params.session as string | undefined,
            task: params.task as string | undefined,
            status: params.status as string | undefined,
            backend: params.backend as "github" | "remote" | "local" | undefined,
            since: params.since as string | undefined,
            until: params.until as string | undefined,
            repo: params.repo as string | undefined,
            json: params.json as boolean | undefined,
            verbose: params.verbose as boolean | undefined,
          },
          { sessionDB: deps.sessionProvider }
        );

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
