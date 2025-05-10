/**
 * Schema definitions for git-related parameters and types
 */
import { z } from "zod";
import { commonCommandOptionsSchema, pathSchema, repoPathSchema, taskIdSchema, flagSchema } from "./common.js";

/**
 * Schema for git clone parameters
 */
export const gitCloneParamsSchema = z.object({
  url: z.string().url().describe("URL of the Git repository to clone"),
  directory: pathSchema.optional().describe("Target directory for the clone"),
  branch: z.string().optional().describe("Branch to checkout after cloning"),
  depth: z.number().optional().describe("Create a shallow clone with specified depth")
}).merge(commonCommandOptionsSchema);

/**
 * Type for git clone parameters
 */
export type GitCloneParams = z.infer<typeof gitCloneParamsSchema>;

/**
 * Schema for git branch parameters
 */
export const gitBranchParamsSchema = z.object({
  name: z.string().min(1).describe("Name of the branch to create"),
  repo: repoPathSchema.optional().describe("Path to the git repository")
}).merge(commonCommandOptionsSchema);

/**
 * Type for git branch parameters
 */
export type GitBranchParams = z.infer<typeof gitBranchParamsSchema>;

/**
 * Schema for git pull request parameters
 */
export const gitPullRequestParamsSchema = z.object({
  repo: repoPathSchema.optional().describe("Path to repository"),
  branch: z.string().optional().describe("Branch to compare against (defaults to main/master)"),
  debug: flagSchema("Enable debug output"),
  session: z.string().optional().describe("Session to create pull request for")
}).merge(commonCommandOptionsSchema);

/**
 * Type for git pull request parameters
 */
export type GitPullRequestParams = z.infer<typeof gitPullRequestParamsSchema>;

/**
 * Schema for git commit parameters
 */
export const gitCommitParamsSchema = z.object({
  message: z.string().describe("Commit message"),
  session: z.string().optional().describe("Session to commit in"),
  repo: repoPathSchema.optional().describe("Repository path"),
  push: flagSchema("Push changes after committing"),
  all: flagSchema("Stage all files"),
  amend: flagSchema("Amend the previous commit"),
  noStage: flagSchema("Skip staging files (use already staged files)"),
  noVerify: flagSchema("Skip pre-commit hooks")
}).merge(commonCommandOptionsSchema);

/**
 * Type for git commit parameters
 */
export type GitCommitParams = z.infer<typeof gitCommitParamsSchema>;

/**
 * Schema for git push parameters
 */
export const gitPushParamsSchema = z.object({
  repo: repoPathSchema.optional().describe("Path to the git repository"),
  remote: z.string().optional().default("origin").describe("Remote to push to"),
  branch: z.string().optional().describe("Branch to push"),
  force: flagSchema("Force push")
}).merge(commonCommandOptionsSchema);

/**
 * Type for git push parameters
 */
export type GitPushParams = z.infer<typeof gitPushParamsSchema>; 
