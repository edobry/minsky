/**
 * Session Management Commands
 *
 * Commands for session management operations (delete, update).
 * Extracted from session.ts as part of modularization effort.
 */
import { BaseSessionCommand, type SessionCommandDependencies } from "./base-session-command";
import { type CommandExecutionContext } from "../../command-registry";
import {
  sessionDeleteCommandParams,
  sessionUpdateCommandParams,
  sessionMigrateBackendCommandParams,
} from "./session-parameters";

/**
 * Session Delete Command
 */
export class SessionDeleteCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.delete";
  }

  getCommandName(): string {
    return "delete";
  }

  getCommandDescription(): string {
    return "Delete a session";
  }

  getParameterSchema(): Record<string, any> {
    return sessionDeleteCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { deleteSessionFromParams } = await import("../../../../domain/session");

    const deleted = await deleteSessionFromParams({
      name: params.name,
      task: params.task,
      force: params.force,
      repo: params.repo,
      json: params.json,
    });

    return this.createSuccessResult({
      success: deleted,
      session: params.name || params.task,
    });
  }
}

/**
 * Session Update Command
 */
export class SessionUpdateCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.update";
  }

  getCommandName(): string {
    return "update";
  }

  getCommandDescription(): string {
    return "Update a session";
  }

  getParameterSchema(): Record<string, any> {
    return sessionUpdateCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    const { updateSessionFromParams } = await import("../../../../domain/session");

    await updateSessionFromParams({
      name: params.name,
      task: params.task,
      repo: params.repo,
      branch: params.branch,
      noStash: params.noStash,
      noPush: params.noPush,
      force: params.force,
      json: params.json,
      skipConflictCheck: params.skipConflictCheck,
      autoResolveDeleteConflicts: params.autoResolveDeleteConflicts,
      dryRun: params.dryRun,
      skipIfAlreadyMerged: params.skipIfAlreadyMerged,
    });

    return this.createSuccessResult({
      session: params.name || params.task,
    });
  }
}

/**
 * Session Migrate Backend Command
 *
 * Migrates a session's repository backend from local to GitHub by discovering the
 * upstream origin URL from the session workspace and updating the session DB record.
 */
export class SessionMigrateBackendCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.migrate-backend";
  }

  getCommandName(): string {
    return "migrate-backend";
  }

  getCommandDescription(): string {
    return "Migrate a session's repository backend to GitHub by following origin remote";
  }

  getParameterSchema(): Record<string, any> {
    return sessionMigrateBackendCommandParams;
  }

  async executeCommand(params: any, _context: CommandExecutionContext): Promise<any> {
    const { resolveSessionContextWithFeedback } = await import(
      "../../../../domain/session/session-context-resolver"
    );
    const { createSessionProvider } = await import("../../../../domain/session");
    const { createGitService } = await import("../../../../domain/git");
    const { extractGitHubInfoFromUrl } = await import(
      "../../../../domain/session/repository-backend-detection"
    );

    const sessionDB = createSessionProvider();
    const gitService = createGitService();

    // Resolve session context (supports name, task, auto-detect)
    const resolved = await resolveSessionContextWithFeedback({
      session: params.name,
      task: params.task,
      repo: params.repo,
      sessionProvider: sessionDB,
      allowAutoDetection: true,
    });

    const sessionName = resolved.sessionName;
    const record = await sessionDB.getSession(sessionName);
    if (!record) {
      throw new Error(`Session '${sessionName}' not found`);
    }

    // Get session workdir to run git command
    const workdir = await sessionDB.getSessionWorkdir(sessionName);
    if (!workdir) {
      throw new Error(`Could not resolve session workspace for '${sessionName}'`);
    }

    // Read origin URL from the session workspace
    const originUrlOutput = await gitService.execInRepository(workdir, "git remote get-url origin");
    const originUrl = (
      typeof originUrlOutput === "string" ? originUrlOutput : originUrlOutput?.stdout || ""
    )
      .toString()
      .trim();

    if (!originUrl) {
      throw new Error("Failed to retrieve origin URL from git");
    }

    if (!originUrl.includes("github.com")) {
      throw new Error(
        `Origin URL is not a GitHub repository: ${originUrl}. Only local→GitHub migration is supported.`
      );
    }

    // Optionally extract owner/repo for future enhancements (not persisted in SessionRecord)
    const gh = extractGitHubInfoFromUrl(originUrl);

    // Update session record to use GitHub backend and remote URL
    await sessionDB.updateSession(sessionName, {
      repoUrl: originUrl,
      backendType: "github",
    });

    return this.createSuccessResult({
      session: sessionName,
      backendType: "github",
      repoUrl: originUrl,
      ...(gh ? { github: gh } : {}),
    });
  }
}

/**
 * Factory functions for creating management commands
 */
export const createSessionDeleteCommand = (deps?: SessionCommandDependencies) =>
  new SessionDeleteCommand(deps);

export const createSessionUpdateCommand = (deps?: SessionCommandDependencies) =>
  new SessionUpdateCommand(deps);

export const createSessionMigrateBackendCommand = (deps?: SessionCommandDependencies) =>
  new SessionMigrateBackendCommand(deps);
