import { validateGitError } from "../../schemas/error";
import { validateProcess } from "../../schemas/runtime";

/**
 * Options for push operations.
 * Session resolution must be done before calling pushImpl — pass resolved repoPath.
 */
export interface PushOptions {
  repoPath?: string;
  remote?: string;
  force?: boolean;
  debug?: boolean;
}

/**
 * Result of push operations
 */
export interface PushResult {
  workdir: string;
  pushed: boolean;
}

/**
 * Dependencies for push operations
 */
export interface PushDependencies {
  execAsync: (
    command: string,
    options?: Record<string, unknown>
  ) => Promise<{ stdout: string; stderr: string }>;
}

// POSIX shell single-quote escape: wrap in '...', and replace each ' with '\''.
// Required because deps.execAsync takes a single shell-string (not argv); paths
// or remote/branch names with spaces or shell metacharacters must be quoted to
// reach git correctly.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Push the current branch to a remote, supporting --repo, --remote, and --force.
 * Session resolution must happen at the adapter boundary before calling this.
 *
 * Error policy: errors from execAsync propagate raw across all phases
 * (rev-parse, remote-list, push), preserving original type, stack, and
 * structured fields. Two intentional UX overrides apply in the push catch:
 * stderr containing "[rejected]" or "no upstream" is rewritten into an
 * actionable user-facing message. All other push failures re-throw the
 * original error unchanged.
 */
export async function pushImpl(options: PushOptions, deps: PushDependencies): Promise<PushResult> {
  const remote = options.remote || "origin";
  const workdir = options.repoPath ?? validateProcess(process).cwd();
  const qWorkdir = shellQuote(workdir);
  const qRemote = shellQuote(remote);

  // Resolve current branch via rev-parse --abbrev-ref HEAD. The literal
  // string "HEAD" is git's machine-readable signal for detached HEAD —
  // locale-independent across git versions. Surface an actionable error
  // for that case (with current commit SHA when available, for context).
  // Unrelated rev-parse failures (not a git repo, missing git binary,
  // permission errors) propagate as the original error from execAsync —
  // preserving type, stack, and structured fields. See mt#994; mt#1217
  // fixed the upstream session_update path that was leaving sessions
  // detached.
  const { stdout } = await deps.execAsync(`git -C ${qWorkdir} rev-parse --abbrev-ref HEAD`);
  const branch = stdout.trim();
  if (branch === "HEAD") {
    let sha = "";
    try {
      const { stdout: shaOut } = await deps.execAsync(`git -C ${qWorkdir} rev-parse --short HEAD`);
      sha = shaOut.trim();
    } catch {
      // Best-effort; if SHA lookup fails, fall back to the message without it.
    }
    const shaSuffix = sha ? ` (currently at ${sha})` : "";
    throw new Error(
      `Cannot push: HEAD is detached in ${workdir}${shaSuffix}. ` +
        `Check out a branch first (e.g. 'git switch <branch>' or 'git checkout -b <new-branch>').`
    );
  }
  if (!branch) {
    throw new Error(`Cannot push: rev-parse returned an empty branch name for ${workdir}.`);
  }
  const qBranch = shellQuote(branch);

  // 2. Validate remote exists
  const { stdout: remotesOut } = await deps.execAsync(`git -C ${qWorkdir} remote`);
  const remotes = remotesOut
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  if (!remotes.includes(remote)) {
    throw new Error(`Remote '${remote}' does not exist in repository at ${workdir}`);
  }

  // 3. Build push command
  let pushCmd = `git -C ${qWorkdir} push ${qRemote} ${qBranch}`;
  if (options.force) {
    pushCmd += " --force";
  }

  // 4. Execute push
  try {
    await deps.execAsync(pushCmd);
    return { workdir, pushed: true };
  } catch (err: unknown) {
    // Two intentional UX rewrites — see policy in JSDoc above.
    const gitError = validateGitError(err);
    if (gitError.stderr && gitError.stderr.includes("[rejected]")) {
      throw new Error(
        "Push was rejected by the remote. You may need to pull or use --force if you intend to overwrite remote history."
      );
    }
    if (gitError.stderr && gitError.stderr.includes("no upstream")) {
      throw new Error(
        "No upstream branch is set for this branch. Set the upstream with 'git push --set-upstream' or push manually first."
      );
    }
    throw err;
  }
}
