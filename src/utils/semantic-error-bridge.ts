/**
 * Semantic Error Bridge for MCP
 *
 * This module bridges the existing SemanticErrorClassifier system with the new
 * standardized MCP error response format, preserving sophisticated error handling
 * while ensuring consistency across all MCP tools.
 *
 * Part of Task #288: Comprehensive MCP Improvements and CLI/MCP Consistency Audit
 */

import {
  createMcpErrorResponse,
  createMcpSuccessResponse,
  MCP_ERROR_CODES,
  type McpResponse,
  type McpErrorCode,
} from "../schemas/mcp-error-responses";
import { SemanticErrorClassifier, type ErrorContext } from "./semantic-error-classifier";
import { type FileOperationResponse } from "../types/semantic-errors";
import { log } from "./logger";

/**
 * Map semantic error codes to standardized MCP error codes
 */
function mapSemanticErrorToMcpCode(semanticErrorCode: string): McpErrorCode {
  switch (semanticErrorCode) {
    case "SESSION_NOT_FOUND":
      return MCP_ERROR_CODES.SESSION_NOT_FOUND;
    case "SESSION_WORKSPACE_INVALID":
      return MCP_ERROR_CODES.SESSION_INVALID;
    case "FILE_NOT_FOUND":
      return MCP_ERROR_CODES.FILE_NOT_FOUND;
    case "PERMISSION_DENIED":
      return MCP_ERROR_CODES.FILE_ACCESS_DENIED;
    case "DIRECTORY_NOT_FOUND":
      return MCP_ERROR_CODES.DIRECTORY_NOT_FOUND;
    case "PATH_ALREADY_EXISTS":
      return MCP_ERROR_CODES.FILE_WRITE_ERROR;
    case "INVALID_PATH":
      return MCP_ERROR_CODES.VALIDATION_ERROR;
    case "INVALID_INPUT":
      return MCP_ERROR_CODES.VALIDATION_ERROR;
    case "GIT_BRANCH_CONFLICT":
      return MCP_ERROR_CODES.GIT_MERGE_CONFLICT;
    case "GIT_AUTHENTICATION_FAILED":
      return MCP_ERROR_CODES.GIT_ERROR;
    case "OPERATION_FAILED":
      return MCP_ERROR_CODES.SYSTEM_ERROR;
    default:
      return MCP_ERROR_CODES.UNKNOWN_ERROR;
  }
}

/**
 * Convert a FileOperationResponse from SemanticErrorClassifier to standardized MCP format
 */
export function convertFileOperationResponseToMcp(
  response: FileOperationResponse,
  operationContext: {
    operation: string;
    resource?: string;
    session?: string;
    debug?: boolean;
  }
): McpResponse {
  // If it's a success response, convert to standardized success format
  if (response.success) {
    return createMcpSuccessResponse(response, {
      operation: operationContext.operation,
      resource: operationContext.resource,
      session: operationContext.session,
    });
  }

  // If it's an error response, convert to standardized error format
  // Cast to SemanticErrorResponse to access error properties
  const errorResponse = response as any; // We know it's an error since success is false

  const errorCode = errorResponse.errorCode
    ? mapSemanticErrorToMcpCode(errorResponse.errorCode)
    : MCP_ERROR_CODES.UNKNOWN_ERROR;

  return createMcpErrorResponse(errorResponse.error || "Unknown error occurred", errorCode, {
    details: {
      originalResponse: response,
      semanticErrorCode: errorResponse.errorCode,
      reason: errorResponse.reason,
      retryable: errorResponse.retryable,
      relatedTools: errorResponse.relatedTools,
    },
    context: {
      operation: operationContext.operation,
      resource: operationContext.resource,
      session: operationContext.session,
    },
    suggestions: errorResponse.solutions || undefined,
    debug: operationContext.debug,
  });
}

/**
 * Enhanced error handling for direct MCP tools
 *
 * This function wraps the SemanticErrorClassifier.classifyError method
 * and returns a standardized MCP response format.
 */
export function classifyErrorForMcp(
  error: unknown,
  context: ErrorContext & {
    debug?: boolean;
  }
): McpResponse {
  try {
    // Use the existing semantic error classification
    const semanticResponse = SemanticErrorClassifier.classifyError(error, context);

    // Convert to standardized MCP format
    return convertFileOperationResponseToMcp(semanticResponse, {
      operation: context.operation,
      resource: context.path,
      session: context.session,
      debug: context.debug,
    });
  } catch (classificationError) {
    // If classification itself fails, fall back to basic error handling
    log.error("Semantic error classification failed", {
      originalError: error,
      classificationError,
      context,
    });

    return createMcpErrorResponse(
      "Error processing failed - unable to classify error",
      MCP_ERROR_CODES.SYSTEM_ERROR,
      {
        context: {
          operation: context.operation,
          resource: context.path,
          session: context.session,
        },
        details: {
          originalError: context.debug ? error : undefined,
          classificationError: context.debug ? classificationError : undefined,
        },
        suggestions: [
          "Check system logs for more details",
          "Ensure the operation is valid",
          "Try the operation again",
        ],
        debug: context.debug,
      }
    );
  }
}

/**
 * Utility to wrap direct MCP tool handlers with standardized error handling
 *
 * This higher-order function wraps existing MCP tool handlers to ensure
 * they return standardized MCP responses.
 */
export function withStandardizedMcpErrorHandling<TArgs, TResult>(
  operation: string,
  handler: (args: TArgs) => Promise<TResult>
): (args: TArgs) => Promise<McpResponse> {
  return async (args: TArgs): Promise<McpResponse> => {
    const startTime = Date.now();
    const requestId = `mcp-${operation}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    try {
      const result = await handler(args);
      const duration = Date.now() - startTime;

      log.debug(`MCP operation ${operation} completed successfully`, {
        duration,
        requestId,
      });

      // If result is already an MCP response, return it as-is
      if (typeof result === "object" && result !== null && "success" in result) {
        return result as McpResponse;
      }

      // Otherwise, wrap in standardized success response
      return createMcpSuccessResponse(result, {
        operation,
        requestId,
        performance: {
          duration,
        },
      });
    } catch (error) {
      const duration = Date.now() - startTime;

      log.error(`MCP operation ${operation} failed`, {
        error,
        args,
        duration,
        requestId,
      });

      // Extract session and path from args if available
      const session = (args as any)?.sessionName || (args as any)?.session;
      const path = (args as any)?.path;
      const debug = (args as any)?.debug || false;

      return classifyErrorForMcp(error, {
        operation,
        session,
        path,
        debug,
      });
    }
  };
}

/**
 * Utility to ensure backwards compatibility with existing error responses
 *
 * This function checks if a response is already in the new format and converts it if needed.
 */
export function ensureStandardizedMcpResponse(
  response: any,
  operationContext: {
    operation: string;
    resource?: string;
    session?: string;
    debug?: boolean;
  }
): McpResponse {
  // If already standardized, return as-is
  if (typeof response === "object" && response !== null && "success" in response) {
    // Check if it has the new standardized structure
    if (response.success === true || (response.success === false && "error" in response)) {
      return response as McpResponse;
    }
  }

  // If it looks like a FileOperationResponse, convert it
  if (typeof response === "object" && response !== null) {
    if ("success" in response || "error" in response || "errorType" in response) {
      return convertFileOperationResponseToMcp(response as FileOperationResponse, operationContext);
    }
  }

  // For any other format, wrap in success response
  return createMcpSuccessResponse(response, {
    operation: operationContext.operation,
    resource: operationContext.resource,
    session: operationContext.session,
  });
}
