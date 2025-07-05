/**
 * Shared Git Commands
 *
 * This module contains shared git command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
} from "../command-registry";
import {
  commitChangesFromParams,
  pushFromParams,
  cloneFromParams,
  branchFromParams,
  createPullRequestFromParams,
} from "../../../domain/git";
import { log } from "../../../utils/logger";
import {
  REPO_DESCRIPTION,
  SESSION_DESCRIPTION,
  GIT_REMOTE_DESCRIPTION,
  GIT_FORCE_DESCRIPTION,
  DEBUG_DESCRIPTION,
  GIT_BRANCH_DESCRIPTION,
  TASK_ID_DESCRIPTION,
  NO_STATUS_UPDATE_DESCRIPTION,
} from "../../../utils/option-descriptions";

/**
 * Parameters for the commit command
 */
const commitCommandParams: CommandParameterMap = {
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
  repo: {
    schema: z.string(),
    description: REPO_DESCRIPTION,
    required: false,
  },
  session: {
    schema: z.string(),
    description: SESSION_DESCRIPTION,
    required: false,
  },
};

/**
 * Parameters for the push command
 */
const pushCommandParams: CommandParameterMap = {
  repo: {
    schema: z.string(),
    description: REPO_DESCRIPTION,
    required: false,
  },
  session: {
    schema: z.string(),
    description: SESSION_DESCRIPTION,
    required: false,
  },
  remote: {
    schema: z.string(),
    description: GIT_REMOTE_DESCRIPTION,
    required: false,
    defaultValue: "origin",
  },
  force: {
    schema: z.boolean(),
    description: GIT_FORCE_DESCRIPTION,
    required: false,
    defaultValue: false,
  },
  debug: {
    schema: z.boolean(),
    description: DEBUG_DESCRIPTION,
    required: false,
    defaultValue: false,
  },
};

/**
 * Parameters for the clone command
 */
const cloneCommandParams: CommandParameterMap = {
  url: {
    schema: (z.string() as any).url(),
    description: "URL of the Git repository to clone",
    required: true,
  },
  workdir: {
    schema: z.string(),
    description: "Directory where the repository will be cloned",
    required: true,
  },
  session: {
    schema: z.string(),
    description: SESSION_DESCRIPTION,
    required: false,
  },
  branch: {
    schema: z.string(),
    description: GIT_BRANCH_DESCRIPTION,
    required: false,
  },
};

/**
 * Parameters for the branch command
 */
const branchCommandParams: CommandParameterMap = {
  session: {
    schema: z.string(),
    description: SESSION_DESCRIPTION,
    required: true,
  },
  name: {
    schema: z.string(),
    description: "Name of the branch to create",
    required: true,
  },
};

/**
 * Parameters for the pr command
 */
const prCommandParams: CommandParameterMap = {
  session: {
    schema: z.string(),
    description: SESSION_DESCRIPTION,
    required: false,
  },
  repo: {
    schema: z.string(),
    description: REPO_DESCRIPTION,
    required: false,
  },
  branch: {
    schema: z.string(),
    description: GIT_BRANCH_DESCRIPTION,
    required: false,
  },
  task: {
    schema: z.string(),
    description: TASK_ID_DESCRIPTION,
    required: false,
  },
  debug: {
    schema: (z.boolean() as any).default(false),
    description: DEBUG_DESCRIPTION,
    required: false,
  },
  noStatusUpdate: {
    schema: (z.boolean() as any).default(false),
    description: NO_STATUS_UPDATE_DESCRIPTION,
    required: false,
  },
};

/**
 * Register the git commands in the shared command registry
 */
export function registerGitCommands(): void {
  // Register git commit command
  (sharedCommandRegistry as any).registerCommand({
    id: "git.commit",
    category: (CommandCategory as any).GIT,
    name: "commit",
    description: "Commit changes to the repository",
    parameters: commitCommandParams,
    execute: async (params: any, context) => {
      log.debug("Executing git.commit command", { params });

      const result = await commitChangesFromParams({
        message: (params as any).message,
        all: (params as any).all,
        amend: (params as any).amend,
        noStage: (params as any).noStage,
        repo: (params as any).repo,
        session: (params as any).session,
      }) as any;

      return {
        success: true,
        commitHash: (result as any).commitHash,
        message: (result as any).message,
      } as any;
    },
  });

  // Register git push command
  (sharedCommandRegistry as any).registerCommand({
    id: "git.push",
    category: (CommandCategory as any).GIT,
    name: "push",
    description: "Push changes to the remote repository",
    parameters: pushCommandParams,
    execute: async (params: any, context) => {
      log.debug("Executing git.push command", { params });

      const result = await pushFromParams({
        repo: (params as any).repo,
        session: (params as any).session,
        remote: (params as any).remote,
        force: (params as any).force,
        debug: (params as any).debug,
      }) as any;

      return {
        success: (result as any).pushed,
        workdir: (result as any).workdir,
      } as any;
    },
  });

  // Register git clone command
  (sharedCommandRegistry as any).registerCommand({
    id: "git.clone",
    category: (CommandCategory as any).GIT,
    name: "clone",
    description: "Clone a Git repository",
    parameters: cloneCommandParams,
    execute: async (params: any, context) => {
      log.debug("Executing git.clone command", { params });

      const result = await cloneFromParams({
        url: (params as any).url,
        workdir: (params as any).workdir,
        session: (params as any).session,
        branch: (params as any).branch,
      }) as any;

      return {
        success: true,
        workdir: (result as any).workdir,
        session: (result as any).session,
      } as any;
    },
  });

  // Register git branch command
  (sharedCommandRegistry as any).registerCommand({
    id: "git.branch",
    category: (CommandCategory as any).GIT,
    name: "branch",
    description: "Create a new branch",
    parameters: branchCommandParams,
    execute: async (params: any, context) => {
      log.debug("Executing git.branch command", { params });

      const result = await branchFromParams({
        session: (params as any).session,
        name: (params as any).name,
      }) as any;

      return {
        success: true,
        workdir: (result as any).workdir,
        branch: (result as any).branch,
      } as any;
    },
  });

  // Register git pr command
  (sharedCommandRegistry as any).registerCommand({
    id: "git.pr",
    category: (CommandCategory as any).GIT,
    name: "pr",
    description: "Create a new pull request",
    parameters: prCommandParams,
    execute: async (params: any, context) => {
      log.debug("Executing git.pr command", { params });

      const result = await createPullRequestFromParams({
        session: (params as any).session,
        repo: (params as any).repo,
        branch: (params as any).branch,
        taskId: (params as any).task,
        debug: (params as any).debug,
        noStatusUpdate: (params as any).noStatusUpdate,
      }) as any;

      return {
        success: true,
        markdown: (result as any).markdown,
        statusUpdateResult: (result as any).statusUpdateResult,
      } as any;
    },
  });
}
