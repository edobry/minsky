/**
 * Common error classes for the Minsky application.
 * All application errors should extend from MinskyError to ensure consistent behavior.
 */

// Import base errors
import { MinskyError, ensureError } from "./base-errors";

// Re-export base errors
export { MinskyError, ensureError };

// Re-export canonical error utilities from schemas/error
export {
  getErrorMessage,
  getErrorStack,
  getErrorCode,
  isErrorLike,
  toError,
  validateError,
  validateSystemError,
  validateGitError,
} from "../schemas/error";

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

/**
 * Thrown when there is nothing to commit (working tree clean).
 */
export class NothingToCommitError extends GitOperationError {
  constructor(message = "Nothing to commit, working tree clean") {
    super(message);
    this.name = "NothingToCommitError";
  }
}

/**
 * Thrown when session branch has merge conflicts that prevent PR creation.
 */
export class SessionConflictError extends GitOperationError {
  constructor(
    message: string,
    public readonly sessionBranch?: string,
    public readonly baseBranch?: string,
    cause?: unknown
  ) {
    super(message, undefined, cause);
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

// Re-export structured MCP error utilities
export { McpErrorCode, type McpErrorCodeValue } from "./mcp-error-codes";
export {
  StructuredMcpError,
  mcpStructuredError,
  type McpErrorPayload,
} from "./mcp-structured-errors";

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
  createSessionNotFoundMessage,
  createSessionExistsMessage,
  createInvalidSessionMessage,
  createGitErrorMessage,
  createConfigErrorMessage,
  createErrorContext,
  SessionErrorType,
  type CommandSuggestion,
  type ContextInfo,
  type ErrorTemplate,
  type ErrorMessageSection,
} from "./message-templates";
