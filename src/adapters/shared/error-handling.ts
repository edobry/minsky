/**
 * Shared Error Handling Utilities
 *
 * This module provides a unified error handling approach for both CLI and MCP
 * adapters. It ensures errors are consistently formatted and reported across
 * interfaces.
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
} from "../../errors/index.js";
import { log, isStructuredMode } from "../../utils/logger.js";
import { exit } from "../../utils/process.js";
/**
 * Interface for adapter-specific error handlers
 */
export interface ErrorHandler {
  /**
   * Handle a specific error with appropriate formatting for the adapter
   *
   * @param error Error to handle
   * @param options Error handling options
   */
  handleError(error: unknown, options?: ErrorHandlingOptions): never;
}

/**
 * Options for error handling
 */
export interface ErrorHandlingOptions {
  /** Whether to show debug information */
  debug?: boolean;
  /** The exit code to use when terminating the process */
  exitCode?: number;
}

/**
 * Common error formatter that all adapters can use
 */
export class SharedErrorHandler {
  /**
   * Format an error into a structured object based on its type
   *
   * @param error The error to format
   * @param debug Whether to include debug information
   * @returns A structured error object with consistent properties
   */
  static formatError(error: unknown, debug: boolean = false): Record<string, unknown> {
    const normalizedError = ensureError(error);
    let errorType = "UNKNOWN_ERROR";
    const result: Record<string, unknown> = {
      message: normalizedError.message,
    };

    // Add error-specific information
    if (error instanceof ValidationError) {
      errorType = "VALIDATION_ERROR";
      if (error.errors) {
        result.validationErrors = error.errors;
      }
    } else if (error instanceof ResourceNotFoundError) {
      errorType = "NOT_FOUND_ERROR";
      if (error.resourceType) {
        result.resourceType = error.resourceType;
      }
      if (error.resourceId) {
        result.resourceId = error.resourceId;
      }
    } else if (error instanceof ServiceUnavailableError) {
      errorType = "SERVICE_UNAVAILABLE_ERROR";
      if (error.serviceName) {
        result.serviceName = error.serviceName;
      }
    } else if (error instanceof FileSystemError) {
      errorType = "FILE_SYSTEM_ERROR";
      if (error.path) {
        result.path = error.path;
      }
    } else if (error instanceof ConfigurationError) {
      errorType = "CONFIGURATION_ERROR";
      if (error.configKey) {
        result.configKey = error.configKey;
      }
    } else if (error instanceof GitOperationError) {
      errorType = "GIT_OPERATION_ERROR";
      if (error.command) {
        result.command = error.command;
      }
    } else if (error instanceof MinskyError) {
      errorType = "MINSKY_ERROR";
    }

    // Add error type to the result
    result.errorType = errorType;

    // Add debug information if requested
    if (debug) {
      if (normalizedError.stack) {
        result.stack = normalizedError.stack;
      }

      // Add cause chain if available
      if (normalizedError instanceof MinskyError && normalizedError.cause) {
        const cause = normalizedError.cause;
        result.cause =
          cause instanceof Error ? { message: cause.message, stack: cause.stack } : String(cause);
      }
    }

    return result;
  }

  /**
   * Get a human-readable error prefix based on error type
   *
   * @param error The error to get a prefix for
   * @returns A human-readable error prefix
   */
  static getErrorPrefix(error: unknown): string {
    if (error instanceof ValidationError) {
      return "Validation error";
    } else if (error instanceof ResourceNotFoundError) {
      return "Not found";
    } else if (error instanceof ServiceUnavailableError) {
      return "Service unavailable";
    } else if (error instanceof FileSystemError) {
      return "File system error";
    } else if (error instanceof ConfigurationError) {
      return "Configuration error";
    } else if (error instanceof GitOperationError) {
      return "Git operation failed";
    } else if (error instanceof MinskyError) {
      return "Error";
    }
    return "Unexpected error";
  }

  /**
   * Determine if debug mode is enabled based on environment variables
   *
   * @returns Whether debug mode is enabled
   */
  static isDebugMode(): boolean {
    return (
      process.env.DEBUG === "true" ||
      process.env.DEBUG === "1" ||
      (typeof process.env.NODE_DEBUG === "string" && process.env.NODE_DEBUG.includes("minsky"))
    );
  }

  /**
   * Common base error handler logic that adapters can build upon
   *
   * @param error Error to handle
   * @param options Error handling options
   * @returns Never returns, process exits
   */
  static handleError(error: unknown, options: ErrorHandlingOptions = {}): never {
    const { debug = SharedErrorHandler.isDebugMode(), exitCode = 1 } = options;
    const normalizedError = ensureError(error);

    // Format error for structured logging
    const formattedError = SharedErrorHandler.formatError(error, debug);

    // Log to appropriate channels based on mode
    if (isStructuredMode()) {
      log.error("Operation failed", formattedError);
    }

    // Exit with the specified code
    exit(exitCode);
  }
}

/**
 * CLI-specific error handler implementation
 */
export class CliErrorHandler implements ErrorHandler {
  /**
   * Handle an error in the CLI context
   *
   * @param error Error to handle
   * @param options Error handling options
   */
  handleError(error: unknown, options: ErrorHandlingOptions = {}): never {
    const { debug = SharedErrorHandler.isDebugMode(), exitCode = 1 } = options;
    const normalizedError = ensureError(error);

    // Get type-specific error prefix
    const prefix = SharedErrorHandler.getErrorPrefix(error);

    // Output human-readable error message
    log.cliError(`${prefix}: ${normalizedError.message}`);

    // Add type-specific details
    if (error instanceof ValidationError && error.errors && debug) {
      log.cliError("\nValidation details:");
      log.cliError(JSON.stringify(error.errors, null, 2));
    } else if (error instanceof ResourceNotFoundError) {
      if (error.resourceType && error.resourceId) {
        log.cliError(`Resource: ${error.resourceType}, ID: ${error.resourceId}`);
      }
    } else if (error instanceof ServiceUnavailableError && error.serviceName) {
      log.cliError(`Service: ${error.serviceName}`);
    } else if (error instanceof FileSystemError && error.path) {
      log.cliError(`Path: ${error.path}`);
    } else if (error instanceof ConfigurationError && error.configKey) {
      log.cliError(`Key: ${error.configKey}`);
    } else if (error instanceof GitOperationError && error.command) {
      log.cliError(`Command: ${error.command}`);
    }

    // Add debug information if in debug mode
    if (debug) {
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

    // Use structured logging in structured mode
    if (isStructuredMode()) {
      // Format error for structured logging
      const formattedError = SharedErrorHandler.formatError(error, debug);
      log.error("CLI operation failed", formattedError);
    }

    // Exit with the specified code
    exit(exitCode);
  }
}

/**
 * MCP-specific error handler implementation
 */
export class McpErrorHandler implements ErrorHandler {
  /**
   * Handle an error in the MCP context
   *
   * @param error Error to handle
   * @param options Error handling options
   */
  handleError(error: unknown, options: ErrorHandlingOptions = {}): never {
    const { debug = SharedErrorHandler.isDebugMode(), exitCode = 1 } = options;

    // Format error for MCP response
    const formattedError = SharedErrorHandler.formatError(error, debug);

    // Log error in structured format
    log.error("MCP operation failed", formattedError);

    // In MCP context, we want to return a structured error
    // But since this function is marked as 'never', we have to exit
    exit(exitCode);
  }
}

/**
 * Create singleton instances of the error handlers
 */
export const cliErrorHandler = new CliErrorHandler();
export const mcpErrorHandler = new McpErrorHandler();

/**
 * Get the appropriate error handler for the given interface
 *
 * @param interfaceName The interface name (cli, mcp)
 * @returns The appropriate error handler
 */
export function getErrorHandler(interfaceName: string): ErrorHandler {
  switch (interfaceName.toLowerCase()) {
  case "cli":
    return cliErrorHandler;
  case "mcp":
    return mcpErrorHandler;
  default:
    // Default to CLI error handler
    return cliErrorHandler;
  }
}
