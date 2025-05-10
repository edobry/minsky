/**
 * Common error classes for the Minsky application.
 * All application errors should extend from MinskyError to ensure consistent behavior.
 */

// Add declaration for captureStackTrace which might not be in the default Error type
declare global {
  interface ErrorConstructor {
    captureStackTrace(error: Error, constructor: (...args: any[]) => any): void;
  }
}

/**
 * Base error class for all Minsky application errors.
 * Supports cause chaining for better error context.
 */
export class MinskyError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    
    // Capture stack trace, excluding constructor call from it
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Thrown when user input or request parameters fail validation.
 */
export class ValidationError extends MinskyError {
  constructor(message: string, public readonly errors?: unknown, cause?: unknown) {
    super(message, cause);
  }
}

/**
 * Thrown when a requested resource (task, session, repository, etc.) does not exist.
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
  constructor(message: string, public readonly serviceName?: string, cause?: unknown) {
    super(message, cause);
  }
}

/**
 * Thrown when a file system operation fails.
 */
export class FileSystemError extends MinskyError {
  constructor(message: string, public readonly path?: string, cause?: unknown) {
    super(message, cause);
  }
}

/**
 * Thrown when there is an issue with configuration values.
 */
export class ConfigurationError extends MinskyError {
  constructor(message: string, public readonly configKey?: string, cause?: unknown) {
    super(message, cause);
  }
}

/**
 * Thrown when a Git operation fails.
 */
export class GitOperationError extends MinskyError {
  constructor(message: string, public readonly command?: string, cause?: unknown) {
    super(message, cause);
  }
}

/**
 * Utility function to ensure an error is a proper Error object
 * @param error Any caught error (which might be a string or other non-Error object)
 * @returns A proper Error or MinskyError object
 */
export function ensureError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  
  return new MinskyError(
    typeof error === 'string' ? error : `Unknown error: ${JSON.stringify(error)}`
  );
} 
