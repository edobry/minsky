import { validateProcess } from "../../schemas/runtime";

// POSIX shell single-quote escape
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface RestoreDependencies {
  execAsync: (
    command: string,
    options?: Record<string, unknown>
  ) => Promise<{ stdout: string; stderr: string }>;
}

// ---------------------------------------------------------------------------
// git_restore
// ---------------------------------------------------------------------------

export interface RestoreOptions {
  repoPath?: string;
  /**
   * Paths to restore (discard unstaged changes). At least one required.
   */
  paths: string[];
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
  await deps.execAsync(`git -C ${qWorkdir} restore -- ${quotedPaths}`);

  return { workdir, restored: options.paths };
}
