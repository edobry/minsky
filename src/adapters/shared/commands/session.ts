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
import { MinskyError, ResourceNotFoundError } from "../../../errors/index";
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

      try {
        const session = await sessionGet({
          session: params!.sessionName || params!.name || params!.task,
          json: params!.json,
        });

        return {
          success: true,
          session,
        };
      } catch (error) {
        log.error("Failed to get session", {
          error: getErrorMessage(error as Error),
          sessionName: params!.sessionName,
          name: params!.name,
          task: params!.task,
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
    },
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.dir command", { params, context });

      try {
        const directory = await sessionDir({
          name: params!.sessionName || params!.name,
          task: params!.task,
          json: params!.json,
        });

        return {
          success: true,
          directory,
        };
      } catch (error) {
        log.debug("Failed to get session directory", {
          error: getErrorMessage(error as Error),
          sessionName: params!.sessionName,
          name: params!.name,
          task: params!.task,
        });

        // Improve error message for better user experience
        if (error instanceof ResourceNotFoundError) {
          const originalMessage = error.message;

          // Add better guidance if task ID or session name wasn't found
          if (originalMessage.includes("not found")) {
            error.message = formatSessionErrorMessage(
              originalMessage,
              "Try \"minsky session list\" to see available sessions."
            );
          }
        }

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
      },
    },
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.delete command", { params, context });

      try {
        const deleted = await sessionDelete({
          name: params!.sessionName || params!.name,
          task: params!.task,
          repo: params!.repo,
          force: params!.force,
        });

        return {
          success: deleted,
        };
      } catch (error) {
        log.debug("Failed to delete session", {
          error: getErrorMessage(error as Error),
          sessionName: params!.sessionName,
          name: params!.name,
          task: params!.task,
        });

        // Improve error message for better user experience
        if (error instanceof ResourceNotFoundError) {
          const originalMessage = error.message;

          // Add better guidance if task ID or session name wasn't found
          if (originalMessage.includes("not found")) {
            error.message = formatSessionErrorMessage(
              originalMessage,
              "Try \"minsky session list\" to see available sessions."
            );
          }
        }

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

      try {
        await sessionUpdate({
          name: params!.sessionName || params!.name,
          task: params!.task,
          repo: params!.repo,
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
          session: params!.sessionName || params!.name,
        };
      } catch (error) {
        log.error("Failed to update session", {
          error: getErrorMessage(error as Error),
          sessionName: params!.sessionName,
          name: params!.name,
          task: params!.task,
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
      // CLI-only parameters for backward compatibility
      name: {
        schema: z.string(),
        description: "Session name (CLI only)",
        required: false,
      },
      task: {
        schema: z.string(),
        description: "Task ID (CLI only)",
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

      try {
        // Map interface parameters to domain parameters correctly:
        // - sessionName/name → session (direct session identifier)
        // - task → task (for lookup by task ID)
        const approvalResult = await sessionApprove({
          session: params!.sessionName || params!.name,  // Direct session identifier
          task: params!.task,         // Task ID for lookup (not session identifier!)
          repo: params!.repo,
          json: params!.json,
          noStash: params!.noStash,   // Add the missing parameter
        });

        log.debug("Session approve result", { result: approvalResult });

        // Return in the expected command response format
        return {
          success: true,
          ...approvalResult,  // Spread the domain result fields
        };
      } catch (error) {
        log.error("Failed to approve session", {
          error: getErrorMessage(error as Error),
          sessionName: params!.sessionName,
          name: params!.name,
          task: params!.task,
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

      try {
        // Validate PR parameters before proceeding
        validatePrParameters(params!.body, params!.bodyPath, params!.sessionName || params!.name);

        const result = await sessionPr({
          session: params!.sessionName || params!.name,
          task: params!.task,
          repo: params!.repo,
          title: params!.title,
          body: params!.body,
          bodyPath: params!.bodyPath,
          debug: params!.debug,
          noStatusUpdate: params!.noStatusUpdate,
          skipUpdate: params!.skipUpdate,
          autoResolveDeleteConflicts: params!.autoResolveDeleteConflicts,
          skipConflictCheck: params!.skipConflictCheck,
        });

        return result;
      } catch (error) {
        return handleSessionPrError(error as Error, params!.sessionName || params!.name, params!.task);
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

/**
 * Format a session error message with improved user guidance
 */
function formatSessionErrorMessage(originalMessage: string, additionalGuidance: string): string {
  // First line is the original error
  return `${originalMessage}\n\n💡 ${additionalGuidance}`;
}
