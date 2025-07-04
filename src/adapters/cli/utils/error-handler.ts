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
} from "../../../errors/index.js";
import { log, isStructuredMode } from "../../../utils/logger.js";
import { exit } from "../../../utils/process.js";
/**
 * Determines if debug mode is enabled based on environment variables
 */
export const isDebugMode = (): boolean =>
  (process.env as any).DEBUG === "true" ||
  (process.env as any).DEBUG === "1" ||
  (typeof (process.env as any).NODE_DEBUG === "string" && (process.env.NODE_DEBUG as any).includes("minsky"));

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

  // Format error message based on type
  if (error instanceof ValidationError) {
    // Use cliError for human-readable output (stderr)
    log.cliError(`Validation error: ${(normalizedError as any).message}`);

    // Show validation details in debug mode
    if (isDebugMode() && (error as any).errors) {
      log.cliError("\nValidation details:");
      log.cliError(JSON.stringify((error as any).errors, null, 2));
    }
  } else if (error instanceof ResourceNotFoundError) {
    log.cliError(`Not found: ${(normalizedError as any).message}`);
    if ((error as any).resourceType && (error as any).resourceId) {
      log.cliError(`Resource: ${(error as any).resourceType}, ID: ${(error as any).resourceId}`);
    }
  } else if (error instanceof ServiceUnavailableError) {
    log.cliError(`Service unavailable: ${(normalizedError as any).message}`);
    if ((error as any).serviceName) {
      log.cliError(`Service: ${(error as any).serviceName}`);
    }
  } else if (error instanceof FileSystemError) {
    log.cliError(`File system error: ${(normalizedError as any).message}`);
    if ((error as any).path) {
      log.cliError(`Path: ${(error as any).path}`);
    }
  } else if (error instanceof ConfigurationError) {
    log.cliError(`Configuration error: ${(normalizedError as any).message}`);
    if ((error as any).configKey) {
      log.cliError(`Key: ${(error as any).configKey}`);
    }
  } else if (error instanceof GitOperationError) {
    log.cliError(`Git operation failed: ${(normalizedError as any).message}`);
    if ((error as any).command) {
      log.cliError(`Command: ${(error as any).command}`);
    }
  } else if (error instanceof MinskyError) {
    log.cliError(`Error: ${(normalizedError as any).message}`);
  } else {
    log.cliError(`Unexpected error: ${(normalizedError as any).message}`);
  }

  // Show detailed debug information only in debug mode
  if (isDebugMode()) {
    log.cliError("\nDebug information:");
    if ((normalizedError as any).stack) {
      log.cliError((normalizedError as any).stack);
    }

    // Log cause chain if available
    if (normalizedError instanceof MinskyError && (normalizedError as any).cause) {
      log.cliError("\nCaused by:");
      const cause = (normalizedError as any).cause;
      if (cause instanceof Error) {
        log.cliError((cause as any).stack || (cause as any).message);
      } else {
        log.cliError(String(cause));
      }
    }
  }

  // In structured mode, also log to agent logger for machine consumption
  // Only do this if we're in structured mode to prevent double-logging
  if (isStructuredMode()) {
    if (error instanceof MinskyError) {
      // For Minsky errors, we can log with additional context
      log.error("CLI operation failed", error as any);
    } else {
      // For other errors, log with basic information
      log.error("CLI operation failed", {
        message: (normalizedError as any).message,
        stack: (normalizedError as any).stack,
      });
    }
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
  if ((options as any).json) {
    // For JSON output, use agent logger to ensure it goes to stdout
    // This ensures machine-readable output is separated from human-readable messages
    if (isStructuredMode()) {
      // In structured mode, log to agent logger
      log.agent({ message: "Command result", result } as any);
    } else {
      // In human mode or when json is explicitly requested, write directly to stdout
      log.cli(JSON.stringify(result as any, null, 2));
    }
  } else if ((options as any).formatter) {
    (options as any).formatter(result as any);
  } else {
    log.cli(String(result as any));
  }
}
