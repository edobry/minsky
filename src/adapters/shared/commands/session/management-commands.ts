/**
 * Session Management Commands
 *
 * Factories for session management operations (delete, update, migrate-backend).
 */
import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { ValidationError } from "../../../../errors/index";
import { type LazySessionDeps, withErrorLogging } from "./types";
import {
  sessionDeleteCommandParams,
  sessionUpdateCommandParams,
  sessionMigrateBackendCommandParams,
  sessionMigrateCommandParams,
} from "./session-parameters";

export function createSessionDeleteCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.delete",
    category: CommandCategory.SESSION,
    name: "delete",
    description: "Delete a session",
    parameters: sessionDeleteCommandParams,
    validate: async (params: Record<string, unknown>) => {
      const sessionId = params.sessionId as string | undefined;
      const task = params.task as string | undefined;
      if (!sessionId && !task) {
        throw new ValidationError(
          "Session identifier required. Provide either --sessionId (session ID) or --task (task ID)."
        );
      }
    },
    execute: withErrorLogging("session.delete", async (params: Record<string, unknown>) => {
      const { SessionService } = await import("../../../../domain/session/session-service");
      const deps = await getDeps();
      const service = new SessionService(deps);

      const result = await service.delete({
        sessionId: params.sessionId as string | undefined,
        task: params.task as string | undefined,
        force: (params.force as boolean | undefined) ?? false,
        repo: params.repo as string | undefined,
        json: (params.json as boolean | undefined) ?? false,
      });

      return {
        success: result.deleted,
        session: params.sessionId || params.task,
        ...(result.error ? { error: result.error } : {}),
      };
    }),
  };
}

export function createSessionUpdateCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.update",
    category: CommandCategory.SESSION,
    name: "update",
    description: "Update a session",
    parameters: sessionUpdateCommandParams,
    mutating: true,
    execute: withErrorLogging("session.update", async (params: Record<string, unknown>) => {
      const { SessionService } = await import("../../../../domain/session/session-service");
      const deps = await getDeps();
      const service = new SessionService(deps);

      await service.update({
        sessionId: params.sessionId as string | undefined,
        task: params.task as string | undefined,
        repo: params.repo as string | undefined,
        branch: params.branch as string | undefined,
        noStash: (params.noStash as boolean | undefined) ?? false,
        noPush: (params.noPush as boolean | undefined) ?? false,
        force: (params.force as boolean | undefined) ?? false,
        json: (params.json as boolean | undefined) ?? false,
        skipConflictCheck: (params.skipConflictCheck as boolean | undefined) ?? false,
        autoResolveDeleteConflicts:
          (params.autoResolveDeleteConflicts as boolean | undefined) ?? false,
        dryRun: (params.dryRun as boolean | undefined) ?? false,
        skipIfAlreadyMerged: (params.skipIfAlreadyMerged as boolean | undefined) ?? false,
      });

      return {
        success: true,
        session: params.sessionId || params.task,
      };
    }),
  };
}

/**
 * Session Migrate Backend Command
 *
 * Migrates a session's repository backend from local to GitHub by discovering
 * the upstream origin URL from the session workspace and updating the session
 * DB record.
 */
export function createSessionMigrateBackendCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.migrate-backend",
    category: CommandCategory.SESSION,
    name: "migrate-backend",
    description: "Migrate a session's repository backend to GitHub by following origin remote",
    requiresSetup: false,
    parameters: sessionMigrateBackendCommandParams,
    execute: withErrorLogging(
      "session.migrate-backend",
      async (params: Record<string, unknown>) => {
        const deps = await getDeps();
        const { resolveSessionContextWithFeedback } = await import(
          "../../../../domain/session/session-context-resolver"
        );
        const { extractGitHubInfoFromUrl } = await import(
          "../../../../domain/session/repository-backend-detection"
        );

        const sessionProvider = deps.sessionProvider;
        const gitService = deps.gitService;

        const resolved = await resolveSessionContextWithFeedback({
          sessionId: params.sessionId as string | undefined,
          task: params.task as string | undefined,
          repo: params.repo as string | undefined,
          sessionProvider,
          allowAutoDetection: true,
        });

        const sessionId = resolved.sessionId;
        const record = await sessionProvider.getSession(sessionId);
        if (!record) {
          throw new Error(`Session '${sessionId}' not found`);
        }

        const workdir = await sessionProvider.getSessionWorkdir(sessionId);
        if (!workdir) {
          throw new Error(`Could not resolve session workspace for '${sessionId}'`);
        }

        const originUrlOutput = await gitService.execInRepository(
          workdir,
          "git remote get-url origin"
        );
        const firstHop = originUrlOutput.toString().trim();

        if (!firstHop) {
          throw new Error("Failed to retrieve origin URL from git");
        }

        const isLocalPath = (p: string) => p.startsWith("/") || p.startsWith("file://");
        let resolvedRemote = firstHop;

        if (isLocalPath(firstHop)) {
          const upstreamPath = firstHop.replace(/^file:\/\//, "");
          const upstreamOriginOut = await gitService.execInRepository(
            upstreamPath,
            "git remote get-url origin"
          );
          const secondHop = upstreamOriginOut.toString().trim();
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

        if (targetBackend !== "github") {
          throw new Error(
            `Unsupported target backend: "${targetBackend}". Only "github" is supported.`
          );
        }

        const gh = extractGitHubInfoFromUrl(resolvedRemote);

        const finalTargetUrl = resolvedRemote;

        if (params.dryRun) {
          const currentBackend = record.backendType || "github";
          const needsMigration =
            currentBackend !== targetBackend || record.repoUrl !== finalTargetUrl;

          const preview = {
            success: true,
            preview: true,
            session: sessionId,
            from: currentBackend,
            to: targetBackend,
            detected: {
              firstHopOrigin: firstHop,
              secondHopOrigin: isLocalPath(firstHop) ? resolvedRemote : undefined,
            },
            proposed: {
              repoUrl: finalTargetUrl,
              backendType: targetBackend,
            },
          };

          if (!needsMigration) {
            return {
              ...preview,
              message: `No migration needed - session already uses '${targetBackend}' backend`,
            };
          }

          return {
            ...preview,
            message: `Will set backend to '${targetBackend}' and repoUrl to '${finalTargetUrl}'`,
          };
        }

        const shouldUpdateRemote = params.updateRemote !== false;
        if (shouldUpdateRemote) {
          await gitService
            .execInRepository(workdir, `git remote remove prev-origin || true`)
            .catch(() => {});
          await gitService.execInRepository(workdir, `git remote add prev-origin origin`);

          await gitService.execInRepository(workdir, `git remote set-url origin ${finalTargetUrl}`);

          if (targetBackend === "github" && isLocalPath(firstHop)) {
            await gitService
              .execInRepository(workdir, `git remote remove local-origin || true`)
              .catch(() => {});
            await gitService.execInRepository(workdir, `git remote add local-origin ${firstHop}`);
          }
        }

        const currentBackend = record.backendType || "github";
        const needsMigration =
          currentBackend !== targetBackend || record.repoUrl !== finalTargetUrl;

        if (!needsMigration) {
          return {
            success: true,
            session: sessionId,
            backendType: targetBackend,
            repoUrl: finalTargetUrl,
            message: "No migration needed - session already uses the correct backend",
            ...(gh ? { github: gh } : {}),
          };
        }

        const sessionUpdates: Record<string, unknown> = {
          repoUrl: finalTargetUrl,
          backendType: targetBackend,
        };

        // GitHub backend: clear local-only PR state fields
        sessionUpdates.prBranch = undefined;
        sessionUpdates.prState = undefined;

        if (gh?.owner && gh?.repo) {
          sessionUpdates.repoName = `${gh.owner}/${gh.repo}`;
        }

        await sessionProvider.updateSession(sessionId, sessionUpdates);

        return {
          success: true,
          session: sessionId,
          backendType: targetBackend,
          repoUrl: finalTargetUrl,
          ...(gh ? { github: gh } : {}),
        };
      }
    ),
  };
}

/**
 * Session Migrate Command
 *
 * Migrates legacy session IDs (task-mt#XXX, task-md#XXX, etc.) to UUID format.
 * Renames both DB records and filesystem directories.
 */
export function createSessionMigrateCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.migrate",
    category: CommandCategory.SESSION,
    name: "migrate",
    description: "Migrate legacy session IDs to UUID format",
    requiresSetup: false,
    parameters: sessionMigrateCommandParams,
    execute: withErrorLogging("session.migrate", async (params: Record<string, unknown>) => {
      const deps = await getDeps();
      const { SessionMigrationService } = await import(
        "../../../../domain/session/migration-command"
      );

      const service = new SessionMigrationService(deps.sessionProvider);

      const dryRun = (params.dryRun as boolean) ?? false;
      const report = await service.migrate({ dryRun, backup: false });

      return {
        success: true,
        dryRun,
        total: report.progress.total,
        needsMigration: report.progress.needsMigration,
        migrated: report.progress.migrated,
        failed: report.progress.failed,
        results: report.results.map((r) => ({
          oldId: r.original.session,
          newId: r.migrated?.session ?? r.original.session,
          taskId: r.original.taskId,
          sessionIdChanged: r.changes.sessionIdChanged,
          success: r.success,
          ...(r.error ? { error: r.error } : {}),
        })),
        executionTime: `${report.executionTime}ms`,
      };
    }),
  };
}
