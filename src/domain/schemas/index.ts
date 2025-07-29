/**
 * Domain Schemas Index
 *
 * Central export point for all domain-wide schemas that can be used
 * across CLI, MCP, and API interfaces.
 */

// Export all common schemas
export * from "./common-schemas";

// Export all task schemas
export * from "./task-schemas";

// Export all session schemas
export * from "./session-schemas";

// Export all file schemas
export * from "./file-schemas";

// Export validation utilities
export * from "./validation-utils";

// Re-export commonly used schema combinations for convenience
export {
  // Common identifiers
  TaskIdSchema,
  SessionIdSchema,
  RepoIdSchema,
  BackendIdSchema,
  WorkspacePathSchema,

  // Common flags
  ForceSchema,
  DebugSchema,
  QuietSchema,
  DryRunSchema,

  // Common response builders
  createSuccessResponse,
  createErrorResponse,

  // Base parameter schemas
  BaseBackendParametersSchema,
  BaseExecutionContextSchema,
  BaseListingParametersSchema,
} from "./common-schemas";

export {
  // Task operation schemas
  TaskCreateParametersSchema,
  TaskUpdateParametersSchema,
  TaskListParametersSchema,
  TaskGetParametersSchema,

  // Task response schemas
  TaskOperationResponseSchema,
  TaskListResponseSchema,

  // Task status
  TaskStatusSchema,
} from "./task-schemas";

export {
  // Session operation schemas
  SessionStartParametersSchema,
  SessionListParametersSchema,
  SessionGetParametersSchema,
  SessionUpdateParametersSchema,
  SessionPRParametersSchema,

  // Session response schemas
  SessionOperationResponseSchema,
  SessionListResponseSchema,

  // Session metadata
  SessionNameSchema,
  SessionDescriptionSchema,
} from "./session-schemas";

export {
  // File operation schemas
  FileReadSchema,
  FileWriteSchema,
  FileEditSchema,
  FileMoveSchema,
  FileRenameSchema,
  DirectoryListSchema,
  GrepSearchSchema,

  // File response schemas
  FileOperationResponseSchema,
  FileReadResponseSchema,
  DirectoryListResponseSchema,

  // File path schemas
  FilePathSchema,
  DirectoryPathSchema,

  // File response builders
  createFileOperationResponse,
} from "./file-schemas";
