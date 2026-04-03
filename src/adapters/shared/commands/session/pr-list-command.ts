/**
 * Session PR List Command
 * Lists PRs across sessions
 */

import {
  BaseSessionCommand,
  type BaseSessionCommandParams,
  type SessionCommandDependencies,
} from "./base-session-command";
import { type CommandExecutionContext } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import { sessionPrListCommandParams } from "./session-parameters";
import { sessionPrList } from "../../../../domain/session/commands/pr-subcommands";
import { formatPrTitleLine } from "./pr-shared-helpers";

/**
 * Parameters for session PR list command
 */
interface SessionPrListParams extends BaseSessionCommandParams {
  session?: string;
  status?: string;
  backend?: string;
  since?: string;
  until?: string;
  verbose?: boolean;
}

export class SessionPrListCommand extends BaseSessionCommand<
  SessionPrListParams,
  Record<string, unknown>
> {
  getCommandId(): string {
    return "session.pr.list";
  }

  getCommandName(): string {
    return "list";
  }

  getCommandDescription(): string {
    return "List all pull requests associated with sessions";
  }

  getParameterSchema(): Record<string, unknown> {
    return sessionPrListCommandParams;
  }

  async executeCommand(
    params: SessionPrListParams,
    _context: CommandExecutionContext
  ): Promise<Record<string, unknown>> {
    try {
      const result = await sessionPrList({
        session: params.session,
        task: params.task,
        status: params.status,
        backend: params.backend as "github" | "remote" | "local" | undefined,
        since: params.since,
        until: params.until,
        repo: params.repo,
        json: params.json,
        verbose: params.verbose,
      });

      if (params.json) {
        return this.createSuccessResult(result);
      }

      // Human-friendly list output
      const { pullRequests } = result;

      if (pullRequests.length === 0) {
        return this.createSuccessResult({
          message: "No pull requests found for the specified criteria.",
        });
      }

      // Sort by most recently updated first
      const sorted = [...pullRequests].sort((a, b) => {
        const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return bt - at;
      });

      const lines: string[] = [];
      sorted.forEach((pr) => {
        const displayId = pr.taskId || pr.sessionName || "";
        const titleLine = formatPrTitleLine({
          status: pr.status,
          rawTitle: pr.title || "",
          prNumber: pr.prNumber !== undefined ? Number(pr.prNumber) : undefined,
          taskId: pr.taskId,
          sessionName: pr.sessionName,
        });
        lines.push(titleLine);

        // Second line: Session, Branch (if different from session), PR number, Updated
        const details: string[] = [];
        if (pr.sessionName) {
          const shouldShowSession =
            pr.sessionName !== displayId && !(pr.taskId && pr.sessionName.includes(pr.taskId));
          if (shouldShowSession) {
            details.push(`Session: ${pr.sessionName}`);
          }
        }
        if (pr.branch && pr.branch !== pr.sessionName) details.push(`Branch: ${pr.branch}`);
        if (pr.updatedAt) details.push(`Updated: ${this.formatRelativeTime(pr.updatedAt)}`);
        if (details.length > 0) lines.push(details.join("  "));

        // Third line: URL on its own line (no label)
        if (pr.url) lines.push(pr.url);

        // Spacer between entries
        lines.push("");
      });

      // Trim trailing spacer
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

      return this.createSuccessResult({ message: lines.join("\n") });
    } catch (error) {
      throw new MinskyError(`Failed to list session PRs: ${getErrorMessage(error)}`);
    }
  }

  private formatRelativeTime(isoString: string): string {
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
}

export const createSessionPrListCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrListCommand(deps);
