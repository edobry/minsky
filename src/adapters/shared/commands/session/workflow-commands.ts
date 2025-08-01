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

// Import the new PR subcommand classes
import {
  SessionPrCreateCommand,
  SessionPrListCommand,
  SessionPrGetCommand,
  createSessionPrCreateCommand,
  createSessionPrListCommand,
  createSessionPrGetCommand,
} from "./pr-subcommand-commands";

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
    const { mergeSession } = await import(
      "../../../../domain/session/session-merge-operations"
    );

    const result = await mergeSession({
      session: params.name,
      task: params.task,
      repo: params.repo,
      json: params.json,
    });

    return this.createSuccessResult({ result });
  }
}

// Export the new PR subcommand classes
export {
  SessionPrCreateCommand,
  SessionPrListCommand,
  SessionPrGetCommand,
  SessionPrApproveCommand,
  SessionPrMergeCommand,
};

/**
 * Factory functions for creating workflow commands
 */
export const createSessionApproveCommand = (deps?: SessionCommandDependencies) =>
  new SessionApproveCommand(deps);

export const createSessionInspectCommand = (deps?: SessionCommandDependencies) =>
  new SessionInspectCommand(deps);

export const createSessionPrApproveCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrApproveCommand(deps);

export const createSessionPrMergeCommand = (deps?: SessionCommandDependencies) =>
  new SessionPrMergeCommand(deps);

// Export the new PR subcommand factory functions
export { createSessionPrCreateCommand, createSessionPrListCommand, createSessionPrGetCommand };
