/**
 * Enhanced Error Handling for SessionDB Storage Backends
 * 
 * Provides comprehensive error classification, recovery suggestions,
 * and monitoring hooks for all storage backend operations.
 */

import { log } from "../../../utils/logger";

export enum StorageErrorType {
  CONNECTION = "CONNECTION",
  PERMISSION = "PERMISSION", 
  CORRUPTION = "CORRUPTION",
  RESOURCE = "RESOURCE",
  VALIDATION = "VALIDATION",
  TIMEOUT = "TIMEOUT",
  UNKNOWN = "UNKNOWN",
}

export enum StorageErrorSeverity {
  CRITICAL = "CRITICAL",   // Data loss possible, immediate attention required
  HIGH = "HIGH",          // Operation failed, but recoverable
  MEDIUM = "MEDIUM",      // Operation failed, retry recommended
  LOW = "LOW",           // Warning, operation may have degraded performance
}

export interface StorageErrorContext {
  backend: string;
  operation: string;
  sessionId?: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface RecoveryAction {
  type: "RETRY" | "FALLBACK" | "REPAIR" | "MANUAL" | "RESTART";
  description: string;
  autoExecutable: boolean;
  command?: string;
  estimatedTime?: string;
}

export class StorageError extends Error {
  public readonly type!: StorageErrorType;
  public readonly severity: StorageErrorSeverity;
  public readonly context: StorageErrorContext;
  public readonly recoveryActions: RecoveryAction[];
  public readonly retryable: boolean;
  public readonly originalError?: Error;

  constructor(
    message: string,
    type: StorageErrorType,
    severity: StorageErrorSeverity,
    context: StorageErrorContext,
    recoveryActions: RecoveryAction[] = [],
    originalError?: Error
  ) {
    super(message);
    this.name = "StorageError";
    this.type = type;
    this.severity = severity;
    this.context = context;
    this.recoveryActions = recoveryActions;
    this.retryable = this.determineRetryability();
    this.originalError = originalError;

    // Ensure stack trace is properly captured
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, StorageError);
    }
  }

  private determineRetryability(): boolean {
    const retryableTypes = [
      StorageErrorType.CONNECTION,
      StorageErrorType.TIMEOUT,
      StorageErrorType.RESOURCE,
    ];
    return retryableTypes.includes(this.type);
  }

  toJSON(): object {
    return {
      message: this.message,
      type: (this).type,
      severity: this.severity,
      context: this.context,
      recoveryActions: this.recoveryActions,
      retryable: this.retryable,
      stack: this.stack,
      originalError: (this.originalError as unknown).message,
    };
  }
}

export class StorageErrorClassifier {
  /**
   * Classify an error and create appropriate StorageError
   */
  static classifyError(
    error: Error,
    context: StorageErrorContext
  ): StorageError {
    const classification = this.analyzeError(error as unknown, context as unknown);
    
    return new StorageError(
      classification.message,
      classification.type,
      classification.severity,
      context,
      classification.recoveryActions,
      error as unknown
    );
  }

  private static analyzeError(
    error: Error,
    context: StorageErrorContext
  ): {
    message: string;
    type: StorageErrorType;
    severity: StorageErrorSeverity;
    recoveryActions: RecoveryAction[];
  } {
    const errorMessage = error.message.toLowerCase();
    const backend = context.backend;

    // JSON File Backend Errors
    if (backend === "json") {
      return this.classifyJsonError(error as unknown, errorMessage);
    }

    // SQLite Backend Errors
    if (backend === "sqlite") {
      return this.classifySqliteError(error as unknown, errorMessage);
    }

    // PostgreSQL Backend Errors
    if (backend === "postgres") {
      return this.classifyPostgresError(error as unknown, errorMessage);
    }

    // Generic error fallback
    return {
      message: `Unclassified storage error: ${(error as any).message}`,
      type: (StorageErrorType).UNKNOWN,
      severity: (StorageErrorSeverity).MEDIUM,
      recoveryActions: [
        {
          type: "RETRY" as const,
          description: "Retry the operation",
          autoExecutable: true,
        },
        {
          type: "MANUAL" as const,
          description: "Check logs and contact support",
          autoExecutable: false,
        },
      ],
    };
  }

  private static classifyJsonError(error: Error, errorMessage: string) {
    // File not found
    if (errorMessage.includes("enoent") || errorMessage.includes("no such file")) {
      return {
        message: "Session database file not found - database may need initialization",
        type: (StorageErrorType).RESOURCE,
        severity: (StorageErrorSeverity).HIGH,
        recoveryActions: [
          {
            type: "REPAIR" as const,
            description: "Initialize session database",
            autoExecutable: true,
            command: "minsky sessiondb init --backend json",
            estimatedTime: "< 1 minute",
          },
        ],
      };
    }

    // Permission denied
    if (errorMessage.includes("eacces") || errorMessage.includes("permission denied")) {
      return {
        message: "Insufficient permissions to access session database file",
        type: (StorageErrorType).PERMISSION,
        severity: (StorageErrorSeverity).HIGH,
        recoveryActions: [
          {
            type: "MANUAL" as const,
            description: "Fix file permissions",
            autoExecutable: false,
            command: "chmod 644 ~/.local/state/minsky/session-db.json",
          },
        ],
      };
    }

    // JSON syntax error (corruption)
    if (errorMessage.includes("syntaxerror") || errorMessage.includes("unexpected token")) {
      return {
        message: "Session database file is corrupted or contains invalid JSON",
        type: (StorageErrorType).CORRUPTION,
        severity: (StorageErrorSeverity).CRITICAL,
        recoveryActions: [
          {
            type: "FALLBACK" as const,
            description: "Restore from backup",
            autoExecutable: true,
            command: "minsky sessiondb restore --backup <latest>",
            estimatedTime: "2-5 minutes",
          },
          {
            type: "REPAIR" as const,
            description: "Attempt JSON repair",
            autoExecutable: true,
            command: "minsky sessiondb repair --auto",
            estimatedTime: "1-2 minutes",
          },
        ],
      };
    }

    // Disk space
    if (errorMessage.includes("enospc") || errorMessage.includes("no space left")) {
      return {
        message: "Insufficient disk space for session database operations",
        type: (StorageErrorType).RESOURCE,
        severity: (StorageErrorSeverity).HIGH,
        recoveryActions: [
          {
            type: "MANUAL" as const,
            description: "Free up disk space",
            autoExecutable: false,
            command: "minsky session clean --older-than 30d",
          },
        ],
      };
    }

    return {
      message: `JSON backend error: ${(error as any).message}`,
      type: (StorageErrorType).UNKNOWN,
      severity: (StorageErrorSeverity).MEDIUM,
      recoveryActions: [],
    };
  }

  private static classifySqliteError(error: Error, errorMessage: string) {
    // Database locked
    if (errorMessage.includes("sqlite_busy") || errorMessage.includes("database is locked")) {
      return {
        message: "SQLite database is locked by another process",
        type: (StorageErrorType).RESOURCE,
        severity: (StorageErrorSeverity).MEDIUM,
        recoveryActions: [
          {
            type: "RETRY" as const,
            description: "Wait and retry operation",
            autoExecutable: true,
            estimatedTime: "5-30 seconds",
          },
          {
            type: "MANUAL" as const,
            description: "Kill blocking processes",
            autoExecutable: false,
            command: "lsof ~/.local/state/minsky/sessions.db",
          },
        ],
      };
    }

    // Database corruption
    if (errorMessage.includes("sqlite_corrupt") || errorMessage.includes("malformed")) {
      return {
        message: "SQLite database is corrupted",
        type: (StorageErrorType).CORRUPTION,
        severity: (StorageErrorSeverity).CRITICAL,
        recoveryActions: [
          {
            type: "REPAIR" as const,
            description: "Attempt database recovery",
            autoExecutable: true,
            command: "minsky sessiondb repair --backend sqlite --auto-recover",
            estimatedTime: "2-10 minutes",
          },
          {
            type: "FALLBACK" as const,
            description: "Restore from backup",
            autoExecutable: true,
            command: "minsky sessiondb restore --backup <latest> --to sqlite",
          },
        ],
      };
    }

    // Read-only database
    if (errorMessage.includes("sqlite_readonly") || errorMessage.includes("readonly")) {
      return {
        message: "SQLite database is in read-only mode",
        type: (StorageErrorType).PERMISSION,
        severity: (StorageErrorSeverity).HIGH,
        recoveryActions: [
          {
            type: "MANUAL" as const,
            description: "Fix database file permissions",
            autoExecutable: false,
            command: "chmod 644 ~/.local/state/minsky/sessions.db",
          },
        ],
      };
    }

    // Cannot open database
    if (errorMessage.includes("sqlite_cantopen") || errorMessage.includes("unable to open")) {
      return {
        message: "Cannot open SQLite database file",
        type: (StorageErrorType).RESOURCE,
        severity: (StorageErrorSeverity).HIGH,
        recoveryActions: [
          {
            type: "REPAIR" as const,
            description: "Initialize database schema",
            autoExecutable: true,
            command: "minsky sessiondb init --backend sqlite --force",
          },
        ],
      };
    }

    return {
      message: `SQLite backend error: ${(error as any).message}`,
      type: (StorageErrorType).UNKNOWN,
      severity: (StorageErrorSeverity).MEDIUM,
      recoveryActions: [],
    };
  }

  private static classifyPostgresError(error: Error, errorMessage: string) {
    const pgError = error as unknown; // PostgreSQL errors have specific properties

    // Connection refused
    if (errorMessage.includes("econnrefused") || errorMessage.includes("connection refused")) {
      return {
        message: "Cannot connect to PostgreSQL server",
        type: (StorageErrorType).CONNECTION,
        severity: (StorageErrorSeverity).HIGH,
        recoveryActions: [
          {
            type: "RETRY" as const,
            description: "Retry connection",
            autoExecutable: true,
            estimatedTime: "10-30 seconds",
          },
          {
            type: "MANUAL" as const,
            description: "Check PostgreSQL server status",
            autoExecutable: false,
            command: "pg_isready -h hostname -p 5432",
          },
        ],
      };
    }

    // Authentication failed
    if (pgError.code === "28P01" || errorMessage.includes("authentication failed")) {
      return {
        message: "PostgreSQL authentication failed",
        type: (StorageErrorType).PERMISSION,
        severity: (StorageErrorSeverity).HIGH,
        recoveryActions: [
          {
            type: "MANUAL" as const,
            description: "Verify database credentials",
            autoExecutable: false,
            command: "minsky config get sessiondb.connectionString",
          },
        ],
      };
    }

    // Database does not exist
    if (pgError.code === "3D000" || errorMessage.includes("database") && errorMessage.includes("does not exist")) {
      return {
        message: "PostgreSQL database does not exist",
        type: (StorageErrorType).RESOURCE,
        severity: (StorageErrorSeverity).HIGH,
        recoveryActions: [
          {
            type: "MANUAL" as const,
            description: "Create database",
            autoExecutable: false,
            command: "createdb minsky_sessions",
          },
        ],
      };
    }

    // Table does not exist
    if (pgError.code === "42P01" || errorMessage.includes("relation") && errorMessage.includes("does not exist")) {
      return {
        message: "PostgreSQL schema not initialized",
        type: (StorageErrorType).RESOURCE,
        severity: (StorageErrorSeverity).HIGH,
        recoveryActions: [
          {
            type: "REPAIR" as const,
            description: "Initialize database schema",
            autoExecutable: true,
            command: "minsky sessiondb init --backend postgres --force",
          },
        ],
      };
    }

    // Too many connections
    if (pgError.code === "53300" || errorMessage.includes("too many connections")) {
      return {
        message: "PostgreSQL connection limit exceeded",
        type: (StorageErrorType).RESOURCE,
        severity: (StorageErrorSeverity).MEDIUM,
        recoveryActions: [
          {
            type: "RETRY" as const,
            description: "Wait for connections to close and retry",
            autoExecutable: true,
            estimatedTime: "1-5 minutes",
          },
          {
            type: "MANUAL" as const,
            description: "Increase connection limits",
            autoExecutable: false,
          },
        ],
      };
    }

    // Timeout
    if (errorMessage.includes("timeout") || errorMessage.includes("etimedout")) {
      return {
        message: "PostgreSQL operation timed out",
        type: (StorageErrorType).TIMEOUT,
        severity: (StorageErrorSeverity).MEDIUM,
        recoveryActions: [
          {
            type: "RETRY" as const,
            description: "Retry with longer timeout",
            autoExecutable: true,
          },
        ],
      };
    }

    return {
      message: `PostgreSQL backend error: ${(error as any).message}`,
      type: (StorageErrorType).UNKNOWN,
      severity: (StorageErrorSeverity).MEDIUM,
      recoveryActions: [],
    };
  }
}

export class StorageErrorRecovery {
  /**
   * Attempt automatic recovery for retryable errors
   */
  static async attemptRecovery(
    storageError: StorageError,
    operation: () => Promise<any>
  ): Promise<{ success: boolean; result?: any; error?: StorageError }> {
    if (!storageError.retryable) {
      return { success: false, error: storageError };
    }

    const maxRetries = this.getMaxRetries(storageError.type);
    const retryDelay = this.getRetryDelay(storageError.type);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        log.debug("Attempting storage operation recovery", {
          attempt,
          maxRetries,
          errorType: storageError.type,
          delay: retryDelay,
        });

        if (attempt > 1) {
          await this.delay(retryDelay * attempt); // Exponential backoff
        }

        const result = await operation();
        
        log.debug("Storage operation recovery successful", {
          attempt,
          errorType: storageError.type,
        });

        return { success: true, result };

      } catch (error) {
        if (attempt === maxRetries) {
          const finalError = StorageErrorClassifier.classifyError(
            error as Error,
            storageError.context
          );
          
          log.error("Storage operation recovery failed after all attempts", {
            attempts: maxRetries,
            finalError: finalError.message,
          });

          return { success: false, error: finalError };
        }

        log.warn("Storage operation recovery attempt failed", {
          attempt,
          error: (error as Error).message,
        });
      }
    }

    return { success: false, error: storageError };
  }

  private static getMaxRetries(errorType: StorageErrorType): number {
    switch (errorType) {
    case StorageErrorType.CONNECTION:
      return 3;
    case StorageErrorType.TIMEOUT:
      return 2;
    case StorageErrorType.RESOURCE:
      return 2;
    default:
      return 1;
    }
  }

  private static getRetryDelay(errorType: StorageErrorType): number {
    switch (errorType) {
    case StorageErrorType.CONNECTION:
      return 1000; // 1 second
    case StorageErrorType.TIMEOUT:
      return 2000; // 2 seconds
    case StorageErrorType.RESOURCE:
      return 500;  // 0.5 seconds
    default:
      return 1000;
    }
  }

  private static delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export class StorageErrorMonitor {
  private static errorCounts = new Map<string, number>();
  private static lastErrors = new Map<string, StorageError>();

  /**
   * Record error occurrence for monitoring
   */
  static recordError(error: StorageError): void {
    const key = `${(error.context as any).backend}-${(error as any).type}`;
    const currentCount = (this.errorCounts as any).get(key) || 0;
    
    (this.errorCounts as unknown).set(key, currentCount + 1);
    this.lastErrors.set(key, error as unknown);

    // Log error with context
    log.error("Storage error recorded", {
      backend: error.context.backend as unknown,
      type: (error).type as unknown,
      severity: (error).severity as unknown,
      operation: error.context.operation as unknown,
      count: currentCount + 1,
      message: (error as any).message as any,
    });

    // Check for error patterns that need attention
    this.checkErrorPatterns(key, currentCount + 1);
  }

  /**
   * Get error statistics for monitoring
   */
  static getErrorStats(): Record<string, { count: number; lastError: StorageError }> {
    const stats: Record<string, { count: number; lastError: StorageError }> = {};
    
    for (const [key, count] of this.errorCounts.entries()) {
      const lastError = this.lastErrors.get(key);
      if (lastError) {
        stats[key] = { count, lastError };
      }
    }

    return stats;
  }

  /**
   * Reset error counters (useful for tests or periodic cleanup)
   */
  static resetCounters(): void {
    (this.errorCounts as unknown).clear();
    this.lastErrors.clear();
  }

  private static checkErrorPatterns(key: string, count: number): void {
    // Alert on high error rates
    if (count >= 10) {
      log.warn("High error rate detected", {
        errorKey: key,
        count,
        recommendation: "Consider investigating underlying issues",
      });
    }

    // Alert on critical errors
    const lastError = this.lastErrors.get(key);
    if (lastError?.severity === StorageErrorSeverity.CRITICAL) {
      log.error("Critical storage error detected", {
        errorKey: key,
        message: lastError.message,
        recoveryActions: lastError?.recoveryActions,
      });
    }
  }
} 
