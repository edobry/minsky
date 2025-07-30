/**
 * Standardized CLI Error Handler
 * 
 * Enhanced error handling for CLI commands that builds on domain validation patterns
 * and standardized response formats from Tasks #322 and #329. Provides consistent
 * error handling with proper exit codes and user-friendly messages.
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
import {
  validateSchema,
  ValidationResult,
  ValidationError as DomainValidationError,
  createValidationErrorResponse,
  formatZodError,
} from "../../../domain/schemas/validation-utils";
import {
  createCliErrorResponse,
  formatCliError,
  CliOutputOptions,
  getEffectiveVerbosity,
} from "../schemas/cli-response-schemas";
import { log, isStructuredMode } from "../../../utils/logger";
import { exit } from "../../../utils/process";
import { ZodError, ZodSchema } from "zod";

// ========================
// ERROR CATEGORIZATION
// ========================

/**
 * CLI exit codes following standard conventions
 */
export enum CliExitCode {
  SUCCESS = 0,
  GENERAL_ERROR = 1,
  MISUSE_OF_SHELL_BUILTINS = 2,
  INVALID_ARGUMENT = 3,
  RESOURCE_NOT_FOUND = 4,
  PERMISSION_DENIED = 5,
  SERVICE_UNAVAILABLE = 6,
  CONFIGURATION_ERROR = 7,
  VALIDATION_ERROR = 8,
  FILE_SYSTEM_ERROR = 9,
  GIT_OPERATION_ERROR = 10,
  TIMEOUT_ERROR = 11,
  NETWORK_ERROR = 12,
  AUTHENTICATION_ERROR = 13,
  AUTHORIZATION_ERROR = 14,
  RATE_LIMIT_ERROR = 15,
}

/**
 * Error category mapping for better error handling
 */
export interface ErrorCategory {
  exitCode: CliExitCode;
  suggestions: string[];
  recoverable: boolean;
  logLevel: 'error' | 'warn' | 'info';
}

/**
 * Maps error types to their categories
 */
export const ERROR_CATEGORIES: Map<string, ErrorCategory> = new Map([
  ['ValidationError', {
    exitCode: CliExitCode.VALIDATION_ERROR,
    suggestions: [
      'Check your command syntax and try again',
      'Use --help to see available options',
      'Verify that all required parameters are provided',
    ],
    recoverable: true,
    logLevel: 'warn',
  }],
  ['ResourceNotFoundError', {
    exitCode: CliExitCode.RESOURCE_NOT_FOUND,
    suggestions: [
      'Verify the resource ID exists',
      'Check your permissions',
      'Try listing available resources first',
    ],
    recoverable: true,
    logLevel: 'warn',
  }],
  ['ServiceUnavailableError', {
    exitCode: CliExitCode.SERVICE_UNAVAILABLE,
    suggestions: [
      'Try again in a few moments',
      'Check your network connection',
      'Verify service status and configuration',
    ],
    recoverable: true,
    logLevel: 'error',
  }],
  ['FileSystemError', {
    exitCode: CliExitCode.FILE_SYSTEM_ERROR,
    suggestions: [
      'Check file permissions',
      'Verify the path exists',
      'Ensure sufficient disk space',
    ],
    recoverable: true,
    logLevel: 'error',
  }],
  ['ConfigurationError', {
    exitCode: CliExitCode.CONFIGURATION_ERROR,
    suggestions: [
      'Check your configuration file',
      'Run: minsky config show',
      'Verify environment variables are set',
    ],
    recoverable: true,
    logLevel: 'warn',
  }],
  ['GitOperationError', {
    exitCode: CliExitCode.GIT_OPERATION_ERROR,
    suggestions: [
      'Check repository status',
      'Ensure you have Git permissions',
      'Try: git status to see repository state',
    ],
    recoverable: true,
    logLevel: 'error',
  }],
]);

// ========================
// VALIDATION ERROR HANDLING
// ========================

/**
 * Validates CLI parameters using a Zod schema and handles errors consistently
 */
export function validateCliParameters<T>(
  schema: ZodSchema<T>,
  parameters: unknown,
  command: string,
  options: CliOutputOptions = {}
): T {
  try {
    return schema.parse(parameters);
  } catch (error) {
    if (error instanceof ZodError) {
      const formattedError = formatZodError(error, `CLI command '${command}'`);
      const cliError = createCliErrorResponse(formattedError, {
        errorCode: 'VALIDATION_ERROR',
        command,
        exitCode: CliExitCode.VALIDATION_ERROR,
        suggestions: ERROR_CATEGORIES.get('ValidationError')?.suggestions,
        verbosity: getEffectiveVerbosity(options),
      });

      formatCliError(cliError, options);
      exit(CliExitCode.VALIDATION_ERROR);
    }

    // Re-throw unexpected errors
    throw error;
  }
}

/**
 * Handles validation results from domain validation utilities
 */
export function handleValidationResult<T>(
  result: ValidationResult<T>,
  command: string,
  options: CliOutputOptions = {}
): T {
  if (result.success) {
    return result.data;
  }

  const cliError = createCliErrorResponse(result.error, {
    errorCode: 'VALIDATION_ERROR',
    command,
    exitCode: CliExitCode.VALIDATION_ERROR,
    details: result.details,
    suggestions: ERROR_CATEGORIES.get('ValidationError')?.suggestions,
    verbosity: getEffectiveVerbosity(options),
  });

  formatCliError(cliError, options);
  exit(CliExitCode.VALIDATION_ERROR);
}

// ========================
// STANDARDIZED ERROR HANDLER
// ========================

/**
 * Determines if debug mode is enabled
 */
export const isDebugMode = (): boolean =>
  process.env.DEBUG === "true" ||
  process.env.DEBUG === "1" ||
  (typeof process.env.NODE_DEBUG === "string" && process.env.NODE_DEBUG.includes("minsky"));

/**
 * Gets error category for a given error
 */
export function getErrorCategory(error: Error): ErrorCategory {
  const errorType = error.constructor.name;
  return ERROR_CATEGORIES.get(errorType) || {
    exitCode: CliExitCode.GENERAL_ERROR,
    suggestions: ['Try again or contact support if the problem persists'],
    recoverable: false,
    logLevel: 'error',
  };
}

/**
 * Enhanced CLI error handler with standardized formatting and exit codes
 */
export function handleStandardizedCliError(
  error: any,
  command?: string,
  options: CliOutputOptions = {}
): never {
  const normalizedError = ensureError(error);
  const category = getErrorCategory(normalizedError);
  const verbosity = getEffectiveVerbosity(options);

  // Create standardized CLI error response
  const cliError = createCliErrorResponse(normalizedError.message, {
    errorCode: normalizedError.constructor.name,
    command,
    exitCode: category.exitCode,
    suggestions: category.suggestions,
    verbosity,
    details: isDebugMode() ? {
      stack: normalizedError.stack,
      cause: normalizedError.cause,
      ...(normalizedError instanceof MinskyError && {
        context: (normalizedError as any).context,
      }),
    } : undefined,
  });

  // Format and display the error
  formatCliError(cliError, options);

  // Log to structured logger in structured mode
  if (isStructuredMode()) {
    const logFunction = log[category.logLevel];
    if (normalizedError instanceof MinskyError) {
      logFunction("CLI operation failed", normalizedError);
    } else {
      logFunction("CLI operation failed", {
        message: normalizedError.message,
        stack: normalizedError.stack,
        command,
      });
    }
  }

  // Exit with appropriate code
  exit(category.exitCode);
}

// ========================
// ERROR RECOVERY UTILITIES
// ========================

/**
 * Suggests recovery actions based on error type
 */
export function suggestRecoveryActions(error: Error, command?: string): string[] {
  const category = getErrorCategory(error);
  const suggestions = [...category.suggestions];

  // Add command-specific suggestions
  if (command) {
    suggestions.push(`Use: ${command} --help for more information`);
  }

  // Add debug suggestions for recoverable errors
  if (category.recoverable) {
    suggestions.push('Run with --debug for more detailed error information');
  }

  return suggestions;
}

/**
 * Checks if an error is recoverable
 */
export function isRecoverableError(error: Error): boolean {
  const category = getErrorCategory(error);
  return category.recoverable;
}

/**
 * Creates a user-friendly error message with context
 */
export function createUserFriendlyErrorMessage(
  error: Error,
  context?: string
): string {
  let message = error.message;

  // Add context if provided
  if (context) {
    message = `${context}: ${message}`;
  }

  // Make specific error types more user-friendly
  if (error instanceof ValidationError) {
    message = `Invalid input: ${message}`;
  } else if (error instanceof ResourceNotFoundError) {
    message = `Resource not found: ${message}`;
  } else if (error instanceof ServiceUnavailableError) {
    message = `Service temporarily unavailable: ${message}`;
  } else if (error instanceof FileSystemError) {
    message = `File operation failed: ${message}`;
  } else if (error instanceof ConfigurationError) {
    message = `Configuration issue: ${message}`;
  } else if (error instanceof GitOperationError) {
    message = `Git operation failed: ${message}`;
  }

  return message;
}

// ========================
// WRAPPER FUNCTIONS FOR COMPATIBILITY
// ========================

/**
 * Legacy error handler wrapper for backward compatibility
 * @deprecated Use handleStandardizedCliError instead
 */
export function handleCliError(error: any): never {
  handleStandardizedCliError(error);
}

/**
 * Creates a command execution wrapper that handles errors consistently
 */
export function withErrorHandling<T extends any[], R>(
  command: string,
  handler: (...args: T) => Promise<R> | R,
  options: CliOutputOptions = {}
) {
  return async (...args: T): Promise<R> => {
    try {
      return await handler(...args);
    } catch (error) {
      handleStandardizedCliError(error, command, options);
    }
  };
}

/**
 * Creates a parameter validation wrapper for CLI commands
 */
export function withParameterValidation<T, R>(
  schema: ZodSchema<T>,
  command: string,
  handler: (params: T) => Promise<R> | R,
  options: CliOutputOptions = {}
) {
  return async (rawParams: unknown): Promise<R> => {
    const validatedParams = validateCliParameters(schema, rawParams, command, options);
    
    try {
      return await handler(validatedParams);
    } catch (error) {
      handleStandardizedCliError(error, command, options);
    }
  };
}

// ========================
// TYPE EXPORTS
// ========================

export type { CliOutputOptions }; 
