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
export function handleCliError(error: unknown): never {
  const normalizedError = ensureError(error);

  // In human mode, use programLogger for all user-facing errors
  // In structured mode, use both loggers as configured

  // Format error message based on type
  if (error instanceof ValidationError) {
    // Use cliError for human-readable output (stderr)
    log.cliError(`Validation error: ${normalizedError.message}`);

    // Show validation details in debug mode
    if (isDebugMode() && error.errors) {
      log.cliError("\nValidation details:", error.errors);
    }
  } else if (error instanceof ResourceNotFoundError) {
    log.cliError(`Not found: ${normalizedError.message}`);
    if (error.resourceType && error.resourceId) {
      log.cliError(`Resource: ${error.resourceType}, ID: ${error.resourceId}`);
    }
  } else if (error instanceof ServiceUnavailableError) {
    log.cliError(`Service unavailable: ${normalizedError.message}`);
    if (error.serviceName) {
      log.cliError(`Service: ${error.serviceName}`);
    }
  } else if (error instanceof FileSystemError) {
    log.cliError(`File system error: ${normalizedError.message}`);
    if (error.path) {
      log.cliError(`Path: ${error.path}`);
    }
  } else if (error instanceof ConfigurationError) {
    log.cliError(`Configuration error: ${normalizedError.message}`);
    if (error.configKey) {
      log.cliError(`Key: ${error.configKey}`);
    }
  } else if (error instanceof GitOperationError) {
    log.cliError(`Git operation failed: ${normalizedError.message}`);
    if (error._command) {
      log.cliError(`Command: ${error._command}`);
    }
  } else if (error instanceof MinskyError) {
    log.cliError(`Error: ${normalizedError.message}`);
  } else {
    log.cliError(`Unexpected error: ${normalizedError.message}`);
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
        log.cliError(String(_cause));
      }
    }
  }

  // In structured mode, also log to agent logger for machine consumption
  // Only do this if we're in structured mode to prevent double-logging
  if (isStructuredMode()) {
    if (error instanceof MinskyError) {
      // For Minsky errors, we can log with additional context
      log.error("CLI operation failed", error);
    } else {
      // For other errors, log with basic information
      log.error("CLI operation failed", {
        message: normalizedError.message,
        stack: normalizedError.stack,
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
  options: { json?: boolean; formatter?: (result: unknown) => void }
): void {
  if (options.json) {
    // For JSON output, use agent logger to ensure it goes to stdout
    // This ensures machine-readable output is separated from human-readable messages
    if (isStructuredMode()) {
      // In structured mode, log to agent logger
      log.agent("Command result", { _result });
    } else {
      // In human mode or when json is explicitly requested, write directly to stdout
      log.cli(JSON.stringify(__result, null, 2));
    }
  } else if (options.formatter) {
    options.formatter(_result);
  } else {
    log.cli(String(_result));
  }
}
