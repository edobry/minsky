/**
 * Session Cleanup Command
 *
 * Identifies and removes stale/orphaned sessions.
 * Default is dryRun=true — safe by default.
 */
import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { sessionCleanupCommandParams } from "./session-parameters";

export function createSessionCleanupCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.cleanup",
    category: CommandCategory.SESSION,
    name: "cleanup",
    description:
      "Identify and remove stale/orphaned sessions (dry-run by default; pass --no-dry-run --yes to delete)",
    parameters: sessionCleanupCommandParams,
    execute: withErrorLogging("session.cleanup", async (params: Record<string, unknown>) => {
      const {
        identifyCleanupCandidates,
        identifyFilesystemOrphanDirs,
        parseDuration,
        sessionHasUncommittedChanges,
      } = await import("../../../../domain/session/session-cleanup");
      const { deleteSessionImpl } = await import(
        "../../../../domain/session/session-lifecycle-operations"
      );
      const { log } = await import("../../../../utils/logger");
      const { existsSync, rmSync } = await import("node:fs");

      const deps = await getDeps();
      const sessionProvider = deps.sessionProvider;

      // Parse olderThan duration if provided
      const olderThanStr = params.olderThan as string | undefined;
      let olderThanMs: number | undefined;
      if (olderThanStr) {
        const parsed = parseDuration(olderThanStr);
        if (parsed === null) {
          throw new Error(
            `Invalid duration format '${olderThanStr}'. Use formats like: 7d, 24h, 30m, 60s, 1500ms, 2w`
          );
        }
        olderThanMs = parsed;
      }

      const includeStale = (params.stale as boolean | undefined) ?? false;
      const includeOrphaned = (params.orphaned as boolean | undefined) ?? false;
      const dryRun = (params.dryRun as boolean | undefined) ?? true;
      const yes = (params.yes as boolean | undefined) ?? false;

      // Identify DB-tracked candidates (stale sessions, DB-orphans with no dir, etc.)
      const candidates = await identifyCleanupCandidates(sessionProvider, {
        includeStale,
        includeOrphaned,
        olderThanMs,
      });

      // Identify filesystem orphan dirs (dirs on disk with no DB record) when --orphaned.
      // This is the mt#1941 failure mode: workspace dir persists after DB record is deleted.
      const fsOrphans = includeOrphaned ? await identifyFilesystemOrphanDirs(sessionProvider) : [];

      if (candidates.length === 0 && fsOrphans.length === 0) {
        return {
          success: true,
          found: 0,
          skipped: 0,
          deleted: 0,
          candidates: [],
          message: "No sessions matching the cleanup criteria were found.",
        };
      }

      // For each DB-tracked candidate, check uncommitted changes (skip + warn if found)
      const safeToDelete: typeof candidates = [];
      const skippedDueToChanges: Array<{ sessionId: string; reason: string }> = [];

      for (const candidate of candidates) {
        const sessionId = candidate.session.sessionId;
        const hasChanges = await sessionHasUncommittedChanges(sessionId, deps.gitService);
        if (hasChanges) {
          const msg = `Session '${sessionId}' has uncommitted changes — skipping`;
          log.warn(msg);
          skippedDueToChanges.push({ sessionId, reason: "uncommitted-changes" });
        } else {
          safeToDelete.push(candidate);
        }
      }

      const candidateSummary = safeToDelete.map((c) => ({
        sessionId: c.session.sessionId,
        taskId: c.session.taskId,
        reason: c.reason,
        liveness: c.liveness,
        lastActivityAt: c.session.lastActivityAt ?? c.session.createdAt,
        status: c.session.status,
      }));

      // Filesystem orphans summary (no DB record — no taskId/status/liveness metadata)
      const fsOrphanSummary = fsOrphans.map((o) => ({
        sessionId: o.sessionId,
        taskId: undefined as string | undefined,
        reason: "filesystem-orphan" as const,
        liveness: "orphaned" as const,
        lastActivityAt: undefined as string | undefined,
        status: "unknown" as const,
        dirPath: o.dirPath,
      }));

      const totalFound = candidates.length + fsOrphans.length;
      const totalWouldDelete = safeToDelete.length + fsOrphans.length;

      // Dry-run: print candidates + fs orphans, don't delete
      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          found: totalFound,
          skipped: skippedDueToChanges.length,
          wouldDelete: totalWouldDelete,
          candidates: [...candidateSummary, ...fsOrphanSummary],
          skippedDetails: skippedDueToChanges,
          message: `Found ${totalWouldDelete} session(s) that would be deleted (dry-run). Pass --no-dry-run --yes to delete.`,
        };
      }

      // Without --yes: require confirmation
      if (!yes) {
        return {
          success: false,
          found: totalFound,
          skipped: skippedDueToChanges.length,
          wouldDelete: totalWouldDelete,
          candidates: [...candidateSummary, ...fsOrphanSummary],
          message:
            `Found ${totalWouldDelete} session(s) to delete. ` +
            `Pass --yes to confirm deletion, or use --dry-run (default) to preview.`,
          requiresConfirmation: true,
        };
      }

      // Delete each DB-tracked candidate
      let deleted = 0;
      const deletionErrors: Array<{ sessionId: string; error: string }> = [];

      for (const candidate of safeToDelete) {
        const sessionId = candidate.session.sessionId;
        try {
          const result = await deleteSessionImpl(
            { sessionId, force: false },
            { sessionDB: sessionProvider, gitService: deps.gitService }
          );
          if (result.deleted) {
            deleted++;
            log.debug(`Deleted session '${sessionId}' (reason: ${candidate.reason})`);
          } else {
            deletionErrors.push({ sessionId, error: result.error ?? "unknown error" });
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          deletionErrors.push({ sessionId, error: msg });
          log.warn(`Failed to delete session '${sessionId}': ${msg}`);
        }
      }

      // Remove filesystem orphan dirs (no DB record to delete — just remove the dir)
      for (const orphan of fsOrphans) {
        try {
          if (existsSync(orphan.dirPath)) {
            rmSync(orphan.dirPath, { recursive: true, force: true });
            deleted++;
            log.debug(`Removed filesystem orphan workspace dir '${orphan.dirPath}' (no DB record)`);
          } else {
            // Dir disappeared between scan and delete — count as success (already gone)
            deleted++;
            log.debug(`Filesystem orphan dir already gone: ${orphan.dirPath}`);
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          deletionErrors.push({ sessionId: orphan.sessionId, error: msg });
          log.warn(`Failed to remove filesystem orphan dir '${orphan.dirPath}': ${msg}`);
        }
      }

      return {
        success: deletionErrors.length === 0,
        found: totalFound,
        skipped: skippedDueToChanges.length + deletionErrors.length,
        deleted,
        candidates: [...candidateSummary, ...fsOrphanSummary],
        skippedDetails: [
          ...skippedDueToChanges,
          ...deletionErrors.map((e) => ({
            sessionId: e.sessionId,
            reason: `deletion-failed: ${e.error}`,
          })),
        ],
        message: `Deleted ${deleted} of ${totalWouldDelete} session(s).`,
      };
    }),
  };
}
