/**
 * Common response builders for MCP tools
 *
 * Provides standardized response types and builders to eliminate duplication
 * across MCP tool implementations.
 */

/**
 * Base response interface for all MCP operations
 */
export interface BaseResponse {
  success: boolean;
  error?: string;
}

/**
 * Session response interface
 */
export interface SessionResponse extends BaseResponse {
  session: string;
}

/**
 * File response interface
 */
export interface FileResponse extends SessionResponse {
  path: string;
  resolvedPath?: string;
}

/**
 * File operation response interface with additional operation-specific fields
 */
export interface FileOperationResponse extends FileResponse {
  bytesWritten?: number;
  created?: boolean;
  edited?: boolean;
  deleted?: boolean;
  moved?: boolean;
  renamed?: boolean;
  overwritten?: boolean;
  recursive?: boolean;
  replaced?: boolean;
  // For move operations
  sourcePath?: string;
  targetPath?: string;
  sourceResolvedPath?: string;
  targetResolvedPath?: string;
  // For rename operations
  originalPath?: string;
  newPath?: string;
  newName?: string;
  originalResolvedPath?: string;
  newResolvedPath?: string;
  // For search/replace operations
  searchText?: string;
  replaceText?: string;
}

/**
 * File read response interface
 */
export interface FileReadResponse extends FileResponse {
  content: string;
  totalLines?: number;
  linesRead?: {
    start: number;
    end: number;
  };
  linesShown?: string;
  omittedContent?: {
    summary: string;
  };
}

/**
 * Directory listing response interface
 */
export interface DirectoryListResponse extends SessionResponse {
  path: string;
  resolvedPath: string;
  files: string[];
  directories: string[];
  totalEntries: number;
}

/**
 * Search response interface
 */
export interface SearchResponse extends SessionResponse {
  results?: any[];
  matchCount?: number;
  query?: string;
}

/**
 * Creates an error response with standardized structure
 */
export function createErrorResponse(
  error: string,
  context: { path?: string; session?: string }
): BaseResponse & { path?: string; session?: string } {
  return {
    success: false,
    error,
    ...(context.path && { path: context.path }),
    ...(context.session && { session: context.session }),
  };
}

/**
 * Creates a success response with standardized structure
 */
export function createSuccessResponse<T extends Record<string, any>>(
  context: { path?: string; session: string; resolvedPath?: string },
  additionalData: T
): FileResponse & T {
  return {
    success: true,
    session: context.session,
    ...(context.path && { path: context.path }),
    ...(context.resolvedPath && { resolvedPath: context.resolvedPath }),
    ...additionalData,
  };
}
