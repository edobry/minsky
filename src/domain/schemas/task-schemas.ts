/**
 * Task Domain Schemas
 *
 * Interface-agnostic schemas for task-related operations that can be used
 * across CLI, MCP, and API interfaces.
 */
import { z } from "zod";
import {
  TaskIdSchema,
  QualifiedTaskIdSchema,
  NormalizedTaskIdSchema,
  BackendIdSchema,
  RepoIdSchema,
  WorkspacePathSchema,
  SessionIdSchema,
  BaseBackendParametersSchema,
  BaseExecutionContextSchema,
  BaseListingParametersSchema,
  BaseSuccessResponseSchema,
  BaseErrorResponseSchema,
  ForceSchema,
  OutputFormatSchema,
} from "./common-schemas";

// ========================
// TASK STATUS SCHEMAS
// ========================

/**
 * Task status schema - used across all interfaces
 */
export const TaskStatusSchema = z.enum([
  "TODO",
  "IN-PROGRESS",
  "IN-REVIEW",
  "DONE",
  "BLOCKED",
  "CLOSED",
]);

/**
 * Task priority schema - used across all interfaces
 */
export const TaskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]).default("medium");

// ========================
// TASK METADATA SCHEMAS
// ========================

/**
 * Task title schema - used across all interfaces
 */
export const TaskTitleSchema = z.string().min(1, "Task title cannot be empty");

/**
 * Task description schema - used across all interfaces
 */
export const TaskDescriptionSchema = z.string().optional();

/**
 * Task description path schema - used across all interfaces
 */
export const TaskDescriptionPathSchema = z.string().optional();

/**
 * Task tag schema - used across all interfaces
 */
export const TaskTagSchema = z.string().min(1);

/**
 * Task tags schema - used across all interfaces
 */
export const TaskTagsSchema = z.array(TaskTagSchema).optional();

/**
 * Task assignee schema - used across all interfaces
 */
export const TaskAssigneeSchema = z.string().optional();

/**
 * Task due date schema - used across all interfaces
 */
export const TaskDueDateSchema = z.string().datetime().optional();

// ========================
// TASK OPERATION PARAMETERS
// ========================

/**
 * Task creation parameters
 */
export const TaskCreateParametersSchema = z
  .object({
    title: TaskTitleSchema,
    description: TaskDescriptionSchema,
    descriptionPath: TaskDescriptionPathSchema,
    priority: TaskPrioritySchema,
    tags: TaskTagsSchema,
    assignee: TaskAssigneeSchema,
    dueDate: TaskDueDateSchema,
    force: ForceSchema,
  })
  .merge(BaseBackendParametersSchema);

/**
 * Task update parameters
 */
export const TaskUpdateParametersSchema = z
  .object({
    taskId: TaskIdSchema,
    title: TaskTitleSchema.optional(),
    description: TaskDescriptionSchema,
    descriptionPath: TaskDescriptionPathSchema,
    priority: TaskPrioritySchema.optional(),
    status: TaskStatusSchema.optional(),
    tags: TaskTagsSchema,
    assignee: TaskAssigneeSchema,
    dueDate: TaskDueDateSchema,
    force: ForceSchema,
  })
  .merge(BaseBackendParametersSchema);

/**
 * Task deletion parameters
 */
export const TaskDeleteParametersSchema = z
  .object({
    taskId: TaskIdSchema,
    force: ForceSchema,
  })
  .merge(BaseBackendParametersSchema);

/**
 * Task retrieval parameters
 */
export const TaskGetParametersSchema = z
  .object({
    taskId: TaskIdSchema,
  })
  .merge(BaseBackendParametersSchema)
  .merge(BaseExecutionContextSchema);

/**
 * Task listing parameters
 */
export const TaskListParametersSchema = z
  .object({
    status: TaskStatusSchema.optional(),
    priority: TaskPrioritySchema.optional(),
    assignee: TaskAssigneeSchema,
    tags: TaskTagsSchema,
    all: z.boolean().default(false),
  })
  .merge(BaseBackendParametersSchema)
  .merge(BaseExecutionContextSchema)
  .merge(BaseListingParametersSchema);

/**
 * Task status update parameters
 */
export const TaskStatusUpdateParametersSchema = z
  .object({
    taskId: TaskIdSchema,
    status: TaskStatusSchema,
  })
  .merge(BaseBackendParametersSchema);

/**
 * Task specification retrieval parameters
 */
export const TaskSpecParametersSchema = z
  .object({
    taskId: TaskIdSchema,
    section: z.string().optional(),
  })
  .merge(BaseBackendParametersSchema)
  .merge(BaseExecutionContextSchema);

// ========================
// MULTI-BACKEND TASK PARAMETERS
// ========================

/**
 * Multi-backend task creation parameters (with backend selection)
 */
export const MultiBackendTaskCreateParametersSchema = z
  .object({
    title: TaskTitleSchema,
    description: TaskDescriptionSchema,
    descriptionPath: TaskDescriptionPathSchema,
    priority: TaskPrioritySchema,
    tags: TaskTagsSchema,
    assignee: TaskAssigneeSchema,
    dueDate: TaskDueDateSchema,
    force: ForceSchema,
    backend: BackendIdSchema.optional(), // Optional backend selection
  })
  .merge(BaseBackendParametersSchema);

/**
 * Multi-backend task update parameters (normalized task ID)
 */
export const MultiBackendTaskUpdateParametersSchema = z
  .object({
    taskId: NormalizedTaskIdSchema, // Auto-migrates legacy IDs
    title: TaskTitleSchema.optional(),
    description: TaskDescriptionSchema,
    descriptionPath: TaskDescriptionPathSchema,
    priority: TaskPrioritySchema.optional(),
    status: TaskStatusSchema.optional(),
    tags: TaskTagsSchema,
    assignee: TaskAssigneeSchema,
    dueDate: TaskDueDateSchema,
    force: ForceSchema,
  })
  .merge(BaseBackendParametersSchema);

/**
 * Multi-backend task deletion parameters (normalized task ID)
 */
export const MultiBackendTaskDeleteParametersSchema = z
  .object({
    taskId: NormalizedTaskIdSchema, // Auto-migrates legacy IDs
    force: ForceSchema,
  })
  .merge(BaseBackendParametersSchema);

/**
 * Multi-backend task retrieval parameters (normalized task ID)
 */
export const MultiBackendTaskGetParametersSchema = z
  .object({
    taskId: NormalizedTaskIdSchema, // Auto-migrates legacy IDs
  })
  .merge(BaseBackendParametersSchema)
  .merge(BaseExecutionContextSchema);

/**
 * Multi-backend task listing parameters (with backend filtering)
 */
export const MultiBackendTaskListParametersSchema = z
  .object({
    status: TaskStatusSchema.optional(),
    priority: TaskPrioritySchema.optional(),
    assignee: TaskAssigneeSchema,
    tags: TaskTagsSchema,
    backend: BackendIdSchema.optional(), // Filter by specific backend
    backends: z.array(BackendIdSchema).optional(), // Filter by multiple backends
  })
  .merge(BaseListingParametersSchema)
  .merge(BaseBackendParametersSchema)
  .merge(BaseExecutionContextSchema);

/**
 * Cross-backend task search parameters
 */
export const CrossBackendTaskSearchParametersSchema = z
  .object({
    query: z.string().min(1, "Search query cannot be empty"),
    backends: z.array(BackendIdSchema).optional(), // Search specific backends
    status: TaskStatusSchema.optional(),
    priority: TaskPrioritySchema.optional(),
  })
  .merge(BaseListingParametersSchema)
  .merge(BaseBackendParametersSchema)
  .merge(BaseExecutionContextSchema);

/**
 * Task migration parameters
 */
export const TaskMigrationParametersSchema = z
  .object({
    sourceTaskId: QualifiedTaskIdSchema, // Must be qualified for migration
    targetBackend: BackendIdSchema,
    force: ForceSchema,
  })
  .merge(BaseBackendParametersSchema)
  .merge(BaseExecutionContextSchema);

// ========================
// TASK RESPONSE SCHEMAS
// ========================

/**
 * Base task data schema
 */
export const BaseTaskDataSchema = z.object({
  id: TaskIdSchema,
  title: TaskTitleSchema,
  description: TaskDescriptionSchema,
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  tags: TaskTagsSchema,
  assignee: TaskAssigneeSchema,
  dueDate: TaskDueDateSchema,
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  repository: RepoIdSchema.optional(),
  backend: BackendIdSchema.optional(),
});

/**
 * Task operation response schema
 */
export const TaskOperationResponseSchema = z.union([
  BaseSuccessResponseSchema.extend({
    task: BaseTaskDataSchema,
    message: z.string().optional(),
  }),
  BaseErrorResponseSchema.extend({
    taskId: TaskIdSchema.optional(),
  }),
]);

/**
 * Task list response schema
 */
export const TaskListResponseSchema = z.union([
  BaseSuccessResponseSchema.extend({
    tasks: z.array(BaseTaskDataSchema),
    totalCount: z.number().optional(),
    hasMore: z.boolean().optional(),
  }),
  BaseErrorResponseSchema,
]);

/**
 * Task specification response schema
 */
export const TaskSpecResponseSchema = z.union([
  BaseSuccessResponseSchema.extend({
    taskId: TaskIdSchema,
    specification: z.string(),
    section: z.string().optional(),
  }),
  BaseErrorResponseSchema.extend({
    taskId: TaskIdSchema.optional(),
  }),
]);

/**
 * Task status response schema
 */
export const TaskStatusResponseSchema = z.union([
  BaseSuccessResponseSchema.extend({
    taskId: TaskIdSchema,
    status: TaskStatusSchema,
    previousStatus: TaskStatusSchema.optional(),
  }),
  BaseErrorResponseSchema.extend({
    taskId: TaskIdSchema.optional(),
  }),
]);

// ========================
// TYPE EXPORTS
// ========================

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;
export type TaskTitle = z.infer<typeof TaskTitleSchema>;
export type TaskDescription = z.infer<typeof TaskDescriptionSchema>;
export type TaskTags = z.infer<typeof TaskTagsSchema>;
export type TaskCreateParameters = z.infer<typeof TaskCreateParametersSchema>;
export type TaskUpdateParameters = z.infer<typeof TaskUpdateParametersSchema>;
export type TaskDeleteParameters = z.infer<typeof TaskDeleteParametersSchema>;
export type TaskGetParameters = z.infer<typeof TaskGetParametersSchema>;
export type TaskListParameters = z.infer<typeof TaskListParametersSchema>;
export type TaskStatusUpdateParameters = z.infer<typeof TaskStatusUpdateParametersSchema>;
export type TaskSpecParameters = z.infer<typeof TaskSpecParametersSchema>;

// Multi-backend type exports
export type MultiBackendTaskCreateParameters = z.infer<typeof MultiBackendTaskCreateParametersSchema>;
export type MultiBackendTaskUpdateParameters = z.infer<typeof MultiBackendTaskUpdateParametersSchema>;
export type MultiBackendTaskDeleteParameters = z.infer<typeof MultiBackendTaskDeleteParametersSchema>;
export type MultiBackendTaskGetParameters = z.infer<typeof MultiBackendTaskGetParametersSchema>;
export type MultiBackendTaskListParameters = z.infer<typeof MultiBackendTaskListParametersSchema>;
export type CrossBackendTaskSearchParameters = z.infer<typeof CrossBackendTaskSearchParametersSchema>;
export type TaskMigrationParameters = z.infer<typeof TaskMigrationParametersSchema>;

export type BaseTaskData = z.infer<typeof BaseTaskDataSchema>;
export type TaskOperationResponse = z.infer<typeof TaskOperationResponseSchema>;
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;
export type TaskSpecResponse = z.infer<typeof TaskSpecResponseSchema>;
export type TaskStatusResponse = z.infer<typeof TaskStatusResponseSchema>;
