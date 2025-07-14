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
    if ((options as unknown)!.json) {
      // JSON output
      log.cli(JSON.stringify(result as unknown, undefined, 2));
    } else if ((options as unknown)!.formatter) {
      // Custom formatter
      (options as unknown)!.formatter(result as unknown);
    } else {
      // Default output based on result type
      if (typeof result === "string") {
        log.cli(result as unknown);
      } else if (typeof result === "object" && result !== null) {
        if (Array.isArray(result as unknown)) {
          (result as unknown)!.forEach((item) => {
            if (typeof item === "string") {
              log.cli(item as unknown);
            } else {
              log.cli(JSON.stringify(item as unknown, undefined, 2));
            }
          });
        } else {
          log.cli(JSON.stringify(result as unknown, undefined, 2));
        }
      } else {
        log.cli(String(result as unknown));
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
    // @ts-expect-error - Bun environment compatibility
    process.exitCode = 2;
  } else if ((err as any)?.name === "NotFoundError") {
    // @ts-expect-error - Bun environment compatibility
    process.exitCode = 4;
  } else {
    // @ts-expect-error - Bun environment compatibility
    process.exitCode = 1;
  }
}
