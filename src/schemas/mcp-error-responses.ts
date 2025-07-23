/**
 * Standardized MCP Error Response Schemas
 *
 * This module provides unified error response schemas for all MCP tools,
 * supporting both direct MCP tools and bridged shared commands.
 *
 * Part of Task #288: Comprehensive MCP Improvements and CLI/MCP Consistency Audit
 */

import { z } from "zod";

/**
 * Standard error codes for MCP operations
 */
export const MCP_ERROR_CODES = {
  // Validation errors
  VALIDATION_ERROR: "VALIDATION_ERROR",
  PARAMETER_MISSING: "PARAMETER_MISSING",
  PARAMETER_INVALID: "PARAMETER_INVALID",

  // Session errors
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_INVALID: "SESSION_INVALID",
  SESSION_ACCESS_DENIED: "SESSION_ACCESS_DENIED",

  // File operation errors
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  FILE_ACCESS_DENIED: "FILE_ACCESS_DENIED",
  FILE_WRITE_ERROR: "FILE_WRITE_ERROR",
  FILE_READ_ERROR: "FILE_READ_ERROR",
  DIRECTORY_NOT_FOUND: "DIRECTORY_NOT_FOUND",
  DIRECTORY_CREATE_ERROR: "DIRECTORY_CREATE_ERROR",

  // Command execution errors
  COMMAND_NOT_FOUND: "COMMAND_NOT_FOUND",
  COMMAND_EXECUTION_ERROR: "COMMAND_EXECUTION_ERROR",
  COMMAND_TIMEOUT: "COMMAND_TIMEOUT",

  // Git operation errors
  GIT_ERROR: "GIT_ERROR",
  GIT_REPOSITORY_ERROR: "GIT_REPOSITORY_ERROR",
  GIT_MERGE_CONFLICT: "GIT_MERGE_CONFLICT",

  // Task management errors
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  TASK_INVALID: "TASK_INVALID",
  TASK_STATUS_ERROR: "TASK_STATUS_ERROR",

  // System errors
  SYSTEM_ERROR: "SYSTEM_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
  PERMISSION_ERROR: "PERMISSION_ERROR",

  // Unknown/generic errors
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
} as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[keyof typeof MCP_ERROR_CODES];

/**
 * Field-specific validation error details
 */
export const fieldValidationErrorSchema = z.object({
  field: z.string().describe("Name of the field that failed validation"),
  message: z.string().describe("Human-readable error message for this field"),
  code: z.string().describe("Error code specific to this validation failure"),
  value: z.any().optional().describe("The invalid value that was provided"),
});

export type FieldValidationError = z.infer<typeof fieldValidationErrorSchema>;

/**
 * Context information for error responses
 */
export const errorContextSchema = z.object({
  operation: z.string().optional().describe("The operation that was being performed"),
  resource: z
    .string()
    .optional()
    .describe("The resource being operated on (file, session, task, etc.)"),
  session: z.string().optional().describe("Session identifier if applicable"),
  timestamp: z.string().optional().describe("ISO timestamp when the error occurred"),
  requestId: z.string().optional().describe("Unique identifier for this request"),
  user: z.string().optional().describe("User identifier if applicable"),
});

export type ErrorContext = z.infer<typeof errorContextSchema>;

/**
 * Standardized error response structure for all MCP tools
 */
export const mcpErrorResponseSchema = z.object({
  success: z.literal(false).describe("Always false for error responses"),
  error: z.object({
    // Core error information
    message: z.string().describe("Human-readable error message"),
    code: z
      .enum([
        MCP_ERROR_CODES.VALIDATION_ERROR,
        MCP_ERROR_CODES.PARAMETER_MISSING,
        MCP_ERROR_CODES.PARAMETER_INVALID,
        MCP_ERROR_CODES.SESSION_NOT_FOUND,
        MCP_ERROR_CODES.SESSION_INVALID,
        MCP_ERROR_CODES.SESSION_ACCESS_DENIED,
        MCP_ERROR_CODES.FILE_NOT_FOUND,
        MCP_ERROR_CODES.FILE_ACCESS_DENIED,
        MCP_ERROR_CODES.FILE_WRITE_ERROR,
        MCP_ERROR_CODES.FILE_READ_ERROR,
        MCP_ERROR_CODES.DIRECTORY_NOT_FOUND,
        MCP_ERROR_CODES.DIRECTORY_CREATE_ERROR,
        MCP_ERROR_CODES.COMMAND_NOT_FOUND,
        MCP_ERROR_CODES.COMMAND_EXECUTION_ERROR,
        MCP_ERROR_CODES.COMMAND_TIMEOUT,
        MCP_ERROR_CODES.GIT_ERROR,
        MCP_ERROR_CODES.GIT_REPOSITORY_ERROR,
        MCP_ERROR_CODES.GIT_MERGE_CONFLICT,
        MCP_ERROR_CODES.TASK_NOT_FOUND,
        MCP_ERROR_CODES.TASK_INVALID,
        MCP_ERROR_CODES.TASK_STATUS_ERROR,
        MCP_ERROR_CODES.SYSTEM_ERROR,
        MCP_ERROR_CODES.NETWORK_ERROR,
        MCP_ERROR_CODES.PERMISSION_ERROR,
        MCP_ERROR_CODES.UNKNOWN_ERROR,
      ])
      .describe("Standardized error code"),

    // Optional detailed information
    details: z.any().optional().describe("Additional error details (context-specific)"),
    fieldErrors: z
      .array(fieldValidationErrorSchema)
      .optional()
      .describe("Field-specific validation errors"),
    context: errorContextSchema.optional().describe("Context information about the error"),

    // Debug information (only included in debug mode)
    stack: z.string().optional().describe("Stack trace (only in debug mode)"),
    originalError: z.any().optional().describe("Original error object (only in debug mode)"),

    // Actionable information
    suggestions: z.array(z.string()).optional().describe("Suggested actions to resolve the error"),
    helpUrl: z.string().optional().describe("URL to documentation about this error"),
  }),
});

export type McpErrorResponse = z.infer<typeof mcpErrorResponseSchema>;

/**
 * Standardized success response structure for all MCP tools
 */
export const mcpSuccessResponseSchema = z.object({
  success: z.literal(true).describe("Always true for success responses"),
  result: z.any().describe("The result data for the operation"),
  metadata: z
    .object({
      operation: z.string().optional().describe("The operation that was performed"),
      resource: z.string().optional().describe("The resource that was operated on"),
      session: z.string().optional().describe("Session identifier if applicable"),
      timestamp: z.string().optional().describe("ISO timestamp when the operation completed"),
      requestId: z.string().optional().describe("Unique identifier for this request"),
      performance: z
        .object({
          duration: z.number().optional().describe("Operation duration in milliseconds"),
          memoryUsed: z.number().optional().describe("Memory used in bytes"),
        })
        .optional()
        .describe("Performance metrics"),
    })
    .optional()
    .describe("Metadata about the successful operation"),
});

export type McpSuccessResponse = z.infer<typeof mcpSuccessResponseSchema>;

/**
 * Union type for all MCP responses
 */
export const mcpResponseSchema = z.union([mcpSuccessResponseSchema, mcpErrorResponseSchema]);
export type McpResponse = z.infer<typeof mcpResponseSchema>;

/**
 * Utility function to create standardized error responses
 */
export function createMcpErrorResponse(
  message: string,
  code: McpErrorCode,
  options: {
    details?: any;
    fieldErrors?: FieldValidationError[];
    context?: Partial<ErrorContext>;
    suggestions?: string[];
    helpUrl?: string;
    originalError?: any;
    stack?: string;
    debug?: boolean;
  } = {}
): McpErrorResponse {
  const errorResponse: McpErrorResponse = {
    success: false,
    error: {
      message,
      code,
    },
  };

  // Add optional fields if provided
  if (options.details !== undefined) {
    errorResponse.error.details = options.details;
  }

  if (options.fieldErrors?.length) {
    errorResponse.error.fieldErrors = options.fieldErrors;
  }

  if (options.context) {
    errorResponse.error.context = {
      timestamp: new Date().toISOString(),
      ...options.context,
    };
  }

  if (options.suggestions?.length) {
    errorResponse.error.suggestions = options.suggestions;
  }

  if (options.helpUrl) {
    errorResponse.error.helpUrl = options.helpUrl;
  }

  // Include debug information only if debug mode is enabled
  if (options.debug) {
    if (options.stack) {
      errorResponse.error.stack = options.stack;
    }
    if (options.originalError) {
      errorResponse.error.originalError = options.originalError;
    }
  }

  return errorResponse;
}

/**
 * Utility function to create standardized success responses
 */
export function createMcpSuccessResponse(
  result: any,
  options: {
    operation?: string;
    resource?: string;
    session?: string;
    requestId?: string;
    performance?: {
      duration?: number;
      memoryUsed?: number;
    };
  } = {}
): McpSuccessResponse {
  const successResponse: McpSuccessResponse = {
    success: true,
    result,
  };

  // Add metadata if any options are provided
  if (Object.keys(options).length > 0) {
    successResponse.metadata = {
      timestamp: new Date().toISOString(),
      ...options,
    };
  }

  return successResponse;
}

/**
 * Utility function to convert existing error objects to standardized MCP error responses
 */
export function errorToMcpErrorResponse(
  error: unknown,
  context: {
    operation?: string;
    resource?: string;
    session?: string;
    debug?: boolean;
  } = {}
): McpErrorResponse {
  // Handle known error types
  if (error instanceof Error) {
    let code: McpErrorCode = MCP_ERROR_CODES.UNKNOWN_ERROR;
    let suggestions: string[] = [];

    // Classify error based on message patterns
    const message = error.message.toLowerCase();

    if (message.includes("no such file") || message.includes("enoent")) {
      code = MCP_ERROR_CODES.FILE_NOT_FOUND;
      suggestions = [
        "Check that the file path is correct",
        "Ensure the file exists in the session workspace",
        "Verify you have access to the session",
      ];
    } else if (message.includes("permission denied") || message.includes("eacces")) {
      code = MCP_ERROR_CODES.PERMISSION_ERROR;
      suggestions = [
        "Check file permissions",
        "Ensure you have write access to the directory",
        "Try running with appropriate permissions",
      ];
    } else if (message.includes("session") && message.includes("not found")) {
      code = MCP_ERROR_CODES.SESSION_NOT_FOUND;
      suggestions = [
        "Check that the session name is correct",
        "Verify the session exists using session.list",
        "Ensure you're using the correct session identifier",
      ];
    } else if (message.includes("validation") || message.includes("invalid")) {
      code = MCP_ERROR_CODES.VALIDATION_ERROR;
      suggestions = [
        "Check the parameter values",
        "Ensure all required parameters are provided",
        "Verify parameter types match the expected format",
      ];
    }

    return createMcpErrorResponse(error.message, code, {
      context: {
        operation: context.operation,
        resource: context.resource,
        session: context.session,
      },
      suggestions,
      stack: context.debug ? error.stack : undefined,
      originalError: context.debug ? error : undefined,
      debug: context.debug,
    });
  }

  // Handle non-Error objects
  const message = typeof error === "string" ? error : String(error);
  return createMcpErrorResponse(message, MCP_ERROR_CODES.UNKNOWN_ERROR, {
    context: {
      operation: context.operation,
      resource: context.resource,
      session: context.session,
    },
    originalError: context.debug ? error : undefined,
    debug: context.debug,
  });
}

/**
 * Validation helper to ensure response conforms to schema
 */
export function validateMcpResponse(response: unknown): McpResponse {
  const result = mcpResponseSchema.safeParse(response);
  if (result.success) {
    return result.data;
  }

  // If validation fails, return an error response about the validation failure
  return createMcpErrorResponse("Invalid MCP response format", MCP_ERROR_CODES.SYSTEM_ERROR, {
    details: result.error.errors,
    suggestions: [
      "Check the response format conforms to MCP response schema",
      "Ensure all required fields are present",
      "Verify field types match expected schema",
    ],
  });
}
