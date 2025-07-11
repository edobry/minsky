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
  mergeFromParams,
  checkoutFromParams,
  rebaseFromParams,
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
    schema: z.string().url(),
    description: "URL of the Git repository to clone",
    required: true,
  },
  session: {
    schema: z.string(),
    description: SESSION_DESCRIPTION,
    required: false,
  },
  destination: {
    schema: z.string(),
    description: "Target directory for the clone",
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
  preview: {
    schema: z.boolean(),
    description: "Preview potential conflicts before creating the branch",
    required: false,
    defaultValue: false,
  },
  autoResolve: {
    schema: z.boolean(),
    description: "Enable advanced auto-resolution for detected conflicts",
    required: false,
    defaultValue: false,
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
    schema: z.boolean().default(false),
    description: DEBUG_DESCRIPTION,
    required: false,
  },
  noStatusUpdate: {
    schema: z.boolean().default(false),
    description: NO_STATUS_UPDATE_DESCRIPTION,
    required: false,
  },
  preview: {
    schema: z.boolean(),
    description: "Preview potential conflicts before creating the PR",
    required: false,
    defaultValue: false,
  },
  autoResolve: {
    schema: z.boolean(),
    description: "Enable advanced auto-resolution for detected conflicts",
    required: false,
    defaultValue: false,
  },
  conflictStrategy: {
    schema: z.enum(["automatic", "guided", "manual"]),
    description: "Choose conflict resolution strategy",
    required: false,
  },
};

/**
 * NEW: Parameters for the merge command
 */
const mergeCommandParams: CommandParameterMap = {
  branch: {
    schema: z.string(),
    description: "Branch to merge into the current branch",
    required: true,
  },
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
  preview: {
    schema: z.boolean(),
    description: "Preview potential conflicts before merging",
    required: false,
    defaultValue: false,
  },
  autoResolve: {
    schema: z.boolean(),
    description: "Enable advanced auto-resolution for detected conflicts",
    required: false,
    defaultValue: false,
  },
  conflictStrategy: {
    schema: z.enum(["automatic", "guided", "manual"]),
    description: "Choose conflict resolution strategy",
    required: false,
  },
  noCommit: {
    schema: z.boolean(),
    description: "Perform merge without committing",
    required: false,
    defaultValue: false,
  },
  fastForwardOnly: {
    schema: z.boolean(),
    description: "Only allow fast-forward merges",
    required: false,
    defaultValue: false,
  },
};

/**
 * NEW: Parameters for the checkout command
 */
const checkoutCommandParams: CommandParameterMap = {
  branch: {
    schema: z.string(),
    description: "Branch to checkout",
    required: true,
  },
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
  preview: {
    schema: z.boolean(),
    description: "Preview potential conflicts and uncommitted changes before checkout",
    required: false,
    defaultValue: false,
  },
  force: {
    schema: z.boolean(),
    description: "Force checkout even with uncommitted changes",
    required: false,
    defaultValue: false,
  },
  autoStash: {
    schema: z.boolean(),
    description: "Automatically stash uncommitted changes before checkout",
    required: false,
    defaultValue: false,
  },
};

/**
 * NEW: Parameters for the rebase command
 */
const rebaseCommandParams: CommandParameterMap = {
  baseBranch: {
    schema: z.string(),
    description: "Base branch to rebase onto",
    required: true,
  },
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
  preview: {
    schema: z.boolean(),
    description: "Preview potential conflicts before rebasing",
    required: false,
    defaultValue: false,
  },
  autoResolve: {
    schema: z.boolean(),
    description: "Enable advanced auto-resolution for detected conflicts",
    required: false,
    defaultValue: false,
  },
  conflictStrategy: {
    schema: z.enum(["automatic", "guided", "manual"]),
    description: "Choose conflict resolution strategy",
    required: false,
  },
};

/**
 * Register the git commands in the shared command registry
 */
export function registerGitCommands(): void {
  // Register git commit command
  sharedCommandRegistry.registerCommand({
    id: "git.commit",
    category: CommandCategory.GIT,
    name: "commit",
    description: "Commit changes to the repository",
    parameters: commitCommandParams,
    execute: async (params, context) => {
      log.debug("Executing git.commit command", { params });

      const result = await commitChangesFromParams({
        message: params!.message,
        all: params!.all,
        amend: params!.amend,
        noStage: params!.noStage,
        repo: params!.repo,
        session: params!.session,
      }) as any;

      return {
        success: true,
        commitHash: result!.commitHash,
        message: result!.message,
      } as any;
    },
  });

  // Register git push command
  sharedCommandRegistry.registerCommand({
    id: "git.push",
    category: CommandCategory.GIT,
    name: "push",
    description: "Push changes to the remote repository",
    parameters: pushCommandParams,
    execute: async (params, context) => {
      log.debug("Executing git.push command", { params });

      const result = await pushFromParams({
        repo: params!.repo,
        session: params!.session,
        remote: params!.remote,
        force: params!.force,
        debug: params!.debug,
      }) as any;

      return {
        success: result!.pushed,
        workdir: result!.workdir,
      } as any;
    },
  });

  // Register git clone command
  sharedCommandRegistry.registerCommand({
    id: "git.clone",
    category: CommandCategory.GIT,
    name: "clone",
    description: "Clone a Git repository",
    parameters: cloneCommandParams,
    execute: async (params, context) => {
      log.debug("Executing git.clone command", { params });

      const result = await cloneFromParams({
        url: params!.url,
        workdir: params!.destination || ".",
        session: params!.session,
        branch: params!.branch,
      }) as any;

      return {
        success: true,
        workdir: result!.workdir,
        session: result!.session,
      } as any;
    },
  });

  // Register git branch command
  sharedCommandRegistry.registerCommand({
    id: "git.branch",
    category: CommandCategory.GIT,
    name: "branch",
    description: "Create a new branch",
    parameters: branchCommandParams,
    execute: async (params, context) => {
      log.debug("Executing git.branch command", { params });

      const result = await branchFromParams({
        session: params!.session,
        name: params!.name,
      }) as any;

      return {
        success: true,
        workdir: result!.workdir,
        branch: result!.branch,
      } as any;
    },
  });

  // Register git pr command
  sharedCommandRegistry.registerCommand({
    id: "git.pr",
    category: CommandCategory.GIT,
    name: "pr",
    description: "Create a new pull request",
    parameters: prCommandParams,
    execute: async (params, context) => {
      log.debug("Executing git.pr command", { params });

      const result = await createPullRequestFromParams({
        session: params!.session,
        repo: params!.repo,
        branch: params!.branch,
        taskId: params!.task,
        debug: params!.debug,
        noStatusUpdate: params!.noStatusUpdate,
      }) as any;

      return {
        success: true,
        markdown: result!.markdown,
        statusUpdateResult: result!.statusUpdateResult,
      } as any;
    },
  });

  // Register git merge command - NEW
  sharedCommandRegistry.registerCommand({
    id: "git.merge",
    category: CommandCategory.GIT,
    name: "merge",
    description: "Merge a branch with conflict detection",
    parameters: mergeCommandParams,
    execute: async (params, context) => {
      log.debug("Executing git.merge command", { params });

      const result = await mergeFromParams({
        sourceBranch: params!.branch,
        session: params!.session,
        repo: params!.repo,
        preview: params!.preview,
        autoResolve: params!.autoResolve,
        conflictStrategy: params!.conflictStrategy,
      });

      return {
        success: result!.merged,
        workdir: result!.workdir,
        message: result!.conflicts ? result!.conflictDetails || "Merge completed with conflicts" : "Merge completed successfully",
      };
    },
  });

  // Register git checkout command - NEW
  sharedCommandRegistry.registerCommand({
    id: "git.checkout",
    category: CommandCategory.GIT,
    name: "checkout",
    description: "Checkout a branch with conflict detection",
    parameters: checkoutCommandParams,
    execute: async (params, context) => {
      log.debug("Executing git.checkout command", { params });

      const result = await checkoutFromParams({
        branch: params!.branch,
        session: params!.session,
        repo: params!.repo,
        preview: params!.preview,
        autoResolve: params!.autoStash, // Map autoStash to autoResolve for conflict handling
        conflictStrategy: params!.conflictStrategy,
      });

      return {
        success: result!.switched,
        workdir: result!.workdir,
        message: result!.conflicts ? result!.conflictDetails || "Checkout completed with warnings" : "Checkout completed successfully",
      };
    },
  });

  // Register git rebase command - NEW
  sharedCommandRegistry.registerCommand({
    id: "git.rebase",
    category: CommandCategory.GIT,
    name: "rebase",
    description: "Rebase with conflict detection",
    parameters: rebaseCommandParams,
    execute: async (params, context) => {
      log.debug("Executing git.rebase command", { params });

      const result = await rebaseFromParams({
        baseBranch: params!.baseBranch,
        session: params!.session,
        repo: params!.repo,
        preview: params!.preview,
        autoResolve: params!.autoResolve,
        conflictStrategy: params!.conflictStrategy,
      });

      return {
        success: result!.rebased,
        workdir: result!.workdir,
        message: result!.conflicts ? result!.conflictDetails || "Rebase completed with conflicts" : "Rebase completed successfully",
      };
    },
  });
}
