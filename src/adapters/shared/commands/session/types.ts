/**
 * Shared types and helpers for session command factories.
 */
import { getErrorMessage } from "../../../../errors/index";
import { log } from "../../../../utils/logger";
import type { CommandDefinition, CommandExecutionContext } from "../../command-registry";
import type { SessionProviderInterface } from "../../../../domain/session/session-db-adapter";

/**
 * Common dependencies injected into session command factories.
 * `sessionProvider` is always supplied by the composition root.
 */
export interface SessionCommandDependencies {
  sessionProvider: SessionProviderInterface;
}

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
