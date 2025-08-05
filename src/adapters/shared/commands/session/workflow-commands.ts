/**
 * Session Workflow Commands
 *
 * Commands for session workflow operations (approve, pr, inspect).
 * Extracted from session.ts as part of modularization effort.
 *
 * Replaced single "session pr" with subcommands (create, list, get)
 */
import { z } from "zod";
import { BaseSessionCommand, type SessionCommandDependencies } from "./base-session-command";
import { type CommandExecutionContext } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import { sessionApproveCommandParams, sessionInspectCommandParams } from "./session-parameters";
import { sessionCommitCommandParams } from "../session-parameters";

// Import the new PR subcommand classes
import {
  SessionPrCreateCommand,
  SessionPrListCommand,
  SessionPrGetCommand,
} from "./pr-subcommand-commands";

/**
 * Session Commit Command
 *
 * Commits and pushes changes within a session workspace
 */
export class SessionCommitCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.commit";
  }

  getCommandName(): string {
    return "commit";
  }

  getCommandDescription(): string {
    return "Commit and push changes within a session workspace";
  }

  getParameterSchema(): Record<string, any> {
    return sessionCommitCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { sessionCommit } = await import("../../../../domain/session/session-commands");

    const result = await sessionCommit({
      session: params.sessionName,
      message: params.message,
      all: params.all,
      amend: params.amend,
      noStage: params.noStage,
    });

    return this.createSuccessResult({
      success: result.success,
      commitHash: result.commitHash,
      message: result.message,
      pushed: result.pushed,
    });
  }
}

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
 * Session PR Approve Command (Task #358 - New Structure)
 */
export class SessionPrApproveCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.pr.approve";
  }

  getCommandName(): string {
    return "approve";
  }

  getCommandDescription(): string {
    return "Approve a session pull request (does not merge)";
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
      reviewComment: params.comment || params.reviewComment,
    });

    return this.createSuccessResult({ result });
  }
}

/**
 * Session PR Merge Command (Task #358 - New Structure)
 */
export class SessionPrMergeCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.pr.merge";
  }

  getCommandName(): string {
    return "merge";
  }

  getCommandDescription(): string {
    return "Merge an approved session pull request";
  }

  getParameterSchema(): Record<string, any> {
    return sessionApproveCommandParams; // Reuse same params for now
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { mergeSessionPr } = await import("../../../../domain/session/session-merge-operations");

    // Cleanup is enabled by default, but can be disabled with --no-cleanup
    const shouldCleanup = params.noCleanup !== true && 
      (params.cleanup !== false && params.cleanupSession !== false);

    const result = await mergeSessionPr({
      session: params.name,
      task: params.task,
      repo: params.repo,
      json: params.json,
      cleanupSession: shouldCleanup,
    });

    return this.createSuccessResult({ result });
  }
}

// Export the imported PR subcommand classes
export { SessionPrCreateCommand, SessionPrListCommand, SessionPrGetCommand };

/**
 * Factory functions for creating workflow commands
 */
export const createSessionCommitCommand = (deps?: SessionCommandDependencies) =>
  new SessionCommitCommand(deps);

export const createSessionApproveCommand = (deps?: SessionCommandDependencies) =>
  new SessionApproveCommand(deps);

export const createSessionInspectCommand = (deps?: SessionCommandDependencies) =>
  new SessionInspectCommand(deps);

export const createSessionPrApproveCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrApproveCommand(deps);

export const createSessionPrMergeCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrMergeCommand(deps);

// Factory functions for PR commands
export const createSessionPrCreateCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrCreateCommand(deps);

export const createSessionPrListCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrListCommand(deps);

export const createSessionPrGetCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrGetCommand(deps);
