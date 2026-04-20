/**
 * Schema definitions for task-related parameters and types
 */
import { z } from "zod";
import { commonCommandOptionsSchema, taskIdSchema, flagSchema } from "./common";
import { TASK_STATUS_VALUES } from "../domain/tasks/taskConstants";

/**
 * Valid task statuses
 */
export const _TASK_STATUS = {
  TODO: "TODO",
  PLANNING: "PLANNING",
  DONE: "DONE",
  IN_PROGRESS: "IN-PROGRESS",
  IN_REVIEW: "IN-REVIEW",
  BLOCKED: "BLOCKED",
  CLOSED: "CLOSED",
} as const;

/**
 * Task status schema
 * @example "TODO"
 * @example "IN-PROGRESS"
 */
export const taskStatusSchema = z
  .enum(TASK_STATUS_VALUES as [string, ...string[]])
  .describe("Task status");

/**
 * Schema for task list parameters
 */
export const taskListParamsSchema = commonCommandOptionsSchema.extend({
  status: taskStatusSchema
    .optional()
    .describe("Filter tasks by status (e.g. TODO, IN-PROGRESS, DONE)"),
  filter: z.string().optional().describe("Filter tasks by status or other criteria"),
  limit: z.number().optional().describe("Limit the number of tasks returned"),
  all: flagSchema("Include completed tasks"),
  backend: z
    .string()
    .optional()
    .describe("Specify task backend (available: github-issues, minsky)"),
  tags: z
    .array(z.string())
    .optional()
    .describe("Filter tasks by tags (e.g., ['di-cleanup', 'test-quality'])"),
});

/**
 * Type for task list parameters
 */
export type TaskListParams = z.infer<typeof taskListParamsSchema>;

/**
 * Schema for task get parameters
 */
export const taskGetParamsSchema = commonCommandOptionsSchema.extend({
  taskId: z
    .union([
      taskIdSchema.describe("ID of the task to retrieve"),
      z.array(taskIdSchema).describe("Array of task IDs to retrieve"),
    ])
    .describe("Task ID or array of task IDs to retrieve"),
  backend: z
    .string()
    .optional()
    .describe("Specify task backend (available: github-issues, minsky)"),
  includeSpec: z
    .boolean()
    .optional()
    .describe("Include task specification content in the response"),
  includeSubtasks: z.boolean().optional().describe("Include subtask summary in the response"),
});

/**
 * Type for task get parameters
 */
export type TaskGetParams = z.infer<typeof taskGetParamsSchema>;

/**
 * Schema for task status get parameters
 */
export const taskStatusGetParamsSchema = z
  .object({
    taskId: taskIdSchema.describe("ID of the task"),
    backend: z
      .string()
      .optional()
      .describe("Specify task backend (available: github-issues, minsky)"),
  })
  .extend(commonCommandOptionsSchema.shape);

/**
 * Type for task status get parameters
 */
export type TaskStatusGetParams = z.infer<typeof taskStatusGetParamsSchema>;

/**
 * Schema for task status set parameters
 */
export const taskStatusSetParamsSchema = z
  .object({
    taskId: taskIdSchema.describe("ID of the task"),
    status: taskStatusSchema.describe("New status for the task"),
    backend: z
      .string()
      .optional()
      .describe("Specify task backend (available: github-issues, minsky)"),
  })
  .extend(commonCommandOptionsSchema.shape);

/**
 * Type for task status set parameters
 */
export type TaskStatusSetParams = z.infer<typeof taskStatusSetParamsSchema>;

/**
 * Schema for task create parameters
 */
export const taskCreateParamsSchema = z
  .object({
    title: z.string().min(1).describe("Title for the task"),
    spec: z.string().optional().describe("Spec text for the task"),
    description: z
      .string()
      .optional()
      .describe("Description text for the task (DEPRECATED: use spec instead)"),
    force: flagSchema("Force creation even if task already exists"),
    backend: z
      .string()
      .optional()
      .describe("Specify task backend (available: github-issues, minsky)"),
    dependsOn: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("Task ID(s) this task depends on (e.g., 'mt#123' or ['mt#123', 'mt#456'])"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Tags/labels for thematic batching (e.g., ['di-cleanup', 'test-quality'])"),
  })
  .extend(commonCommandOptionsSchema.shape)
  .refine(
    (data) => {
      // Either spec or description must be provided (description is deprecated alias for spec)
      return data.spec || data.description;
    },
    {
      message: "--spec must be provided",
    }
  );

/**
 * Type for task create parameters
 */
export type TaskCreateParams = z.infer<typeof taskCreateParamsSchema>;

/**
 * Type for task create from title and spec parameters
 */
export type TaskCreateFromTitleAndSpecParams = z.infer<
  typeof taskCreateFromTitleAndSpecParamsSchema
>;

/**
 * Schema for task create from title and spec parameters
 */
export const taskCreateFromTitleAndSpecParamsSchema = z
  .object({
    title: z.string().min(1).describe("Title for the task (required)"),
    spec: z.string().optional().describe("Spec text for the task"),
    force: flagSchema("Force creation even if task already exists"),
    backend: z
      .string()
      .optional()
      .describe("Specify task backend (available: github-issues, minsky)"),
    githubRepo: z
      .string()
      .optional()
      .describe(
        "GitHub repository override in 'owner/repo' format (only for github-issues backend)"
      ),
  })
  .extend(commonCommandOptionsSchema.shape)
  .refine((data) => data.spec, {
    message: "'spec' must be provided",
    path: ["spec"],
  });

/**
 * Schema for task spec content parameters
 */
export const taskSpecContentParamsSchema = z
  .object({
    taskId: taskIdSchema.describe("ID of the task to retrieve specification _content for"),
    section: z
      .string()
      .optional()
      .describe("Specific section of the specification to retrieve (e.g., 'requirements')"),
    backend: z
      .string()
      .optional()
      .describe("Specify task backend (available: github-issues, minsky)"),
  })
  .extend(commonCommandOptionsSchema.shape);

/**
 * Type for task spec content parameters
 */
export type TaskSpecContentParams = z.infer<typeof taskSpecContentParamsSchema>;

/**
 * Schema for task delete parameters
 */
export const taskDeleteParamsSchema = z
  .object({
    taskId: taskIdSchema.describe("ID of the task to delete"),
    force: flagSchema("Force deletion without confirmation"),
    backend: z
      .string()
      .optional()
      .describe("Specify task backend (available: github-issues, minsky)"),
  })
  .extend(commonCommandOptionsSchema.shape);

/**
 * Type for task delete parameters
 */
export type TaskDeleteParams = z.infer<typeof taskDeleteParamsSchema>;
