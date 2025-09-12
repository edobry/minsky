/**
 * Session Workflow Commands (Migrated to DatabaseCommand)
 *
 * Commands for session workflow operations (approve, pr, inspect, commit).
 * Migrated from BaseSessionCommand to DatabaseSessionCommand for type-safe persistence.
 */
import { DatabaseSessionCommand } from "../../../../domain/commands/database-session-command";
import { DatabaseCommandContext, CommandExecutionResult } from "../../command-registry";
import {
  sessionApproveCommandParams,
  sessionInspectCommandParams,
  sessionReviewCommandParams,
} from "./session-parameters";
import { sessionCommitCommandParams } from "../session-parameters";
import { createSessionProvider } from "../../../../domain/session/session-db-adapter";

/**
 * Session Commit Command
 */
export class SessionCommitCommand extends DatabaseSessionCommand<any, any> {
  readonly id = "session.commit";
  readonly name = "commit";
  readonly description = "Commit and push changes within a session workspace";
  readonly parameters = sessionCommitCommandParams;

  async execute(
    params: any,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
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
        sessionName: params.sessionName,
        commitHash: result.commitHash,
        shortHash: result.shortHash,
        subject: result.subject,
        branch: result.branch,
        authorName: result.authorName,
        authorEmail: result.authorEmail,
        timestamp: result.timestamp,
        message: result.message,
        filesChanged: result.filesChanged,
        insertions: result.insertions,
        deletions: result.deletions,
        files: result.files,
        pushed: result.pushed,
        oneline: params.oneline === true,
        noFiles: params.noFiles === true,
      });
    } catch (error) {
      this.logError(params, error);
      throw error;
    }
  }
}

/**
 * Session Approve Command
 */
export class SessionApproveCommand extends DatabaseSessionCommand<any, any> {
  readonly id = "session.approve";
  readonly name = "approve";
  readonly description = "Approve a session pull request";
  readonly parameters = sessionApproveCommandParams;

  async execute(
    params: any,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      const { approveSessionPrFromParams } = await import("../../../../domain/session");

      // Create session provider with injected persistence provider
      const sessionProvider = await createSessionProvider({
        persistenceProvider: context.provider,
      });

      const result = await approveSessionPrFromParams(
        {
          name: params.name,
          task: params.task,
          repo: params.repo,
          json: params.json,
        },
        {
          sessionDB: sessionProvider,
        }
      );

      return this.createSuccessResult(result);
    } catch (error) {
      this.logError(params, error);
      throw error;
    }
  }
}

/**
 * Session Inspect Command
 */
export class SessionInspectCommand extends DatabaseSessionCommand<any, any> {
  readonly id = "session.inspect";
  readonly name = "inspect";
  readonly description = "Inspect session details and status";
  readonly parameters = sessionInspectCommandParams;

  async execute(
    params: any,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      const { inspectSessionFromParams } = await import("../../../../domain/session");

      // Create session provider with injected persistence provider
      const sessionProvider = await createSessionProvider({
        persistenceProvider: context.provider,
      });

      const result = await inspectSessionFromParams(
        {
          name: params.name,
          task: params.task,
          repo: params.repo,
          json: params.json,
        },
        {
          sessionDB: sessionProvider,
        }
      );

      return this.createSuccessResult(result);
    } catch (error) {
      this.logError(params, error);
      throw error;
    }
  }
}

/**
 * Session Review Command
 */
export class SessionReviewCommand extends DatabaseSessionCommand<any, any> {
  readonly id = "session.review";
  readonly name = "review";
  readonly description = "Review session pull request";
  readonly parameters = sessionReviewCommandParams;

  async execute(
    params: any,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      const { reviewSessionPrFromParams } = await import("../../../../domain/session");

      // Create session provider with injected persistence provider
      const sessionProvider = await createSessionProvider({
        persistenceProvider: context.provider,
      });

      const result = await reviewSessionPrFromParams(
        {
          name: params.name,
          task: params.task,
          repo: params.repo,
          json: params.json,
        },
        {
          sessionDB: sessionProvider,
        }
      );

      return this.createSuccessResult(result);
    } catch (error) {
      this.logError(params, error);
      throw error;
    }
  }
}
