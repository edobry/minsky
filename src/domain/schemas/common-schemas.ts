/**
 * Domain-Wide Common Schemas
 *
 * Interface-agnostic schemas that can be used across CLI, MCP, and API interfaces.
 * These schemas define the core domain concepts that are shared across all interfaces.
 */
import { z } from "zod";

// ========================
// CORE IDENTIFIER SCHEMAS
// ========================

/**
 * Task identifier schema - used across all interfaces
 * Supports both qualified IDs (md#123, gh#456) and legacy formats (123, task#123, #123)
 */
export const TaskIdSchema = z
  .string()
  .min(1, "Task ID cannot be empty")
  .refine(
    (value) => {
      // Import here to avoid circular dependencies
      const { isQualifiedTaskId, isLegacyTaskId } = require("../tasks/unified-task-id");
      return isQualifiedTaskId(value) || isLegacyTaskId(value);
    },
    {
      message: "Task ID must be either qualified (md#123, gh#456) or legacy format (123, task#123, #123)",
    }
  );

/**
 * Qualified task identifier schema - only accepts new format (md#123, gh#456)
 * Used when legacy formats should not be accepted
 */
export const QualifiedTaskIdSchema = z
  .string()
  .min(1, "Task ID cannot be empty")
  .refine(
    (value) => {
      // Import here to avoid circular dependencies
      const { isQualifiedTaskId } = require("../tasks/unified-task-id");
      return isQualifiedTaskId(value);
    },
    {
      message: "Task ID must be qualified format (md#123, gh#456, json#789)",
    }
  );

/**
 * Normalized task identifier schema - accepts any format but transforms to qualified
 * Used when we want to normalize legacy formats to qualified IDs
 */
export const NormalizedTaskIdSchema = z
  .string()
  .min(1, "Task ID cannot be empty")
  .transform((value, ctx) => {
    // Import here to avoid circular dependencies
    const { migrateUnqualifiedTaskId, isQualifiedTaskId, isLegacyTaskId } = require("../tasks/unified-task-id");

    if (isQualifiedTaskId(value)) {
      return value; // Already qualified
    }

    if (isLegacyTaskId(value)) {
      return migrateUnqualifiedTaskId(value, "md"); // Default to markdown backend
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Task ID must be either qualified (md#123) or legacy format (123, task#123, #123)",
    });
    return z.NEVER;
  });

/**
 * Session identifier schema - used across all interfaces
 */
export const SessionIdSchema = z.string().min(1, "Session ID cannot be empty");

/**
 * Repository identifier schema - used across all interfaces
 */
export const RepoIdSchema = z.string().min(1, "Repository ID cannot be empty");

/**
 * Backend identifier schema - used across all interfaces
 */
export const BackendIdSchema = z.string().min(1, "Backend ID cannot be empty");

/**
 * Workspace path schema - used across all interfaces
 */
export const WorkspacePathSchema = z.string().min(1, "Workspace path cannot be empty");

// ========================
// COMMON FLAG SCHEMAS
// ========================

/**
 * Force flag schema - used across all interfaces for operations that need confirmation
 */
export const ForceSchema = z.boolean().default(false);

/**
 * Debug flag schema - used across all interfaces for debug output
 */
export const DebugSchema = z.boolean().default(false);

/**
 * All flag schema - used across all interfaces for operations on all items
 */
export const AllSchema = z.boolean().default(false);

/**
 * Quiet flag schema - used across all interfaces to suppress output
 */
export const QuietSchema = z.boolean().default(false);

/**
 * Dry run flag schema - used across all interfaces for preview operations
 */
export const DryRunSchema = z.boolean().default(false);

// ========================
// FILTERING AND PAGINATION SCHEMAS
// ========================

/**
 * Filter string schema - used across all interfaces for filtering results
 */
export const FilterSchema = z.string().optional();

/**
 * Limit number schema - used across all interfaces for pagination
 */
export const LimitSchema = z.number().positive().optional();

/**
 * Offset number schema - used across all interfaces for pagination
 */
export const OffsetSchema = z.number().min(0).optional().default(0);

/**
 * Sort order schema - used across all interfaces for result ordering
 */
export const SortOrderSchema = z.enum(["asc", "desc"]).default("asc");

/**
 * Sort field schema - used across all interfaces for result ordering
 */
export const SortFieldSchema = z.string().optional();

// ========================
// OUTPUT FORMAT SCHEMAS
// ========================

/**
 * Format schema - used across all interfaces for output formatting
 */
export const OutputFormatSchema = z.enum(["json", "yaml", "table", "text"]).default("json");

/**
 * Verbosity level schema - used across all interfaces for output detail control
 */
export const VerbositySchema = z.enum(["quiet", "normal", "verbose", "debug"]).default("normal");

// ========================
// COMMON RESPONSE SCHEMAS
// ========================

/**
 * Base success response schema - used across all interfaces
 */
export const BaseSuccessResponseSchema = z.object({
  success: z.literal(true),
  timestamp: z.string().datetime().optional(),
});

/**
 * Base error response schema - used across all interfaces
 */
export const BaseErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  errorCode: z.string().optional(),
  details: z.record(z.any()).optional(),
  timestamp: z.string().datetime().optional(),
});

/**
 * Base response union schema - used across all interfaces
 */
export const BaseResponseSchema = z.union([BaseSuccessResponseSchema, BaseErrorResponseSchema]);

// ========================
// COMPOSED COMMON SCHEMAS
// ========================

/**
 * Base backend parameters that are common across domain operations
 */
export const BaseBackendParametersSchema = z.object({
  backend: BackendIdSchema.optional(),
  repo: RepoIdSchema.optional(),
  workspace: WorkspacePathSchema.optional(),
  session: SessionIdSchema.optional(),
});

/**
 * Base execution context parameters for command execution
 */
export const BaseExecutionContextSchema = z.object({
  debug: DebugSchema,
  format: OutputFormatSchema,
  quiet: QuietSchema,
  force: ForceSchema,
});

/**
 * Base pagination parameters for listing operations
 */
export const BasePaginationSchema = z.object({
  limit: LimitSchema,
  offset: OffsetSchema,
  filter: FilterSchema,
});

/**
 * Base sorting parameters for listing operations
 */
export const BaseSortingSchema = z.object({
  sortField: SortFieldSchema,
  sortOrder: SortOrderSchema,
});

/**
 * Complete listing parameters combining pagination and sorting
 */
export const BaseListingParametersSchema = BasePaginationSchema.merge(BaseSortingSchema);

// ========================
// COMMON RESPONSE BUILDERS
// ========================

/**
 * Creates a standardized success response
 */
export function createSuccessResponse<T extends Record<string, any>>(
  data: T,
  includeTimestamp: boolean = true
): z.infer<typeof BaseSuccessResponseSchema> & T {
  return {
    success: true as const,
    ...(includeTimestamp && { timestamp: new Date().toISOString() }),
    ...data,
  };
}

/**
 * Creates a standardized error response
 */
export function createErrorResponse(
  error: string,
  errorCode?: string,
  details?: Record<string, any>,
  includeTimestamp: boolean = true
): z.infer<typeof BaseErrorResponseSchema> {
  return {
    success: false as const,
    error,
    ...(errorCode && { errorCode }),
    ...(details && { details }),
    ...(includeTimestamp && { timestamp: new Date().toISOString() }),
  };
}

// ========================
// TYPE EXPORTS
// ========================

export type TaskId = z.infer<typeof TaskIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type RepoId = z.infer<typeof RepoIdSchema>;
export type BackendId = z.infer<typeof BackendIdSchema>;
export type WorkspacePath = z.infer<typeof WorkspacePathSchema>;
export type OutputFormat = z.infer<typeof OutputFormatSchema>;
export type Verbosity = z.infer<typeof VerbositySchema>;
export type SortOrder = z.infer<typeof SortOrderSchema>;
export type BaseBackendParameters = z.infer<typeof BaseBackendParametersSchema>;
export type BaseExecutionContext = z.infer<typeof BaseExecutionContextSchema>;
export type BasePagination = z.infer<typeof BasePaginationSchema>;
export type BaseSorting = z.infer<typeof BaseSortingSchema>;
export type BaseListingParameters = z.infer<typeof BaseListingParametersSchema>;
export type BaseSuccessResponse = z.infer<typeof BaseSuccessResponseSchema>;
export type BaseErrorResponse = z.infer<typeof BaseErrorResponseSchema>;
export type BaseResponse = z.infer<typeof BaseResponseSchema>;
