import { validateProcess } from "../schemas/runtime";

/**
 * Options for pull operations.
 * Session resolution must be done before calling pullImpl — pass resolved repoPath.
 */
export interface PullOptions {
  repoPath?: string;
  remote?: string;
  branch?: string;
}

/**
 * Result of pull operations
 */
export interface PullImplResult {
  workdir: string;
  alreadyUpToDate: boolean;
  /**
   * Files that blocked the fast-forward merge (populated when error is
   * "Your local changes ... would be overwritten by merge").
   */
  conflictingFiles?: string[];
}

/**
 * Dependencies for pull operations
 */
export interface PullDependencies {
  execAsync: (
    command: string,
    options?: Record<string, unknown>
  ) => Promise<{ stdout: string; stderr: string }>;
}

// POSIX shell single-quote escape: wrap in '...', and replace each ' with '\''.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Parse conflicting file paths from `git pull --ff-only` stderr.
 *
 * Example stderr block:
 *   error: Your local changes to the following files would be overwritten by merge:
 *           skills-lock.json
 *   Please commit your changes or stash them before you merge.
 */
function parseConflictingFiles(stderr: string): string[] {
  const marker = "Your local changes to the following files would be overwritten by merge:";
  const idx = stderr.indexOf(marker);
  if (idx === -1) return [];

  const after = stderr.slice(idx + marker.length);
  // Lines are indented with tabs or spaces up to "Please" line.
  // The first character after the marker may be a newline — skip empty lines.
  const files: string[] = [];
  for (const line of after.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue; // skip blank/empty lines between marker and first file
    if (trimmed.startsWith("Please") || trimmed.startsWith("Aborting")) break;
    files.push(trimmed);
  }
  return files;
}

/**
 * Pull the latest changes from a remote using --ff-only.
 * Refuses non-fast-forward merges. When local changes block the pull,
 * returns a structured error naming the conflicting file paths.
 *
 * TOCTOU accept-rationale: git pull --ff-only is FF-conflict-preserving.
 * If the remote advances between the implicit fetch and the merge step,
 * the operation fails atomically with a non-zero exit — no silent
 * corruption. The caller retries against the newly fetched state.
 * (Documented per feedback_toctou_enumeration_required.md.)
 */
export async function pullImpl(
  options: PullOptions,
  deps: PullDependencies
): Promise<PullImplResult> {
  const remote = options.remote || "origin";
  const branch = options.branch || "main";
  const workdir = options.repoPath ?? validateProcess(process).cwd();
  const qWorkdir = shellQuote(workdir);
  const qRemote = shellQuote(remote);
  const qBranch = shellQuote(branch);

  try {
    const { stdout } = await deps.execAsync(
      `git -C ${qWorkdir} pull --ff-only ${qRemote} ${qBranch}`
    );
    const alreadyUpToDate =
      stdout.includes("Already up to date") || stdout.includes("Already up-to-date");
    return { workdir, alreadyUpToDate };
  } catch (err: unknown) {
    // Extract stderr safely using direct property access rather than validateGitError,
    // because the exec error's `signal: null` fails gitErrorSchema (z.string().optional()
    // does not accept null), causing the schema fallback to strip stderr entirely.
    const stderr =
      err !== null && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr ?? "")
        : "";

    // Conflict: local changes would be overwritten by merge
    if (stderr.includes("Your local changes to the following files would be overwritten")) {
      const conflictingFiles = parseConflictingFiles(stderr);
      const fileList =
        conflictingFiles.length > 0
          ? conflictingFiles.map((f) => `  - ${f}`).join("\n")
          : "  (unable to parse file list from git output)";
      throw Object.assign(
        new Error(
          `Pull blocked: local changes to the following files would be overwritten by the fast-forward merge:\n${fileList}\n\n` +
            `Use \`mcp__minsky__git_stash\` to stash these changes, then retry the pull, then \`mcp__minsky__git_stash_pop\` to restore.`
        ),
        { conflictingFiles }
      );
    }

    // Non-fast-forward rejection. Match only canonical non-FF markers — do NOT
    // match "CONFLICT" alone, which could appear in other states unrelated to
    // non-FF rejection (`--ff-only` aborts before merge, so genuine conflicts
    // shouldn't surface here, but matching `CONFLICT` would also catch weird
    // intermediate states we'd rather propagate raw).
    if (stderr.includes("Not possible to fast-forward") || stderr.includes("non-fast-forward")) {
      throw new Error(
        `Pull rejected: cannot fast-forward. The remote has diverged from the local branch. ` +
          `Use \`mcp__minsky__git_status\` to inspect the state, then decide whether to rebase or merge manually.`
      );
    }

    throw err;
  }
}
