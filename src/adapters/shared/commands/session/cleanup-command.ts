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
      const { identifyCleanupCandidates, parseDuration, sessionHasUncommittedChanges } =
        await import("../../../../domain/session/session-cleanup");
      const { deleteSessionImpl } = await import(
        "../../../../domain/session/session-lifecycle-operations"
      );
      const { log } = await import("../../../../utils/logger");

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

      // Identify candidates
      const candidates = await identifyCleanupCandidates(sessionProvider, {
        includeStale,
        includeOrphaned,
        olderThanMs,
      });

      if (candidates.length === 0) {
        return {
          success: true,
          found: 0,
          skipped: 0,
          deleted: 0,
          candidates: [],
          message: "No sessions matching the cleanup criteria were found.",
        };
      }

      // For each candidate, check uncommitted changes (skip + warn if found)
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

      // Dry-run: print candidates, don't delete
      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          found: candidates.length,
          skipped: skippedDueToChanges.length,
          wouldDelete: safeToDelete.length,
          candidates: candidateSummary,
          skippedDetails: skippedDueToChanges,
          message: `Found ${safeToDelete.length} session(s) that would be deleted (dry-run). Pass --no-dry-run --yes to delete.`,
        };
      }

      // Without --yes: require confirmation
      if (!yes) {
        return {
          success: false,
          found: candidates.length,
          skipped: skippedDueToChanges.length,
          wouldDelete: safeToDelete.length,
          candidates: candidateSummary,
          message:
            `Found ${safeToDelete.length} session(s) to delete. ` +
            `Pass --yes to confirm deletion, or use --dry-run (default) to preview.`,
          requiresConfirmation: true,
        };
      }

      // Delete each candidate
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

      return {
        success: deletionErrors.length === 0,
        found: candidates.length,
        skipped: skippedDueToChanges.length + deletionErrors.length,
        deleted,
        candidates: candidateSummary,
        skippedDetails: [
          ...skippedDueToChanges,
          ...deletionErrors.map((e) => ({
            sessionId: e.sessionId,
            reason: `deletion-failed: ${e.error}`,
          })),
        ],
        message: `Deleted ${deleted} of ${safeToDelete.length} session(s).`,
      };
    }),
  };
}
