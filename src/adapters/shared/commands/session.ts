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
} from "../../shared/command-registry.js";
import {
  getSessionFromParams,
  listSessionsFromParams,
  startSessionFromParams,
  deleteSessionFromParams,
  getSessionDirFromParams,
  updateSessionFromParams,
  approveSessionFromParams,
  sessionPrFromParams,
  inspectSessionFromParams,
} from "../../../domain/session.js";
import { log } from "../../../utils/logger.js";
import { MinskyError } from "../../../errors/index.js";

/**
 * Parameters for the session list command
 */
const sessionListCommandParams: CommandParameterMap = {
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
const sessionGetCommandParams: CommandParameterMap = {
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
const sessionStartCommandParams: CommandParameterMap = {
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
    schema: z.string(),
    description: "Override the detected package manager",
    required: false,
  },
};

/**
 * Parameters for the session dir command
 */
const sessionDirCommandParams: CommandParameterMap = {
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
const sessionDeleteCommandParams: CommandParameterMap = {
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
const sessionUpdateCommandParams: CommandParameterMap = {
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
const sessionApproveCommandParams: CommandParameterMap = {
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
const sessionPrCommandParams: CommandParameterMap = {
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
 * Register the session commands in the shared command registry
 */
export function registerSessionCommands(): void {
  // Register session list command
  (sharedCommandRegistry as any).registerCommand({
    id: "session.list",
    category: (CommandCategory as any).SESSION,
    name: "list",
    description: "List all sessions",
    parameters: sessionListCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.list command", { params, context });

      try {
        const sessions = await listSessionsFromParams({
          repo: (params as any).repo,
          json: (params as any).json,
        });

        return {
          success: true,
          sessions,
        };
      } catch (error) {
        log.error("Failed to list sessions", {
          error: getErrorMessage(error as any),
        });
        throw error;
      }
    },
  });

  // Register session get command
  (sharedCommandRegistry as any).registerCommand({
    id: "session.get",
    category: (CommandCategory as any).SESSION,
    name: "get",
    description: "Get details of a specific session",
    parameters: sessionGetCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.get command", { params, context });

      try {
        const session = await getSessionFromParams({
          name: (params as any).name,
          task: (params as any).task,
          repo: (params as any).repo,
          json: (params as any).json,
        });

        if (!session) {
          const identifier = (params as any).name || `task #${(params as any).task}`;
          throw new Error(`Session '${identifier}' not found`);
        }

        return {
          success: true,
          session,
        };
      } catch (error) {
        log.error("Failed to get session", {
          error: getErrorMessage(error as any),
          session: (params as any).name,
          task: (params as any).task,
        });
        throw error;
      }
    },
  });

  // Register session start command
  (sharedCommandRegistry as any).registerCommand({
    id: "session.start",
    category: (CommandCategory as any).SESSION,
    name: "start",
    description: "Start a new session",
    parameters: sessionStartCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.start command", { params, context });

      // Phase 2: Validate that task association is provided
      if (!(params as any).task && !(params as any).description) {
        throw new Error(`Task association is required for proper tracking.
Please provide one of:
  --task <id>           Associate with existing task
  --description <text>  Create new task automatically

Examples:
  minsky session start --task 123
  minsky session start --description "Fix login issue" my-session`);
      }

      try {
        const session = await startSessionFromParams({
          name: (params as any).name,
          task: (params as any).task,
          description: (params as any).description,
          branch: (params as any).branch,
          repo: (params as any).repo,
          session: (params as any).session,
          json: (params as any).json,
          quiet: (params as any).quiet,
          noStatusUpdate: (params as any).noStatusUpdate,
          skipInstall: (params as any).skipInstall,
          packageManager: (params as any).packageManager,
        });

        return {
          success: true,
          session,
        };
      } catch (error) {
        log.error("Failed to start session", {
          error: getErrorMessage(error as any),
          session: (params as any).name,
          task: (params as any).task,
        });
        throw error;
      }
    },
  });

  // Register session dir command
  (sharedCommandRegistry as any).registerCommand({
    id: "session.dir",
    category: (CommandCategory as any).SESSION,
    name: "dir",
    description: "Get the directory of a session",
    parameters: sessionDirCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.dir command", { params, context });

      try {
        const directory = await getSessionDirFromParams({
          name: (params as any).name,
          task: (params as any).task,
          repo: (params as any).repo,
          json: (params as any).json,
        });

        return {
          success: true,
          directory,
        };
      } catch (error) {
        log.error("Failed to get session directory", {
          error: getErrorMessage(error as any),
          session: (params as any).name,
          task: (params as any).task,
        });
        throw error;
      }
    },
  });

  // Register session delete command
  (sharedCommandRegistry as any).registerCommand({
    id: "session.delete",
    category: (CommandCategory as any).SESSION,
    name: "delete",
    description: "Delete a session",
    parameters: sessionDeleteCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.delete command", { params, context });

      try {
        const deleted = await deleteSessionFromParams({
          name: (params as any).name,
          task: (params as any).task,
          force: (params as any).force,
          repo: (params as any).repo,
          json: (params as any).json,
        });

        return {
          success: deleted,
          session: (params as any).name || (params as any).task,
        };
      } catch (error) {
        log.error("Failed to delete session", {
          error: getErrorMessage(error as any),
          session: (params as any).name || (params as any).task,
        });
        throw error;
      }
    },
  });

  // Register session update command
  (sharedCommandRegistry as any).registerCommand({
    id: "session.update",
    category: (CommandCategory as any).SESSION,
    name: "update",
    description: "Update a session",
    parameters: sessionUpdateCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.update command", { params, context });

      try {
        await updateSessionFromParams({
          name: (params as any).name,
          task: (params as any).task,
          repo: (params as any).repo,
          branch: (params as any).branch,
          noStash: (params as any).noStash,
          noPush: (params as any).noPush,
          force: (params as any).force,
          json: (params as any).json,
          skipConflictCheck: (params as any).skipConflictCheck,
          autoResolveDeleteConflicts: (params as any).autoResolveDeleteConflicts,
          dryRun: (params as any).dryRun,
          skipIfAlreadyMerged: (params as any).skipIfAlreadyMerged,
        });

        return {
          success: true,
          session: (params as any).name || (params as any).task,
        };
      } catch (error) {
        log.error("Failed to update session", {
          error: getErrorMessage(error as any),
          session: (params as any).name || (params as any).task,
        });
        throw error;
      }
    },
  });

  // Register session approve command
  (sharedCommandRegistry as any).registerCommand({
    id: "session.approve",
    category: (CommandCategory as any).SESSION,
    name: "approve",
    description: "Approve a session pull request",
    parameters: sessionApproveCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.approve command", { params, context });

      try {
        const result = await approveSessionFromParams({
          session: (params as any).name,
          task: (params as any).task,
          repo: (params as any).repo,
          json: (params as any).json,
        }) as any;

        return {
          success: true,
          result,
        };
      } catch (error) {
        log.error("Failed to approve session", {
          error: getErrorMessage(error as any),
          session: (params as any).name,
          task: (params as any).task,
        });
        throw error;
      }
    },
  });

  // Register session pr command
  (sharedCommandRegistry as any).registerCommand({
    id: "session.pr",
    category: (CommandCategory as any).SESSION,
    name: "pr",
    description: "Create a pull request for a session",
    parameters: sessionPrCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.pr command", { params, context });

      try {
        const result = await sessionPrFromParams({
          title: (params as any).title,
          body: (params as any).body,
          bodyPath: (params as any).bodyPath,
          session: (params as any).name,
          task: (params as any).task,
          repo: (params as any).repo,
          noStatusUpdate: (params as any).noStatusUpdate,
          debug: (params as any).debug,
          skipUpdate: (params as any).skipUpdate,
          autoResolveDeleteConflicts: (params as any).autoResolveDeleteConflicts,
          skipConflictCheck: (params as any).skipConflictCheck,
        }) as any;

        return {
          success: true,
          ...result,
        };
      } catch (error) {
        // Instead of just logging and rethrowing, provide user-friendly error messages
        const errorMessage = getErrorMessage(error as any);
        
        // Handle specific error types with friendly messages
        if ((errorMessage as any).includes("CONFLICT") || (errorMessage as any).includes("conflict")) {
          throw new MinskyError(
            `🔥 Git merge conflict detected while creating PR branch.
            
This usually happens when:
• The PR branch already exists with different content
• There are conflicting changes between your session and the base branch

💡 Quick fixes:
• Try with --skip-update to avoid session updates
• Or manually resolve conflicts and retry

Technical details: ${errorMessage}`
          );
        } else if ((errorMessage as any).includes("Failed to create prepared merge commit")) {
          throw new MinskyError(
            `❌ Failed to create PR branch merge commit.
            
This could be due to:
• Merge conflicts between your session branch and base branch
• Remote PR branch already exists with different content
• Network issues with git operations

💡 Try these solutions:
• Run 'git status' to check for conflicts
• Use --skip-update to bypass session updates
• Check your git remote connection

Technical details: ${errorMessage}`
          );
        } else if ((errorMessage as any).includes("Permission denied") || (errorMessage as any).includes("authentication")) {
          throw new MinskyError(
            `🔐 Git authentication error.
            
Please check:
• Your SSH keys are properly configured
• You have push access to the repository
• Your git credentials are valid

Technical details: ${errorMessage}`
          );
        } else if ((errorMessage as any).includes("Session") && (errorMessage as any).includes("not found")) {
          throw new MinskyError(
            `🔍 Session not found.
            
The session '${(params as any).name || (params as any).task}' could not be located.

💡 Try:
• Check available sessions: minsky session list
• Verify you're in the correct directory
• Use the correct session name or task ID

Technical details: ${errorMessage}`
          );
        } else {
          // For other errors, provide a general helpful message
          throw new MinskyError(
            `❌ Failed to create session PR.
            
The operation failed with: ${errorMessage}

💡 Troubleshooting:
• Check that you're in a session workspace
• Verify all files are committed
• Try running with --debug for more details
• Check 'minsky session list' to see available sessions

Need help? Run the command with --debug for detailed error information.`
          );
        }
      }
    },
  });

  // Register session inspect command
  (sharedCommandRegistry as any).registerCommand({
    id: "session.inspect",
    category: (CommandCategory as any).SESSION,
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
        const session = await inspectSessionFromParams({
          json: (params as any).json,
        });

        return {
          success: true,
          session,
        };
      } catch (error) {
        log.error("Failed to inspect session", {
          error: getErrorMessage(error as any),
        });
        throw error;
      }
    },
  });
}
