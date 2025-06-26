/**
 * Common error classes for the Minsky application.
 * All application errors should extend from MinskyError to ensure consistent behavior.
 */

// Import base errors
import { MinskyError, ensureError } from "./base-errors";

// Re-export base errors
export { MinskyError, ensureError };

/**
 * Thrown when user input or request parameters fail validation.
 */
export class ValidationError extends MinskyError {
  constructor(
    message: string,
    public readonly errors?: unknown,
    cause?: unknown
  ) {
    super(message, cause);
  }
}

/**
 * Thrown when a requested resource (task, _session, repository, etc.) does not exist.
 */
export class ResourceNotFoundError extends MinskyError {
  constructor(
    message: string,
    public readonly resourceType?: string,
    public readonly resourceId?: string,
    cause?: unknown
  ) {
    super(message, cause);
  }
}

/**
 * Thrown when a service dependency is unavailable or fails to respond.
 */
export class ServiceUnavailableError extends MinskyError {
  constructor(
    message: string,
    public readonly serviceName?: string,
    cause?: unknown
  ) {
    super(message, cause);
  }
}

/**
 * Thrown when a file system operation fails.
 */
export class FileSystemError extends MinskyError {
  constructor(
    message: string,
    public readonly path?: string,
    cause?: unknown
  ) {
    super(message, cause);
  }
}

/**
 * Thrown when there is an issue with configuration values.
 */
export class ConfigurationError extends MinskyError {
  constructor(
    message: string,
    public readonly configKey?: string,
    cause?: unknown
  ) {
    super(message, cause);
  }
}

/**
 * Thrown when a Git operation fails.
 */
export class GitOperationError extends MinskyError {
  constructor(
    message: string,
    public readonly command?: string,
    cause?: unknown
  ) {
    super(message, cause);
  }
}

// Import individual exports from network-errors
import {
  NetworkError,
  PortInUseError,
  NetworkPermissionError,
  createNetworkError,
  isNetworkError,
  formatNetworkErrorMessage,
} from "./network-errors";

// Re-export the network error classes and functions
export {
  NetworkError,
  PortInUseError,
  NetworkPermissionError,
  createNetworkError,
  isNetworkError,
  formatNetworkErrorMessage,
};

// Import and re-export message templates
export {
  ErrorEmojis,
  formatCommandSuggestions,
  formatContextInfo,
  buildErrorMessage,
  createResourceNotFoundMessage,
  createMissingInfoMessage,
  createValidationErrorMessage,
  createCommandFailureMessage,
  createSessionErrorMessage,
  createGitErrorMessage,
  createConfigErrorMessage,
  getErrorMessage,
  createErrorContext,
  type CommandSuggestion,
  type ContextInfo,
  type ErrorTemplate,
  type ErrorMessageSection
} from "./message-templates";
