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
  QualifiedTaskIdSchema,
  NormalizedTaskIdSchema,
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
  TaskDeleteParametersSchema,
  TaskSpecParametersSchema,
  TaskStatusUpdateParametersSchema,

  // Multi-backend task operation schemas
  MultiBackendTaskCreateParametersSchema,
  MultiBackendTaskUpdateParametersSchema,
  MultiBackendTaskDeleteParametersSchema,
  MultiBackendTaskGetParametersSchema,
  MultiBackendTaskListParametersSchema,
  CrossBackendTaskSearchParametersSchema,
  TaskMigrationParametersSchema,

  // Task response schemas
  TaskOperationResponseSchema,
  TaskListResponseSchema,

  // Task status
  TaskStatusSchema,

  // Task types
  type TaskCreateParameters,
  type TaskUpdateParameters,
  type TaskListParameters,
  type TaskGetParameters,
  type TaskDeleteParameters,
  type TaskSpecParameters,
  type TaskStatusUpdateParameters,

  // Multi-backend task types
  type MultiBackendTaskCreateParameters,
  type MultiBackendTaskUpdateParameters,
  type MultiBackendTaskDeleteParameters,
  type MultiBackendTaskGetParameters,
  type MultiBackendTaskListParameters,
  type CrossBackendTaskSearchParameters,
  type TaskMigrationParameters,
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

// ========================
// BACKWARD COMPATIBILITY ALIASES
// ========================

// Import schemas and types for aliasing
import {
  TaskListParametersSchema,
  TaskGetParametersSchema,
  TaskCreateParametersSchema,
  TaskDeleteParametersSchema,
  TaskSpecParametersSchema,
  TaskStatusUpdateParametersSchema,
  type TaskListParameters,
  type TaskGetParameters,
  type TaskCreateParameters,
  type TaskDeleteParameters,
  type TaskSpecParameters,
  type TaskStatusUpdateParameters,
} from "./task-schemas";

// Task schema aliases for backward compatibility
export const taskListParamsSchema = TaskListParametersSchema;
export const taskGetParamsSchema = TaskGetParametersSchema;
export const taskStatusGetParamsSchema = TaskGetParametersSchema; // Reuse TaskGetParametersSchema
export const taskStatusSetParamsSchema = TaskStatusUpdateParametersSchema;
export const taskCreateParamsSchema = TaskCreateParametersSchema;
export const taskSpecContentParamsSchema = TaskSpecParametersSchema;
export const taskDeleteParamsSchema = TaskDeleteParametersSchema;

// Task type aliases for backward compatibility
export type TaskListParams = TaskListParameters;
export type TaskGetParams = TaskGetParameters;
export type TaskStatusGetParams = TaskGetParameters;
export type TaskStatusSetParams = TaskStatusUpdateParameters;
export type TaskCreateParams = TaskCreateParameters;
export type TaskSpecContentParams = TaskSpecParameters;
export type TaskDeleteParams = TaskDeleteParameters;
