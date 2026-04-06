/**
 * Session PR Edit Command
 * Updates an existing PR for a session
 */

import {
  BaseSessionCommand,
  type BaseSessionCommandParams,
  type SessionCommandDependencies,
} from "./base-session-command";
import { type CommandExecutionContext } from "../../command-registry";
import {
  MinskyError,
  SessionConflictError,
  ValidationError,
  getErrorMessage,
} from "../../../../errors/index";
import { sessionPrEditCommandParams } from "./session-parameters";
import { sessionPrEdit } from "../../../../domain/session/commands/pr-subcommands";
import { composeConventionalTitle } from "./pr-conventional-title";

/**
 * Parameters for session PR edit command
 */
interface SessionPrEditParams extends BaseSessionCommandParams {
  title?: string;
  body?: string;
  bodyPath?: string;
  type?: string;
  debug?: boolean;
}

export class SessionPrEditCommand extends BaseSessionCommand<
  SessionPrEditParams,
  Record<string, unknown>
> {
  getCommandId(): string {
    return "session.pr.edit";
  }

  getCommandName(): string {
    return "edit";
  }

  getCommandDescription(): string {
    return "Update an existing pull request for a session";
  }

  getParameterSchema(): Record<string, unknown> {
    return sessionPrEditCommandParams;
  }

  async executeCommand(
    params: SessionPrEditParams,
    context: CommandExecutionContext
  ): Promise<Record<string, unknown>> {
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
        const sessionProvider = this.deps.sessionProvider!;

        // Try to get session ID from params or resolve from task
        let sessionId = params.name;
        if (!sessionId && params.task) {
          const { resolveSessionContextWithFeedback } = await import(
            "../../../../domain/session/session-context-resolver"
          );
          const resolvedContext = await resolveSessionContextWithFeedback({
            task: params.task,
            repo: params.repo,
            sessionProvider,
            allowAutoDetection: false, // No auto-detection for MCP
          });
          sessionId = resolvedContext.sessionId;
        }

        if (sessionId) {
          const sessionRecord = await sessionProvider.getSession(sessionId);
          if (sessionRecord) {
            workingDirectory = await sessionProvider.getRepoPath(sessionRecord);
          }
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
            const { formatTaskIdForDisplay } = await import(
              "../../../../domain/tasks/task-id-utils"
            );

            const sessionProvider = this.deps.sessionProvider!;
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

      const sessionDB = this.deps.sessionProvider!;

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
        { sessionDB },
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

  private handlePrError(error: unknown, params: SessionPrEditParams): Error {
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
        `🔍 Session not found.\n\nThe session '${params.name || params.task}' could not be located.\n\n💡 Try:\n• Check available sessions: minsky session list\n• Verify you're in the correct directory\n• Use the correct session ID or task ID\n\nTechnical details: ${errorMessage}`
      );
    } else {
      return new MinskyError(
        `❌ Failed to edit session PR: ${errorMessage}\n\n💡 Troubleshooting:\n• Check that you're in a session workspace\n• Verify the session has an existing PR\n• Try running with --debug for more details\n• Check 'minsky session pr list' to see available sessions\n\nNeed help? Run the command with --debug for detailed error information.`
      );
    }
  }

  protected getAdditionalLogContext(params: SessionPrEditParams): Record<string, unknown> {
    return {
      title: params.title,
      hasBody: !!params.body,
      hasBodyPath: !!params.bodyPath,
    };
  }
}

export const createSessionPrEditCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrEditCommand(deps);
