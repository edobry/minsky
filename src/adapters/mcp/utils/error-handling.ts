/**
 * Common error handling utilities for MCP tools
 *
 * Provides standardized error handling patterns that eliminate duplication
 * across MCP tool implementations.
 */
import { getErrorMessage } from "../../../errors/index";
import { log } from "../../../utils/logger";

/**
 * Standard context for MCP errors
 */
export interface McpErrorContext {
  path?: string;
  session?: string;
  operation?: string;
  [key: string]: any;
}

/**
 * Base response interface for all MCP operations
 */
export interface BaseMcpResponse {
  success: boolean;
  error?: string;
}

/**
 * Session response interface
 */
export interface SessionMcpResponse extends BaseMcpResponse {
  session: string;
}

/**
 * File operation response interface
 */
export interface FileMcpResponse extends SessionMcpResponse {
  path: string;
  resolvedPath?: string;
}

/**
 * Creates a standardized error response for MCP operations
 */
export function createMcpErrorResponse(error: unknown, context: McpErrorContext): FileMcpResponse {
  const errorMessage = getErrorMessage(error);

  const response: FileMcpResponse = {
    success: false,
    error: errorMessage,
    session: context.session || "unknown",
    path: context.path || "unknown",
  };

  return response;
}

/**
 * Creates a standardized success response for MCP operations
 */
export function createMcpSuccessResponse<T extends Record<string, any>>(
  context: { path?: string; session: string; resolvedPath?: string },
  additionalData: T
): FileMcpResponse & T {
  return {
    success: true,
    session: context.session,
    ...(context.path && { path: context.path }),
    ...(context.resolvedPath && { resolvedPath: context.resolvedPath }),
    ...additionalData,
  };
}

/**
 * Creates a standardized MCP error handler for a specific tool
 */
export function createMcpErrorHandler(toolName: string) {
  return (error: unknown, context: McpErrorContext): FileMcpResponse => {
    const errorMessage = getErrorMessage(error);

    log.error(`${toolName} failed`, {
      ...context,
      error: errorMessage,
    });

    return createMcpErrorResponse(error, context);
  };
}

/**
 * Wraps an MCP handler with standardized error handling
 */
export function withMcpErrorHandling<T extends Record<string, any>, R>(
  toolName: string,
  handler: (args: T) => Promise<R>
): (args: T) => Promise<R | FileMcpResponse> {
  const errorHandler = createMcpErrorHandler(toolName);

  return async (args: T): Promise<R | FileMcpResponse> => {
    try {
      return await handler(args);
    } catch (error) {
      return errorHandler(error, {
        path: args.path as string,
        session: args.sessionName as string,
        operation: toolName,
      });
    }
  };
}
