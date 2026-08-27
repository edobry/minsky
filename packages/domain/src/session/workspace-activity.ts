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
 * Scope is bounded to files `git status --porcelain=v1 -z` already reports
 * as changed (staged + unstaged + untracked) — the same set
 * `classifyDispatchRecoveryState`'s `dirtyFileCount` already consults, just
 * read for its filesystem timestamps rather than its count. This keeps the
 * per-tick cost proportional to the SIZE OF THE DIFF, not the size of the
 * checkout (a `refactorer` session can be a full repo clone), and ties
 * "activity" to the same "uncommitted work" concept the classifier already
 * uses: a file that was written and then reverted to its original content
 * (and so no longer shows as dirty) stops contributing to this signal rather
 * than reporting stale "recent activity" forever from a leftover mtime.
 *
 * ## `-z` parsing, renames, and deletions (PR #2307 R1 BLOCKING #1)
 *
 * The original version of this module used the newline-delimited
 * `--porcelain=v1` format and `line.slice(3).trim()` to extract each dirty
 * path, then `fs.statSync`'d it. Two failure modes made the signal blind
 * exactly where it matters most — the long, file-churning refactor work
 * that motivated it in the first place:
 *
 * - **Renames.** A rename line reads `R  old/path -> new/path`; slicing off
 *   the 3-char prefix yields the literal string `"old/path -> new/path"`,
 *   which is not a real filesystem path — `stat` always throws and the
 *   entry was silently skipped.
 * - **Deletions.** A deletion line's path no longer exists on disk by
 *   definition — `stat` always throws there too.
 *
 * A change set that is ENTIRELY renames or deletions therefore produced
 * `maxMtimeMs = null` — no signal at all, reproducing the exact false
 * positive this module exists to fix for precisely the rename/deletion-heavy
 * refactor case.
 *
 * Fix: `git status --porcelain=v1 -z` (NUL-delimited) instead. This buys two
 * things at once: it is immune to whitespace/newlines embedded in a
 * filename (undefined behavior for the newline format), and — the actual
 * fix — it represents a rename/copy as TWO separate NUL-terminated fields:
 * the CURRENT (post-rename) path in the same field as the `XY` status code,
 * followed by a bare old-path field with no status prefix. `parsePorcelainZPaths`
 * (below) takes the current path and discards the accompanying old path, so
 * a rename now yields a real, `stat`-able filesystem path instead of an
 * unparseable arrow-joined string.
 *
 * Deletions still can't be `stat`'d (the path genuinely doesn't exist), so
 * `resolveLastWorkspaceMtimeAtMs` falls back to the git index's own mtime —
 * `git rev-parse --git-path index` resolves the actual index file location
 * for ANY repository layout (plain clone or a linked worktree with `.git`
 * as a gitdir-pointer file), mirroring the existing `resolveGitDir` helper
 * in `packages/domain/src/git/lock-operations.ts`, which uses the same
 * `git rev-parse` indirection rather than assuming `<repo>/.git` for exactly
 * this reason. `git status` itself refreshes the index's stat-cache on
 * every invocation it runs against a dirty tree, so the index's mtime tracks
 * "when did the working tree last show as dirty" closely enough to serve as
 * a fallback floor — not as precise as a per-file mtime, but it turns "no
 * signal at all" into "a signal that's at worst a few seconds stale," which
 * is what a deletion-only change set needs to stop being invisible.
 *
 * ## Residual blind spot
 *
 * A dispatch that reads files but never WRITES/RENAMES/DELETES any (a pure
 * investigation stretch with no dirty tree) produces no signal here either —
 * this closes the "wrote files, never committed, never called an MCP tool"
 * gap specifically, not every conceivable "the process is alive" gap. A
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
 * @see packages/domain/src/git/lock-operations.ts `resolveGitDir` — the
 *   `git rev-parse` indirection pattern this module's index-path resolution
 *   mirrors, for the same plain-clone-vs-worktree reason
 */
import * as fs from "fs";
import * as path from "path";
import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "../errors/index";

/** Identifies the calling site in log lines so a shared-helper failure is traceable to its origin. */
export interface WorkspaceActivityLogContext {
  /** Short caller tag, e.g. "tasks.dispatch-recover" or "dispatch-watchdog". */
  source: string;
}

/**
 * Parse `git status --porcelain=v1 -z` output into the list of CURRENT
 * (post-change) relative paths it reports as dirty (staged + unstaged +
 * untracked). Pure string parsing — no I/O — so this is the unit-testable
 * core of the rename/deletion fix described in this module's docstring.
 *
 * A rename/copy entry (`XY` starting with `R` or `C`) consumes an EXTRA
 * NUL-terminated field immediately after its own — the original path, with
 * no `XY` prefix of its own — which is discarded here rather than
 * misparsed as an independent status entry on the next iteration.
 */
export function parsePorcelainZPaths(output: string): string[] {
  const fields = output.split("\0");
  // A trailing NUL produces one empty trailing field (or the whole string
  // is empty when the tree is clean) — drop it; every other field is a
  // genuine record.
  if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();

  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field || field.length < 3) continue;
    const xy = field.slice(0, 2);
    const currentPath = field.slice(3);
    if (currentPath) paths.push(currentPath);
    if (xy[0] === "R" || xy[0] === "C") {
      // Consume the accompanying old-path field (mt#3193 PR #2307 R1
      // BLOCKING #1) — it carries no status prefix and would otherwise be
      // misread as its own entry.
      i += 1;
    }
  }
  return paths;
}

/**
 * Resolve the absolute path to the repository's actual `.git/index` file
 * via `git rev-parse --git-path index`, which correctly handles both a
 * plain clone (the common Minsky session-workspace layout) and a linked
 * worktree (`.git` as a gitdir-pointer file) — mirroring
 * `resolveGitDir` in `packages/domain/src/git/lock-operations.ts`. Returns
 * `null` on any failure (fail-open; this is a best-effort fallback signal,
 * not a hard dependency).
 */
async function resolveGitIndexPath(sessionDir: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--git-path", "index"], {
      cwd: sessionDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return null;
    const trimmed = output.trim();
    if (!trimmed) return null;
    return path.isAbsolute(trimmed) ? trimmed : path.join(sessionDir, trimmed);
  } catch {
    return null;
  }
}

/**
 * Resolve the ms-epoch mtime of the most recently modified currently-dirty
 * file in a git working tree at `sessionDir`, or `null` when unavailable:
 * the directory doesn't exist, it isn't a git working tree (or `git status`
 * otherwise fails), or there are no dirty files at all.
 *
 * A dirty path that no longer exists on disk (a deletion) falls back to the
 * git index's own mtime (`resolveGitIndexPath`) rather than being dropped
 * from consideration — see this module's docstring, "`-z` parsing, renames,
 * and deletions", for the full rationale. This means a change set that is
 * ENTIRELY deletions still produces a non-null, reasonably-fresh signal
 * instead of collapsing to `null`.
 *
 * **Contract caution (mt#3958):** this clock only advances on a dirty-file
 * WRITE. A caller that is reading source, planning, or running tests without
 * touching the working tree produces no write, so a large "ago" value
 * computed from this function's result means "no writes recently" — it does
 * NOT mean "no agent is here." Do not use it alone as a liveness/death
 * signal; see `tasks.dispatch-recover`'s escalate-message caution for the
 * consumer-facing wording this produced.
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

    const proc = Bun.spawn(["git", "status", "--porcelain=v1", "-z"], {
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

    const candidatePaths = parsePorcelainZPaths(output);
    if (candidatePaths.length === 0) return null;

    // Lazily resolved (and memoized for this call) — only actually spawns
    // the extra `git rev-parse` subprocess if at least one candidate path
    // fails to `stat` (i.e. a deletion), not on every healthy call.
    let indexMtimeMs: number | null | undefined;
    const getIndexMtimeMs = async (): Promise<number | null> => {
      if (indexMtimeMs !== undefined) return indexMtimeMs;
      const indexPath = await resolveGitIndexPath(sessionDir);
      if (!indexPath) {
        indexMtimeMs = null;
        return indexMtimeMs;
      }
      try {
        indexMtimeMs = fs.statSync(indexPath).mtimeMs;
      } catch {
        indexMtimeMs = null;
      }
      return indexMtimeMs;
    };

    let maxMtimeMs: number | null = null;
    for (const relPath of candidatePaths) {
      let mtimeMs: number | null;
      try {
        mtimeMs = fs.statSync(path.join(sessionDir, relPath)).mtimeMs;
      } catch {
        // Path no longer exists on disk (a deletion) — fall back to the
        // git index's mtime rather than dropping this entry entirely (PR
        // #2307 R1 BLOCKING #1).
        mtimeMs = await getIndexMtimeMs();
      }
      if (mtimeMs !== null && (maxMtimeMs === null || mtimeMs > maxMtimeMs)) {
        maxMtimeMs = mtimeMs;
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
      { sessionDir, error: getLoggableErrorSummary(err) }
    );
    return null;
  }
}
