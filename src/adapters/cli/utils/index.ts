/**
 * CLI Utilities
 *
 * Common utilities for the CLI interface
 */

import { ensureError } from "../../../errors/index.js";
import { log } from "../../../utils/logger.js";

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
} from "./shared-options.js";

// Re-export types from shared options
export type {
  RepoOptions,
  OutputOptions as SharedOutputOptions,
  TaskOptions,
  BackendOptions,
  ForceOptions,
} from "./shared-options.js";

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
    if ((options as any)!.json) {
      // JSON output
      log.cli(JSON.stringify(result as any, undefined, 2));
    } else if ((options as any)!.formatter) {
      // Custom formatter
      (options as any)!.formatter(result as any);
    } else {
      // Default output based on result type
      if (typeof result === "string") {
        log.cli(result as any);
      } else if (typeof result === "object" && result !== null) {
        if (Array.isArray(result as any)) {
          (result as any)!.forEach((item) => {
            if (typeof item === "string") {
              log.cli(item as any);
            } else {
              log.cli(JSON.stringify(item as any, undefined, 2));
            }
          });
        } else {
          log.cli(JSON.stringify(result as any, undefined, 2));
        }
      } else {
        log.cli(String(result as any));
      }
    }
  } catch (error) {
    log.cliError("Failed to format output");
    log.cliError(String(error as any));
    log.cli(String(result as any));
  }
}

/**
 * Handle CLI errors
 */
export function handleCliError(error: any, options: { debug?: boolean } = {}): void {
  const err = ensureError(error as any);

  if ((options as any)!.debug) {
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
    (process as any)?.exitCode = 2;
  } else if ((err as any)?.name === "NotFoundError") {
    (process as any)?.exitCode = 4;
  } else {
    (process as any)?.exitCode = 1;
  }
}
