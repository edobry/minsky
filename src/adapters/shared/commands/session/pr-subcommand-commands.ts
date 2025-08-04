/**
 * Session PR Subcommand CLI Commands
 * Restructure session pr command with explicit subcommands
 */

import { z } from "zod";
import { BaseSessionCommand, type SessionCommandDependencies } from "./base-session-command";
import { type CommandExecutionContext } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import {
  sessionPrCreateCommandParams,
  sessionPrListCommandParams,
  sessionPrGetCommandParams,
} from "./session-parameters";
import {
  sessionPrCreate,
  sessionPrList,
  sessionPrGet,
} from "../../../../domain/session/commands/pr-subcommands";

/**
 * Session PR Create Command
 * Replaces the current 'session pr' command
 */
export class SessionPrCreateCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.pr.create";
  }

  getCommandName(): string {
    return "create";
  }

  getCommandDescription(): string {
    return "Create a pull request for a session";
  }

  getParameterSchema(): Record<string, any> {
    return sessionPrCreateCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    // Conditional validation: require body/bodyPath only for new PRs
    if (!params.body && !params.bodyPath) {
      const canRefresh = await this.checkIfPrCanBeRefreshed(params);

      if (!canRefresh) {
        throw new Error(
          'PR description is required for new pull request creation.\nPlease provide one of:\n  --body <text>       Direct PR body text\n  --body-path <path>  Path to file containing PR body\n\nExample:\n  minsky session pr create --title "feat: Add new feature" --body "This PR adds..."\n  minsky session pr create --title "fix: Bug fix" --body-path process/tasks/189/pr.md\n\nNote: If updating an existing PR, the body requirement is optional.'
        );
      }
    }

    try {
      const result = await sessionPrCreate({
        title: params.title,
        body: params.body,
        bodyPath: params.bodyPath,
        name: params.name,
        task: params.task,
        repo: params.repo,
        noStatusUpdate: params.noStatusUpdate,
        debug: params.debug,
        skipUpdate: params.skipUpdate,
        autoResolveDeleteConflicts: params.autoResolveDeleteConflicts,
        skipConflictCheck: params.skipConflictCheck,
      });

      return this.createSuccessResult(result);
    } catch (error) {
      throw this.handlePrError(error, params);
    }
  }

  private async checkIfPrCanBeRefreshed(params: any): Promise<boolean> {
    // Check if there's a valid existing PR registered in the session record
    // This allows updates to existing PRs without requiring body again
    const currentDir = process.cwd();
    const isSessionWorkspace = currentDir.includes("/sessions/");

    let sessionName = params.name;
    if (!sessionName && isSessionWorkspace) {
      // Try to detect session name from current directory
      const pathParts = currentDir.split("/");
      const sessionsIndex = pathParts.indexOf("sessions");
      if (sessionsIndex >= 0 && sessionsIndex < pathParts.length - 1) {
        sessionName = pathParts[sessionsIndex + 1];
      }
    }

    if (!sessionName) {
      return false;
    }

    try {
      // Check if session has a valid PR record (not just stale branches)
      const { createSessionProvider } = await import("../../../../domain/session");
      const sessionDB = createSessionProvider();
      const sessionRecord = await sessionDB.getSession(sessionName);
      
      // Session must exist and have PR state indicating a valid PR was created
      if (!sessionRecord || !sessionRecord.prState || !sessionRecord.prBranch) {
        return false;
      }

      // Verify the PR branch actually exists (not just stale)
      const { createGitService } = await import("../../../../domain/git");
      const gitService = createGitService();
      const prBranch = sessionRecord.prBranch;

      // Check if branch exists locally or remotely
      const localBranchOutput = await gitService.execInRepository(
        currentDir,
        `git show-ref --verify --quiet refs/heads/${prBranch} || echo "not-exists"`
      );
      const localBranchExists = localBranchOutput.trim() !== "not-exists";

      if (localBranchExists) {
        return true;
      }

      // Check if branch exists remotely
      const remoteBranchOutput = await gitService.execInRepository(
        currentDir,
        `git ls-remote --heads origin ${prBranch}`
      );
      return remoteBranchOutput.trim().length > 0;
    } catch (error) {
      // If we can't verify session/PR state, require body for safety
      return false;
    }
  }

  private handlePrError(error: any, params: any): Error {
    const errorMessage = getErrorMessage(error);

    // Handle specific error types with friendly messages
    if (errorMessage.includes("CONFLICT") || errorMessage.includes("conflict")) {
      return new MinskyError(
        `🔥 Git merge conflict detected while creating PR branch.\n\nThis usually happens when:\n• The PR branch already exists with different content\n• There are conflicting changes between your session and the base branch\n\n💡 Quick fixes:\n• Try with --skip-update to avoid session updates\n• Or manually resolve conflicts and retry\n\nTechnical details: ${errorMessage}`
      );
    } else if (errorMessage.includes("Failed to create prepared merge commit")) {
      return new MinskyError(
        `❌ Failed to create PR branch merge commit.\n\nThis could be due to:\n• Merge conflicts between your session branch and base branch\n• Remote PR branch already exists with different content\n• Network issues with git operations\n\n💡 Try these solutions:\n• Run 'git status' to check for conflicts\n• Use --skip-update to bypass session updates\n• Check your git remote connection\n\nTechnical details: ${errorMessage}`
      );
    } else if (
      errorMessage.includes("Permission denied") ||
      errorMessage.includes("authentication")
    ) {
      return new MinskyError(
        `🔐 Git authentication error.\n\nPlease check:\n• Your SSH keys are properly configured\n• You have push access to the repository\n• Your git credentials are valid\n\nTechnical details: ${errorMessage}`
      );
    } else if (errorMessage.includes("Session") && errorMessage.includes("not found")) {
      return new MinskyError(
        `🔍 Session not found.\n\nThe session '${params.name || params.task}' could not be located.\n\n💡 Try:\n• Check available sessions: minsky session list\n• Verify you're in the correct directory\n• Use the correct session name or task ID\n\nTechnical details: ${errorMessage}`
      );
    } else {
      return new MinskyError(
        `❌ Failed to create session PR.\n\nThe operation failed with: ${errorMessage}\n\n💡 Troubleshooting:\n• Check that you're in a session workspace\n• Verify all files are committed\n• Try running with --debug for more details\n• Check 'minsky session list' to see available sessions\n\nNeed help? Run the command with --debug for detailed error information.`
      );
    }
  }

  protected getAdditionalLogContext(params: any): Record<string, any> {
    return {
      title: params.title,
      hasBody: !!params.body,
      hasBodyPath: !!params.bodyPath,
      skipUpdate: params.skipUpdate,
    };
  }
}

/**
 * Session PR List Command
 * New command for listing PRs across sessions
 */
export class SessionPrListCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.pr.list";
  }

  getCommandName(): string {
    return "list";
  }

  getCommandDescription(): string {
    return "List all pull requests associated with sessions";
  }

  getParameterSchema(): Record<string, any> {
    return sessionPrListCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    try {
      const result = await sessionPrList({
        session: params.session,
        task: params.task,
        status: params.status,
        repo: params.repo,
        json: params.json,
        verbose: params.verbose,
      });

      if (params.json) {
        return this.createSuccessResult(result);
      }

      // Format tabular output
      const { pullRequests } = result;

      if (pullRequests.length === 0) {
        return this.createSuccessResult({
          message: "No pull requests found for the specified criteria.",
        });
      }

      // Format table output
      const headers = ["SESSION", "TASK", "PR#", "STATUS", "TITLE", "UPDATED"];
      const rows = pullRequests.map((pr) => [
        pr.sessionName,
        pr.taskId ? `#${pr.taskId}` : "-",
        pr.prNumber ? `#${pr.prNumber}` : "-",
        pr.status,
        pr.title.length > 40 ? `${pr.title.substring(0, 37)}...` : pr.title,
        pr.updatedAt ? this.formatRelativeTime(pr.updatedAt) : "-",
      ]);

      return this.createSuccessResult({
        table: { headers, rows },
        count: pullRequests.length,
      });
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

/**
 * Session PR Get Command
 * New command for getting detailed PR information
 */
export class SessionPrGetCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.pr.get";
  }

  getCommandName(): string {
    return "get";
  }

  getCommandDescription(): string {
    return "Get detailed information about a session pull request";
  }

  getParameterSchema(): Record<string, any> {
    return sessionPrGetCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    try {
      const result = await sessionPrGet({
        sessionName: params.sessionName,
        name: params.name,
        task: params.task,
        repo: params.repo,
        json: params.json,
        content: params.content,
      });

      if (params.json) {
        return this.createSuccessResult(result);
      }

      // Format detailed output
      const { pullRequest } = result;

      const output = [
        `PR ${pullRequest.number ? `#${pullRequest.number}` : "(no number)"}: ${pullRequest.title}`,
        "",
        `Session:     ${pullRequest.sessionName}`,
        `Task:        ${pullRequest.taskId ? `#${pullRequest.taskId}` : "none"}`,
        `Branch:      ${pullRequest.branch}`,
        `Status:      ${pullRequest.status}`,
        `Created:     ${pullRequest.createdAt || "unknown"}`,
        `Updated:     ${pullRequest.updatedAt || "unknown"}`,
        `URL:         ${pullRequest.url || "not available"}`,
      ];

      if (pullRequest.description) {
        output.push("", "Description:");
        output.push(pullRequest.description);
      }

      if (pullRequest.filesChanged && pullRequest.filesChanged.length > 0) {
        output.push("", `Files Changed: (${pullRequest.filesChanged.length})`);
        pullRequest.filesChanged.slice(0, 10).forEach((file) => {
          output.push(`- ${file}`);
        });
        if (pullRequest.filesChanged.length > 10) {
          output.push(`... and ${pullRequest.filesChanged.length - 10} more files`);
        }
      }

      return this.createSuccessResult({
        message: output.join("\n"),
      });
    } catch (error) {
      throw new MinskyError(`Failed to get session PR: ${getErrorMessage(error)}`);
    }
  }
}

/**
 * Factory functions for creating PR subcommand commands
 */
export const createSessionPrCreateCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrCreateCommand(deps);

export const createSessionPrListCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrListCommand(deps);

export const createSessionPrGetCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrGetCommand(deps);
