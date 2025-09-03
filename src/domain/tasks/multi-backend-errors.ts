/**
 * Enhanced Error Handling for Multi-Backend Task System
 *
 * Provides structured error types and logging for better debugging
 * and user experience in multi-backend operations.
 */

// Enhanced error types for multi-backend operations
export class MultiBackendError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly backend?: string,
    public readonly taskId?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "MultiBackendError";
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      operation: this.operation,
      backend: this.backend,
      taskId: this.taskId,
      cause: this.cause?.message,
      stack: this.stack,
    };
  }
}

export class BackendNotFoundError extends MultiBackendError {
  constructor(backendName: string, availableBackends: string[]) {
    super(
      `Backend '${backendName}' not found. Available backends: ${availableBackends.join(", ")}`,
      "backend_lookup",
      backendName
    );
    this.name = "BackendNotFoundError";
  }
}

export class TaskRoutingError extends MultiBackendError {
  constructor(taskId: string, reason: string) {
    super(`Failed to route task '${taskId}': ${reason}`, "task_routing", undefined, taskId);
    this.name = "TaskRoutingError";
  }
}

export class BackendOperationError extends MultiBackendError {
  constructor(operation: string, backendName: string, taskId: string, cause: Error) {
    super(
      `Backend operation '${operation}' failed on backend '${backendName}' for task '${taskId}': ${cause.message}`,
      operation,
      backendName,
      taskId,
      cause
    );
    this.name = "BackendOperationError";
  }
}

export class TaskMigrationError extends MultiBackendError {
  constructor(
    sourceTaskId: string,
    sourceBackend: string,
    targetBackend: string,
    reason: string,
    cause?: Error
  ) {
    super(
      `Failed to migrate task '${sourceTaskId}' from '${sourceBackend}' to '${targetBackend}': ${reason}`,
      "task_migration",
      sourceBackend,
      sourceTaskId,
      cause
    );
    this.name = "TaskMigrationError";
  }
}

// Error context builder for structured logging
export class ErrorContext {
  private context: Record<string, unknown> = {};

  static create(): ErrorContext {
    return new ErrorContext();
  }

  withOperation(operation: string): ErrorContext {
    this.context.operation = operation;
    return this;
  }

  withBackend(backend: string): ErrorContext {
    this.context.backend = backend;
    return this;
  }

  withTaskId(taskId: string): ErrorContext {
    this.context.taskId = taskId;
    return this;
  }

  withFilters(filters: Record<string, unknown>): ErrorContext {
    this.context.filters = filters;
    return this;
  }

  withMetadata(metadata: Record<string, unknown>): ErrorContext {
    this.context.metadata = metadata;
    return this;
  }

  build(): Record<string, unknown> {
    return { ...this.context };
  }
}

// Enhanced logging utilities
export interface MultiBackendLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

import { log } from "../../utils/logger";

export class ConsoleMultiBackendLogger implements MultiBackendLogger {
  info(message: string, context?: Record<string, unknown>): void {
    log.info(`[INFO] ${message}`, context ? JSON.stringify(context, null, 2) : "");
  }

  warn(message: string, context?: Record<string, unknown>): void {
    log.warn(`[WARN] ${message}`, context ? JSON.stringify(context, null, 2) : "");
  }

  error(message: string, context?: Record<string, unknown>): void {
    log.error(`[ERROR] ${message}`, context ? JSON.stringify(context, null, 2) : "");
  }

  debug(message: string, context?: Record<string, unknown>): void {
    log.debug(`[DEBUG] ${message}`, context ? JSON.stringify(context, null, 2) : "");
  }
}

// Default logger instance
export const logger = new ConsoleMultiBackendLogger();

// Error recovery utilities
export class ErrorRecovery {
  /**
   * Attempts to recover from backend operation failures by retrying with different strategies
   */
  static async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    backoffMs: number = 1000
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt === maxRetries) {
          break;
        }

        // Exponential backoff
        await new Promise((resolve) => setTimeout(resolve, backoffMs * Math.pow(2, attempt - 1)));
      }
    }

    throw new MultiBackendError(
      `Operation failed after ${maxRetries} attempts`,
      "retry_exhausted",
      undefined,
      undefined,
      lastError
    );
  }

  /**
   * Gracefully handles partial failures in multi-backend operations
   */
  static handlePartialFailure<T>(
    results: Array<{ success: boolean; result?: T; error?: Error; backend?: string }>,
    operation: string
  ): T[] {
    const successes = results.filter((r) => r.success).map((r) => r.result!);
    const failures = results.filter((r) => !r.success);

    if (failures.length > 0) {
      const failureContext = failures.map((f) => ({
        backend: f.backend,
        error: f.error?.message,
      }));

      logger.warn(
        `Partial failure in ${operation}: ${failures.length}/${results.length} backends failed`,
        { failures: failureContext }
      );
    }

    return successes;
  }
}

// Validation utilities
export class MultiBackendValidation {
  static validateTaskId(taskId: string, operation: string): void {
    if (!taskId || typeof taskId !== "string" || taskId.trim() === "") {
      throw new MultiBackendError("Task ID is required and must be a non-empty string", operation);
    }
  }

  static validateBackendName(backendName: string, operation: string): void {
    if (!backendName || typeof backendName !== "string" || backendName.trim() === "") {
      throw new MultiBackendError(
        "Backend name is required and must be a non-empty string",
        operation
      );
    }
  }

  static validateTaskSpec(spec: Record<string, unknown>, operation: string): void {
    if (!spec || typeof spec !== "object") {
      throw new MultiBackendError(
        "Task specification is required and must be an object",
        operation
      );
    }

    if (!spec.title || typeof spec.title !== "string" || spec.title.trim() === "") {
      throw new MultiBackendError("Task specification must include a non-empty title", operation);
    }
  }
}
