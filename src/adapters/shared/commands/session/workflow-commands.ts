/**
 * Session Workflow Commands
 *
 * Commands for session workflow operations (approve, pr, inspect).
 * Extracted from session.ts as part of modularization effort.
 */
import { z } from "zod";
import { BaseSessionCommand, type SessionCommandDependencies } from "./base-session-command";
import { type CommandExecutionContext } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import {
  sessionApproveCommandParams,
  sessionPrCommandParams,
  sessionInspectCommandParams,
} from "./session-parameters";

/**
 * Session Approve Command
 */
export class SessionApproveCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.approve";
  }

  getCommandName(): string {
    return "approve";
  }

  getCommandDescription(): string {
    return "Approve a session pull request";
  }

  getParameterSchema(): Record<string, any> {
    return sessionApproveCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { approveSessionFromParams } = await import("../../../../domain/session");

    const result = await approveSessionFromParams({
      session: params.name,
      task: params.task,
      repo: params.repo,
      json: params.json,
    });

    return this.createSuccessResult({ result });
  }
}

/**
 * Session PR Command
 */
export class SessionPrCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.pr";
  }

  getCommandName(): string {
    return "pr";
  }

  getCommandDescription(): string {
    return "Create a pull request for a session";
  }

  getParameterSchema(): Record<string, any> {
    return sessionPrCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    // Conditional validation: require body/bodyPath only for new PRs
    if (!params.body && !params.bodyPath) {
      const canRefresh = await this.checkIfPrCanBeRefreshed(params);

      if (!canRefresh) {
        throw new Error(
          'PR description is required for meaningful pull requests.\nPlease provide one of:\n  --body <text>       Direct PR body text\n  --body-path <path>  Path to file containing PR body\n\nExample:\n  minsky session pr --title "feat: Add new feature" --body "This PR adds..."\n  minsky session pr --title "fix: Bug fix" --body-path process/tasks/189/pr.md'
        );
      }
    }

    const { sessionPrFromParams } = await import("../../../../domain/session");

    try {
      const result = await sessionPrFromParams({
        title: params.title,
        body: params.body,
        bodyPath: params.bodyPath,
        session: params.name,
        task: params.task,
        repo: params.repo,
        noStatusUpdate: params.noStatusUpdate,
        debug: params.debug,
        skipUpdate: params.skipUpdate,
        autoResolveDeleteConflicts: params.autoResolveDeleteConflicts,
        skipConflictCheck: params.skipConflictCheck,
      });

      return this.createSuccessResult(result);
    } catch (error) {
      throw this.handlePrError(error, params);
    }
  }

  private async checkIfPrCanBeRefreshed(params: any): Promise<boolean> {
    // Check if there's an existing PR branch to determine if we can refresh
    const currentDir = process.cwd();
    const isSessionWorkspace = currentDir.includes("/sessions/");

    let sessionName = params.name;
    if (!sessionName && isSessionWorkspace) {
      // Try to detect session name from current directory
      const pathParts = currentDir.split("/");
      const sessionsIndex = pathParts.indexOf("sessions");
      if (sessionsIndex >= 0 && sessionsIndex < pathParts.length - 1) {
        sessionName = pathParts[sessionsIndex + 1];
      }
    }

    if (!sessionName) {
      return false;
    }

    try {
      const { createGitService } = await import("../../../../domain/git");
      const gitService = createGitService();
      const prBranch = `pr/${sessionName}`;

      // Check if branch exists locally
      const localBranchOutput = await gitService.execInRepository(
        currentDir,
        `git show-ref --verify --quiet refs/heads/${prBranch} || echo "not-exists"`
      );
      const localBranchExists = localBranchOutput.trim() !== "not-exists";

      if (localBranchExists) {
        return true;
      }

      // Check if branch exists remotely
      const remoteBranchOutput = await gitService.execInRepository(
        currentDir,
        `git ls-remote --heads origin ${prBranch}`
      );
      return remoteBranchOutput.trim().length > 0;
    } catch (error) {
      // If we can't check branch existence, assume it doesn't exist
      return false;
    }
  }

  private handlePrError(error: any, params: any): Error {
    const errorMessage = getErrorMessage(error);

    // Handle specific error types with friendly messages
    if (errorMessage.includes("CONFLICT") || errorMessage.includes("conflict")) {
      return new MinskyError(
        `🔥 Git merge conflict detected while creating PR branch.\n\nThis usually happens when:\n• The PR branch already exists with different content\n• There are conflicting changes between your session and the base branch\n\n💡 Quick fixes:\n• Try with --skip-update to avoid session updates\n• Or manually resolve conflicts and retry\n\nTechnical details: ${errorMessage}`
      );
    } else if (errorMessage.includes("Failed to create prepared merge commit")) {
      return new MinskyError(
        `❌ Failed to create PR branch merge commit.\n\nThis could be due to:\n• Merge conflicts between your session branch and base branch\n• Remote PR branch already exists with different content\n• Network issues with git operations\n\n💡 Try these solutions:\n• Run 'git status' to check for conflicts\n• Use --skip-update to bypass session updates\n• Check your git remote connection\n\nTechnical details: ${errorMessage}`
      );
    } else if (
      errorMessage.includes("Permission denied") ||
      errorMessage.includes("authentication")
    ) {
      return new MinskyError(
        `🔐 Git authentication error.\n\nPlease check:\n• Your SSH keys are properly configured\n• You have push access to the repository\n• Your git credentials are valid\n\nTechnical details: ${errorMessage}`
      );
    } else if (errorMessage.includes("Session") && errorMessage.includes("not found")) {
      return new MinskyError(
        `🔍 Session not found.\n\nThe session '${params.name || params.task}' could not be located.\n\n💡 Try:\n• Check available sessions: minsky session list\n• Verify you're in the correct directory\n• Use the correct session name or task ID\n\nTechnical details: ${errorMessage}`
      );
    } else {
      return new MinskyError(
        `❌ Failed to create session PR.\n\nThe operation failed with: ${errorMessage}\n\n💡 Troubleshooting:\n• Check that you're in a session workspace\n• Verify all files are committed\n• Try running with --debug for more details\n• Check 'minsky session list' to see available sessions\n\nNeed help? Run the command with --debug for detailed error information.`
      );
    }
  }

  protected getAdditionalLogContext(params: any): Record<string, any> {
    return {
      title: params.title,
      hasBody: !!params.body,
      hasBodyPath: !!params.bodyPath,
      skipUpdate: params.skipUpdate,
    };
  }
}

/**
 * Session Inspect Command
 */
export class SessionInspectCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.inspect";
  }

  getCommandName(): string {
    return "inspect";
  }

  getCommandDescription(): string {
    return "Inspect the current session (auto-detected from workspace)";
  }

  getParameterSchema(): Record<string, any> {
    return sessionInspectCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { inspectSessionFromParams } = await import("../../../../domain/session");

    const result = await inspectSessionFromParams({
      json: params.json,
    });

    return this.createSuccessResult(result);
  }
}

/**
 * Factory functions for creating workflow commands
 */
export const createSessionApproveCommand = (deps?: SessionCommandDependencies) =>
  new SessionApproveCommand(deps);

export const createSessionPrCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrCommand(deps);

export const createSessionInspectCommand = (deps?: SessionCommandDependencies) =>
  new SessionInspectCommand(deps);
