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
 * - Format messages differently based on error type
 *
 * @param error Any error caught during command execution
 */
export function handleCliError(error: unknown): never {
  const normalizedError = ensureError(error);

  // Format error message based on type
  if (error instanceof ValidationError) {
    console.error(`Validation error: ${normalizedError.message}`);
    // Show validation details in debug mode
    if (isDebugMode() && error.errors) {
      console.error("\nValidation details:", error.errors);
    }
  } else if (error instanceof ResourceNotFoundError) {
    console.error(`Not found: ${normalizedError.message}`);
    if (error.resourceType && error.resourceId) {
      console.error(`Resource: ${error.resourceType}, ID: ${error.resourceId}`);
    }
  } else if (error instanceof ServiceUnavailableError) {
    console.error(`Service unavailable: ${normalizedError.message}`);
    if (error.serviceName) {
      console.error(`Service: ${error.serviceName}`);
    }
  } else if (error instanceof FileSystemError) {
    console.error(`File system error: ${normalizedError.message}`);
    if (error.path) {
      console.error(`Path: ${error.path}`);
    }
  } else if (error instanceof ConfigurationError) {
    console.error(`Configuration error: ${normalizedError.message}`);
    if (error.configKey) {
      console.error(`Key: ${error.configKey}`);
    }
  } else if (error instanceof GitOperationError) {
    console.error(`Git operation failed: ${normalizedError.message}`);
    if (error.command) {
      console.error(`Command: ${error.command}`);
    }
  } else if (error instanceof MinskyError) {
    console.error(`Error: ${normalizedError.message}`);
  } else {
    console.error(`Unexpected error: ${normalizedError.message}`);
  }

  // Show detailed debug information only in debug mode
  if (isDebugMode()) {
    console.error("\nDebug information:");
    if (normalizedError.stack) {
      console.error(normalizedError.stack);
    }

    // Log cause chain if available
    if (normalizedError instanceof MinskyError && normalizedError.cause) {
      console.error("\nCaused by:");
      const cause = normalizedError.cause;
      if (cause instanceof Error) {
        console.error(cause.stack || cause.message);
      } else {
        console.error(cause);
      }
    }
  }

  process.exit(1);
}

/**
 * Helper function for CLI commands that output results as JSON or formatted text
 *
 * @param result The result to output
 * @param options Output options
 */
export function outputResult<T>(
  result: T,
  options: { json?: boolean; formatter?: (result: T) => void }
): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (options.formatter) {
    options.formatter(result);
  } else {
    console.log(result);
  }
}
