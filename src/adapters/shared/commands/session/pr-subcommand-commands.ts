/**
 * Session PR Subcommand CLI Commands
 * Restructure session pr command with explicit subcommands
 */

import { z } from "zod";
import { BaseSessionCommand, type SessionCommandDependencies } from "./base-session-command";
import { type CommandExecutionContext } from "../../command-registry";
import {
  MinskyError,
  SessionConflictError,
  ValidationError,
  getErrorMessage,
} from "../../../../errors/index";
import {
  sessionPrCreateCommandParams,
  sessionPrEditCommandParams,
  sessionPrListCommandParams,
  sessionPrGetCommandParams,
  sessionPrOpenCommandParams,
} from "./session-parameters";
import {
  sessionPrCreate,
  sessionPrEdit,
  sessionPrList,
  sessionPrGet,
  sessionPrOpen,
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
    // Validation: require title and body/bodyPath for new PR creation
    if (!params.title) {
      throw new ValidationError(
        'Title is required for pull request creation.\nPlease provide:\n  --title <text>       PR title\n\nExample:\n  minsky session pr create --title "feat: Add new feature"'
      );
    }

    if (!params.body && !params.bodyPath) {
      throw new ValidationError(
        'PR description is required for new pull request creation.\nPlease provide one of:\n  --body <text>       Direct PR body text\n  --body-path <path>  Path to file containing PR body\n\nExample:\n  minsky session pr create --title "feat: Add new feature" --body "This PR adds..."\n  minsky session pr create --title "fix: Bug fix" --body-path process/tasks/189/pr.md\n\nNote: To update an existing PR, use \'session pr edit\' instead.'
      );
    }

    // Check if PR already exists and fail
    await this.validateNoPrExists(params);

    try {
      // For MCP interface, resolve session workspace directory
      let workingDirectory = process.cwd();
      const interfaceType = context.interface as "cli" | "mcp";

      if (interfaceType === "mcp") {
        // For MCP, resolve the session workspace path from session parameters
        const { createSessionProvider } = await import("../../../../domain/session");
        const sessionProvider = createSessionProvider();

        // Try to get session name from params or resolve from task
        let sessionName = params.name;
        if (!sessionName && params.task) {
          const { resolveSessionContextWithFeedback } = await import(
            "../../../../domain/session/session-context-resolver"
          );
          const resolvedContext = await resolveSessionContextWithFeedback({
            task: params.task,
            repo: params.repo,
            sessionProvider,
            allowAutoDetection: false, // No auto-detection for MCP
          });
          sessionName = resolvedContext.sessionName;
        }

        if (sessionName) {
          workingDirectory = await sessionProvider.getRepoPath(
            await sessionProvider.getSession(sessionName)
          );
        }
      }

      const result = await sessionPrCreate(
        {
          title: params.title,
          body: params.body,
          bodyPath: params.bodyPath,
          name: params.name,
          task: params.task,
          repo: params.repo,
          noStatusUpdate: params.noStatusUpdate,
          debug: params.debug,

          autoResolveDeleteConflicts: params.autoResolveDeleteConflicts,
          skipConflictCheck: params.skipConflictCheck,
          draft: params.draft,
        },
        {
          interface: interfaceType,
          workingDirectory,
        }
      );

      return this.createSuccessResult(result);
    } catch (error) {
      throw this.handlePrError(error, params);
    }
  }

  private async validateNoPrExists(params: any): Promise<void> {
    // Check if there's already an existing PR and fail if so
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

    // If no session name resolved yet, try task-to-session resolution
    if (!sessionName && params.task) {
      try {
        const { resolveSessionContextWithFeedback } = await import(
          "../../../../domain/session/session-context-resolver"
        );
        const { createSessionProvider } = await import("../../../../domain/session");

        const sessionProvider = createSessionProvider();
        const resolvedContext = await resolveSessionContextWithFeedback({
          session: params.name,
          task: params.task,
          repo: params.repo,
          sessionProvider,
          allowAutoDetection: true,
        });

        sessionName = resolvedContext.sessionName;
      } catch (error) {
        // If session resolution fails, continue with PR creation
        return;
      }
    }

    if (!sessionName) {
      return;
    }

    try {
      // Check if session has an existing PR
      const { createSessionProvider } = await import("../../../../domain/session");
      const sessionDB = createSessionProvider();
      const sessionRecord = await sessionDB.getSession(sessionName);

      // If session has PR state, a PR already exists
      if (sessionRecord && sessionRecord.prState && sessionRecord.prBranch) {
        throw new ValidationError(
          `A pull request already exists for session '${sessionName}' (branch: ${sessionRecord.prBranch}).\nTo update the existing PR, use:\n  minsky session pr edit --title "new title" --body "new body"\n  minsky session pr edit --body-path path/to/description.md`
        );
      }
    } catch (error) {
      // If it's our validation error, re-throw it
      if (error instanceof ValidationError) {
        throw error;
      }
      // If we can't verify session state, continue with PR creation
      return;
    }
  }

  private handlePrError(error: any, params: any): Error {
    const errorMessage = getErrorMessage(error);

    // Handle specific error types with friendly messages
    if (error instanceof SessionConflictError) {
      // Pass through SessionConflictError as-is - it has proper messaging
      return error;
    } else if (errorMessage.includes("CONFLICT") || errorMessage.includes("conflict")) {
      return new MinskyError(
        `🔥 Git merge conflict detected while creating PR branch.\n\nThis usually happens when:\n• The PR branch already exists with different content\n• There are conflicting changes between your session and the base branch\n\n💡 Quick fixes:\n• Resolve conflicts manually and retry\n• Use --auto-resolve-delete-conflicts for simple conflicts\n\nTechnical details: ${errorMessage}`
      );
    } else if (errorMessage.includes("Failed to create prepared merge commit")) {
      return new MinskyError(
        `❌ Failed to create PR branch merge commit.\n\nThis could be due to:\n• Merge conflicts between your session branch and base branch\n• Remote PR branch already exists with different content\n• Network issues with git operations\n\n💡 Try these solutions:\n• Run 'git status' to check for conflicts\n• Resolve conflicts in your session branch first\n• Check your git remote connection\n\nTechnical details: ${errorMessage}`
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
        `❌ Failed to create session PR: ${errorMessage}\n\n💡 Troubleshooting:\n• Check that you're in a session workspace\n• Verify all files are committed\n• Try running with --debug for more details\n• Check 'minsky session list' to see available sessions\n\nNeed help? Run the command with --debug for detailed error information.`
      );
    }
  }

  protected getAdditionalLogContext(params: any): Record<string, any> {
    return {
      title: params.title,
      hasBody: !!params.body,
      hasBodyPath: !!params.bodyPath,
    };
  }
}

/**
 * Session PR Edit Command
 * Updates an existing PR for a session
 */
export class SessionPrEditCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.pr.edit";
  }

  getCommandName(): string {
    return "edit";
  }

  getCommandDescription(): string {
    return "Update an existing pull request for a session";
  }

  getParameterSchema(): Record<string, any> {
    return sessionPrEditCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    // Validate that at least one field is provided for updating
    if (!params.title && !params.body && !params.bodyPath) {
      throw new ValidationError(
        'At least one field must be provided to update the PR:\n  --title <text>       Update PR title\n  --body <text>        Update PR body text\n  --body-path <path>   Update PR body from file\n\nExample:\n  minsky session pr edit --title "feat: Updated feature"\n  minsky session pr edit --body-path process/tasks/189/pr.md'
      );
    }

    try {
      // For MCP interface, resolve session workspace directory
      let workingDirectory = process.cwd();
      const interfaceType = context.interface as "cli" | "mcp";

      if (interfaceType === "mcp") {
        // For MCP, resolve the session workspace path from session parameters
        const { createSessionProvider } = await import("../../../../domain/session");
        const sessionProvider = createSessionProvider();

        // Try to get session name from params or resolve from task
        let sessionName = params.name;
        if (!sessionName && params.task) {
          const { resolveSessionContextWithFeedback } = await import(
            "../../../../domain/session/session-context-resolver"
          );
          const resolvedContext = await resolveSessionContextWithFeedback({
            task: params.task,
            repo: params.repo,
            sessionProvider,
            allowAutoDetection: false, // No auto-detection for MCP
          });
          sessionName = resolvedContext.sessionName;
        }

        if (sessionName) {
          workingDirectory = await sessionProvider.getRepoPath(
            await sessionProvider.getSession(sessionName)
          );
        }
      }

      const result = await sessionPrEdit(
        {
          title: params.title,
          body: params.body,
          bodyPath: params.bodyPath,
          name: params.name,
          task: params.task,
          repo: params.repo,
          debug: params.debug,
        },
        {
          interface: interfaceType,
          workingDirectory,
        }
      );

      return {
        success: true,
        prBranch: result.prBranch,
        baseBranch: result.baseBranch,
        title: result.title,
        body: result.body,
        updated: result.updated,
      };
    } catch (error) {
      throw this.handlePrError(error, params);
    }
  }

  private handlePrError(error: any, params: any): Error {
    const errorMessage = getErrorMessage(error);

    // Handle specific error types with friendly messages
    if (error instanceof SessionConflictError) {
      // Pass through SessionConflictError as-is - it has proper messaging
      return error;
    } else if (errorMessage.includes("CONFLICT") || errorMessage.includes("conflict")) {
      return new MinskyError(
        `🔥 Git merge conflict detected while updating PR.\n\nThis usually happens when:\n• There are conflicting changes between your session and the base branch\n• The PR branch has diverged from your session\n\n💡 Quick fixes:\n• Resolve conflicts manually and retry\n• Check the current state of your PR branch\n\nTechnical details: ${errorMessage}`
      );
    } else if (errorMessage.includes("No pull request found")) {
      return new MinskyError(
        `🔍 No PR found for this session.\n\nThe session '${params.name || params.task}' doesn't have an existing pull request to edit.\n\n💡 Try:\n• Create a PR first: minsky session pr create --title "..." --body "..."\n• Check available PRs: minsky session pr list\n• Verify you're in the correct session\n\nTechnical details: ${errorMessage}`
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
        `❌ Failed to edit session PR: ${errorMessage}\n\n💡 Troubleshooting:\n• Check that you're in a session workspace\n• Verify the session has an existing PR\n• Try running with --debug for more details\n• Check 'minsky session pr list' to see available PRs\n\nNeed help? Run the command with --debug for detailed error information.`
      );
    }
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

      // Human-friendly list output
      const { pullRequests } = result;

      if (pullRequests.length === 0) {
        return this.createSuccessResult({
          message: "No pull requests found for the specified criteria.",
        });
      }

      const lines: string[] = [];
      pullRequests.forEach((pr) => {
        const title = pr.title.length > 80 ? `${pr.title.substring(0, 77)}...` : pr.title;
        const headerParts: string[] = [];
        headerParts.push(pr.prNumber ? `PR #${pr.prNumber}` : "PR");
        if (pr.status) headerParts.push(pr.status);
        lines.push(`${headerParts.join(" ")} - ${title}`);

        const details: string[] = [];
        details.push(`Session: ${pr.sessionName}`);
        if (pr.taskId) details.push(`Task: ${pr.taskId}`);
        if (pr.updatedAt) details.push(`Updated: ${this.formatRelativeTime(pr.updatedAt)}`);
        if (params.verbose && pr.branch) details.push(`Branch: ${pr.branch}`);
        lines.push(details.join("  "));

        if (params.verbose && pr.url) {
          lines.push(`URL: ${pr.url}`);
        }

        lines.push("");
      });

      const count = pullRequests.length;
      lines.push(`${count} pull request${count === 1 ? "" : "s"} found`);

      return this.createSuccessResult({
        message: lines.join("\n"),
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
        `${pullRequest.number ? `PR #${pullRequest.number}: ` : ""}${pullRequest.title}`,
        "",
        `Session:     ${pullRequest.sessionName}`,
        `Task:        ${pullRequest.taskId || "none"}`,
        `Status:      ${pullRequest.status}`,
        `Created:     ${pullRequest.createdAt || "unknown"}`,
        `Updated:     ${pullRequest.updatedAt || "unknown"}`,
      ];

      // Show branch info only if it differs from the session name (avoid redundant noise)
      if (pullRequest.branch && pullRequest.branch !== pullRequest.sessionName) {
        output.splice(4, 0, `Branch:      ${pullRequest.branch}`);
      }

      if (pullRequest.url) {
        output.push(`URL:         ${pullRequest.url}`);
      }

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
 * Session PR Open Command
 * Opens the pull request in the default web browser
 */
export class SessionPrOpenCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.pr.open";
  }

  getCommandName(): string {
    return "open";
  }

  getCommandDescription(): string {
    return "Open the pull request in the default web browser";
  }

  getParameterSchema(): Record<string, any> {
    return sessionPrOpenCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    try {
      const result = await sessionPrOpen({
        sessionName: params.sessionName,
        name: params.name,
        task: params.task,
        repo: params.repo,
      });

      return this.createSuccessResult({
        message: `✅ Opened PR #${result.prNumber || "N/A"} for session '${result.sessionName}' in browser\n🔗 ${result.url}`,
        url: result.url,
        sessionName: result.sessionName,
        prNumber: result.prNumber,
      });
    } catch (error) {
      throw new MinskyError(`Failed to open session PR: ${getErrorMessage(error)}`);
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

export const createSessionPrOpenCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrOpenCommand(deps);
