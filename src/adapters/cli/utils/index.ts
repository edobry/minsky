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
  formatter?: (result: unknown) => void;
}

/**
 * Format and output command results
 */
export function outputResult(result: unknown, options: OutputOptions = {}): void {
  if (result === undefined) {
    return;
  }

  try {
    if (options.json) {
      // JSON output
      log.cli(JSON.stringify(result, null, 2));
    } else if (options.formatter) {
      // Custom formatter
      options.formatter(result);
    } else {
      // Default output based on result type
      if (typeof result === "string") {
        log.cli(_result);
      } else if (typeof result === "object" && result !== null) {
        if (Array.isArray(_result)) {
          result.forEach((item) => {
            if (typeof item === "string") {
              log.cli(item);
            } else {
              log.cli(JSON.stringify(_item, null, 2));
            }
          });
        } else {
          log.cli(JSON.stringify(__result, null, 2));
        }
      } else {
        log.cli(String(_result));
      }
    }
  } catch (error) {
    log.cliError("Failed to format output:", error);
    log.cli(String(_result));
  }
}

/**
 * Handle CLI errors
 */
export function handleCliError(error: unknown, options: { debug?: boolean } = {}): void {
  const err = ensureError(error);

  if (options.debug) {
    // Detailed error in debug mode
    log.cliError("Command execution failed:", err);
    if (err.stack) {
      log.cliError(err.stack);
    }
  } else {
    // Simple error in regular mode
    log.cliError(`Error: ${err.message}`);
  }

  // Set appropriate exit code based on error type
  if (err.name === "ValidationError") {
    process.exitCode = 2;
  } else if (err.name === "NotFoundError") {
    process.exitCode = 4;
  } else {
    process.exitCode = 1;
  }
}
