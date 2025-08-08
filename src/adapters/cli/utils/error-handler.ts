/**
 * CLI error handling utilities
 *
 * This module provides centralized error handling for CLI commands to ensure
 * consistent, user-friendly error messages while supporting detailed logging
 * for debugging purposes.
 */
import {
  MinskyError,
  ValidationError,
  ResourceNotFoundError,
  ServiceUnavailableError,
  FileSystemError,
  ConfigurationError,
  GitOperationError,
  ensureError,
} from "../../../errors/index";
import { log, isStructuredMode } from "../../../utils/logger";
import { exit } from "../../../utils/process";
/**
 * Determines if debug mode is enabled based on environment variables
 */
export const isDebugMode = (): boolean =>
  process.env.DEBUG === "true" ||
  process.env.DEBUG === "1" ||
  (typeof process.env.NODE_DEBUG === "string" && process.env.NODE_DEBUG.includes("minsky"));

/**
 * Handles CLI command errors with consistent formatting
 *
 * - Provides concise, user-friendly error messages
 * - Shows detailed error information only in debug mode
 * - Format messages differently based on error type and environment
 *
 * @param error Any error caught during command execution
 */
export function handleCliError(error: any): never {
  const normalizedError = ensureError(error as any);

  // In human mode, use programLogger for all user-facing errors
  // In structured mode, use both loggers as configured

  // Sanitize noisy error messages (e.g., Drizzle "Failed query: ...")
  const sanitizeMessage = (msg: string): string => {
    if (!msg) return msg;
    if (msg.includes("Failed query")) return "database operation failed";
    // Use only first line to avoid long stacks in message
    return (msg.split("\n")[0] || msg).slice(0, 200);
  };

  // Format error message based on type
  if (error instanceof ValidationError) {
    // Check if the error message already has good formatting (starts with emoji)
    const message = normalizedError.message;
    const hasGoodFormatting = /^[❌🚫⛔💥]/u.test(message);

    if (hasGoodFormatting) {
      // Already well-formatted, display as-is
      log.cliError(message);
    } else {
      // Add validation error prefix for less formatted messages
      log.cliError(`Validation error: ${sanitizeMessage(message)}`);
    }

    // Show validation details in debug mode
    if (isDebugMode() && (error as any).errors) {
      log.cliError("\nValidation details:");
      log.cliError(JSON.stringify((error as any).errors, undefined, 2));
    }
  } else if (error instanceof ResourceNotFoundError) {
    log.cliError(`Not found: ${sanitizeMessage((normalizedError as any).message)}`);
    if ((error as any).resourceType && (error as any).resourceId) {
      log.cliError(`Resource: ${(error as any).resourceType}, ID: ${(error as any).resourceId}`);
    }
  } else if (error instanceof ServiceUnavailableError) {
    log.cliError(`Service unavailable: ${sanitizeMessage((normalizedError as any).message)}`);
    if ((error as any).serviceName) {
      log.cliError(`Service: ${(error as any).serviceName}`);
    }
  } else if (error instanceof FileSystemError) {
    log.cliError(`File system error: ${sanitizeMessage((normalizedError as any).message)}`);
    if ((error as any).path) {
      log.cliError(`Path: ${(error as any).path}`);
    }
  } else if (error instanceof ConfigurationError) {
    log.cliError(`Configuration error: ${sanitizeMessage((normalizedError as any).message)}`);
    if ((error as any).configKey) {
      log.cliError(`Key: ${(error as any).configKey}`);
    }
  } else if (error instanceof GitOperationError) {
    log.cliError(`Git operation failed: ${sanitizeMessage((normalizedError as any).message)}`);
    if ((error as any).command) {
      log.cliError(`Command: ${(error as any).command}`);
    }
  } else if (error instanceof MinskyError) {
    log.cliError(`Error: ${sanitizeMessage(normalizedError.message)}`);
  } else {
    log.cliError(`❌ ${sanitizeMessage(normalizedError.message)}`);
  }

  // Show detailed debug information only in debug mode
  if (isDebugMode()) {
    log.cliError("\nDebug information:");
    if (normalizedError.stack) {
      log.cliError(normalizedError.stack);
    }

    // Log cause chain if available
    if (normalizedError instanceof MinskyError && normalizedError.cause) {
      log.cliError("\nCaused by:");
      const cause = normalizedError.cause;
      if (cause instanceof Error) {
        log.cliError(cause.stack || cause.message);
      } else {
        log.cliError(String(cause));
      }
    }
  }

  // Avoid JSON blob in CLI: emit structured logs only in debug mode
  if (isStructuredMode() && isDebugMode()) {
    const conciseMsg = sanitizeMessage(normalizedError.message);
    log.error("CLI operation failed", { message: conciseMsg });
  }

  exit(1);
}

/**
 * Helper function for CLI commands that output results as JSON or formatted text
 *
 * @param result The result to output
 * @param options Output options
 */
export function outputResult<T>(
  result: T,
  options: { json?: boolean; formatter?: (result: any) => void }
): void {
  if (options.json) {
    // For JSON output, use agent logger to ensure it goes to stdout
    // This ensures machine-readable output is separated from human-readable messages
    if (isStructuredMode()) {
      // In structured mode, log to agent logger
      log.agent({ message: "Command result", result });
    } else {
      // In human mode or when json is explicitly requested, write directly to stdout
      log.cli(JSON.stringify(result, undefined, 2));
    }
  } else if (options.formatter) {
    options.formatter(result);
  } else {
    log.cli(String(result));
  }
}
