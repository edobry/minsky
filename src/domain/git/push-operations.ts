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
  let workdir: string;
  let branch: string;
  const remote = options.remote || "origin";

  // Resolve workdir
  if (options.repoPath) {
    workdir = options.repoPath;
    const { stdout: branchOut } = await deps.execAsync(
      `git -C ${workdir} rev-parse --abbrev-ref HEAD`
    );
    branch = branchOut.trim();
  } else {
    workdir = validateProcess(process).cwd();
    const { stdout: branchOut } = await deps.execAsync(
      `git -C ${workdir} rev-parse --abbrev-ref HEAD`
    );
    branch = branchOut.trim();
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
