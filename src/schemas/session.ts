/**
 * Schema definitions for session-related parameters and types
 */
import { z } from "zod";
import {
  commonCommandOptionsSchema,
  sessionIdSchema,
  taskIdSchema,
  repoPathSchema,
  flagSchema,
} from "./common";

/**
 * Schema for a session record
 */
export const _sessionRecordSchema = z.object({
  session: sessionIdSchema.describe("Unique name of the session"),
  repoUrl: z.string().describe("URL of the repository"),
  repoName: z.string().describe("Normalized name of the repository"),
  repoPath: z.string().optional().describe("Path to the session repository"),
  createdAt: z.string().describe("ISO timestamp of when the session was created"),
  taskId: taskIdSchema.optional().describe("Task ID associated with the session"),
  branch: z.string().optional().describe("Branch name for this session"),
  backendType: z.literal("github").describe("Backend type (only github is supported)"),
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
export const sessionListParamsSchema = commonCommandOptionsSchema.extend({
  task: taskIdSchema.optional().describe("Filter sessions by task ID"),
});

/**
 * Type for session list parameters
 */
export type SessionListParams = z.infer<typeof sessionListParamsSchema>;

/**
 * Schema for session get parameters
 */
export const sessionGetParamsSchema = z
  .object({
    sessionId: sessionIdSchema.optional().describe("Session ID to retrieve"),
    task: taskIdSchema.optional().describe("Task ID associated with the session"),
  })
  .extend(commonCommandOptionsSchema.shape)
  .refine((data) => data.sessionId !== undefined || data.task !== undefined, {
    message: "Either session ID or task ID must be provided",
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
    sessionId: sessionIdSchema.optional().describe("Session ID for the new session"),
    repo: repoPathSchema.optional().describe("Repository to start the session in"),
    task: taskIdSchema.optional().describe("Task ID to associate with the session"),
    description: z.string().min(1).optional().describe("Description for auto-created task"),
    branch: z.string().optional().describe("Branch name to create"),
    quiet: flagSchema("Suppress output except for the session directory path"),
    noStatusUpdate: flagSchema("Skip updating task status when starting a session with a task"),
    skipInstall: flagSchema(
      "⚠️ DEPRECATED — DO NOT USE. Skips dependency installation, creating a workspace that cannot pass typecheck hooks or run tests. Will be removed in a future release."
    ),
    packageManager: z
      .enum(["bun", "npm", "yarn", "pnpm"] as const)
      .optional()
      .describe("Override the detected package manager"),
    recover: z
      .boolean()
      .optional()
      .describe(
        "Delete existing stale/orphaned session for this task and create fresh (use with caution)"
      ),
  })
  .extend(commonCommandOptionsSchema.shape)
  .refine(
    (data) => {
      // Phase 2: Task association is required
      if (!data.task && !data.description) {
        return false;
      }
      // Either sessionId or task or description must be provided
      return data.sessionId || data.task || data.description;
    },
    {
      message: "Task association is required. Please provide --task <id> or --description <text>",
    }
  );

/**
 * Type for session start parameters
 */
export type SessionStartParams = z.infer<typeof sessionStartParamsSchema>;

/**
 * Schema for session delete parameters
 */
export const sessionDeleteParamsSchema = z
  .object({
    sessionId: sessionIdSchema.optional().describe("Session ID to delete"),
    task: taskIdSchema.optional().describe("Task ID associated with the session"),
    force: flagSchema("Skip confirmation prompt"),
  })
  .extend(commonCommandOptionsSchema.shape)
  .refine((data) => data.sessionId !== undefined || data.task !== undefined, {
    message: "Either session ID or task ID must be provided",
  });

/**
 * Type for session delete parameters
 */
export type SessionDeleteParams = z.infer<typeof sessionDeleteParamsSchema>;

/**
 * Schema for session dir parameters
 */
export const sessionDirParamsSchema = z
  .object({
    sessionId: sessionIdSchema.optional().describe("Session ID"),
    task: taskIdSchema.optional().describe("Task ID associated with the session"),
  })
  .extend(commonCommandOptionsSchema.shape)
  .refine((data) => data.sessionId !== undefined || data.task !== undefined, {
    message: "Either session ID or task ID must be provided",
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
    sessionId: sessionIdSchema.optional().describe("Session ID to update"),
    task: taskIdSchema.optional().describe("Task ID associated with the session"),
    branch: z.string().optional().describe("Branch to merge from (defaults to main)"),
    remote: z.string().optional().describe("Remote name to pull from (defaults to origin)"),
    noStash: flagSchema("Skip stashing local changes"),
    noPush: flagSchema("Skip pushing changes to remote after update"),
    force: flagSchema("Force update even if the session workspace is dirty"),
    skipConflictCheck: flagSchema("Skip proactive conflict detection before update"),
    autoResolveDeleteConflicts: flagSchema(
      "Automatically resolve delete/modify conflicts by accepting deletions"
    ),
    dryRun: flagSchema("Check for conflicts without performing actual update"),
    skipIfAlreadyMerged: flagSchema("Skip update if session changes are already in base branch"),
  })
  .extend(commonCommandOptionsSchema.shape)
  .refine((data) => data.sessionId !== undefined || data.task !== undefined, {
    message: "Either session ID or task ID must be provided",
  });

/**
 * Type for session update parameters
 */
export type SessionUpdateParams = z.infer<typeof sessionUpdateParamsSchema>;

/**
 * Schema for session approve parameters
 */
export const sessionApproveParamsSchema = z
  .object({
    sessionId: sessionIdSchema.optional().describe("Session ID to approve"),
    task: taskIdSchema.optional().describe("Task ID associated with the session"),
    repo: repoPathSchema.optional().describe("Repository path"),
    noStash: z
      .boolean()
      .optional()
      .default(false)
      .describe("Skip automatic stashing of uncommitted changes"),
  })
  .extend(commonCommandOptionsSchema.shape)
  .refine(
    (data) => data.sessionId !== undefined || data.task !== undefined || data.repo !== undefined,
    {
      message: "Either session ID, task ID, or repo path must be provided",
    }
  );

/**
 * Type for session approve parameters
 */
export type SessionApproveParams = z.infer<typeof sessionApproveParamsSchema>;

/**
 * Schema for session PR parameters
 */
export const sessionPrParamsSchema = z
  .object({
    sessionId: sessionIdSchema.optional().describe("Session ID"),
    task: taskIdSchema.optional().describe("Task ID associated with the session"),
    title: z.string().min(1).optional().describe("PR title (optional for existing PRs)"),
    body: z.string().optional().describe("PR body text"),
    bodyPath: z.string().optional().describe("Path to file containing PR body text"),
    baseBranch: z.string().optional().describe("Base branch for PR (defaults to main)"),
    debug: flagSchema("Enable debug output"),
    noStatusUpdate: flagSchema("Skip updating task status"),

    autoResolveDeleteConflicts: flagSchema(
      "Automatically resolve delete/modify conflicts by accepting deletions"
    ),
    skipConflictCheck: flagSchema("Skip proactive conflict detection during update"),
  })
  .extend(commonCommandOptionsSchema.shape)
  .refine((data) => !(data.body && data.bodyPath), {
    message: "Cannot provide both 'body' and 'bodyPath' - use one or the other",
    path: ["body"],
  })
  .refine((data) => data.body || data.bodyPath, {
    message: "PR description is required. Please provide either --body or --body-path",
    path: ["body"],
  });

/**
 * Type for session PR parameters
 */
export type SessionPrParams = z.infer<typeof sessionPrParamsSchema>;

/**
 * Schema for session review parameters
 */
export const sessionReviewParamsSchema = z
  .object({
    sessionId: sessionIdSchema.optional().describe("Session ID to review"),
    task: taskIdSchema.optional().describe("Task ID associated with the session"),
    repo: repoPathSchema.optional().describe("Repository path to use"),
    output: z.string().optional().describe("File path to save the review output"),
    prBranch: z.string().optional().describe("PR branch name (defaults to 'pr/<session>')"),
  })
  .extend(commonCommandOptionsSchema.shape);

/**
 * Type for session review parameters
 */
export type SessionReviewParams = z.infer<typeof sessionReviewParamsSchema>;

/**
 * Schema for session inspect parameters
 */
export const sessionInspectParamsSchema = z.object({}).extend(commonCommandOptionsSchema.shape);

/**
 * Type for session inspect parameters
 */
export type SessionInspectParams = z.infer<typeof sessionInspectParamsSchema>;
