/**
 * Session Command Parameters
 *
 * This module contains all parameter definitions for session commands,
 * extracted from the main session commands file for better organization.
 */

import { z } from "zod";
import { type CommandParameterMap } from "../../shared/command-registry";

/**
 * Parameters for the session list command
 */
export const sessionListCommandParams: CommandParameterMap = {
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
};

/**
 * Parameters for the session get command
 */
export const sessionGetCommandParams: CommandParameterMap = {
  name: {
    schema: z.string().min(1),
    description: "Session name",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID associated with the session",
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
};

/**
 * Parameters for the session start command
 */
export const sessionStartCommandParams: CommandParameterMap = {
  name: {
    schema: z.string().min(1),
    description: "Name for the new session (optional, alternative to --task)",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID to associate with the session (required if --description not provided)",
    required: false,
  },
  description: {
    schema: z.string().min(1),
    description: "Description for auto-created task (required if --task not provided)",
    required: false,
  },
  branch: {
    schema: z.string(),
    description: "Branch name to create (defaults to session name)",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Deprecated: use name parameter instead",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
  quiet: {
    schema: z.boolean(),
    description: "Suppress output except for the session directory path",
    required: false,
    defaultValue: false,
  },
  noStatusUpdate: {
    schema: z.boolean(),
    description: "Skip updating task status when starting a session with a task",
    required: false,
    defaultValue: false,
  },
  skipInstall: {
    schema: z.boolean(),
    description: "Skip automatic dependency installation",
    required: false,
    defaultValue: false,
  },
  packageManager: {
    schema: z.enum(["bun", "npm", "yarn", "pnpm"]),
    description: "Override the detected package manager",
    required: false,
  },
};

/**
 * Parameters for the session dir command
 */
export const sessionDirCommandParams: CommandParameterMap = {
  name: {
    schema: z.string().min(1),
    description: "Session name",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID associated with the session",
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
};

/**
 * Parameters for the session delete command
 */
export const sessionDeleteCommandParams: CommandParameterMap = {
  name: {
    schema: z.string().min(1),
    description: "Session name to delete",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID associated with the session",
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
    description: "Skip confirmation prompt",
    required: false,
    defaultValue: false,
  },
};

/**
 * Parameters for the session update command
 */
export const sessionUpdateCommandParams: CommandParameterMap = {
  name: {
    schema: z.string(),
    description: "Session name to update",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID associated with the session",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  branch: {
    schema: z.string(),
    description: "Update branch name",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
  noStash: {
    schema: z.boolean(),
    description: "Skip stashing local changes",
    required: false,
    defaultValue: false,
  },
  noPush: {
    schema: z.boolean(),
    description: "Skip pushing changes to remote after update",
    required: false,
    defaultValue: false,
  },
  force: {
    schema: z.boolean(),
    description: "Force update even if the session workspace is dirty",
    required: false,
    defaultValue: false,
  },
  skipConflictCheck: {
    schema: z.boolean(),
    description: "Skip proactive conflict detection before update",
    required: false,
    defaultValue: false,
  },
  autoResolveDeleteConflicts: {
    schema: z.boolean(),
    description: "Automatically resolve delete/modify conflicts by accepting deletions",
    required: false,
    defaultValue: false,
  },
  dryRun: {
    schema: z.boolean(),
    description: "Check for conflicts without performing actual update",
    required: false,
    defaultValue: false,
  },
  skipIfAlreadyMerged: {
    schema: z.boolean(),
    description: "Skip update if session changes are already in base branch",
    required: false,
    defaultValue: false,
  },
};

/**
 * Parameters for the session approve command
 */
export const sessionApproveCommandParams: CommandParameterMap = {
  name: {
    schema: z.string(),
    description: "Session name to approve",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID associated with the session",
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
};

/**
 * Parameters for the session pr command
 */
export const sessionPrCommandParams: CommandParameterMap = {
  title: {
    schema: z.string().min(1),
    description: "Title for the PR (optional for existing PRs)",
    required: false,
  },
  body: {
    schema: z.string(),
    description: "Body text for the PR",
    required: false,
  },
  bodyPath: {
    schema: z.string(),
    description: "Path to file containing PR body text",
    required: false,
  },
  name: {
    schema: z.string(),
    description: "Session name",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID associated with the session",
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
  noStatusUpdate: {
    schema: z.boolean(),
    description: "Skip updating task status",
    required: false,
    defaultValue: false,
  },
  debug: {
    schema: z.boolean(),
    description: "Enable debug output",
    required: false,
    defaultValue: false,
  },
  skipUpdate: {
    schema: z.boolean(),
    description: "Skip session update before creating PR",
    required: false,
    defaultValue: false,
  },
  autoResolveDeleteConflicts: {
    schema: z.boolean(),
    description: "Automatically resolve delete/modify conflicts by accepting deletions",
    required: false,
    defaultValue: false,
  },
  skipConflictCheck: {
    schema: z.boolean(),
    description: "Skip proactive conflict detection during update",
    required: false,
    defaultValue: false,
  },
};

/**
 * Parameters for the session inspect command
 */
export const sessionInspectCommandParams: CommandParameterMap = {
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
};
