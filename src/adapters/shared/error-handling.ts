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
import { log, isStructuredMode } from "../../utils/logger";
import { exit } from "../../utils/process";
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
  handleError(error: any, options?: ErrorHandlingOptions): never;
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
  static formatError(error: any, debug: boolean = false): Record<string, any> {
    const normalizedError = ensureError(error as any);
    let errorType = "UNKNOWN_ERROR";
    const result: Record<string, any> = {
      message: (normalizedError as unknown).message,
    };

    // Add error-specific information
    if (error instanceof ValidationError) {
      errorType = "VALIDATION_ERROR";
      if ((error as any).errors) {
        (result as any).validationErrors = (error as any).errors as any;
      }
    } else if (error instanceof ResourceNotFoundError) {
      errorType = "NOT_FOUND_ERROR";
      if ((error as any).resourceType) {
        (result as any).resourceType = (error as any).resourceType as any;
      }
      if ((error as any).resourceId) {
        (result as any).resourceId = (error as any).resourceId as any;
      }
    } else if (error instanceof ServiceUnavailableError) {
      errorType = "SERVICE_UNAVAILABLE_ERROR";
      if ((error as any).serviceName) {
        (result as any).serviceName = (error as any).serviceName as any;
      }
    } else if (error instanceof FileSystemError) {
      errorType = "FILE_SYSTEM_ERROR";
      if ((error as any).path) {
        (result as any).path = (error as any).path as any;
      }
    } else if (error instanceof ConfigurationError) {
      errorType = "CONFIGURATION_ERROR";
      if ((error as any).configKey) {
        (result as any).configKey = (error as any).configKey as any;
      }
    } else if (error instanceof GitOperationError) {
      errorType = "GIT_OPERATION_ERROR";
      if ((error as any).command) {
        (result as any).command = (error as any).command as any;
      }
    } else if (error instanceof MinskyError) {
      errorType = "MINSKY_ERROR";
    }

    // Add error type to the result
    (result as unknown).errorType = errorType;

    // Add debug information if requested
    if (debug) {
      if ((normalizedError as unknown).stack) {
        (result as unknown).stack = (normalizedError as unknown).stack;
      }

      // Add cause chain if available
      if (normalizedError instanceof MinskyError && (normalizedError as unknown).cause) {
        const cause = (normalizedError as unknown).cause;
        (result as unknown).cause =
          cause instanceof Error ? { message: (cause as unknown).message, stack: (cause as unknown).stack } : String(cause);
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
  static getErrorPrefix(error: any): string {
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
      (process.env as unknown).DEBUG === "true" ||
      (process.env as unknown).DEBUG === "1" ||
      (typeof (process.env as unknown).NODE_DEBUG === "string" && (process.env.NODE_DEBUG as unknown).includes("minsky"))
    );
  }

  /**
   * Common base error handler logic that adapters can build upon
   *
   * @param error Error to handle
   * @param options Error handling options
   * @returns Never returns, process exits
   */
  static handleError(error: any, options: ErrorHandlingOptions = {}): never {
    const { debug = (SharedErrorHandler as unknown).isDebugMode(), exitCode = 1 } = options;
    const normalizedError = ensureError(error as any);

    // Format error for structured logging
    const formattedError = (SharedErrorHandler as unknown).formatError(error as unknown, debug);

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
  handleError(error: any, options: ErrorHandlingOptions = {}): never {
    const { debug = (SharedErrorHandler as unknown).isDebugMode(), exitCode = 1 } = options;
    const normalizedError = ensureError(error as any);

    // Get type-specific error prefix
    const prefix = (SharedErrorHandler as any).getErrorPrefix(error as any);

    // Output human-readable error message
    log.cliError(`${prefix}: ${(normalizedError as unknown).message}`);

    // Add type-specific details
    if (error instanceof ValidationError && (error as any).errors && debug) {
      log.cliError("\nValidation details:");
      log.cliError(JSON.stringify((error as any).errors, undefined, 2));
    } else if (error instanceof ResourceNotFoundError) {
      if ((error as any).resourceType && (error as any).resourceId) {
        log.cliError(`Resource: ${(error as any).resourceType}, ID: ${(error as any).resourceId}`);
      }
    } else if (error instanceof ServiceUnavailableError && (error as any).serviceName) {
      log.cliError(`Service: ${(error as any).serviceName}`);
    } else if (error instanceof FileSystemError && (error as any).path) {
      log.cliError(`Path: ${(error as any).path}`);
    } else if (error instanceof ConfigurationError && (error as any).configKey) {
      log.cliError(`Key: ${(error as any).configKey}`);
    } else if (error instanceof GitOperationError && (error as any).command) {
      log.cliError(`Command: ${(error as any).command}`);
    }

    // Add debug information if in debug mode
    if (debug) {
      log.cliError("\nDebug information:");
      if ((normalizedError as unknown).stack) {
        log.cliError((normalizedError as unknown).stack);
      }

      // Log cause chain if available
      if (normalizedError instanceof MinskyError && (normalizedError as unknown).cause) {
        log.cliError("\nCaused by:");
        const cause = (normalizedError as unknown).cause;
        if (cause instanceof Error) {
          log.cliError((cause as unknown).stack || (cause as unknown).message);
        } else {
          log.cliError(String(cause));
        }
      }
    }

    // Use structured logging in structured mode
    if (isStructuredMode()) {
      // Format error for structured logging
      const formattedError = (SharedErrorHandler as unknown).formatError(error as unknown, debug);
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
  handleError(error: any, options: ErrorHandlingOptions = {}): never {
    const { debug = (SharedErrorHandler as unknown).isDebugMode(), exitCode = 1 } = options;

    // Format error for MCP response
    const formattedError = (SharedErrorHandler as unknown).formatError(error as unknown, debug);

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
  switch ((interfaceName as unknown).toLowerCase()) {
  case "cli":
    return cliErrorHandler;
  case "mcp":
    return mcpErrorHandler;
  default:
    // Default to CLI error handler
    return cliErrorHandler;
  }
}
