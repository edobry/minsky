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
 * Helper to compose and validate conventional commit title
 */
export function composeConventionalTitle(input: {
  type: string | undefined;
  title: string;
  taskId?: string;
}): string {
  const { type, title, taskId } = input;

  // Require type
  if (!type) {
    throw new ValidationError(
      "--type is required. Provide one of: feat, fix, docs, style, refactor, perf, test, chore"
    );
  }

  // Reject titles that already have conventional prefix
  const hasPrefix = /^(?:[a-z]+)(?:\([^)]*\))?:\s*/i.test(title);
  if (hasPrefix) {
    throw new ValidationError(
      "Title should be description only. Do not include conventional prefix like 'feat:' or 'feat(scope):'"
    );
  }

  const scope = taskId ? `(${taskId})` : "";
  return `${type}${scope}: ${title}`.trim();
}

/**
 * Shared helpers for formatting PR titles consistently across commands
 */
function parseConventionalTitleShared(title: string): {
  type?: string;
  scope?: string;
  title: string;
} {
  if (!title) return { title: "" };
  const match =
    title.match(/^([a-z]+)!?\(([^)]*)\):\s*(.*)$/i) || title.match(/^([a-z]+)!?:\s*(.*)$/i);
  if (match) {
    if (match.length === 4) {
      const [, type, scope, rest] = match;
      return { type: type.toLowerCase(), scope, title: rest };
    }
    if (match.length === 3) {
      const [, type, rest] = match;
      return { type: type.toLowerCase(), title: rest };
    }
  }
  return { title };
}

function getStatusIconShared(status?: string): string {
  const normalized = (status || "").toLowerCase();
  switch (normalized) {
    case "open":
      return "🟢";
    case "draft":
      return "📝";
    case "merged":
      return "🟣";
    case "closed":
      return "🔴";
    case "created":
      return "🆕";
    default:
      return "•";
  }
}

function formatPrTitleLineShared(input: {
  status?: string;
  rawTitle: string;
  prNumber?: number;
  taskId?: string;
  sessionName?: string;
}): string {
  const displayId = input.taskId || input.sessionName || "";
  const { type, title: cleanedTitle } = parseConventionalTitleShared(input.rawTitle || "");
  const statusIcon = getStatusIconShared(input.status);

  const idBadge = displayId ? `[${displayId}]` : "";
  const typeBadge = type ? `[${type}]` : "";
  const prSuffix = input.prNumber ? `[#${input.prNumber}]` : "";
  return [statusIcon, typeBadge, idBadge, cleanedTitle, prSuffix]
    .filter((p) => p && p.trim().length > 0)
    .join(" ");
}

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
        'Title is required for pull request creation.\nPlease provide:\n  --title <text>       PR title (description only; do not include "feat:")\n\nExample:\n  minsky session pr create --type feat --title "Add new feature"'
      );
    }

    if (!params.body && !params.bodyPath) {
      throw new ValidationError(
        'PR description is required for new pull request creation.\nPlease provide one of:\n  --body <text>       Direct PR body text\n  --body-path <path>  Path to file containing PR body\n\nExample:\n  minsky session pr create --type feat --title "Add new feature" --body "This PR adds..."\n  minsky session pr create --type fix --title "Bug fix" --body-path process/tasks/189/pr.md\n\nNote: To update an existing PR, use \'session pr edit\' instead.'
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
        const sessionProvider = await createSessionProvider();

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

      // Conventional commit title generation requires --type and forbids prefixed titles
      let finalTitle: string = params.title;
      if (params.type) {
        try {
          const { resolveSessionContextWithFeedback } = await import(
            "../../../../domain/session/session-context-resolver"
          );
          const { createSessionProvider } = await import("../../../../domain/session");
          const { formatTaskIdForDisplay } = await import("../../../../domain/tasks/task-id-utils");

          const sessionProvider = await createSessionProvider();
          const resolved = await resolveSessionContextWithFeedback({
            session: params.name,
            task: params.task,
            repo: params.repo,
            sessionProvider,
            allowAutoDetection: true,
          });

          const taskId: string | undefined = resolved.taskId || params.task;
          finalTitle = composeConventionalTitle({
            type: params.type,
            title: params.title,
            taskId: taskId ? formatTaskIdForDisplay(taskId) : undefined,
          });
        } catch (error) {
          // Use helper to validate and compose without task when resolution fails
          finalTitle = composeConventionalTitle({ type: params.type, title: params.title });
        }
      } else {
        // If no --type provided, enforce requirement per new behavior
        throw new ValidationError(
          "--type is required for session pr create. Provide one of: feat, fix, docs, style, refactor, perf, test, chore"
        );
      }

      const result = await sessionPrCreate(
        {
          title: finalTitle,
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

      // Do not surface local prBranch in CLI result; GitHub backend does not use it
      const { prBranch, ...rest } = result as any;
      return this.createSuccessResult(rest);
    } catch (error) {
      throw this.handlePrError(error, params);
    }
  }

  // Exposed for testing: validate absence of existing PR (previously private)
  async validateNoPrExists(params: any): Promise<void> {
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

        const sessionProvider = await createSessionProvider();
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
      const sessionDB = await createSessionProvider();
      const sessionRecord = await sessionDB.getSession(sessionName);

      // If session has PR state, a PR already exists
      if (sessionRecord && sessionRecord.prState && sessionRecord.prBranch) {
        throw new ValidationError(
          `A pull request already exists for session '${sessionName}' (branch: ${sessionRecord.prBranch}).\nTo update the existing PR, use:\n  minsky session pr edit --title "new title" --body "new body"\n  minsky session pr edit --body-path path/to/spec.md`
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

  // Exposed for testing: method used by tests to check refresh decision
  async checkIfPrCanBeRefreshed(params: any): Promise<boolean> {
    try {
      // Resolve via task or explicit name; do not depend on cwd for testability
      let sessionName: string | undefined = params.name;
      if (!sessionName && params.task) {
        const { resolveSessionContextWithFeedback } = await import(
          "../../../../domain/session/session-context-resolver"
        );
        const { createSessionProvider } = await import("../../../../domain/session");
        const sessionProvider = await createSessionProvider();
        const resolved = await resolveSessionContextWithFeedback({
          session: params.name,
          task: params.task,
          repo: params.repo,
          sessionProvider,
          allowAutoDetection: true,
        });
        sessionName = resolved.sessionName;
      }

      if (!sessionName) return false;

      const { createSessionProvider } = await import("../../../../domain/session");
      const sessionDB = await createSessionProvider();
      const record = await sessionDB.getSession(sessionName);
      return Boolean(record && record.prBranch && record.prState && record.prState.exists);
    } catch {
      return false;
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
        `❌ Failed to create session PR: ${errorMessage}\n\n💡 Troubleshooting:\n• Check that you're in a session workspace\n• Verify all files are committed\n• Try running with --debug for more details\n• Check 'minsky session pr list' to see available sessions\n\nNeed help? Run the command with --debug for detailed error information.`
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
        const sessionProvider = await createSessionProvider();

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

      // Compose or validate title for edit
      let finalTitle: string | undefined = params.title;
      if (params.title) {
        const { assertValidPrTitle } = await import(
          "../../../../domain/session/validation/title-validation"
        );
        // Base title hygiene checks (length, markdown, newlines)
        assertValidPrTitle(params.title);

        if (params.type) {
          try {
            const { resolveSessionContextWithFeedback } = await import(
              "../../../../domain/session/session-context-resolver"
            );
            const { createSessionProvider } = await import("../../../../domain/session");
            const { formatTaskIdForDisplay } = await import(
              "../../../../domain/tasks/task-id-utils"
            );

            const sessionProvider = await createSessionProvider();
            const resolved = await resolveSessionContextWithFeedback({
              session: params.name,
              task: params.task,
              repo: params.repo,
              sessionProvider,
              allowAutoDetection: true,
            });

            const taskId: string | undefined = resolved.taskId || params.task;
            finalTitle = composeConventionalTitle({
              type: params.type,
              title: params.title,
              taskId: taskId ? formatTaskIdForDisplay(taskId) : undefined,
            });
          } catch {
            // Fallback: compose without task scope
            finalTitle = composeConventionalTitle({ type: params.type, title: params.title });
          }
        } else {
          // No --type provided; accept only a fully-formed conventional commit title
          const conventionalRe = /^(feat|fix|docs|style|refactor|perf|test|chore)(\([^)]*\))?:\s+/i;
          if (!conventionalRe.test(params.title)) {
            throw new ValidationError(
              "Invalid title. Provide either:\n" +
                "  • --type <feat|fix|docs|style|refactor|perf|test|chore> with a description-only --title\n" +
                "  • or a full conventional commit title like 'feat(scope): short description'"
            );
          }
        }
      }

      const result = await sessionPrEdit(
        {
          title: finalTitle,
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
        `❌ Failed to edit session PR: ${errorMessage}\n\n💡 Troubleshooting:\n• Check that you're in a session workspace\n• Verify the session has an existing PR\n• Try running with --debug for more details\n• Check 'minsky session pr list' to see available sessions\n\nNeed help? Run the command with --debug for detailed error information.`
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
        backend: params.backend,
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
        const titleLine = formatPrTitleLineShared({
          status: pr.status,
          rawTitle: pr.title || "",
          prNumber: pr.prNumber,
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

  private stripConventionalPrefix(title: string): string {
    if (!title) return "";
    const patterns = [/^[a-z]+\([^)]*\):\s*/i, /^[a-z]+!?:\s*/i];
    let result = title;
    for (const re of patterns) {
      result = result.replace(re, "");
    }
    const max = 100;
    return result.length > max ? `${result.substring(0, max - 3)}...` : result;
  }

  // parseConventionalTitle and getStatusIcon moved to shared helpers above
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
        status: params.status,
        since: params.since,
        until: params.until,
        content: params.content,
      });

      if (params.json) {
        return this.createSuccessResult(result);
      }

      // Format detailed output
      const { pullRequest } = result;

      const titleLine = formatPrTitleLineShared({
        status: pullRequest.status,
        rawTitle: pullRequest.title,
        prNumber: pullRequest.number,
        taskId: pullRequest.taskId,
        sessionName: pullRequest.sessionName,
      });

      const output = [
        titleLine,
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
