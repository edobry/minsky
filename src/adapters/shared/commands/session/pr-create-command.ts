/**
 * Session PR Create Command
 * Replaces the current 'session pr' command
 */

import { BaseSessionCommand, type SessionCommandDependencies } from "./base-session-command";
import { type CommandExecutionContext } from "../../command-registry";
import {
  MinskyError,
  SessionConflictError,
  ValidationError,
  getErrorMessage,
} from "../../../../errors/index";
import { sessionPrCreateCommandParams } from "./session-parameters";
import { sessionPrCreate } from "../../../../domain/session/commands/pr-subcommands";
import { composeConventionalTitle } from "./pr-conventional-title";

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

export const createSessionPrCreateCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrCreateCommand(deps);
