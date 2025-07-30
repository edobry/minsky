/**
 * Session Command Parameters
 *
 * This module contains all parameter definitions for session commands,
 * extracted from the main session commands file for better organization.
 */

import { z } from "zod";
import { type CommandParameterMap } from "../../shared/command-registry";
import {
  CommonParameters,
  SessionParameters,
  GitParameters,
  composeParams,
} from "../common-parameters";

/**
 * Parameters for the session list command
 */
export const sessionListCommandParams: CommandParameterMap = composeParams(
  {
    repo: CommonParameters.repo,
    json: CommonParameters.json,
  },
  {}
);

/**
 * Parameters for the session get command
 */
export const sessionGetCommandParams: CommandParameterMap = composeParams(
  {
    sessionName: SessionParameters.sessionName,
    name: SessionParameters.name,
    task: CommonParameters.task,
    repo: CommonParameters.repo,
    json: CommonParameters.json,
  },
  {}
);

/**
 * Parameters for the session start command
 */
export const sessionStartCommandParams: CommandParameterMap = composeParams(
  {
    name: SessionParameters.name,
    task: CommonParameters.task,
    repo: CommonParameters.repo,
    json: CommonParameters.json,
    quiet: CommonParameters.quiet,
    skipInstall: SessionParameters.skipInstall,
    packageManager: SessionParameters.packageManager,
  },
  {
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
    noStatusUpdate: {
      schema: z.boolean(),
      description: "Skip updating task status when starting a session with a task",
      required: false,
      defaultValue: false,
    },
  }
);

/**
 * Parameters for the session dir command
 */
export const sessionDirCommandParams: CommandParameterMap = composeParams(
  {
    sessionName: SessionParameters.sessionName,
    json: CommonParameters.json,
  },
  {}
);

/**
 * Parameters for the session delete command
 */
export const sessionDeleteCommandParams: CommandParameterMap = composeParams(
  {
    sessionName: SessionParameters.sessionName,
    force: CommonParameters.force,
    json: CommonParameters.json,
  },
  {}
);

/**
 * Parameters for the session update command
 */
export const sessionUpdateCommandParams: CommandParameterMap = composeParams(
  {
    sessionName: SessionParameters.sessionName,
    force: CommonParameters.force,
    json: CommonParameters.json,
    noStash: GitParameters.noStash,
    noPush: GitParameters.noPush,
  },
  {
    branch: {
      schema: z.string(),
      description: "Update branch name",
      required: false,
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
  }
);

/**
 * Parameters for the session approve command
 */
export const sessionApproveCommandParams: CommandParameterMap = composeParams(
  {
    sessionName: SessionParameters.sessionName,
    noStash: GitParameters.noStash,
    json: CommonParameters.json,
  },
  {}
);

/**
 * Parameters for the session pr command
 */
export const sessionPrCommandParams: CommandParameterMap = {
  sessionName: {
    schema: z.string().min(1),
    description: "Session identifier (name or task ID)",
    required: false, // Changed to allow using name or task instead
  },
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

/**
 * Parameters for the session commit command
 */
export const sessionCommitCommandParams: CommandParameterMap = composeParams(
  {
    sessionName: SessionParameters.sessionName,
    json: CommonParameters.json,
  },
  {
    message: {
      schema: z.string().min(1),
      description: "Commit message",
      required: true,
    },
    all: {
      schema: z.boolean(),
      description: "Stage all changes including deletions",
      required: false,
      defaultValue: false,
    },
    amend: {
      schema: z.boolean(),
      description: "Amend the previous commit",
      required: false,
      defaultValue: false,
    },
    noStage: {
      schema: z.boolean(),
      description: "Skip staging changes",
      required: false,
      defaultValue: false,
    },
  }
);
