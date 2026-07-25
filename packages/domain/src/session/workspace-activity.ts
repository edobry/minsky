/**
 * Shared workspace-mtime activity-freshness lookup (mt#3193).
 *
 * `tasks.dispatch-recover`'s staleness check (`computeDispatchStaleness`,
 * `./dispatch-recovery-classifier.ts`) and the dispatch-watchdog PRODUCER's
 * periodic sweep (`src/cockpit/dispatch-watchdog.ts`) both need a THIRD
 * activity signal beyond commits and `presence_claims`: evidence that a
 * dispatch is actively writing files through harness-native tools (`Read`,
 * `Edit`, `Write`, `Glob`, `Grep`) that never route through the Minsky MCP
 * server at all — and therefore never touch a commit OR a `presence_claims`
 * refresh (`presence_claims` is written only by session-scoped MCP tool
 * calls; see `./presence-activity.ts`'s documented residual blind spot).
 *
 * ## Originating incident (mt#3193)
 *
 * mt#2598 (PlantFlowPage split), session `b9941a68-...`: a `refactorer`
 * dispatch spent 55 minutes reading a 2132-line file and writing nine new
 * module files entirely through non-MCP harness tools. Its last commit/
 * presence activity was recorded at the 13-minute mark; the watchdog flagged
 * it stalled at the 45-minute mark (32 minutes silent by BOTH signals) even
 * though it was actively writing files to disk the entire time. The
 * orchestrator redispatched a second agent into the SAME occupied session —
 * the double-dispatch race mt#3086 documents the symptoms of.
 *
 * ## Why "dirty-file mtime", not a full recursive tree walk
 *
 * Scope is bounded to files `git status --porcelain=v1` already reports as
 * changed (staged + unstaged + untracked) — the same set
 * `classifyDispatchRecoveryState`'s `dirtyFileCount` already consults, just
 * read for its filesystem timestamps rather than its count. This keeps the
 * per-tick cost proportional to the SIZE OF THE DIFF, not the size of the
 * checkout (a `refactorer` session can be a full repo clone), and ties
 * "activity" to the same "uncommitted work" concept the classifier already
 * uses: a file that was written and then reverted to its original content
 * (and so no longer shows as dirty) stops contributing to this signal rather
 * than reporting stale "recent activity" forever from a leftover mtime.
 *
 * ## Residual blind spot
 *
 * A dispatch that reads files but never WRITES any (a pure investigation
 * stretch with no dirty tree) produces no signal here either — this closes
 * the "wrote files, never committed, never called an MCP tool" gap
 * specifically, not every conceivable "the process is alive" gap. A
 * dispatch making literally zero writes AND zero MCP calls for an entire
 * stale window is still invisible to every signal in this family (commit,
 * presence, or workspace-mtime) — see the "Does NOT cover" section of the
 * mt#3193 spec and `dispatch-recovery-classifier.ts`'s own documented
 * residual blind spot for the pre-existing version of this same caveat.
 *
 * Fail-open throughout: a missing workspace, a non-git directory, or a
 * `git`/`stat` failure all resolve to `null` rather than throwing — this is
 * a best-effort signal, matching the commit/presence signals' posture.
 *
 * @see mt#3193 — this module (workspace-mtime signal)
 * @see mt#3086 — presence-claim signal (the signal this one is the sibling of)
 * @see mt#3172 — extracted presence-claim lookup into a shared helper (the
 *   pattern this module follows for the new signal)
 * @see ./presence-activity.ts — the sibling shared lookup + its documented
 *   "MCP-routed calls only" blind spot this module exists to narrow
 * @see ./dispatch-recovery-classifier.ts — `computeDispatchStaleness`'s
 *   consumption of this signal
 */
import * as fs from "fs";
import * as path from "path";
import { log } from "@minsky/shared/logger";

/** Identifies the calling site in log lines so a shared-helper failure is traceable to its origin. */
export interface WorkspaceActivityLogContext {
  /** Short caller tag, e.g. "tasks.dispatch-recover" or "dispatch-watchdog". */
  source: string;
}

/**
 * Resolve the ms-epoch mtime of the most recently modified currently-dirty
 * file in a git working tree at `sessionDir`, or `null` when unavailable:
 * the directory doesn't exist, it isn't a git working tree (or `git status`
 * otherwise fails), there are no dirty files, or every dirty path failed to
 * `stat` (e.g. deleted between the `git status` read and the `stat` call).
 *
 * Parsing note: `git status --porcelain=v1` rename lines (`R  old -> new`)
 * are not specially handled — the raw `old -> new` fragment fails `stat` and
 * is skipped, same as any other unresolvable path. This mirrors the
 * existing (equally simplified) porcelain parsing in
 * `dispatch-recover-command.ts`'s `createRealDispatchRecoveryGitOps`.
 */
export async function resolveLastWorkspaceMtimeAtMs(
  sessionDir: string,
  logContext: WorkspaceActivityLogContext
): Promise<number | null> {
  try {
    if (!sessionDir || !fs.existsSync(sessionDir)) {
      log.debug(
        `[${logContext.source}] resolveLastWorkspaceMtimeAtMs: session directory missing — ` +
          "workspace-mtime signal unavailable",
        { sessionDir }
      );
      return null;
    }

    const proc = Bun.spawn(["git", "status", "--porcelain=v1"], {
      cwd: sessionDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) {
      log.debug(
        `[${logContext.source}] resolveLastWorkspaceMtimeAtMs: git status failed — ` +
          "workspace-mtime signal unavailable",
        { sessionDir, exitCode: proc.exitCode }
      );
      return null;
    }

    const lines = output.trim() ? output.trim().split("\n") : [];
    let maxMtimeMs: number | null = null;
    for (const line of lines) {
      if (line.length < 3) continue;
      const relPath = line.slice(3).trim();
      if (!relPath) continue;
      try {
        const stat = fs.statSync(path.join(sessionDir, relPath));
        if (maxMtimeMs === null || stat.mtimeMs > maxMtimeMs) {
          maxMtimeMs = stat.mtimeMs;
        }
      } catch {
        // Path unresolvable (deleted since `git status` ran, or a rename
        // line's "old -> new" fragment) — skip, this is best-effort.
      }
    }
    return maxMtimeMs;
  } catch (err) {
    // Reaching here means something OTHER than the expected "no git repo" /
    // "no dirty files" case threw (e.g. Bun.spawn itself failing to resolve
    // `git`) — an operational anomaly worth surfacing, not a silent degrade.
    log.warn(
      `[${logContext.source}] resolveLastWorkspaceMtimeAtMs resolution failed unexpectedly ` +
        "(degrading to no workspace-mtime signal)",
      { sessionDir, error: err instanceof Error ? err.message : String(err) }
    );
    return null;
  }
}
