/**
 * CLI Utilities
 *
 * Common utilities for the CLI interface
 */
import { ensureError } from "../../../errors/index";
import { log } from "../../../utils/logger";
// Re-export shared options functions needed by other modules
export {
  normalizeSessionParams,
  normalizeRepoOptions,
  normalizeOutputOptions,
  normalizeTaskOptions,
  normalizeTaskParams,
  addRepoOptions,
  addOutputOptions,
  addTaskOptions,
  addBackendOptions,
  addForceOptions,
} from "./shared-options";
// Re-export types from shared options
export type {
  RepoOptions,
  OutputOptions as SharedOutputOptions,
  TaskOptions,
  BackendOptions,
  ForceOptions,
} from "./shared-options";
/**
 * Options for formatting output
 */
export interface OutputOptions {
  json?: boolean;
  formatter?: (result: any) => void;
}
/**
 * Format and output command results
 */
export function outputResult(result: any, options: OutputOptions = {}): void {
  if (result === undefined) {
    return;
  }
  try {
    if (options.json) {
      const json = JSON.stringify(result, null, 2);
      log.cli(json);
    } else if (options.formatter) {
      options.formatter(result);
    } else {
      if (typeof result === "string") {
        log.cli(result);
      } else if (typeof result === "object" && result !== null) {
        if (Array.isArray(result)) {
          result.forEach((item) => {
            if (typeof item === "string") {
              log.cli(item);
            } else {
              log.cli(JSON.stringify(item, null, 2));
            }
          });
        } else {
          log.cli(JSON.stringify(result, null, 2));
        }
      } else {
        log.cli(String(result));
      }
    }
  } catch (e) {
    try {
      // eslint-disable-next-line no-console
      console.log(options.json ? JSON.stringify(result, null, 2) : String(result));
    } catch {
      // ignore fallback errors
    }
  }
}
/**
 * Handle CLI errors
 */
export function handleCliError(error: any, options: { debug?: boolean } = {}): void {
  const err = ensureError(error as any);
  if (options.debug) {
    // Detailed error in debug mode
    log.cliError("Command execution failed");
    log.cliError(String(err as any));
    if ((err as any)?.stack) {
      log.cliError((err as any).stack);
    }
  } else {
    // Simple error in regular mode
    log.cliError(`Error: ${(err as any).message}`);
  }
  // Set appropriate exit code based on error type
  if ((err as any)?.name === "ValidationError") {
    process.exitCode = 2;
  } else if ((err as any)?.name === "NotFoundError") {
    process.exitCode = 4;
  } else {
    process.exitCode = 1;
  }
}
