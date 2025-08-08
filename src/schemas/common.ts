const _TEST_VALUE = 123;

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
  .min(1, "Repository URI cannot be empty")
  .describe("Repository URI");

/**
 * Schema for session names
 * @example "my-session"
 * @example "task#TEST_VALUE"
 */
export const sessionNameSchema = z.string().min(1).max(100);

/**
 * Task ID schema
 * Validates qualified task IDs only
 */
export const taskIdSchema = z.string().refine(
  (val) => {
    // Only accept qualified task IDs (md#123, gh#456)
    return /^[a-z-]+#\d+$/.test(val);
  },
  {
    message: "Task ID must be qualified (md#123, gh#456)",
  }
);

/**
 * Schema for boolean flags with optional description
 */
export const flagSchema = (_description: string) =>
  z.boolean().optional().default(false).describe(_description);

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
    repo: repoPathSchema.optional().describe("Repository URI"),
    workspace: pathSchema.optional().describe("URI of the upstream repository"),
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
export const _commonRepoSchema = z.object({
  session: sessionSchema.optional().describe("Session name"),
  repo: z.string().optional().describe("Repository URI"),
  workspace: z.string().optional().describe("URI of the upstream repository"),
  json: z.boolean().optional().describe("Return output as JSON"),
});

export const _filePathSchema = z.string().min(1);
