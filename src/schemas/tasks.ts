/**
 * Schema definitions for task-related parameters and types
 */
import { z } from "zod";
import { commonCommandOptionsSchema, taskIdSchema, flagSchema } from "./common";
import { TASK_STATUS_VALUES } from "../domain/tasks/taskConstants.js";

/**
 * Valid task statuses
 */
export const TASK_STATUS = {
  TODO: "TODO",
  DONE: "DONE",
  IN_PROGRESS: "IN-PROGRESS",
  IN_REVIEW: "IN-REVIEW",
  BLOCKED: "BLOCKED",
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
    .describe("Specify task backend (markdown, json-file, github-issues)"),
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
    .describe("Specify task backend (markdown, json-file, github-issues)"),
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
      .describe("Specify task backend (markdown, json-file, github-issues)"),
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
      .describe("Specify task backend (markdown, json-file, github-issues)"),
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
    description: z.string().optional().describe("Description text for the task"),
    descriptionPath: z.string().optional().describe("Path to file containing task description"),
    force: flagSchema("Force creation even if task already exists"),
    backend: z
      .string()
      .optional()
      .describe("Specify task backend (markdown, json-file, github-issues)"),
  })
  .merge(commonCommandOptionsSchema)
  .refine(
    (data) => {
      // Either description or descriptionPath must be provided
      return data.description || data.descriptionPath;
    },
    {
      message: "Either --description or --description-path must be provided",
    }
  );

/**
 * Type for task create parameters
 */
export type TaskCreateParams = z.infer<typeof taskCreateParamsSchema>;

/**
 * Type for task create from title and description parameters
 */
export type TaskCreateFromTitleAndDescriptionParams = z.infer<typeof taskCreateFromTitleAndDescriptionParamsSchema>;

/**
 * Schema for task create from title and description parameters
 */
export const taskCreateFromTitleAndDescriptionParamsSchema = z
  .object({
    title: z.string().min(1).describe("Title for the task (required)"),
    description: z.string().optional().describe("Description text for the task"),
    descriptionPath: z.string().optional().describe("Path to file containing task description"),
    force: flagSchema("Force creation even if task already exists"),
    backend: z
      .string()
      .optional()
      .describe("Specify task backend (markdown, json-file, github-issues)"),
  })
  .merge(commonCommandOptionsSchema)
  .refine((data) => data.description || data.descriptionPath, {
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
      .describe("Specify task backend (markdown, json-file, github-issues)"),
  })
  .merge(commonCommandOptionsSchema);

/**
 * Type for task spec content parameters
 */
export type TaskSpecContentParams = z.infer<typeof taskSpecContentParamsSchema>;
