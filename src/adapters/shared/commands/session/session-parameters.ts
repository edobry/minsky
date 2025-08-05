/**
 * Session Command Parameters
 *
 * Consolidated parameter definitions for all session commands.
 * Extracted from session.ts as part of modularization effort.
 */
import { z } from "zod";

/**
 * Common parameter building blocks for session commands
 */
export const commonSessionParams = {
  name: {
    schema: z.string(),
    description: "Session name",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
  force: {
    schema: z.boolean(),
    description: "Force the operation",
    required: false,
    defaultValue: false,
  },
  debug: {
    schema: z.boolean(),
    description: "Enable debug output",
    required: false,
    defaultValue: false,
  },
  quiet: {
    schema: z.boolean(),
    description: "Suppress output",
    required: false,
    defaultValue: false,
  },
  noStash: {
    schema: z.boolean(),
    description: "Skip stashing changes",
    required: false,
    defaultValue: false,
  },
  noPush: {
    schema: z.boolean(),
    description: "Skip pushing changes",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session list command parameters
 */
export const sessionListCommandParams = {
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
};

/**
 * Session get command parameters
 */
export const sessionGetCommandParams = {
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
};

/**
 * Session start command parameters
 */
export const sessionStartCommandParams = {
  name: {
    schema: z.string(),
    description: "Session name",
    required: false,
  },
  task: commonSessionParams.task,
  description: {
    schema: z.string(),
    description: "Task description for auto-creation",
    required: false,
  },
  branch: {
    schema: z.string(),
    description: "Git branch to use",
    required: false,
  },
  repo: commonSessionParams.repo,
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
  json: commonSessionParams.json,
  quiet: commonSessionParams.quiet,
  noStatusUpdate: {
    schema: z.boolean(),
    description: "Skip updating task status",
    required: false,
    defaultValue: false,
  },
  skipInstall: {
    schema: z.boolean(),
    description: "Skip dependency installation",
    required: false,
    defaultValue: false,
  },
  packageManager: {
    schema: z.enum(["npm", "yarn", "pnpm", "bun"]),
    description: "Package manager to use",
    required: false,
  },
};

/**
 * Session directory command parameters
 */
export const sessionDirCommandParams = {
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
};

/**
 * Session delete command parameters
 */
export const sessionDeleteCommandParams = {
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  force: commonSessionParams.force,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
};

/**
 * Session update command parameters
 */
export const sessionUpdateCommandParams = {
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  branch: {
    schema: z.string(),
    description: "Branch to update from",
    required: false,
  },
  noStash: commonSessionParams.noStash,
  noPush: commonSessionParams.noPush,
  force: commonSessionParams.force,
  json: commonSessionParams.json,
  skipConflictCheck: {
    schema: z.boolean(),
    description: "Skip conflict detection",
    required: false,
    defaultValue: false,
  },
  autoResolveDeleteConflicts: {
    schema: z.boolean(),
    description: "Automatically resolve delete conflicts",
    required: false,
    defaultValue: false,
  },
  dryRun: {
    schema: z.boolean(),
    description: "Preview changes without applying",
    required: false,
    defaultValue: false,
  },
  skipIfAlreadyMerged: {
    schema: z.boolean(),
    description: "Skip if changes already merged",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session approve command parameters
 */
export const sessionApproveCommandParams = {
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  cleanup: {
    schema: z.boolean(),
    description: "Clean up session directories and database record after merge",
    required: false,
    defaultValue: false,
  },
  cleanupSession: {
    schema: z.boolean(),
    description: "Clean up session directories and database record after merge (alias)",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session PR command parameters
 */
export const sessionPrCommandParams = {
  title: {
    schema: z.string(),
    description: "PR title",
    required: false,
  },
  body: {
    schema: z.string(),
    description: "PR body content",
    required: false,
  },
  bodyPath: {
    schema: z.string(),
    description: "Path to file containing PR body",
    required: false,
  },
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  noStatusUpdate: {
    schema: z.boolean(),
    description: "Skip updating task status",
    required: false,
    defaultValue: false,
  },
  debug: commonSessionParams.debug,

  autoResolveDeleteConflicts: {
    schema: z.boolean(),
    description: "Automatically resolve delete conflicts",
    required: false,
    defaultValue: false,
  },
  skipConflictCheck: {
    schema: z.boolean(),
    description: "Skip conflict detection",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session inspect command parameters
 */
export const sessionInspectCommandParams = {
  json: commonSessionParams.json,
};

/**
 * Session PR Create command parameters
 * Replaces the current session PR command
 */
export const sessionPrCreateCommandParams = {
  title: {
    schema: z.string(),
    description: "PR title",
    required: false,
  },
  body: {
    schema: z.string(),
    description: "PR body content",
    required: false,
  },
  bodyPath: {
    schema: z.string(),
    description: "Path to file containing PR body",
    required: false,
  },
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  noStatusUpdate: {
    schema: z.boolean(),
    description: "Skip updating task status",
    required: false,
    defaultValue: false,
  },
  debug: commonSessionParams.debug,

  autoResolveDeleteConflicts: {
    schema: z.boolean(),
    description: "Automatically resolve delete conflicts",
    required: false,
    defaultValue: false,
  },
  skipConflictCheck: {
    schema: z.boolean(),
    description: "Skip conflict detection",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session PR List command parameters
 * Lists all PRs associated with sessions
 */
export const sessionPrListCommandParams = {
  session: {
    schema: z.string(),
    description: "Filter PRs by specific session name",
    required: false,
  },
  task: commonSessionParams.task,
  status: {
    schema: z.enum(["open", "closed", "merged", "draft"]),
    description: "Filter by PR status",
    required: false,
  },
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  verbose: {
    schema: z.boolean(),
    description: "Show detailed PR information",
    required: false,
    defaultValue: false,
  },
};

/**
 * Session PR Get command parameters
 * Gets detailed information about a specific PR
 */
export const sessionPrGetCommandParams = {
  sessionName: {
    schema: z.string(),
    description: "Session name to look up PR for (positional)",
    required: false,
  },
  name: commonSessionParams.name,
  task: commonSessionParams.task,
  repo: commonSessionParams.repo,
  json: commonSessionParams.json,
  content: {
    schema: z.boolean(),
    description: "Include PR description and diff content",
    required: false,
    defaultValue: false,
  },
};
