/**
 * Base error classes for the Minsky application.
 * All application errors should extend from MinskyError to ensure consistent behavior.
 */

// Add declaration for captureStackTrace which might not be in the default Error type
declare global {
  interface ErrorConstructor {
    captureStackTrace(error: Error, constructor: (..._args: any[]) => any): void;
  }
}

/**
 * Base error class for all Minsky application errors.
 * Supports cause chaining for better error context.
 */
export class MinskyError extends Error {
  constructor(
    message: string,
    public readonly cause?: any
  ) {
    super(message);
    (this as any).name = (this.constructor as any).name;

    // Capture stack trace, excluding constructor call from it
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Utility function to ensure an error is a proper Error object
 * @param error Any caught error (which might be a string or other non-Error object)
 * @returns A proper Error or MinskyError object
 */
export function ensureError(error: any): Error {
  if (error instanceof Error) {
    return error;
  }

  return new MinskyError(
    typeof error === "string" ? error : `Unknown error: ${JSON.stringify(error as any)}`
  );
}
