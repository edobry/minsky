/**
 * Shared Session Commands
 *
 * This module contains shared session command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import { getErrorMessage } from "../../../errors/index";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../shared/command-registry";
import {
  sessionGet,
  sessionList,
  sessionStart,
  sessionDelete,
  sessionDir,
  sessionUpdate,
  sessionApprove,
  sessionPr,
  sessionInspect,
  sessionCommit,
} from "../../../domain/session";
import { log } from "../../../utils/logger";
import { MinskyError } from "../../../errors/index";
import {
  sessionListCommandParams,
  sessionGetCommandParams,
  sessionStartCommandParams,
  sessionDirCommandParams,
  sessionDeleteCommandParams,
  sessionUpdateCommandParams,
  sessionApproveCommandParams,
  sessionPrCommandParams,
  sessionInspectCommandParams,
  sessionCommitCommandParams,
} from "./session-parameters";
import {
  handleSessionPrError,
  validatePrParameters,
  generateMissingBodyErrorMessage,
  generateMissingTaskAssociationErrorMessage,
} from "./session-error-handling";



/**
 * Register the session commands in the shared command registry
 */
export function registerSessionCommands(): void {
  // Register session list command
  sharedCommandRegistry.registerCommand({
    id: "session.list",
    category: CommandCategory.SESSION,
    name: "list",
    description: "List all sessions",
    parameters: sessionListCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.list command", { params, context });

      try {
        const sessions = await sessionList({
          repo: params!.repo,
          json: params!.json,
        });

        return {
          success: true,
          sessions,
        };
      } catch (error) {
        log.error("Failed to list sessions", {
          error: getErrorMessage(error as Error),
        });
        throw error;
      }
    },
  });

  // Register session get command
  sharedCommandRegistry.registerCommand({
    id: "session.get",
    category: CommandCategory.SESSION,
    name: "get",
    description: "Get a specific session by name or task ID",
    parameters: {
      ...sessionGetCommandParams,
      // Add backward compatible parameters for CLI
      name: {
        schema: z.string(),
        description: "Session name",
        required: false,
      },
      task: {
        schema: z.string(),
        description: "Task ID associated with the session",
        required: false,
      }
    },
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.get command", { params, context });

      // CLI compatibility: map name or task to session if not provided
      if (!params!.session && (params!.name || params!.task)) {
        params!.session = params!.name || params!.task;
      }

      try {
        const session = await sessionGet({
          session: params!.session,
          json: params!.json,
        });

        return {
          success: true,
          session,
        };
      } catch (error) {
        log.error("Failed to get session", {
          error: getErrorMessage(error as Error),
          session: params!.session,
        });
        throw error;
      }
    },
  });

  // Register session start command
  sharedCommandRegistry.registerCommand({
    id: "session.start",
    category: CommandCategory.SESSION,
    name: "start",
    description: "Start a new session",
    parameters: sessionStartCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.start command", { params, context });

      // Phase 2: Validate that task association is provided
      if (!params!.task && !params!.description) {
        throw new Error(`Task association is required for proper tracking.
Please provide one of:
  --task <id>           Associate with existing task
  --description <text>  Create new task automatically

Examples:
  minsky session start --task 123
  minsky session start --description "Fix login issue" my-session`);
      }

      const session = await sessionStart({
        name: params!.name,
        task: params!.task,
        description: params!.description,
        branch: params!.branch,
        repo: params!.repo,
        session: params!.session,
        json: params!.json,
        quiet: params!.quiet,
        noStatusUpdate: params!.noStatusUpdate,
        skipInstall: params!.skipInstall,
        packageManager: params!.packageManager,
      });

      return {
        success: true,
        session,
      };    },
  });

  // Register session dir command
  sharedCommandRegistry.registerCommand({
    id: "session.dir",
    category: CommandCategory.SESSION,
    name: "dir",
    description: "Get the directory of a session",
    parameters: {
      ...sessionDirCommandParams,
      // Add backward compatible parameters for CLI
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
      // Remove the session parameter
      sessionname: {
        schema: z.string().min(1),
        description: "Session name (for MCP)",
        required: false
      }
    },
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.dir command", { params, context });

      // CLI compatibility: map name or task to sessionname if not provided
      if (!params!.sessionname && (params!.name || params!.task)) {
        params!.sessionname = params!.name || params!.task;
      }

      try {
        const directory = await sessionDir({
          sessionname: params!.sessionname,
          json: params!.json,
        });

        return {
          success: true,
          directory,
        };
      } catch (error) {
        log.debug("Failed to get session directory", {
          error: getErrorMessage(error as Error),
          session: params!.sessionname,
        });
        throw error;
      }
    },
  });

  // Register session delete command
  sharedCommandRegistry.registerCommand({
    id: "session.delete",
    category: CommandCategory.SESSION,
    name: "delete",
    description: "Delete a session",
    parameters: {
      ...sessionDeleteCommandParams,
      // Add backward compatible parameters for CLI
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
      }
    },
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.delete command", { params, context });

      // CLI compatibility: map name or task to session if not provided
      if (!params!.session && (params!.name || params!.task)) {
        params!.session = params!.name || params!.task;
      }

      try {
        const deleted = await sessionDelete({
          session: params!.session,
          force: params!.force,
          json: params!.json,
        });

        return {
          success: deleted,
          session: params!.session,
        };
      } catch (error) {
        log.error("Failed to delete session", {
          error: getErrorMessage(error as Error),
          session: params!.session,
        });
        throw error;
      }
    },
  });

  // Register session update command
  sharedCommandRegistry.registerCommand({
    id: "session.update",
    category: CommandCategory.SESSION,
    name: "update",
    description: "Update a session",
    parameters: {
      ...sessionUpdateCommandParams,
      // Add backward compatible parameters for CLI
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
      }
    },
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.update command", { params, context });

      // CLI compatibility: map name or task to session if not provided
      if (!params!.session && (params!.name || params!.task)) {
        params!.session = params!.name || params!.task;
      }

      try {
        await sessionUpdate({
          session: params!.session,
          branch: params!.branch,
          noStash: params!.noStash,
          noPush: params!.noPush,
          force: params!.force,
          skipConflictCheck: params!.skipConflictCheck,
          autoResolveDeleteConflicts: params!.autoResolveDeleteConflicts,
          dryRun: params!.dryRun,
          skipIfAlreadyMerged: params!.skipIfAlreadyMerged,
          json: params!.json,
        });

        return {
          success: true,
          session: params!.session,
        };
      } catch (error) {
        log.error("Failed to update session", {
          error: getErrorMessage(error as Error),
          session: params!.session,
        });
        throw error;
      }
    },
  });

  // Register session approve command
  sharedCommandRegistry.registerCommand({
    id: "session.approve",
    category: CommandCategory.SESSION,
    name: "approve",
    description: "Approve a session pull request",
    parameters: {
      ...sessionApproveCommandParams,
      // Add backward compatible parameters for CLI
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
      }
    },
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.approve command", { params, context });

      // CLI compatibility: map name or task to session if not provided
      if (!params!.session && (params!.name || params!.task)) {
        params!.session = params!.name || params!.task;
      }

      try {
        const result = (await sessionApprove({
          session: params!.session,
          noStash: params!.noStash,
          json: params!.json,
        })) as unknown;

        log.debug("Session approve result", { result });

        return result;
      } catch (error) {
        log.error("Failed to approve session", {
          error: getErrorMessage(error as Error),
          session: params!.session,
        });
        throw error;
      }
    },
  });

  // Register session pr command
  sharedCommandRegistry.registerCommand({
    id: "session.pr",
    category: CommandCategory.SESSION,
    name: "pr",
    description: "Create a pull request for a session",
    parameters: {
      ...sessionPrCommandParams,
      // Add backward compatible parameters for CLI
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
      }
    },
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.pr command", { params, context });

      // CLI compatibility: map name or task to session if not provided
      if (!params!.session && (params!.name || params!.task)) {
        params!.session = params!.name || params!.task;
      }

      // Check if we need body/bodyPath for new PRs (keep existing PR branch logic)
      if (!params!.body && !params!.bodyPath) {
        // Import gitService for validation
        const { createGitService } = await import("../../../domain/git.js");
        const { SessionPathResolver } = await import("../../mcp/session-files.js");

        const gitService = createGitService();
        const pathResolver = new SessionPathResolver();
        const prBranch = `pr/${params!.session}`;

        try {
          // Get session workspace path for git operations
          const sessionWorkspacePath = await pathResolver.getSessionWorkspacePath(params!.session);

          // Check if PR branch exists locally or remotely
          let prBranchExists = false;
          try {
            // Check if branch exists locally
            const localBranchOutput = await gitService.execInRepository(
              sessionWorkspacePath,
              `git show-ref --verify --quiet refs/heads/${prBranch} || echo "not-exists"`
            );
            const localBranchExists = localBranchOutput.trim() !== "not-exists";

            if (localBranchExists) {
              prBranchExists = true;
            } else {
              // Check if branch exists remotely
              const remoteBranchOutput = await gitService.execInRepository(
                sessionWorkspacePath,
                `git ls-remote --heads origin ${prBranch}`
              );
              prBranchExists = remoteBranchOutput.trim().length > 0;
            }

            log.debug(`PR branch check: ${prBranchExists ? "exists" : "does not exist"}`, {
              prBranch,
              sessionWorkspacePath
            });
          } catch (branchCheckError) {
            log.debug("Failed to check PR branch existence", {
              error: getErrorMessage(branchCheckError as Error),
              prBranch
            });
          }

          if (!prBranchExists) {
            // No existing PR branch, so body/bodyPath is required for new PR
            throw new Error(`PR description is required for meaningful pull requests.
Please provide one of:
  --body <text>       Direct PR body text
  --body-path <path>  Path to file containing PR body

Example:
  minsky session pr --session "${params!.session}" --title "feat: Add new feature" --body "This PR adds..."
  minsky session pr --session "${params!.session}" --title "fix: Bug fix" --body-path process/tasks/189/pr.md`);
          }
          // If prBranchExists is true, we can proceed with refresh (no body/bodyPath needed)
        } catch (error) {
          // If we can't determine session workspace, let the domain function handle the error
          log.debug("Could not validate PR branch existence", { error: getErrorMessage(error) });
        }
      }

      try {
        const result = await sessionPr({
          title: params!.title,
          body: params!.body,
          bodyPath: params!.bodyPath,
          session: params!.session,
          noStatusUpdate: params!.noStatusUpdate,
          debug: params!.debug,
          skipUpdate: params!.skipUpdate,
          skipConflictCheck: params!.skipConflictCheck,
          autoResolveDeleteConflicts: params!.autoResolveDeleteConflicts,
        });

        return result;
      } catch (error) {
        log.error("Failed to create PR for session", {
          error: getErrorMessage(error as Error),
          session: params!.session,
        });
        throw error;
      }
    },
  });

  // Register session inspect command
  sharedCommandRegistry.registerCommand({
    id: "session.inspect",
    category: CommandCategory.SESSION,
    name: "inspect",
    description: "Inspect the current session (auto-detected from workspace)",
    parameters: {
      json: {
        schema: z.boolean(),
        description: "Output in JSON format",
        required: false,
        defaultValue: false,
      },
    },
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.inspect command", { params, context });

      try {
        const session = await sessionInspect({
          json: params!.json,
        });

        return {
          success: true,
          session,
        };
      } catch (error) {
        log.error("Failed to inspect session", {
          error: getErrorMessage(error as Error),
        });
        throw error;
      }
    },
  });

  // Register session commit command
  sharedCommandRegistry.registerCommand({
    id: "session.commit",
    category: CommandCategory.SESSION,
    name: "commit",
    description: "Commit and push changes in a session (atomic operation)",
    parameters: sessionCommitCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.commit command", { params, context });

      try {
        const result = await sessionCommit({
          session: params!.session,
          message: params!.message,
          all: params!.all,
          amend: params!.amend,
          noStage: params!.noStage,
        });

        return {
          success: result.success,
          commitHash: result.commitHash,
          message: result.message,
          pushed: result.pushed,
        };
      } catch (error) {
        log.error("Failed to commit in session", {
          error: getErrorMessage(error as Error),
          session: params!.session,
        });
        throw error;
      }
    },
  });
}
