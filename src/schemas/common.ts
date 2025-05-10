/**
 * Common schema definitions that can be reused across multiple domain modules
 */
import { z } from "zod";

/**
 * Schema for file or directory paths
 * @example "/path/to/directory"
 * @example "relative/path/to/file.txt"
 */
export const pathSchema = z.string()
  .min(1, "Path cannot be empty")
  .describe("File or directory path");

/**
 * Schema for Git repository paths
 * @example "/path/to/git/repo"
 * @example "https://github.com/user/repo.git"
 * @example "git@github.com:user/repo.git"
 */
export const repoPathSchema = z.string()
  .min(1, "Repository path cannot be empty")
  .describe("Path to a Git repository");

/**
 * Schema for session names
 * @example "my-session"
 * @example "task#123"
 */
export const sessionNameSchema = z.string()
  .min(1, "Session name cannot be empty")
  .describe("Session name");

/**
 * Schema for task IDs
 * @example "123"
 * @example "#123"
 */
export const taskIdSchema = z.string()
  .regex(/^#?\d+$/, "Task ID must be a number with optional '#' prefix")
  .describe("Task ID");

/**
 * Schema for boolean flags with optional description
 */
export const flagSchema = (description: string) => z.boolean()
  .optional()
  .default(false)
  .describe(description);

/**
 * Schema for JSON output option
 */
export const jsonOutputSchema = flagSchema("Output as JSON");

/**
 * Common options present in many commands
 */
export const commonCommandOptionsSchema = z.object({
  json: jsonOutputSchema,
  session: sessionNameSchema.optional().describe("Session name to use"),
  repo: repoPathSchema.optional().describe("Git repository path"),
  workspace: pathSchema.optional().describe("Workspace path"),
  task: taskIdSchema.optional().describe("Task ID")
}).partial();

/**
 * Type for common command options
 */
export type CommonCommandOptions = z.infer<typeof commonCommandOptionsSchema>; 
