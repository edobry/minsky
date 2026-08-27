/**
 * Session PR Create Command
 */

import {
  CommandCategory,
  type CommandDefinition,
  type CommandExecutionContext,
  type InferParams,
} from "../../command-registry";
import {
  MinskyError,
  SessionConflictError,
  ValidationError,
  getErrorMessage,
  getLoggableErrorSummary,
} from "@minsky/domain/errors/index";
import { GitHubApiError } from "@minsky/domain/repository/index";
import { McpErrorCode } from "@minsky/domain/errors/mcp-error-codes";
import { mcpStructuredError } from "@minsky/domain/errors/mcp-structured-errors";
import { log } from "@minsky/shared/logger";
import { type SessionCommandDependencies, type LazySessionDeps } from "./types";
import { sessionPrCreateCommandParams } from "./session-parameters";
import { sessionPrCreate } from "@minsky/domain/session/commands/pr-subcommands";
import type { SessionPrCreateDependencies } from "@minsky/domain/session/commands/pr-create-subcommand";
import { composeConventionalTitle } from "./pr-conventional-title";
import { CONVENTIONAL_COMMIT_TYPES_DISPLAY } from "@minsky/domain/git/conventional-commit-types";
import { DrizzleAskRepository } from "@minsky/domain/ask/repository";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import type { PersistenceProvider } from "@minsky/domain/persistence/types";

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
export type SessionPrCreateParams = InferParams<typeof sessionPrCreateCommandParams>;

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
        "@minsky/domain/session/session-context-resolver"
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

  let sessionId: string | undefined = params.sessionId;
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
        "@minsky/domain/session/session-context-resolver"
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

/** JSON-stringify that never throws (cyclic payloads, exotic getters). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "<unserializable>";
  }
}

/**
 * Render the upstream diagnostic payload for `--debug` / `debug: true` (mt#3169).
 *
 * The originating incident: `session_pr_create` failed seven times during the
 * 2026-07-24 GitHub outage, its message told the operator to re-run with
 * `--debug`, and doing so produced BYTE-IDENTICAL output — the flag was
 * threaded into the domain call and read by nothing. ~35 minutes went into
 * disproving alternatives the upstream payload would have settled at once.
 *
 * Two things had to be true for this to be renderable at all, and only the
 * first was:
 *   1. the flag reaches a site that also holds the error — `handlePrError`
 *      already did, and
 *   2. the upstream payload still EXISTS by then — it did not, because
 *      `handleOctokitError` threw a replacement without a `cause`. mt#3169
 *      restores that link, which is what this reads.
 *
 * Deliberately additive: this never changes the default message. mt#3171 made
 * that carry GitHub's own text, and `documentation_url` was declined there as
 * noise — a debug block is exactly where it belongs instead.
 *
 * Returns null when nothing diagnostic is available, so the caller appends
 * nothing rather than an empty header.
 *
 * Exported for direct unit testing — see pr-create-command.test.ts.
 */
export function buildDebugDetail(error: unknown): string | null {
  const lines: string[] = [];

  if (error instanceof GitHubApiError) {
    lines.push(`classification: ${safeJson(error.classification)}`);
  }

  // The Octokit error carrying the payload is one level down the cause chain;
  // fall back to the error itself for paths that throw the raw value.
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const raw = (cause ?? error) as {
    status?: unknown;
    response?: { status?: unknown; data?: unknown };
    request?: { method?: unknown; url?: unknown };
  } | null;

  if (raw && typeof raw === "object") {
    const status = raw.status ?? raw.response?.status;
    if (status !== undefined && status !== null) {
      lines.push(`http status: ${String(status)}`);
    }

    const req = raw.request;
    if (req && typeof req === "object" && (req.method || req.url)) {
      lines.push(`request: ${String(req.method ?? "?")} ${String(req.url ?? "?")}`);
    }

    const data = raw.response?.data;
    if (data && typeof data === "object") {
      const docUrl = (data as { documentation_url?: unknown }).documentation_url;
      if (typeof docUrl === "string" && docUrl.length > 0) {
        lines.push(`documentation_url: ${docUrl}`);
      }
      const errors = (data as { errors?: unknown }).errors;
      if (errors !== undefined) {
        lines.push(`response.data.errors: ${safeJson(errors)}`);
      }
    }
  }

  if (lines.length === 0) return null;
  return `🔎 Debug detail:\n${lines.map((line) => `• ${line}`).join("\n")}`;
}

/**
 * Map a thrown value to the operator-facing error for `session pr create`.
 *
 * Exported for direct unit testing — see pr-create-command.test.ts (mt#3169
 * pins that `debug` actually changes the output).
 */
export function handlePrError(error: unknown, params: SessionPrCreateParams): Error {
  const errorMessage = getErrorMessage(error);
  // mt#3169: the message text advises `--debug` twice, but `debug` was passed
  // into the domain call and never read by anything on this path — an
  // advertised affordance that burned a probe during the 2026-07-24 outage.
  // This is where it is honored: `handlePrError` already receives BOTH the
  // thrown error and `params`, so no new threading is required.
  const debugDetail = params.debug ? buildDebugDetail(error) : null;
  const withDebug = (message: string): string =>
    debugDetail ? `${message}\n\n${debugDetail}` : message;

  if (error instanceof SessionConflictError) {
    // Structured error: MCP clients can branch on code === "CONFLICT"
    return mcpStructuredError({
      code: McpErrorCode.CONFLICT,
      summary: "Merge conflict detected while creating PR branch",
      details: {
        sessionBranch: error.sessionBranch,
        baseBranch: error.baseBranch,
        originalMessage: errorMessage,
        ...(debugDetail ? { debug: debugDetail } : {}),
      },
    });
  } else if (errorMessage.includes("CONFLICT") || errorMessage.includes("conflict")) {
    // Structured error for conflict text that is not a SessionConflictError instance
    return mcpStructuredError({
      code: McpErrorCode.CONFLICT,
      summary: "Git merge conflict detected while creating PR branch",
      details: {
        originalMessage: errorMessage,
        ...(debugDetail ? { debug: debugDetail } : {}),
      },
    });
  } else if (
    errorMessage.includes("Permission denied") ||
    errorMessage.includes("authentication")
  ) {
    return new MinskyError(
      withDebug(
        `🔐 Git authentication error.\n\nPlease check:\n• Your SSH keys are properly configured\n• You have push access to the repository\n• Your git credentials are valid\n\nTechnical details: ${errorMessage}`
      )
    );
  } else if (errorMessage.includes("Session") && errorMessage.includes("not found")) {
    const sessionDisplay = params.task
      ? `task ${params.task}`
      : params.sessionId
        ? `session '${params.sessionId}'`
        : "the requested session";
    return new MinskyError(
      withDebug(
        `🔍 Session not found.\n\n${sessionDisplay} could not be located.\n\n💡 Try:\n• Check available sessions: minsky session list\n• Verify you're in the correct directory\n• Use the correct session ID or task ID\n\nTechnical details: ${errorMessage}`
      )
    );
  } else {
    return new MinskyError(
      withDebug(
        `❌ Failed to create session PR: ${errorMessage}\n\n💡 Troubleshooting:\n• Check that you're in a session workspace\n• Verify all files are committed\n• Try running with --debug for more details\n• Check 'minsky session pr list' to see available sessions\n\nNeed help? Run the command with --debug for detailed error information.`
      )
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
          "@minsky/domain/session/session-context-resolver"
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
          "@minsky/domain/session/session-context-resolver"
        );
        const { formatTaskIdForDisplay } = await import("@minsky/domain/tasks/task-id-utils");

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
        `--type is required for session pr create. Provide one of: ${CONVENTIONAL_COMMIT_TYPES_DISPLAY}`
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
        // mt#3480: this object is built field-by-field, so a parameter absent
        // HERE is accepted by the command and silently dropped before the
        // domain ever sees it. Forwarded to the pre-PR session update's push.
        pushTimeoutMs: params.pushTimeoutMs,
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

export function createSessionPrCreateCommand(
  getDeps: LazySessionDeps
): CommandDefinition<typeof sessionPrCreateCommandParams> {
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
        return await executeSessionPrCreate(deps, params, context);
      } catch (error) {
        log.debug(`Error in session.pr.create`, {
          params,
          error: getLoggableErrorSummary(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }
    },
  };
}
