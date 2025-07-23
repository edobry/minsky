/**
 * Semantic Error Classifier
 *
 * Utility for converting low-level filesystem errors into semantic errors
 * with actionable guidance for AI agents.
 */

import { dirname } from "path";
import {
  SemanticErrorCode,
  SemanticErrorResponse,
  FILESYSTEM_ERROR_MAPPINGS,
  SESSION_ERROR_MAPPINGS,
  GIT_ERROR_MAPPINGS,
  ErrorMapping,
} from "../types/semantic-errors";
import { getErrorMessage } from "../errors/index";
import { log } from "./logger";

/**
 * Context for error classification
 */
export interface ErrorContext {
  operation: string; // The operation being performed (read, write, delete, etc.)
  path?: string; // File/directory path involved
  session?: string; // Session context
  createDirs?: boolean; // Whether directory creation was requested
}

/**
 * Classifies a filesystem error into a semantic error response
 */
export class SemanticErrorClassifier {
  /**
   * Convert a filesystem error to a semantic error response
   */
  static classifyError(error: any, context: ErrorContext): SemanticErrorResponse {
    const errorMessage = getErrorMessage(error);
    const errorCode = error?.code || error?.errno;

    log.debug("Classifying error", {
      errorMessage,
      errorCode,
      context,
    });

    // Handle specific filesystem errors
    if (errorCode === "ENOENT") {
      return this.handleENOENTError(error, context);
    }

    if (errorCode === "EACCES") {
      return this.handlePermissionError(error, context);
    }

    if (errorCode === "EEXIST") {
      return this.handleExistsError(error, context);
    }

    if (errorCode === "EINVAL") {
      return this.handleInvalidPathError(error, context);
    }

    // Handle session-specific errors
    const originalMessage = error?.message || error || "";
    if (
      errorMessage.includes("Session not found") ||
      originalMessage.includes("Session not found") ||
      (errorMessage.includes("session") && errorMessage.includes("not found")) ||
      (originalMessage.includes("session") && originalMessage.includes("not found"))
    ) {
      return this.handleSessionError(error, context, "SESSION_NOT_FOUND");
    }

    if (
      (errorMessage.includes("workspace") &&
        (errorMessage.includes("invalid") || errorMessage.includes("corrupt"))) ||
      (originalMessage.includes("workspace") &&
        (originalMessage.includes("invalid") || originalMessage.includes("corrupt")))
    ) {
      return this.handleSessionError(error, context, "SESSION_WORKSPACE_INVALID");
    }

    // Handle git errors
    if (
      errorMessage.includes("git") ||
      errorMessage.includes("branch") ||
      errorMessage.includes("merge") ||
      originalMessage.includes("git") ||
      originalMessage.includes("branch") ||
      originalMessage.includes("merge")
    ) {
      return this.handleGitError(error, context);
    }

    // Generic fallback
    return this.handleGenericError(error, context);
  }

  /**
   * Handle ENOENT errors by determining if it's a file or directory issue
   */
  private static handleENOENTError(error: any, context: ErrorContext): SemanticErrorResponse {
    const errorMessage = getErrorMessage(error);
    const rawMessage = error?.message || error || "";
    const path =
      context.path ||
      this.extractPathFromError(errorMessage) ||
      this.extractPathFromError(rawMessage);

    // Determine if this is a file or directory issue based on context and error message
    let isDirectoryIssue = false;

    // Use operation type and context as indicators
    if (context.operation === "write_file" || context.operation === "create_directory") {
      // For write operations, check if the error message indicates a directory operation
      // or if createDirs is explicitly disabled (user needs directory guidance)
      if (
        errorMessage.includes("mkdir") ||
        errorMessage.includes("parent") ||
        errorMessage.includes("directory") ||
        context.createDirs === false
      ) {
        isDirectoryIssue = true;
      }
    } else {
      // For read operations, this is typically a file not found issue
      // unless the error message specifically mentions directory operations
      isDirectoryIssue = errorMessage.includes("mkdir") || errorMessage.includes("directory");
    }

    const mappingKey = isDirectoryIssue ? "ENOENT_DIR" : "ENOENT_FILE";
    const mapping = FILESYSTEM_ERROR_MAPPINGS[mappingKey];

    if (!mapping) {
      return this.handleGenericError(error, context);
    }

    return this.createSemanticErrorResponse(mapping, error, context, {
      customMessage: isDirectoryIssue
        ? `Cannot create file - parent directory does not exist: ${dirname(path || "")}`
        : `File not found: ${path || "unknown"}`,
    });
  }

  /**
   * Handle permission errors
   */
  private static handlePermissionError(error: any, context: ErrorContext): SemanticErrorResponse {
    const mapping = FILESYSTEM_ERROR_MAPPINGS.EACCES;
    if (!mapping) {
      return this.handleGenericError(error, context);
    }
    return this.createSemanticErrorResponse(mapping, error, context);
  }

  /**
   * Handle file/directory already exists errors
   */
  private static handleExistsError(error: any, context: ErrorContext): SemanticErrorResponse {
    const mapping = FILESYSTEM_ERROR_MAPPINGS.EEXIST;
    if (!mapping) {
      return this.handleGenericError(error, context);
    }
    return this.createSemanticErrorResponse(mapping, error, context);
  }

  /**
   * Handle invalid path errors
   */
  private static handleInvalidPathError(error: any, context: ErrorContext): SemanticErrorResponse {
    const mapping = FILESYSTEM_ERROR_MAPPINGS.EINVAL;
    if (!mapping) {
      return this.handleGenericError(error, context);
    }
    return this.createSemanticErrorResponse(mapping, error, context);
  }

  /**
   * Handle session-related errors
   */
  private static handleSessionError(
    error: any,
    context: ErrorContext,
    sessionErrorType: keyof typeof SESSION_ERROR_MAPPINGS
  ): SemanticErrorResponse {
    const mapping = SESSION_ERROR_MAPPINGS[sessionErrorType];
    if (!mapping) {
      return this.handleGenericError(error, context);
    }
    return this.createSemanticErrorResponse(mapping, error, context);
  }

  /**
   * Handle git-related errors
   */
  private static handleGitError(error: any, context: ErrorContext): SemanticErrorResponse {
    const errorMessage = getErrorMessage(error);
    const originalMessage = error?.message || error || "";

    // Determine specific git error type
    let gitErrorType: keyof typeof GIT_ERROR_MAPPINGS = "GIT_BRANCH_CONFLICT";

    if (
      errorMessage.includes("auth") ||
      errorMessage.includes("permission") ||
      errorMessage.includes("credential") ||
      originalMessage.includes("auth") ||
      originalMessage.includes("permission") ||
      originalMessage.includes("credential")
    ) {
      gitErrorType = "GIT_AUTH_FAILED";
    }

    const mapping = GIT_ERROR_MAPPINGS[gitErrorType];
    if (!mapping) {
      return this.handleGenericError(error, context);
    }
    return this.createSemanticErrorResponse(mapping, error, context);
  }

  /**
   * Handle generic errors
   */
  private static handleGenericError(error: any, context: ErrorContext): SemanticErrorResponse {
    const errorMessage = getErrorMessage(error);

    return {
      success: false,
      error: `Operation failed: ${errorMessage}`,
      errorCode: SemanticErrorCode.OPERATION_FAILED,
      reason: errorMessage,
      solutions: [
        "Check the error details for specific guidance",
        "Verify all parameters are correct",
        "Try the operation again",
        "Check system logs for additional information",
      ],
      retryable: true,
      path: context.path,
      session: context.session,
    };
  }

  /**
   * Create a semantic error response from a mapping
   */
  private static createSemanticErrorResponse(
    mapping: ErrorMapping,
    error: any,
    context: ErrorContext,
    options: {
      customMessage?: string;
      additionalSolutions?: string[];
    } = {}
  ): SemanticErrorResponse {
    const errorMessage = getErrorMessage(error);
    const rawMessage = error?.message || error || "";
    const path =
      context.path ||
      this.extractPathFromError(errorMessage) ||
      this.extractPathFromError(rawMessage);

    // Enhance solutions based on context
    let solutions = [...mapping.solutions];

    // Add context-specific solutions
    if (
      context.createDirs === false &&
      mapping.errorCode === SemanticErrorCode.DIRECTORY_NOT_FOUND
    ) {
      solutions.unshift("Set createDirs: true to automatically create parent directories");
    }

    if (options.additionalSolutions) {
      solutions.push(...options.additionalSolutions);
    }

    return {
      success: false,
      error: options.customMessage || `${mapping.message}${path ? `: ${path}` : ""}`,
      errorCode: mapping.errorCode,
      reason: errorMessage,
      solutions,
      retryable: mapping.retryable,
      relatedTools: mapping.relatedTools,
      path,
      session: context.session,
    };
  }

  /**
   * Extract file path from error message
   */
  private static extractPathFromError(errorMessage: string): string | undefined {
    if (!errorMessage || typeof errorMessage !== "string") {
      return undefined;
    }

    // Try to extract path from common error message patterns (ordered by specificity)
    const patterns = [
      // Specific Node.js error patterns (most reliable)
      /no such file or directory, open '([^']+)'/,
      /no such file or directory, open "([^"]+)"/,
      /no such file or directory, mkdir '([^']+)'/,
      /no such file or directory, scandir '([^']+)'/,

      // Generic ENOENT patterns
      /ENOENT.*['"`]([^'"`]+)['"`]/,
      /open ['"`]([^'"`]+)['"`]/,

      // Fallback patterns (less reliable)
      /'([^']+)'/,
      /"([^"]+)"/,
    ];

    for (const pattern of patterns) {
      const match = errorMessage.match(pattern);
      if (match && match[1] && this.isValidExtractedPath(match[1])) {
        return match[1];
      }
    }

    return undefined;
  }

  /**
   * Validate that an extracted path looks reasonable
   */
  private static isValidExtractedPath(path: string): boolean {
    if (!path || path.length === 0) return false;
    if (path.length > 1000) return false; // Suspiciously long
    if (path.includes("\n") || path.includes("\r")) return false; // Multi-line
    if (/^[<>:|*?]+$/.test(path)) return false; // Only special characters

    return true;
  }
}
