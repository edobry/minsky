/**
 * Session Management Commands
 *
 * Factories for session management operations (delete, update, migrate-backend).
 */
import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { type SessionCommandDependencies, withErrorLogging } from "./types";
import {
  sessionDeleteCommandParams,
  sessionUpdateCommandParams,
  sessionMigrateBackendCommandParams,
} from "./session-parameters";

export function createSessionDeleteCommand(deps: SessionCommandDependencies): CommandDefinition {
  return {
    id: "session.delete",
    category: CommandCategory.SESSION,
    name: "delete",
    description: "Delete a session",
    parameters: sessionDeleteCommandParams,
    execute: withErrorLogging("session.delete", async (params: Record<string, unknown>) => {
      const { deleteSessionFromParams } = await import("../../../../domain/session");

      const deleted = await deleteSessionFromParams({
        name: params.name as string | undefined,
        task: params.task as string | undefined,
        force: (params.force as boolean | undefined) ?? false,
        repo: params.repo as string | undefined,
        json: (params.json as boolean | undefined) ?? false,
      });

      return {
        success: deleted,
        session: params.name || params.task,
      };
    }),
  };
}

export function createSessionUpdateCommand(deps: SessionCommandDependencies): CommandDefinition {
  return {
    id: "session.update",
    category: CommandCategory.SESSION,
    name: "update",
    description: "Update a session",
    parameters: sessionUpdateCommandParams,
    execute: withErrorLogging("session.update", async (params: Record<string, unknown>) => {
      const { updateSessionFromParams } = await import("../../../../domain/session");

      await updateSessionFromParams({
        name: params.name as string | undefined,
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
        session: params.name || params.task,
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
export function createSessionMigrateBackendCommand(
  deps: SessionCommandDependencies
): CommandDefinition {
  return {
    id: "session.migrate-backend",
    category: CommandCategory.SESSION,
    name: "migrate-backend",
    description: "Migrate a session's repository backend to GitHub by following origin remote",
    parameters: sessionMigrateBackendCommandParams,
    execute: withErrorLogging(
      "session.migrate-backend",
      async (params: Record<string, unknown>) => {
        const { resolveSessionContextWithFeedback } = await import(
          "../../../../domain/session/session-context-resolver"
        );
        const { createGitService } = await import("../../../../domain/git");
        const { extractGitHubInfoFromUrl } = await import(
          "../../../../domain/session/repository-backend-detection"
        );

        const sessionDB = deps.sessionProvider;
        const gitService = createGitService();

        const resolved = await resolveSessionContextWithFeedback({
          session: params.name as string | undefined,
          task: params.task as string | undefined,
          repo: params.repo as string | undefined,
          sessionProvider: sessionDB,
          allowAutoDetection: true,
        });

        const sessionId = resolved.sessionId;
        const record = await sessionDB.getSession(sessionId);
        if (!record) {
          throw new Error(`Session '${sessionId}' not found`);
        }

        const workdir = await sessionDB.getSessionWorkdir(sessionId);
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

        if (targetBackend === "local" && !isLocalPath(firstHop)) {
          throw new Error(
            `First-hop origin is not a local path: ${firstHop}. Cannot migrate to local backend from a non-local upstream.`
          );
        }

        const gh = extractGitHubInfoFromUrl(resolvedRemote);

        const finalTargetUrl = targetBackend === "github" ? resolvedRemote : firstHop;

        if (params.dryRun) {
          const currentBackend = record.backendType || "local";
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
          if (targetBackend === "local" && resolvedRemote.includes("github.com")) {
            await gitService
              .execInRepository(workdir, `git remote remove github-origin || true`)
              .catch(() => {});
            await gitService.execInRepository(
              workdir,
              `git remote add github-origin ${resolvedRemote}`
            );
          }
        }

        const currentBackend = record.backendType || "local";
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

        if (targetBackend === "github") {
          sessionUpdates.prBranch = undefined;
          sessionUpdates.prState = undefined;

          if (gh?.owner && gh?.repo) {
            sessionUpdates.repoName = `${gh.owner}/${gh.repo}`;
          }
        } else if (targetBackend === "local") {
          sessionUpdates.pullRequest = undefined;
          sessionUpdates.repoName = "local-minsky";
        }

        await sessionDB.updateSession(sessionId, sessionUpdates);

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
