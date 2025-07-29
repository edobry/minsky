/**
 * Task-Specific Parameter Schemas for MCP Tools
 *
 * Follows the type composition patterns established in Task #322 for session tools.
 * These schemas provide reusable validation and typing for task-related parameters.
 *
 * Task #328 Phase 4: Updated to use cross-domain common schemas.
 */

import { z } from "zod";
import {
  TaskIdSchema,
  BackendSchema,
  RepoSchema,
  WorkspaceSchema,
  SessionSchema,
  ForceSchema,
  FilterSchema,
  LimitSchema,
  AllSchema,
  BaseBackendParametersSchema,
} from "./common-parameters";

/**
 * Task title schema
 */
export const TaskTitleSchema = z.string().min(1, "Task title cannot be empty");

/**
 * Task status schema
 */
export const TaskStatusSchema = z.enum([
  "TODO",
  "IN-PROGRESS",
  "IN-REVIEW",
  "DONE",
  "BLOCKED",
  "CLOSED",
], {
  errorMap: () => ({
    message:
      "Status must be one of: TODO, IN-PROGRESS, IN-REVIEW, DONE, BLOCKED, CLOSED",
  }),
});

/**
 * Task description schema
 */
export const TaskDescriptionSchema = z.string().optional();

/**
 * Task creation parameters schema
 */
export const TaskCreateParametersSchema = BaseBackendParametersSchema.extend({
  title: TaskTitleSchema,
  description: TaskDescriptionSchema,
  force: ForceSchema,
});

/**
 * Task listing parameters schema
 */
export const TaskListParametersSchema = BaseBackendParametersSchema.extend({
  all: AllSchema,
  status: TaskStatusSchema.optional(),
  filter: FilterSchema,
  limit: LimitSchema,
});

/**
 * Task retrieval parameters schema
 */
export const TaskGetParametersSchema = BaseBackendParametersSchema.extend({
  taskId: TaskIdSchema,
});

/**
 * Task status update parameters schema
 */
export const TaskStatusUpdateParametersSchema = BaseBackendParametersSchema.extend({
  taskId: TaskIdSchema,
  status: TaskStatusSchema,
});

// Export types for TypeScript usage
export type TaskCreateParameters = z.infer<typeof TaskCreateParametersSchema>;
export type TaskListParameters = z.infer<typeof TaskListParametersSchema>;
export type TaskGetParameters = z.infer<typeof TaskGetParametersSchema>;
export type TaskStatusUpdateParameters = z.infer<
  typeof TaskStatusUpdateParametersSchema
>;
export type BaseTaskParameters = z.infer<typeof BaseBackendParametersSchema>;
