import { validateProcess } from "../schemas/runtime";
import { runGitCommandWithLockHandling, type LockDependencies } from "./lock-operations";

// POSIX shell single-quote escape
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export type ResetDependencies = LockDependencies;

// ---------------------------------------------------------------------------
// git_reset
// ---------------------------------------------------------------------------

export interface ResetOptions {
  repoPath?: string;
  /**
   * Reset mode (required):
   * - "soft": move HEAD only; index and working tree unchanged.
   * - "mixed": move HEAD and reset index; working tree unchanged (default git behavior).
   * - "hard": move HEAD, reset index, and reset working tree (DESTRUCTIVE).
   */
  mode: "soft" | "mixed" | "hard";
  /**
   * Target ref to reset to. Defaults to HEAD (unstage staged changes).
   */
  target?: string;
  /**
   * Required when `mode === "hard"`. Must be `true` to proceed.
   * This is a destructive operation that discards uncommitted working-tree changes.
   */
  confirmHard?: boolean;
  /**
   * When true, a blocked `.git/index.lock` is auto-repaired (confirm-gated
   * internally: only removed when provably stale) and the reset retried once.
   */
  repairLock?: boolean;
}

export interface ResetResult {
  workdir: string;
  reset: boolean;
  mode: "soft" | "mixed" | "hard";
  target: string;
}

/**
 * Run `git reset` with an explicit mode.
 *
 * `mode: "hard"` requires `confirmHard: true` (enforced here for
 * defense-in-depth; the Zod schema at the adapter layer enforces it too).
 */
export async function resetImpl(
  options: ResetOptions,
  deps: ResetDependencies
): Promise<ResetResult> {
  if (options.mode === "hard" && !options.confirmHard) {
    throw new Error(
      "git reset --hard requires `confirmHard: true`. " +
        "This operation permanently discards all uncommitted working-tree changes and cannot be undone. " +
        "Set `confirmHard: true` to proceed. " +
        "Consider `mcp__minsky__git_stash` first if you may want to recover these changes."
    );
  }

  const workdir = options.repoPath ?? validateProcess(process).cwd();
  const qWorkdir = shellQuote(workdir);
  const target = options.target ?? "HEAD";
  const qTarget = shellQuote(target);

  await runGitCommandWithLockHandling(
    `git -C ${qWorkdir} reset --${options.mode} ${qTarget}`,
    deps,
    {
      repoPath: workdir,
      repairLock: options.repairLock,
    }
  );

  return { workdir, reset: true, mode: options.mode, target };
}
