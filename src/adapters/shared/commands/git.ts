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
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../command-registry.js";
import { commitChangesFromParams, pushFromParams } from "../../../domain/git.js";
import { log } from "../../../utils/logger.js";

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
    description: "Repository path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
};

/**
 * Parameters for the push command
 */
const pushCommandParams: CommandParameterMap = {
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
  remote: {
    schema: z.string(),
    description: "Remote name",
    required: false,
    defaultValue: "origin",
  },
  force: {
    schema: z.boolean(),
    description: "Force push changes",
    required: false,
    defaultValue: false,
  },
  debug: {
    schema: z.boolean(),
    description: "Enable debug output",
    required: false,
    defaultValue: false,
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
      log.debug("Executing git.commit command", { params, context });
      
      const result = await commitChangesFromParams({
        message: params.message,
        all: params.all,
        amend: params.amend,
        noStage: params.noStage,
        repo: params.repo,
        session: params.session,
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
    execute: async (params, context) => {
      log.debug("Executing git.push command", { params, context });
      
      const result = await pushFromParams({
        repo: params.repo,
        session: params.session,
        remote: params.remote,
        force: params.force,
        debug: params.debug,
      });
      
      return {
        success: result.pushed,
        workdir: result.workdir,
      };
    },
  });
} 
