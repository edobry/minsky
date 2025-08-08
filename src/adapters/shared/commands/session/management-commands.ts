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

    // Read origin URL from the session workspace (may be a local path)
    const originUrlOutput = await gitService.execInRepository(workdir, "git remote get-url origin");
    const firstHop = (
      typeof originUrlOutput === "string" ? originUrlOutput : originUrlOutput?.stdout || ""
    )
      .toString()
      .trim();

    if (!firstHop) {
      throw new Error("Failed to retrieve origin URL from git");
    }

    // Follow one hop if the origin is a local path; resolve its own origin to get the GitHub URL
    const isLocalPath = (p: string) => p.startsWith("/") || p.startsWith("file://");
    let resolvedRemote = firstHop;

    if (isLocalPath(firstHop)) {
      const upstreamPath = firstHop.replace(/^file:\/\//, "");
      const upstreamOriginOut = await gitService.execInRepository(
        upstreamPath,
        "git remote get-url origin"
      );
      const secondHop = (
        typeof upstreamOriginOut === "string" ? upstreamOriginOut : upstreamOriginOut?.stdout || ""
      )
        .toString()
        .trim();
      if (secondHop) {
        resolvedRemote = secondHop;
      }
    }

    const targetBackend = (params.to as string) || "github";

    if (targetBackend === "github" && !resolvedRemote.includes("github.com")) {
      throw new Error(
        `Resolved origin is not a GitHub URL: ${resolvedRemote}. Only local→GitHub migration is supported.`
      );
    }

    if (targetBackend === "local" && !isLocalPath(firstHop)) {
      throw new Error(
        `First-hop origin is not a local path: ${firstHop}. Cannot migrate to local backend from a non-local upstream.`
      );
    }

    // Optionally extract owner/repo for future enhancements (not persisted in SessionRecord)
    const gh = extractGitHubInfoFromUrl(resolvedRemote);

    // If dry-run, return a preview without applying changes
    const finalTargetUrl = targetBackend === "github" ? resolvedRemote : firstHop;

    if (params.dryRun) {
      return this.createSuccessResult({
        preview: true,
        session: sessionName,
        from: record.backendType || "local",
        to: targetBackend,
        proposed: {
          repoUrl: finalTargetUrl,
          backendType: targetBackend,
        },
      });
    }

    // Update session record to use selected backend and remote URL
    await sessionDB.updateSession(sessionName, {
      repoUrl: finalTargetUrl,
      backendType: targetBackend,
    });

    return this.createSuccessResult({
      session: sessionName,
      backendType: targetBackend,
      repoUrl: finalTargetUrl,
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
