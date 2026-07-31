import { validateProcess } from "../schemas/runtime";
import { runGitCommandWithLockHandling, type LockDependencies } from "./lock-operations";

// POSIX shell single-quote escape
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export type RestoreDependencies = LockDependencies;

// ---------------------------------------------------------------------------
// git_restore
// ---------------------------------------------------------------------------

export interface RestoreOptions {
  repoPath?: string;
  /**
   * Paths to restore (discard unstaged changes). At least one required.
   */
  paths: string[];
  /**
   * When true, a blocked `.git/index.lock` is auto-repaired (confirm-gated
   * internally: only removed when provably stale) and the restore retried
   * once. When false/omitted, a lock-blocked error is enriched with
   * diagnostics (age, owning-process liveness) instead of the raw git fatal.
   */
  repairLock?: boolean;
}

export interface RestoreResult {
  workdir: string;
  restored: string[];
}

/**
 * Restore (discard) unstaged working-tree changes for specific paths.
 * Equivalent to `git restore <path>` (not --staged).
 *
 * This is less destructive than `git reset --hard` because it only affects
 * the listed paths, not the entire working tree.
 */
export async function restoreImpl(
  options: RestoreOptions,
  deps: RestoreDependencies
): Promise<RestoreResult> {
  if (!options.paths || options.paths.length === 0) {
    throw new Error(
      "restore requires at least one path. " +
        'Provide `paths: ["file1", "file2"]` to specify which files to restore.'
    );
  }

  const workdir = options.repoPath ?? validateProcess(process).cwd();
  const qWorkdir = shellQuote(workdir);

  const quotedPaths = options.paths.map(shellQuote).join(" ");
  await runGitCommandWithLockHandling(`git -C ${qWorkdir} restore -- ${quotedPaths}`, deps, {
    repoPath: workdir,
    repairLock: options.repairLock,
  });

  return { workdir, restored: options.paths };
}
