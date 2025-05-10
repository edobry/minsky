/**
 * Schema definitions for git-related parameters and types
 */
import { z } from "zod";
import { commonCommandOptionsSchema, repoPathSchema, taskIdSchema, flagSchema } from "./common.js";

/**
 * Schema for git clone parameters
 */
export const gitCloneParamsSchema = z.object({
  url: z.string().url().describe("URL of the repository to clone"),
  dir: z.string().optional().describe("Directory to clone into"),
  branch: z.string().optional().describe("Branch to checkout")
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
export const gitPrParamsSchema = z.object({
  repo: repoPathSchema.optional().describe("Path to the git repository"),
  task: taskIdSchema.optional().describe("Task ID to use for PR generation"),
  base: z.string().optional().describe("Base branch to compare against"),
  title: z.string().optional().describe("PR title"),
  debug: flagSchema("Enable debug output"),
  noStatusUpdate: flagSchema("Skip updating task status when creating a PR for a task")
}).merge(commonCommandOptionsSchema);

/**
 * Type for git pull request parameters
 */
export type GitPrParams = z.infer<typeof gitPrParamsSchema>;

/**
 * Schema for git commit parameters
 */
export const gitCommitParamsSchema = z.object({
  message: z.string().min(1).describe("Commit message"),
  repo: repoPathSchema.optional().describe("Path to the git repository"),
  amend: flagSchema("Amend the previous commit"),
  noStage: flagSchema("Skip staging files"),
  all: flagSchema("Stage all files (including untracked)"),
  taskPrefix: flagSchema("Prefix commit message with task ID")
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
