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
  filter: z.string().optional().describe("Filter tasks by status or other criteria"),
  limit: z.number().optional().describe("Limit the number of tasks returned"),
  all: flagSchema("Include completed tasks"),
  backend: z
    .string()
    .optional()
    .describe("Specify task backend (available: markdown, json-file, github, minsky)"),
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
    .describe("Specify task backend (available: markdown, json-file, github, minsky)"),
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
      .describe("Specify task backend (available: markdown, json-file, github, minsky)"),
  })
  .merge(commonCommandOptionsSchema);

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
      .describe("Specify task backend (available: markdown, json-file, github, minsky)"),
  })
  .merge(commonCommandOptionsSchema);

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
    description: z.string().optional().describe("Description text for the task (alias for spec)"),
    specPath: z.string().optional().describe("Path to file containing task spec"),
    dependencies: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("Comma-separated list of task IDs this task depends on, or array of task IDs"),
    force: flagSchema("Force creation even if task already exists"),
    backend: z
      .string()
      .optional()
      .describe("Specify task backend (available: markdown, json-file, github, minsky)"),
  })
  .merge(commonCommandOptionsSchema)
  .refine(
    (data) => {
      // Either spec/description or specPath must be provided
      return data.spec || data.description || data.specPath;
    },
    {
      message: "Either --description or --spec-path must be provided",
    }
  );

/**
 * Type for task create parameters
 */
export type TaskCreateParams = z.infer<typeof taskCreateParamsSchema>;

/**
 * Type for task create from title and description parameters
 */
export type TaskCreateFromTitleAndDescriptionParams = z.infer<
  typeof taskCreateFromTitleAndDescriptionParamsSchema
>;

/**
 * Schema for task create from title and description parameters
 */
export const taskCreateFromTitleAndDescriptionParamsSchema = z
  .object({
    title: z.string().min(1).describe("Title for the task (required)"),
    spec: z.string().optional().describe("Spec text for the task"),
    specPath: z.string().optional().describe("Path to file containing task spec"),
    force: flagSchema("Force creation even if task already exists"),
    backend: z
      .string()
      .optional()
      .describe("Specify task backend (available: markdown, json-file, github, minsky)"),
    githubRepo: z
      .string()
      .optional()
      .describe(
        "GitHub repository override in 'owner/repo' format (only for github-issues backend)"
      ),
  })
  .merge(commonCommandOptionsSchema)
  .refine((data) => data.spec || data.specPath, {
    message: "Either 'description' or 'descriptionPath' must be provided",
    path: ["description"],
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
      .describe("Specify task backend (available: markdown, json-file, github, minsky)"),
  })
  .merge(commonCommandOptionsSchema);

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
      .describe("Specify task backend (available: markdown, json-file, github, minsky)"),
  })
  .merge(commonCommandOptionsSchema);

/**
 * Type for task delete parameters
 */
export type TaskDeleteParams = z.infer<typeof taskDeleteParamsSchema>;
