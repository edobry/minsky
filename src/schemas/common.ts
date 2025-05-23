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
 * @example "task#123"
 */
export const sessionNameSchema = z.string().min(1).max(100);

/**
 * Task ID schema
 * Validates and normalizes task IDs (with or without the # prefix)
 */
export const taskIdSchema = z
  .string()
  .transform((val) => {
    // Normalize the task ID to #XXX format
    if (!val) return val;

    let normalized = val.trim();

    // Handle formats like "task#064" or "task#64"
    if (normalized.toLowerCase().startsWith("task#")) {
      normalized = normalized.substring(5);
    }

    // Remove all leading '#' characters to avoid multiple hashes
    while (normalized.startsWith("#")) {
      normalized = normalized.substring(1);
    }

    // Check if the result is a valid number (integer)
    if (!/^[0-9]+$/.test(normalized) || normalized.length === 0) {
      // Return original value to let refine validation catch it
      return val;
    }

    // Add the '#' prefix to ensure canonical format
    return `#${normalized}`;
  })
  .refine((val) => /^#[a-zA-Z0-9]+$/.test(val), {
    message: "Task ID must be in format #123 or 123",
  });

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
export const commonRepoSchema = z.object({
  session: sessionSchema.optional().describe("Session name"),
  repo: z.string().optional().describe("Repository URI"),
  workspace: z.string().optional().describe("URI of the upstream repository"),
  json: z.boolean().optional().describe("Return output as JSON"),
});

export const filePathSchema = z.string().min(1);
