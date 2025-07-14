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
  getSessionFromParams,
  listSessionsFromParams,
  startSessionFromParams,
  deleteSessionFromParams,
  getSessionDirFromParams,
  updateSessionFromParams,
  approveSessionFromParams,
  sessionPrFromParams,
  inspectSessionFromParams,
} from "../../../domain/session";
import { log } from "../../../utils/logger";
import { MinskyError } from "../../../errors/index";

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
    schema: z.enum(["bun", "npm", "yarn", "pnpm"]),
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
 * 
 * PROGRESSIVE DISCLOSURE STRATEGY:
 * - Core flags: Essential for basic PR creation (always visible)
 * - Advanced flags: Expert-level control (hidden by default, shown with --advanced)
 * - Smart defaults: Work for 90% of cases without additional flags
 */
const sessionPrCommandParams: CommandParameterMap = {
  // === CORE PARAMETERS (Always visible) ===
  title: {
    schema: z.string().min(1),
    description: "Title for the PR (auto-generated if not provided)",
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
    description: "Session name (auto-detected from workspace if not provided)",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID associated with the session (auto-detected if not provided)",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path (auto-detected if not provided)",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
  
  // === PROGRESSIVE DISCLOSURE CONTROL ===
  advanced: {
    schema: z.boolean(),
    description: "Show advanced options for conflict resolution and debugging",
    required: false,
    defaultValue: false,
  },
  
  // === ADVANCED PARAMETERS (Hidden by default) ===
  // Note: These are still registered but will be hidden in help unless --advanced is used
  debug: {
    schema: z.boolean(),
    description: "Enable debug output (use with --advanced)",
    required: false,
    defaultValue: false,
  },
  noStatusUpdate: {
    schema: z.boolean(),
    description: "Skip updating task status (use with --advanced)",
    required: false,
    defaultValue: false,
  },
  skipUpdate: {
    schema: z.boolean(),
    description: "Skip session update before creating PR (use with --advanced)",
    required: false,
    defaultValue: false,
  },
  autoResolveDeleteConflicts: {
    schema: z.boolean(),
    description: "Automatically resolve delete/modify conflicts by accepting deletions (use with --advanced)",
    required: false,
    defaultValue: false,
  },
  skipConflictCheck: {
    schema: z.boolean(),
    description: "Skip proactive conflict detection during update (use with --advanced)",
    required: false,
    defaultValue: false,
  },
};

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
        const sessions = await listSessionsFromParams({
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
        const session = await getSessionFromParams({
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

      try {
        const session = await startSessionFromParams({
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
        };
      } catch (error) {
        log.error("Failed to start session", {
          error: getErrorMessage(error as Error),
          session: params!.name,
          task: params!.task,
        });
        throw error;
      }
    },
  });

  // Register session dir command
  sharedCommandRegistry.registerCommand({
    id: "session.dir",
    category: CommandCategory.SESSION,
    name: "dir",
    description: "Get the directory of a session",
    parameters: sessionDirCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.dir command", { params, context });

      try {
        const directory = await getSessionDirFromParams({
          name: params!.name,
          task: params!.task,
          repo: params!.repo,
          json: params!.json,
        });

        return {
          success: true,
          directory,
        };
      } catch (error) {
        log.debug("Failed to get session directory", {
          error: getErrorMessage(error as Error),
          session: params!.name,
          task: params!.task,
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
        const deleted = await deleteSessionFromParams({
          name: params!.name,
          task: params!.task,
          force: params!.force,
          repo: params!.repo,
          json: params!.json,
        });

        return {
          success: deleted,
          session: params!.name || params!.task,
        };
      } catch (error) {
        log.error("Failed to delete session", {
          error: getErrorMessage(error as Error),
          session: params!.name || params!.task,
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
        await updateSessionFromParams({
          name: params!.name,
          task: params!.task,
          repo: params!.repo,
          branch: params!.branch,
          noStash: params!.noStash,
          noPush: params!.noPush,
          force: params!.force,
          json: params!.json,
          skipConflictCheck: params!.skipConflictCheck,
          autoResolveDeleteConflicts: params!.autoResolveDeleteConflicts,
          dryRun: params!.dryRun,
          skipIfAlreadyMerged: params!.skipIfAlreadyMerged,
        });

        return {
          success: true,
          session: params!.name || params!.task,
        };
      } catch (error) {
        log.error("Failed to update session", {
          error: getErrorMessage(error as Error),
          session: params!.name || params!.task,
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
        const result = (await approveSessionFromParams({
          session: params!.name,
          task: params!.task,
          repo: params!.repo,
          json: params!.json,
        })) as unknown;

        return {
          success: true,
          result,
        };
      } catch (error) {
        log.error("Failed to approve session", {
          error: getErrorMessage(error as Error),
          session: params!.name,
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
    description: "Create a pull request for a session with intelligent defaults and smart auto-detection. Use --advanced for expert options.",
    parameters: sessionPrCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing session.pr command", { params, context });

      // PROGRESSIVE DISCLOSURE: Show advanced usage help if --advanced flag is used
      if (params!.advanced) {
        const advancedHelp = `
🎯 Advanced Session PR Options:

CONFLICT RESOLUTION:
• --skip-update                    Skip session update before creating PR
• --skip-conflict-check           Skip proactive conflict detection
• --auto-resolve-delete-conflicts Auto-resolve delete/modify conflicts

DEBUGGING & CONTROL:
• --debug                         Enable detailed debug output
• --no-status-update             Skip automatic task status updates

COMMON ADVANCED SCENARIOS:
• Conflicted session:    minsky session pr --skip-update --title "fix: Emergency fix"
• Debug mode:           minsky session pr --debug --title "feat: New feature"
• Manual control:       minsky session pr --no-status-update --skip-conflict-check

💡 These options provide expert-level control over the PR creation process.
   Most users should use the basic command without these flags.
`;
        
        console.log(advancedHelp);
        return {
          success: true,
          message: "Advanced options displayed. Use these flags for expert-level control.",
        };
      }

      // Import gitService for validation
      const { createGitService } = await import("../../../domain/git.js");

      // SMART DEFAULTS: Apply intelligent defaults based on common scenarios
      const smartDefaults = {
        // Auto-generate title from task ID or session name if not provided
        title: params!.title || `PR for ${params!.task || params!.name || "session"}`,
        // Use smart conflict resolution by default
        autoResolveDeleteConflicts: params!.autoResolveDeleteConflicts ?? false,
        skipConflictCheck: params!.skipConflictCheck ?? false,
        skipUpdate: params!.skipUpdate ?? false,
        debug: params!.debug ?? false,
        noStatusUpdate: params!.noStatusUpdate ?? false,
      };

      // Conditional validation: require body/bodyPath only for new PRs (not refreshing existing ones)
      if (!params!.body && !params!.bodyPath) {
        // Check if there's an existing PR branch to determine if we can refresh
        const currentDir = process.cwd();
        const isSessionWorkspace = currentDir.includes("/sessions/");

        let sessionName = params!.name;
        if (!sessionName && isSessionWorkspace) {
          // Try to detect session name from current directory
          const pathParts = currentDir.split("/");
          const sessionsIndex = pathParts.indexOf("sessions");
          if (sessionsIndex >= 0 && sessionsIndex < pathParts.length - 1) {
            sessionName = pathParts[sessionsIndex + 1];
          }
        }

        if (sessionName) {
          const gitService = createGitService();
          const prBranch = `pr/${sessionName}`;

          // Check if PR branch exists locally or remotely
          let prBranchExists = false;
          try {
            // Check if branch exists locally
            const localBranchOutput = await gitService.execInRepository(
              currentDir,
              `git show-ref --verify --quiet refs/heads/${prBranch} || echo "not-exists"`
            );
            const localBranchExists = localBranchOutput.trim() !== "not-exists";

            if (localBranchExists) {
              prBranchExists = true;
            } else {
              // Check if branch exists remotely
              const remoteBranchOutput = await gitService.execInRepository(
                currentDir,
                `git ls-remote --heads origin ${prBranch}`
              );
              prBranchExists = remoteBranchOutput.trim().length > 0;
            }
          } catch (error) {
            // If we can't check branch existence, assume it doesn't exist
            prBranchExists = false;
          }

          if (!prBranchExists) {
            // No existing PR branch, so body/bodyPath is required
            throw new Error(`PR description is required for meaningful pull requests.
Please provide one of:
  --body <text>       Direct PR body text
  --body-path <path>  Path to file containing PR body

Example:
  minsky session pr --title "feat: Add new feature" --body "This PR adds..."
  minsky session pr --title "fix: Bug fix" --body-path process/tasks/189/pr.md`);
          }
          // If prBranchExists is true, we can proceed with refresh (no body/bodyPath needed)
        }
        // If we can't determine sessionName, let sessionPrFromParams handle the error
      }

      try {
        const result = await sessionPrFromParams({
          title: smartDefaults.title,
          body: params!.body,
          bodyPath: params!.bodyPath,
          session: params!.name,
          task: params!.task,
          repo: params!.repo,
          noStatusUpdate: smartDefaults.noStatusUpdate,
          debug: smartDefaults.debug,
          skipUpdate: smartDefaults.skipUpdate,
          autoResolveDeleteConflicts: smartDefaults.autoResolveDeleteConflicts,
          skipConflictCheck: smartDefaults.skipConflictCheck,
        });

        return {
          success: true,
          ...result,
        };
      } catch (error) {
        // Instead of just logging and rethrowing, provide user-friendly error messages
        const errorMessage = getErrorMessage(error as Error);

        // Enhanced error handling with scenario-based guidance
        if (errorMessage.includes("CONFLICT") || errorMessage.includes("conflict")) {
          throw new MinskyError(
            `🔥 Git merge conflict detected while creating PR branch.

🎯 SCENARIO-BASED SOLUTIONS:

📍 For emergency fixes:
   minsky session pr --skip-update --title "fix: Emergency fix"

📍 For complex conflicts:
   1. Manually resolve conflicts in your session workspace
   2. Commit resolved changes
   3. Run: minsky session pr --title "Your PR title"

📍 For clean slate approach:
   minsky session pr --skip-conflict-check --title "Your PR title"

💡 Use --advanced to see all conflict resolution options.

Technical details: ${errorMessage}`
          );
        } else if (errorMessage.includes("Failed to create prepared merge commit")) {
          throw new MinskyError(
            `❌ Failed to create PR branch merge commit.

🎯 QUICK DIAGNOSIS:
• Check for uncommitted changes: git status
• Check branch state: git branch -a
• Check remote connection: git remote -v

💡 Common solutions:
• Emergency bypass: minsky session pr --skip-update --title "fix: Issue"
• Debug mode: minsky session pr --advanced --debug --title "Your title"
• Manual resolution: Commit changes first, then retry

Technical details: ${errorMessage}`
          );
        } else if (
          errorMessage.includes("Permission denied") ||
          errorMessage.includes("authentication")
        ) {
          throw new MinskyError(
            `🔐 Git authentication error.

🎯 QUICK FIXES:
• Check SSH keys: ssh -T git@github.com
• Verify repository access permissions
• Ensure git credentials are configured

🔧 Common solutions:
• GitHub: Generate new personal access token
• SSH: Add your key to ssh-agent
• HTTPS: Update stored credentials

Technical details: ${errorMessage}`
          );
        } else if (errorMessage.includes("Session") && errorMessage.includes("not found")) {
          throw new MinskyError(
            `🔍 Session not found: '${params!.name || params!.task}'

🎯 TROUBLESHOOTING STEPS:
1. Check available sessions: minsky session list
2. Verify you're in the correct directory
3. Auto-detect from workspace: minsky session pr --title "Your title"

💡 The command auto-detects your session context when run from a session workspace.

Technical details: ${errorMessage}`
          );
        } else {
          // Enhanced general error with progressive disclosure
          throw new MinskyError(
            `❌ Failed to create session PR.

🎯 QUICK DIAGNOSIS:
• Are you in a session workspace? (Check with: pwd)
• Are all changes committed? (Check with: git status)
• Is the session registered? (Check with: minsky session list)

💡 For detailed diagnosis, run with --advanced --debug:
   minsky session pr --advanced --debug --title "Your title"

🔧 Common solutions:
• Commit uncommitted changes first
• Run from session workspace directory
• Use --skip-update if session updates are problematic

Technical details: ${errorMessage}`
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
        const session = await inspectSessionFromParams({
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
}
