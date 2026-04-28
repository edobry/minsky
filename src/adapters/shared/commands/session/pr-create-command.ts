/**
 * Session PR Create Command
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
import { McpErrorCode } from "../../../../errors/mcp-error-codes";
import { mcpStructuredError } from "../../../../errors/mcp-structured-errors";
import { log } from "../../../../utils/logger";
import { type SessionCommandDependencies, type LazySessionDeps } from "./types";
import { sessionPrCreateCommandParams } from "./session-parameters";
import { sessionPrCreate } from "../../../../domain/session/commands/pr-subcommands";
import type { SessionPrCreateDependencies } from "../../../../domain/session/commands/pr-create-subcommand";
import { composeConventionalTitle } from "./pr-conventional-title";
import { DrizzleAskRepository } from "../../../../domain/ask/repository";
import type { SqlCapablePersistenceProvider } from "../../../../domain/persistence/types";
import type { PersistenceProvider } from "../../../../domain/persistence/types";

/** Minimal container interface required by buildSessionPrCreateDeps. */
type PrCreateDepContainer = { has(key: string): boolean; get(key: string): unknown };

/**
 * Build the SessionPrCreateDependencies shape from the adapter's DI deps and
 * command execution container. Exported for unit-testing the DI wiring —
 * see pr-create-status-advance.test.ts (mt#1266).
 */
export function buildSessionPrCreateDeps(
  deps: SessionCommandDependencies,
  container: PrCreateDepContainer | undefined,
  askRepository?: DrizzleAskRepository
): SessionPrCreateDependencies {
  return {
    sessionDB: deps.sessionProvider,
    taskService: deps.taskService,
    persistenceProvider: container?.has("persistence")
      ? (container.get("persistence") as PersistenceProvider)
      : undefined,
    askRepository,
  };
}

/**
 * Parameters accepted by the session PR create command.
 */
export interface SessionPrCreateParams {
  sessionId?: string;
  task?: string;
  repo?: string;
  json?: boolean;
  title?: string;
  body?: string;
  bodyPath?: string;
  type?: string;
  noStatusUpdate?: boolean;
  debug?: boolean;
  autoResolveDeleteConflicts?: boolean;
  skipConflictCheck?: boolean;
  draft?: boolean;
}

/**
 * Check whether an existing PR is eligible for refresh. Exported for tests.
 */
export async function checkIfPrCanBeRefreshed(
  deps: SessionCommandDependencies,
  params: SessionPrCreateParams
): Promise<boolean> {
  try {
    if (!deps.sessionProvider) return false;

    let sessionId: string | undefined = params.sessionId;
    if (!sessionId && params.task) {
      const { resolveSessionContextWithFeedback } = await import(
        "../../../../domain/session/session-context-resolver"
      );
      const resolved = await resolveSessionContextWithFeedback({
        sessionId: params.sessionId,
        task: params.task,
        repo: params.repo,
        sessionProvider: deps.sessionProvider,
        allowAutoDetection: true,
      });
      sessionId = resolved.sessionId;
    }

    if (!sessionId) return false;

    const record = await deps.sessionProvider.getSession(sessionId);
    return Boolean(record && record.prBranch && record.prState && record.prState.exists);
  } catch {
    return false;
  }
}

/**
 * Throw if the session already has a PR. Exported for tests.
 */
export async function validateNoPrExists(
  deps: SessionCommandDependencies,
  params: SessionPrCreateParams
): Promise<void> {
  const currentDir = process.cwd();
  const isSessionWorkspace = currentDir.includes("/sessions/");

  let sessionId = params.sessionId;
  if (!sessionId && isSessionWorkspace) {
    const pathParts = currentDir.split("/");
    const sessionsIndex = pathParts.indexOf("sessions");
    if (sessionsIndex >= 0 && sessionsIndex < pathParts.length - 1) {
      sessionId = pathParts[sessionsIndex + 1];
    }
  }

  if (!sessionId && params.task) {
    try {
      const { resolveSessionContextWithFeedback } = await import(
        "../../../../domain/session/session-context-resolver"
      );
      const resolvedContext = await resolveSessionContextWithFeedback({
        sessionId: params.sessionId,
        task: params.task,
        repo: params.repo,
        sessionProvider: deps.sessionProvider,
        allowAutoDetection: true,
      });

      sessionId = resolvedContext.sessionId;
    } catch {
      return;
    }
  }

  if (!sessionId) {
    return;
  }

  try {
    const sessionRecord = await deps.sessionProvider.getSession(sessionId);

    if (sessionRecord && sessionRecord.prState && sessionRecord.prBranch) {
      const sessionDisplay = sessionRecord.taskId
        ? `task ${sessionRecord.taskId}`
        : `session '${sessionId}'`;
      throw new ValidationError(
        `A pull request already exists for ${sessionDisplay} (branch: ${sessionRecord.prBranch}).\nTo update the existing PR, use:\n  minsky session pr edit --title "new title" --body "new body"\n  minsky session pr edit --body-path path/to/spec.md`
      );
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    return;
  }
}

function handlePrError(error: unknown, params: SessionPrCreateParams): Error {
  const errorMessage = getErrorMessage(error);

  if (error instanceof SessionConflictError) {
    // Structured error: MCP clients can branch on code === "CONFLICT"
    return mcpStructuredError({
      code: McpErrorCode.CONFLICT,
      summary: "Merge conflict detected while creating PR branch",
      details: {
        sessionBranch: error.sessionBranch,
        baseBranch: error.baseBranch,
        originalMessage: errorMessage,
      },
    });
  } else if (errorMessage.includes("CONFLICT") || errorMessage.includes("conflict")) {
    // Structured error for conflict text that is not a SessionConflictError instance
    return mcpStructuredError({
      code: McpErrorCode.CONFLICT,
      summary: "Git merge conflict detected while creating PR branch",
      details: { originalMessage: errorMessage },
    });
  } else if (
    errorMessage.includes("Permission denied") ||
    errorMessage.includes("authentication")
  ) {
    return new MinskyError(
      `🔐 Git authentication error.\n\nPlease check:\n• Your SSH keys are properly configured\n• You have push access to the repository\n• Your git credentials are valid\n\nTechnical details: ${errorMessage}`
    );
  } else if (errorMessage.includes("Session") && errorMessage.includes("not found")) {
    const sessionDisplay = params.task
      ? `task ${params.task}`
      : params.sessionId
        ? `session '${params.sessionId}'`
        : "the requested session";
    return new MinskyError(
      `🔍 Session not found.\n\n${sessionDisplay} could not be located.\n\n💡 Try:\n• Check available sessions: minsky session list\n• Verify you're in the correct directory\n• Use the correct session ID or task ID\n\nTechnical details: ${errorMessage}`
    );
  } else {
    return new MinskyError(
      `❌ Failed to create session PR: ${errorMessage}\n\n💡 Troubleshooting:\n• Check that you're in a session workspace\n• Verify all files are committed\n• Try running with --debug for more details\n• Check 'minsky session pr list' to see available sessions\n\nNeed help? Run the command with --debug for detailed error information.`
    );
  }
}

/**
 * Core execute logic for session.pr.create. Exported for tests that want to
 * exercise the command body with a mocked composition root.
 */
export async function executeSessionPrCreate(
  deps: SessionCommandDependencies,
  params: SessionPrCreateParams,
  context: CommandExecutionContext
): Promise<Record<string, unknown>> {
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

  await validateNoPrExists(deps, params);

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

    let finalTitle: string = params.title;
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
      throw new ValidationError(
        "--type is required for session pr create. Provide one of: feat, fix, docs, style, refactor, perf, test, chore"
      );
    }

    // Build an AskRepository from the persistence provider's DB connection (best-effort).
    let askRepository: DrizzleAskRepository | undefined;
    const persistenceProvider = context.container?.has("persistence")
      ? context.container.get("persistence")
      : undefined;
    if (persistenceProvider) {
      try {
        const sqlProvider = persistenceProvider as SqlCapablePersistenceProvider;
        if (sqlProvider.getDatabaseConnection) {
          const db = await sqlProvider.getDatabaseConnection();
          if (db) {
            askRepository = new DrizzleAskRepository(db);
          }
        }
      } catch (askRepoError) {
        log.debug(`Could not initialize AskRepository for PR create: ${askRepoError}`);
      }
    }

    const result = await sessionPrCreate(
      {
        title: finalTitle,
        body: params.body,
        bodyPath: params.bodyPath,
        sessionId: params.sessionId,
        task: params.task,
        repo: params.repo,
        noStatusUpdate: params.noStatusUpdate,
        debug: params.debug,
        autoResolveDeleteConflicts: params.autoResolveDeleteConflicts,
        skipConflictCheck: params.skipConflictCheck,
        draft: params.draft,
      },
      {
        sessionDB: deps.sessionProvider,
        persistenceProvider,
        askRepository,
        taskService: deps.taskService,
      },
      {
        interface: interfaceType,
        workingDirectory,
      }
    );

    const { prBranch: _prBranch, ...rest } = result as Record<string, unknown>;
    return { success: true, ...rest };
  } catch (error) {
    throw handlePrError(error, params);
  }
}

export function createSessionPrCreateCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.pr.create",
    category: CommandCategory.SESSION,
    name: "create",
    description: "Create a pull request for a session",
    parameters: sessionPrCreateCommandParams,
    mutating: true,
    execute: async (params, context) => {
      try {
        const deps = await getDeps();
        return await executeSessionPrCreate(deps, params as SessionPrCreateParams, context);
      } catch (error) {
        log.debug(`Error in session.pr.create`, {
          params,
          error: getErrorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }
    },
  };
}
