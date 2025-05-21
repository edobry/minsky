/**
 * CLI Utilities
 *
 * Common utilities for the CLI interface
 */

import { ensureError } from "../../../errors/index.js";
import { log } from "../../../utils/logger.js";

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
      // JSON output
      console.log(JSON.stringify(result, null, 2));
    } else if (options.formatter) {
      // Custom formatter
      options.formatter(result);
    } else {
      // Default output based on result type
      if (typeof result === "string") {
        console.log(result);
      } else if (typeof result === "object" && result !== null) {
        if (Array.isArray(result)) {
          result.forEach((item) => {
            if (typeof item === "string") {
              console.log(item);
            } else {
              console.log(JSON.stringify(item, null, 2));
            }
          });
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } else {
        console.log(result);
      }
    }
  } catch (error) {
    log.error("Failed to format output:", error);
    console.log(String(result));
  }
}

/**
 * Handle CLI errors
 */
export function handleCliError(error: unknown, options: { debug?: boolean } = {}): void {
  const err = ensureError(error);
  
  if (options.debug) {
    // Detailed error in debug mode
    log.error("Command execution failed:", err);
    if (err.stack) {
      console.error(err.stack);
    }
  } else {
    // Simple error in regular mode
    console.error(`Error: ${err.message}`);
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
