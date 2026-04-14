/**
 * Shared types and helpers for session command factories.
 */
import { getErrorMessage } from "../../../../errors/index";
import { log } from "../../../../utils/logger";
import type { CommandDefinition, CommandExecutionContext } from "../../command-registry";
import type { SessionDeps } from "../../../../domain/session/session-service";

/**
 * Common dependencies injected into session command factories.
 *
 * Aliased to the domain `SessionDeps` superset (built once in the composition
 * root via `createSessionDeps()`). Using the same type avoids parallel
 * dep shapes and lets adapter commands consume any service the domain layer
 * already wires up — gitService, taskService, workspaceUtils, getCurrentSession,
 * etc. — without re-constructing them inline.
 */
export type SessionCommandDependencies = SessionDeps;

/**
 * Lazy resolver for session command dependencies.
 * Defers persistence initialization and domain module loading to first command execution,
 * keeping CLI bootstrap fast (command registration only needs metadata + parameter schemas).
 */
export type LazySessionDeps = () => Promise<SessionCommandDependencies>;

/**
 * Minimal parameter shape used by the error-logging helper to extract
 * session/task/repo context from arbitrary command params.
 */
interface LoggableSessionParams {
  name?: string;
  task?: string;
  repo?: string;
  json?: boolean;
}

/**
 * Wrap a command execute handler with a consistent debug-level error log
 * so every session command logs failures the same way.
 */
export function withErrorLogging<T extends Record<string, unknown>, R>(
  commandId: string,
  fn: (params: T, context: CommandExecutionContext) => Promise<R>
): CommandDefinition["execute"] {
  return async (params, context) => {
    try {
      return (await fn(params as T, context)) as Awaited<ReturnType<CommandDefinition["execute"]>>;
    } catch (error) {
      const base = params as LoggableSessionParams;
      log.debug(`Error in ${commandId}`, {
        session: base.name,
        task: base.task,
        repo: base.repo,
        error: getErrorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
        command: commandId,
      });
      throw error;
    }
  };
}
