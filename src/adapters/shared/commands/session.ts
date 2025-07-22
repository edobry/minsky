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
    description: "Get details of a specific session",
    parameters: sessionGetCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.get command", { params, context });

      try {
        const session = await sessionGet({
          name: params!.name,
          task: params!.task,
          repo: params!.repo,
          json: params!.json,
        });

        if (!session) {
          const identifier = params!.name || `task #${params!.task}`;
          throw new Error(`Session '${identifier}' not found`);
        }

        return {
          success: true,
          session,
        };
      } catch (error) {
        log.error("Failed to get session", {
          error: getErrorMessage(error as Error),
          session: params!.name,
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
          name: params!.name,
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
          sessionname: params!.sessionname,
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
    parameters: sessionDeleteCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.delete command", { params, context });

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
    parameters: sessionUpdateCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.update command", { params, context });

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
    parameters: sessionApproveCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.approve command", { params, context });

      try {
        const result = (await sessionApprove({
          session: params!.session,
          noStash: params!.noStash,
          json: params!.json,
        })) as unknown;

        return {
          success: true,
          result,
        };
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
    parameters: sessionPrCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.pr command", { params, context });

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
          } catch (error) {
            // If we can't check branch existence, assume it doesn't exist
            prBranchExists = false;
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
        const result = (await sessionPr({
          title: params!.title,
          body: params!.body,
          bodyPath: params!.bodyPath,
          session: params!.session,
          noStatusUpdate: params!.noStatusUpdate,
          debug: params!.debug,
          skipUpdate: params!.skipUpdate,
          autoResolveDeleteConflicts: params!.autoResolveDeleteConflicts,
          skipConflictCheck: params!.skipConflictCheck,
        })) as Record<string, any>;

        return {
          success: true,
          ...result,
        };
      } catch (error) {
        // Instead of just logging and rethrowing, provide user-friendly error messages
        const errorMessage = getErrorMessage(error as Error);

        // Handle specific error types with friendly messages
        if (errorMessage.includes("CONFLICT") || errorMessage.includes("conflict")) {
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
        } else if (errorMessage.includes("Failed to create prepared merge commit")) {
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
        } else if (
          errorMessage.includes("Permission denied") ||
          errorMessage.includes("authentication")
        ) {
          throw new MinskyError(
            `🔐 Git authentication error.

Please check:
• Your SSH keys are properly configured
• You have push access to the repository
• Your git credentials are valid

Technical details: ${errorMessage}`
          );
        } else if (errorMessage.includes("Session") && errorMessage.includes("not found")) {
          throw new MinskyError(
            `🔍 Session not found.

The session '${params!.name || params!.task}' could not be located.

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
