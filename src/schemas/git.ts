/**
 * Schema definitions for git-related parameters and types
 */
import { z } from "zod";
import {
  commonCommandOptionsSchema,
  pathSchema,
  repoPathSchema,
  taskIdSchema,
  flagSchema,
  sessionSchema,
  commonRepoSchema,
} from "./common.js";

/**
 * Schema for git clone parameters
 */
export const gitCloneParamsSchema = (z
  .object({
    url: z.string().url().describe("URL of the Git repository to clone"),
    directory: pathSchema.optional().describe("Target directory for the clone"),
    branch: z.string().optional().describe("Branch to checkout after cloning"),
    depth: z.number().optional().describe("Create a shallow clone with specified depth"),
  }) as unknown).merge(commonCommandOptionsSchema);

/**
 * Type for git clone parameters
 */
export type GitCloneParams = z.infer<typeof gitCloneParamsSchema>;

/**
 * Schema for git branch parameters
 */
export const gitBranchParamsSchema = (z
  .object({
    name: z.string().min(1).describe("Name of the _branch to create"),
    repo: repoPathSchema.optional().describe("Path to the git repository"),
  }) as unknown).merge(commonCommandOptionsSchema);

/**
 * Type for git branch parameters
 */
export type GitBranchParams = z.infer<typeof gitBranchParamsSchema>;

/**
 * Common Git options schema
 */
export const gitCommonOptionsSchema = z.object({
  ...(commonRepoSchema as unknown).shape,
  branch: z.string().optional().describe("Branch name"),
  remote: z.string().optional().describe("Remote name"),
});

/**
 * PR Command parameters schema
 */
export const createPrParamsSchema = (gitCommonOptionsSchema as unknown).extend({
  debug: (z.boolean().optional() as unknown).describe("Enable debug logging"),
  noStatusUpdate: (z.boolean().optional() as unknown).describe("Skip updating task status"),
  taskId: (taskIdSchema.optional() as unknown).describe("Task ID associated with this PR"),
  json: (z.boolean().optional() as unknown).describe("Return output as JSON"),
});

export type CreatePrParams = z.infer<typeof createPrParamsSchema>;

/**
 * Commit command parameters schema
 */
export const commitChangesParamsSchema = (gitCommonOptionsSchema as unknown).extend({
  message: z.string().min(1).describe("Commit message"),
  amend: (z.boolean().optional() as unknown).describe("Amend the previous commit"),
  all: (z.boolean().optional() as unknown).describe("Stage all changes including deletions"),
  noStage: (z.boolean().optional() as unknown).describe("Skip staging changes"),
});

export type CommitChangesParams = z.infer<typeof commitChangesParamsSchema>;

/**
 * Legacy schema definitions (to maintain backward compatibility)
 */
export type GitPullRequestParams = z.infer<typeof createPrParamsSchema>;
export type GitCommitParams = z.infer<typeof commitChangesParamsSchema>;

/**
 * Schema for git push parameters
 */
export const gitPushParamsSchema = (z
  .object({
    repo: repoPathSchema.optional().describe("Path to the git repository"),
    remote: z.string().optional().default("origin").describe("Remote to push to"),
    branch: z.string().optional().describe("Branch to push"),
    force: flagSchema("Force push"),
  }) as unknown).merge(commonCommandOptionsSchema);

/**
 * Type for git push parameters
 */
export type GitPushParams = z.infer<typeof gitPushParamsSchema>;
