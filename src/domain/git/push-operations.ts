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

/**
 * Push the current branch to a remote, supporting --repo, --remote, and --force.
 * Session resolution must happen at the adapter boundary before calling this.
 */
export async function pushImpl(options: PushOptions, deps: PushDependencies): Promise<PushResult> {
  const remote = options.remote || "origin";
  const workdir = options.repoPath ?? validateProcess(process).cwd();

  // Resolve current branch via symbolic-ref. A non-zero exit means HEAD is
  // detached — pushing a detached HEAD produces git's cryptic "destination
  // is not a full refname" error. Surface an actionable message instead.
  // See mt#994; mt#1217 fixed the upstream session_update path that was
  // leaving sessions detached. (Unborn HEAD is out of scope: symbolic-ref
  // succeeds in that case and returns the would-be branch name, so the
  // remote-validation / push step will surface its own error.)
  let branch: string;
  try {
    const { stdout } = await deps.execAsync(`git -C ${workdir} symbolic-ref -q --short HEAD`);
    branch = stdout.trim();
  } catch {
    throw new Error(
      `Cannot push: HEAD is detached in ${workdir}. ` +
        `Check out a branch first (e.g. 'git switch <branch>' or 'git checkout -b <new-branch>').`
    );
  }

  // 2. Validate remote exists
  const { stdout: remotesOut } = await deps.execAsync(`git -C ${workdir} remote`);
  const remotes = remotesOut
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  if (!remotes.includes(remote)) {
    throw new Error(`Remote '${remote}' does not exist in repository at ${workdir}`);
  }

  // 3. Build push command
  let pushCmd = `git -C ${workdir} push ${remote} ${branch}`;
  if (options.force) {
    pushCmd += " --force";
  }

  // 4. Execute push
  try {
    await deps.execAsync(pushCmd);
    return { workdir, pushed: true };
  } catch (err: unknown) {
    // Provide helpful error messages for common issues
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
    throw new Error(gitError.stderr || gitError.message || String(err));
  }
}
