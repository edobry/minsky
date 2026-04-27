/**
 * Session PR Edit Command
 */

import {
  CommandCategory,
  type CommandDefinition,
  type CommandExecutionContext,
} from "../../command-registry";
import {
  MinskyError,
  SessionConflictError,
  ValidationError,
  getErrorMessage,
} from "../../../../errors/index";
import { log } from "../../../../utils/logger";
import { type SessionCommandDependencies, type LazySessionDeps } from "./types";
import { sessionPrEditCommandParams } from "./session-parameters";
import { sessionPrEdit } from "../../../../domain/session/commands/pr-subcommands";
import { composeConventionalTitle } from "./pr-conventional-title";

export interface SessionPrEditParams {
  sessionId?: string;
  task?: string;
  repo?: string;
  json?: boolean;
  title?: string;
  body?: string;
  bodyPath?: string;
  type?: string;
  debug?: boolean;
}

function handlePrError(error: unknown, params: SessionPrEditParams): Error {
  const errorMessage = getErrorMessage(error);

  if (error instanceof SessionConflictError) {
    return error;
  } else if (errorMessage.includes("CONFLICT") || errorMessage.includes("conflict")) {
    return new MinskyError(
      `🔥 Git merge conflict detected while updating PR.\n\nThis usually happens when:\n• There are conflicting changes between your session and the base branch\n• The PR branch has diverged from your session\n\n💡 Quick fixes:\n• Resolve conflicts manually and retry\n• Check the current state of your PR branch\n\nTechnical details: ${errorMessage}`
    );
  } else if (errorMessage.includes("No pull request found")) {
    return new MinskyError(
      `🔍 No PR found for this session.\n\nThe session '${params.sessionId || params.task}' doesn't have an existing pull request to edit.\n\n💡 Try:\n• Create a PR first: minsky session pr create --title "..." --body "..."\n• Check available PRs: minsky session pr list\n• Verify you're in the correct session\n\nTechnical details: ${errorMessage}`
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
      `🔍 Session not found.\n\nThe session '${params.sessionId || params.task}' could not be located.\n\n💡 Try:\n• Check available sessions: minsky session list\n• Verify you're in the correct directory\n• Use the correct session ID or task ID\n\nTechnical details: ${errorMessage}`
    );
  } else {
    return new MinskyError(
      `❌ Failed to edit session PR: ${errorMessage}\n\n💡 Troubleshooting:\n• Check that you're in a session workspace\n• Verify the session has an existing PR\n• Try running with --debug for more details\n• Check 'minsky session pr list' to see available sessions\n\nNeed help? Run the command with --debug for detailed error information.`
    );
  }
}

/**
 * Core execute logic for session.pr.edit. Exported for tests.
 */
export async function executeSessionPrEdit(
  deps: SessionCommandDependencies,
  params: SessionPrEditParams,
  context: CommandExecutionContext
): Promise<Record<string, unknown>> {
  if (!params.title && !params.body && !params.bodyPath) {
    throw new ValidationError(
      'At least one field must be provided to update the PR:\n  --title <text>       Update PR title\n  --body <text>        Update PR body text\n  --body-path <path>   Update PR body from file\n\nExample:\n  minsky session pr edit --title "feat: Updated feature"\n  minsky session pr edit --body-path process/tasks/189/pr.md'
    );
  }

  try {
    let workingDirectory = process.cwd();
    const interfaceType = context.interface as "cli" | "mcp";

    if (interfaceType === "mcp") {
      let sessionId = params.sessionId;
      if (!sessionId && params.task) {
        const { resolveSessionContextWithFeedback } = await import(
          "../../../../domain/session/session-context-resolver"
        );
        const resolvedContext = await resolveSessionContextWithFeedback({
          task: params.task,
          repo: params.repo,
          sessionProvider: deps.sessionProvider,
          allowAutoDetection: false,
        });
        sessionId = resolvedContext.sessionId;
      }

      if (sessionId) {
        const sessionRecord = await deps.sessionProvider.getSession(sessionId);
        if (sessionRecord) {
          workingDirectory = await deps.sessionProvider.getRepoPath(sessionRecord);
        }
      }
    }

    let finalTitle: string | undefined = params.title;
    if (params.title) {
      const { assertValidPrTitle } = await import(
        "../../../../domain/session/validation/title-validation"
      );
      assertValidPrTitle(params.title);

      if (params.type) {
        try {
          const { resolveSessionContextWithFeedback } = await import(
            "../../../../domain/session/session-context-resolver"
          );
          const { formatTaskIdForDisplay } = await import("../../../../domain/tasks/task-id-utils");

          const resolved = await resolveSessionContextWithFeedback({
            sessionId: params.sessionId,
            task: params.task,
            repo: params.repo,
            sessionProvider: deps.sessionProvider,
            allowAutoDetection: true,
          });

          const taskId: string | undefined = resolved.taskId || params.task;
          finalTitle = composeConventionalTitle({
            type: params.type,
            title: params.title,
            taskId: taskId ? formatTaskIdForDisplay(taskId) : undefined,
          });
        } catch {
          finalTitle = composeConventionalTitle({ type: params.type, title: params.title });
        }
      } else {
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
        sessionId: params.sessionId,
        task: params.task,
        repo: params.repo,
        debug: params.debug,
      },
      { sessionDB: deps.sessionProvider },
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
    throw handlePrError(error, params);
  }
}

export function createSessionPrEditCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.pr.edit",
    category: CommandCategory.SESSION,
    name: "edit",
    description: "Update an existing pull request for a session",
    parameters: sessionPrEditCommandParams,
    mutating: true,
    execute: async (params, context) => {
      try {
        const deps = await getDeps();
        return await executeSessionPrEdit(deps, params as SessionPrEditParams, context);
      } catch (error) {
        log.debug(`Error in session.pr.edit`, {
          params,
          error: getErrorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }
    },
  };
}
