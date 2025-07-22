/**
 * Semantic Error Response Types
 * 
 * This module defines the semantic error response schema for better AI agent UX
 * as specified in Task #309.
 */

/**
 * Semantic error codes for file operations
 */
export enum SemanticErrorCode {
  // File/Directory errors
  FILE_NOT_FOUND = "FILE_NOT_FOUND",
  DIRECTORY_NOT_FOUND = "DIRECTORY_NOT_FOUND", 
  PATH_ALREADY_EXISTS = "PATH_ALREADY_EXISTS",
  INVALID_PATH = "INVALID_PATH",
  
  // Permission errors
  PERMISSION_DENIED = "PERMISSION_DENIED",
  
  // Session errors
  SESSION_NOT_FOUND = "SESSION_NOT_FOUND",
  SESSION_WORKSPACE_INVALID = "SESSION_WORKSPACE_INVALID",
  
  // Git errors
  GIT_BRANCH_CONFLICT = "GIT_BRANCH_CONFLICT",
  GIT_AUTHENTICATION_FAILED = "GIT_AUTHENTICATION_FAILED",
  
  // Generic errors
  OPERATION_FAILED = "OPERATION_FAILED",
  INVALID_INPUT = "INVALID_INPUT"
}

/**
 * Recovery action for error resolution
 */
export interface RecoveryAction {
  type: "manual" | "automatic" | "tool";
  description: string;
  tool?: string;
  command?: string;
}

/**
 * Semantic error response schema
 */
export interface SemanticErrorResponse {
  success: false;
  error: string;           // Human-readable message
  errorCode: SemanticErrorCode; // Semantic error type
  reason?: string;         // Technical details
  solutions: string[];     // Actionable recovery steps
  retryable: boolean;      // Can operation be retried
  relatedTools?: string[]; // Tools that might help
  path?: string;          // Affected file/directory path
  session?: string;       // Session context if applicable
}

/**
 * Success response for file operations
 */
export interface FileOperationSuccess {
  success: true;
  path: string;
  session?: string;
  [key: string]: any; // Allow additional properties
}

/**
 * Union type for file operation responses
 */
export type FileOperationResponse = FileOperationSuccess | SemanticErrorResponse;

/**
 * Error mapping configuration for filesystem errors
 */
export interface ErrorMapping {
  errorCode: SemanticErrorCode;
  message: string;
  solutions: string[];
  retryable: boolean;
  relatedTools?: string[];
}

/**
 * Filesystem error to semantic error mappings
 */
export const FILESYSTEM_ERROR_MAPPINGS: Record<string, ErrorMapping> = {
  ENOENT_FILE: {
    errorCode: SemanticErrorCode.FILE_NOT_FOUND,
    message: "File not found",
    solutions: [
      "Check the file path for typos",
      "Use file_search to locate the file",
      "Create the file first if it should exist"
    ],
    retryable: false,
    relatedTools: ["file_search", "session_write_file"]
  },
  
  ENOENT_DIR: {
    errorCode: SemanticErrorCode.DIRECTORY_NOT_FOUND,
    message: "Directory not found - parent directory does not exist",
    solutions: [
      "Set createDirs: true to auto-create directories",
      "Create parent directory first using create_directory tool",
      "Check the directory path for typos"
    ],
    retryable: true,
    relatedTools: ["session_create_directory"]
  },
  
  EACCES: {
    errorCode: SemanticErrorCode.PERMISSION_DENIED,
    message: "Permission denied - insufficient permissions to access file/directory",
    solutions: [
      "Check file permissions and ownership",
      "Use a different path with write access",
      "Run with appropriate permissions"
    ],
    retryable: false
  },
  
  EEXIST: {
    errorCode: SemanticErrorCode.PATH_ALREADY_EXISTS,
    message: "Path already exists",
    solutions: [
      "Use a different file/directory name",
      "Delete the existing file first if replacement intended",
      "Use force flag if available"
    ],
    retryable: false,
    relatedTools: ["session_delete_file"]
  },
  
  EINVAL: {
    errorCode: SemanticErrorCode.INVALID_PATH,
    message: "Invalid path format",
    solutions: [
      "Check path format and avoid special characters",
      "Use relative paths within session workspace",
      "Ensure path separators are correct for the system"
    ],
    retryable: false
  }
};

/**
 * Session-specific error mappings
 */
export const SESSION_ERROR_MAPPINGS: Record<string, ErrorMapping> = {
  SESSION_NOT_FOUND: {
    errorCode: SemanticErrorCode.SESSION_NOT_FOUND,
    message: "Session not found",
    solutions: [
      "Use session_list to see available sessions",
      "Verify session name or ID",
      "Create a new session if needed"
    ],
    retryable: false,
    relatedTools: ["session_list", "session_start"]
  },
  
  SESSION_WORKSPACE_INVALID: {
    errorCode: SemanticErrorCode.SESSION_WORKSPACE_INVALID,
    message: "Session workspace is invalid or inaccessible",
    solutions: [
      "Check session status with session_inspect",
      "Recreate session if corrupted",
      "Verify session directory permissions"
    ],
    retryable: false,
    relatedTools: ["session_inspect", "session_start"]
  }
};

/**
 * Git operation error mappings
 */
export const GIT_ERROR_MAPPINGS: Record<string, ErrorMapping> = {
  GIT_BRANCH_CONFLICT: {
    errorCode: SemanticErrorCode.GIT_BRANCH_CONFLICT,
    message: "Git branch conflict detected",
    solutions: [
      "Use conflict resolution flags",
      "Manually resolve conflicts first",
      "Use git status to check current state"
    ],
    retryable: true,
    relatedTools: ["session_commit"]
  },
  
  GIT_AUTH_FAILED: {
    errorCode: SemanticErrorCode.GIT_AUTHENTICATION_FAILED,
    message: "Git authentication failed",
    solutions: [
      "Check git credentials",
      "Set up SSH keys or personal access token",
      "Verify repository access permissions"
    ],
    retryable: true
  }
};