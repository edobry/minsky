import { normalizeRepoName } from "../repo-utils";
import { getErrorMessage } from "../../errors/index";

/**
 * Options for push operations
 */
export interface PushOptions {
  session?: string;
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
  execAsync: (command: string, options?: any) => Promise<{ stdout: string; stderr: string }>;
  getSession: (sessionName: string) => Promise<any>;
  getSessionWorkdir: (sessionName: string) => string;
}

/**
 * Push the current or session branch to a remote, supporting --session, --repo, --remote, and --force.
 */
export async function pushImpl(options: PushOptions, deps: PushDependencies): Promise<PushResult> {
  let workdir: string;
  let branch: string;
  const remote = options.remote || "origin";

  // 1. Resolve workdir
  if (options.session) {
    const record = await deps.getSession(options.session);
    if (!record) {
      throw new Error(`Session '${options.session}' not found.`);
    }
    const repoName = record.repoName || normalizeRepoName(record.repoUrl);
    workdir = deps.getSessionWorkdir(options.session);
    branch = options.session; // Session branch is named after the session
  } else if (options.repoPath) {
    workdir = options.repoPath;
    // Get current branch from repo
    const { stdout: branchOut } = await deps.execAsync(
      `git -C ${workdir} rev-parse --abbrev-ref HEAD`
    );
    branch = branchOut.trim();
  } else {
    // Try to infer from current directory
    workdir = (process as any).cwd();
    // Get current branch from cwd
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
  } catch (err: any) {
    // Provide helpful error messages for common issues
    if ((err as any).stderr && (err.stderr as any).includes("[rejected]")) {
      throw new Error(
        "Push was rejected by the remote. You may need to pull or use --force if you intend to overwrite remote history."
      );
    }
    if ((err as any).stderr && (err.stderr as any).includes("no upstream")) {
      throw new Error(
        "No upstream branch is set for this branch. Set the upstream with 'git push --set-upstream' or push manually first."
      );
    }
    throw new Error((err as any).stderr || (err as any).message || String(err as any));
  }
}
