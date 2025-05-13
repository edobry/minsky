/**
 * Common schema definitions that can be reused across multiple domain modules
 */
import { z } from "zod";

/**
 * Schema for file or directory paths
 * @example "/path/to/directory"
 * @example "relative/path/to/file.txt"
 */
export const pathSchema = z
  .string()
  .min(1, "Path cannot be empty")
  .describe("File or directory path");

/**
 * Schema for Git repository paths
 * @example "/path/to/git/repo"
 * @example "https://github.com/user/repo.git"
 * @example "git@github.com:user/repo.git"
 */
export const repoPathSchema = z
  .string()
  .min(1, "Repository path cannot be empty")
  .describe("Path to a Git repository");

/**
 * Schema for session names
 * @example "my-session"
 * @example "task#123"
 */
export const sessionNameSchema = z
  .string()
  .min(1, "Session name cannot be empty")
  .describe("Session name");

/**
 * Task ID schema
 * Validates and normalizes task IDs (with or without the # prefix)
 */
export const taskIdSchema = z
  .string()
  .transform((val) => {
    // Normalize task IDs to always have a # prefix
    return val.startsWith("#") ? val : `#${val}`;
  })
  .describe("Task ID (with or without # prefix)");

/**
 * Schema for boolean flags with optional description
 */
export const flagSchema = (description: string) =>
  z.boolean().optional().default(false).describe(description);

/**
 * Schema for JSON output option
 */
export const jsonOutputSchema = flagSchema("Output as JSON");

/**
 * Common options present in many commands
 */
export const commonCommandOptionsSchema = z
  .object({
    json: jsonOutputSchema,
    session: sessionNameSchema.optional().describe("Session name to use"),
    repo: repoPathSchema.optional().describe("Git repository path"),
    workspace: pathSchema.optional().describe("Workspace path"),
    task: taskIdSchema.optional().describe("Task ID"),
  })
  .partial();

/**
 * Type for common command options
 */
export type CommonCommandOptions = z.infer<typeof commonCommandOptionsSchema>;

/**
 * Session schema
 * Validates session names
 */
export const sessionSchema = z.string().min(1).describe("Session identifier");

/**
 * Common repository options schema
 * Common parameters shared across repository operations
 */
export const commonRepoSchema = z.object({
  session: sessionSchema.optional().describe("Session name"),
  repo: z.string().optional().describe("Path to a git repository"),
  workspace: z.string().optional().describe("Path to main workspace"),
  json: z.boolean().optional().describe("Return output as JSON"),
});

/**
 * Utility function to normalize task IDs
 */
export function normalizeTaskId(taskId: string): string {
  return taskIdSchema.parse(taskId);
}
