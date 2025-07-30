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
  mergeFromParams,
  checkoutFromParams,
  rebaseFromParams,
} from "../../../domain/git";
import {
  conflictsFromParams,
  conflictsCommandParams,
} from "../../../domain/git/commands/subcommands/conflicts-subcommand";
import { log } from "../../../utils/logger";
import {
  REPO_DESCRIPTION,
  SESSION_DESCRIPTION,
  GIT_REMOTE_DESCRIPTION,
  GIT_FORCE_DESCRIPTION,
  DEBUG_DESCRIPTION,
  GIT_BRANCH_DESCRIPTION,
  NO_STATUS_UPDATE_DESCRIPTION,
} from "../../../utils/option-descriptions";
import { CommonParameters, GitParameters, composeParams } from "../common-parameters";

/**
 * Parameters for the commit command
 */
const commitCommandParams: CommandParameterMap = composeParams(
  {
    repo: CommonParameters.repo,
    session: CommonParameters.session,
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

/**
 * Parameters for the push command
 */
const pushCommandParams: CommandParameterMap = composeParams(
  {
    repo: CommonParameters.repo,
    session: CommonParameters.session,
    force: CommonParameters.force,
    debug: CommonParameters.debug,
  },
  {
    remote: GitParameters.remote,
  }
);

/**
 * Parameters for the clone command
 */
const cloneCommandParams: CommandParameterMap = composeParams(
  {
    session: CommonParameters.session,
    branch: GitParameters.branch,
  },
  {
    url: {
      schema: z.string().url(),
      description: "URL of the Git repository to clone",
      required: true,
    },
    destination: {
      schema: z.string(),
      description: "Target directory for the clone",
      required: false,
    },
  }
);

/**
 * Parameters for the branch command
 */
const branchCommandParams: CommandParameterMap = composeParams(
  {
    preview: GitParameters.preview,
    autoResolve: GitParameters.autoResolve,
  },
  {
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
  }
);

/**
 * Parameters for the merge command
 */
const mergeCommandParams: CommandParameterMap = composeParams(
  {
    session: CommonParameters.session,
    repo: CommonParameters.repo,
    preview: GitParameters.preview,
    autoResolve: GitParameters.autoResolve,
  },
  {
    branch: {
      schema: z.string().min(1),
      description: "Branch to merge",
      required: true,
    },
    conflictStrategy: {
      schema: z.enum(["automatic", "guided", "manual"]),
      description: "Choose conflict resolution strategy",
      required: false,
    },
  }
);

/**
 * NEW: Parameters for the checkout command
 */
const checkoutCommandParams: CommandParameterMap = composeParams(
  {
    session: CommonParameters.session,
    repo: CommonParameters.repo,
    force: CommonParameters.force,
    preview: GitParameters.preview,
  },
  {
    branch: {
      schema: z.string(),
      description: "Branch to checkout",
      required: true,
    },
    autoStash: {
      schema: z.boolean(),
      description: "Automatically stash uncommitted changes before checkout",
      required: false,
      defaultValue: false,
    },
  }
);

/**
 * NEW: Parameters for the rebase command
 */
const rebaseCommandParams: CommandParameterMap = composeParams(
  {
    session: CommonParameters.session,
    repo: CommonParameters.repo,
    preview: GitParameters.preview,
    autoResolve: GitParameters.autoResolve,
  },
  {
    baseBranch: {
      schema: z.string(),
      description: "Base branch to rebase onto",
      required: true,
    },
    conflictStrategy: {
      schema: z.enum(["automatic", "guided", "manual"]),
      description: "Choose conflict resolution strategy",
      required: false,
    },
  }
);

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
    execute: async (params, _context) => {
      log.debug("Executing git.commit command", { params });

      const result = await commitChangesFromParams({
        message: params!.message,
        all: params!.all,
        amend: params!.amend,
        noStage: params!.noStage,
        repo: params!.repo,
        session: params!.session,
      });

      return {
        success: true,
        commitHash: result.commitHash,
        message: result.message,
      };
    },
  });

  // Register git push command
  sharedCommandRegistry.registerCommand({
    id: "git.push",
    category: CommandCategory.GIT,
    name: "push",
    description: "Push changes to the remote repository",
    parameters: pushCommandParams,
    execute: async (params, _context) => {
      log.debug("Executing git.push command", { params });

      const result = await pushFromParams({
        repo: params!.repo,
        session: params!.session,
        remote: params!.remote,
        force: params!.force,
        debug: params!.debug,
      });

      return {
        success: result.pushed,
        workdir: result.workdir,
      };
    },
  });

  // Register git clone command
  sharedCommandRegistry.registerCommand({
    id: "git.clone",
    category: CommandCategory.GIT,
    name: "clone",
    description: "Clone a Git repository",
    parameters: cloneCommandParams,
    execute: async (params, _context) => {
      log.debug("Executing git.clone command", { params });

      const result = await cloneFromParams({
        url: params!.url,
        workdir: params!.destination || ".",
        session: params!.session,
        branch: params!.branch,
      });

      return {
        success: true,
        workdir: result.workdir,
        session: result.session,
      };
    },
  });

  // Register git branch command
  sharedCommandRegistry.registerCommand({
    id: "git.branch",
    category: CommandCategory.GIT,
    name: "branch",
    description: "Create a new branch",
    parameters: branchCommandParams,
    execute: async (params, _context) => {
      log.debug("Executing git.branch command", { params });

      const result = await branchFromParams({
        session: params!.session,
        name: params!.name,
      });

      return {
        success: true,
        workdir: result.workdir,
        branch: result.branch,
      };
    },
  });

  // Register git merge command
  sharedCommandRegistry.registerCommand({
    id: "git.merge",
    category: CommandCategory.GIT,
    name: "merge",
    description: "Merge a branch with conflict detection",
    parameters: mergeCommandParams,
    execute: async (params, _context) => {
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
        success: result.merged,
        workdir: result.workdir,
        message: result.conflicts
          ? result.conflictDetails || "Merge completed with conflicts"
          : "Merge completed successfully",
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
    execute: async (params, _context) => {
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
        message: result!.conflicts
          ? result!.conflictDetails || "Checkout completed with warnings"
          : "Checkout completed successfully",
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
    execute: async (params, _context) => {
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
        message: result!.conflicts
          ? result!.conflictDetails || "Rebase completed with conflicts"
          : "Rebase completed successfully",
      };
    },
  });

  // Register git conflicts command
  sharedCommandRegistry.registerCommand({
    id: "git.conflicts",
    category: CommandCategory.GIT,
    name: "conflicts",
    description: "Detect and report merge conflicts in structured format",
    parameters: conflictsCommandParams,
    execute: async (params, _context) => {
      log.debug("Executing git.conflicts command", { params });

      const result = await conflictsFromParams({
        format: params!.format,
        context: params!.context,
        files: params!.files,
      });

      if (!result.success) {
        throw new Error(result.error || "Failed to scan for conflicts");
      }

      return {
        success: true,
        data: result.data,
      };
    },
  });
}
