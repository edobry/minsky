/**
 * Schema definitions for session-related parameters and types
 */
import { z } from "zod";
import {
  commonCommandOptionsSchema,
  sessionNameSchema,
  taskIdSchema,
  repoPathSchema,
  flagSchema,
} from "./common.js";

/**
 * Schema for a session record
 */
export const sessionRecordSchema = z.object({
  session: sessionNameSchema.describe("Unique name of the session"),
  repoUrl: z.string().describe("URL of the repository"),
  repoName: z.string().describe("Normalized name of the repository"),
  repoPath: z.string().optional().describe("Path to the session repository"),
  createdAt: z.string().describe("ISO timestamp of when the session was created"),
  taskId: taskIdSchema.optional().describe("Task ID associated with the session"),
  branch: z.string().optional().describe("Branch name for this session"),
  backendType: z.string().describe("Backend type (local, remote, etc.)"),
  remote: z
    .object({
      authMethod: z.string().describe("Authentication method for remote operations"),
      depth: z.number().describe("Clone depth"),
    })
    .describe("Remote repository configuration"),
});

/**
 * Schema for session list parameters
 */
export const sessionListParamsSchema = commonCommandOptionsSchema;

/**
 * Type for session list parameters
 */
export type SessionListParams = z.infer<typeof sessionListParamsSchema>;

/**
 * Schema for session get parameters
 */
export const sessionGetParamsSchema = z
  .object({
    name: sessionNameSchema.optional().describe("Name of the session to retrieve"),
    task: taskIdSchema.optional().describe("Task ID associated with the session"),
  })
  .merge(commonCommandOptionsSchema)
  .refine((data) => data.name !== undefined || data.task !== undefined, {
    message: "Either session name or task ID must be provided",
  });

/**
 * Type for session get parameters
 */
export type SessionGetParams = z.infer<typeof sessionGetParamsSchema>;

/**
 * Schema for session start parameters
 */
export const sessionStartParamsSchema = z
  .object({
    name: sessionNameSchema.optional().describe("Name for the new session"),
    repo: repoPathSchema.optional().describe("Repository to start the session in"),
    task: taskIdSchema.optional().describe("Task ID to associate with the session"),
    branch: z.string().optional().describe("Branch name to create"),
    quiet: flagSchema("Suppress output except for the session directory path"),
    noStatusUpdate: flagSchema("Skip updating task status when starting a session with a task"),
  })
  .merge(commonCommandOptionsSchema);

/**
 * Type for session start parameters
 */
export type SessionStartParams = z.infer<typeof sessionStartParamsSchema>;

/**
 * Schema for session delete parameters
 */
export const sessionDeleteParamsSchema = z
  .object({
    name: sessionNameSchema.describe("Name of the session to delete"),
    force: flagSchema("Skip confirmation prompt"),
  })
  .merge(commonCommandOptionsSchema);

/**
 * Type for session delete parameters
 */
export type SessionDeleteParams = z.infer<typeof sessionDeleteParamsSchema>;

/**
 * Schema for session dir parameters
 */
export const sessionDirParamsSchema = z
  .object({
    name: sessionNameSchema.optional().describe("Name of the session"),
    task: taskIdSchema.optional().describe("Task ID associated with the session"),
  })
  .merge(commonCommandOptionsSchema)
  .refine((data) => data.name !== undefined || data.task !== undefined, {
    message: "Either session name or task ID must be provided",
  });

/**
 * Type for session dir parameters
 */
export type SessionDirParams = z.infer<typeof sessionDirParamsSchema>;

/**
 * Schema for session update parameters
 */
export const sessionUpdateParamsSchema = z
  .object({
    name: sessionNameSchema.describe("Name of the session to update"),
    branch: z.string().optional().describe("Branch to merge from (defaults to main)"),
    remote: z.string().optional().describe("Remote name to pull from (defaults to origin)"),
    noStash: flagSchema("Skip stashing local changes"),
    noPush: flagSchema("Skip pushing changes to remote after update"),
  })
  .merge(commonCommandOptionsSchema);

/**
 * Type for session update parameters
 */
export type SessionUpdateParams = z.infer<typeof sessionUpdateParamsSchema>;

/**
 * Schema for session approve parameters
 */
export const sessionApproveParamsSchema = z
  .object({
    task: taskIdSchema.optional().describe("Task ID associated with the session"),
    session: sessionNameSchema.optional().describe("Name of the session to approve"),
    repo: repoPathSchema.optional().describe("Repository path"),
  })
  .merge(commonCommandOptionsSchema)
  .refine((data) => data.session !== undefined || data.task !== undefined || data.repo !== undefined, {
    message: "Either session name, task ID, or repo path must be provided",
  });

/**
 * Type for session approve parameters
 */
export type SessionApproveParams = z.infer<typeof sessionApproveParamsSchema>;

/**
 * Schema for session PR parameters
 */
export const sessionPrParamsSchema = z
  .object({
    session: sessionNameSchema.optional().describe("Name of the session"),
    task: taskIdSchema.optional().describe("Task ID associated with the session"),
    title: z.string().optional().describe("PR title (if not provided, will be generated)"),
    body: z.string().optional().describe("PR body (if not provided, will be generated)"),
    baseBranch: z.string().optional().describe("Base branch for PR (defaults to main)"),
    debug: flagSchema("Enable debug output"),
    noStatusUpdate: flagSchema("Skip updating task status"),
  })
  .merge(commonCommandOptionsSchema);

/**
 * Type for session PR parameters
 */
export type SessionPrParams = z.infer<typeof sessionPrParamsSchema>;

/**
 * Schema for session inspect parameters
 */
export const sessionInspectParamsSchema = z
  .object({})
  .merge(commonCommandOptionsSchema);

/**
 * Type for session inspect parameters
 */
export type SessionInspectParams = z.infer<typeof sessionInspectParamsSchema>;
