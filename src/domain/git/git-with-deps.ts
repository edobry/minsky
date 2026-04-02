import { NothingToCommitError } from "../../errors/index";
import { getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import type {
  BasicGitDependencies,
  PrDependencies,
  BranchOptions,
  BranchResult,
  StashResult,
  PullResult,
  MergeResult,
} from "./types";

/**
 * Returns true when a caught git exec error represents "nothing to commit".
 */
export function classifyNothingToCommit(err: unknown): boolean {
  const e = err !== null && typeof err === "object" ? (err as Record<string, unknown>) : null;
  const msg = (
    (typeof e?.stderr === "string" ? e.stderr : null) ||
    (typeof e?.stdout === "string" ? e.stdout : null) ||
    (typeof e?.message === "string" ? e.message : null) ||
    ""
  ).toString();
  return msg.includes("nothing to commit") || msg.includes("nothing added to commit");
}

/**
 * Extracts the commit hash from git commit output (stdout + stderr).
 * Falls back to `git log -1` via the provided async resolver when the hash
 * cannot be parsed from the raw output (e.g. when hooks redirect git's output).
 */
export async function extractCommitHash(
  stdout: string,
  stderr: string,
  logFallback: () => Promise<string>
): Promise<string> {
  const combinedOutput = `${stdout}\n${stderr || ""}`;
  const match = combinedOutput.match(/\[.*\s+([a-f0-9]+)\]/);
  if (match?.[1]) {
    return match[1];
  }

  try {
    const logOutput = await logFallback();
    const hash = logOutput.trim();
    if (hash && /^[a-f0-9]{7,40}$/.test(hash)) {
      return hash;
    }
  } catch (_logErr) {
    // ignore log fallback error
  }

  throw new Error("Failed to extract commit hash from git output");
}

/**
 * Testable commit with dependency injection
 */
export async function commitWithDepsImpl(
  message: string,
  workdir: string,
  deps: BasicGitDependencies,
  amend: boolean = false
): Promise<string> {
  const amendFlag = amend ? "--amend" : "";

  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await deps.execAsync(
      `git -C ${workdir} commit ${amendFlag} -m "${message}"`
    ));
  } catch (err: unknown) {
    if (classifyNothingToCommit(err)) {
      throw new NothingToCommitError();
    }
    throw err;
  }

  return extractCommitHash(stdout, stderr, async () => {
    const { stdout: logOutput } = await deps.execAsync(
      `git -C ${workdir} log -1 --pretty=format:%H`
    );
    return logOutput;
  });
}

/**
 * Testable stashChanges with dependency injection
 */
export async function stashChangesWithDepsImpl(
  workdir: string,
  deps: BasicGitDependencies
): Promise<StashResult> {
  try {
    const { stdout: status } = await deps.execAsync(`git -C ${workdir} status --porcelain`);
    if (!status.trim()) {
      return { workdir, stashed: false };
    }
    await deps.execAsync(`git -C ${workdir} stash push -m "minsky session update"`);
    return { workdir, stashed: true };
  } catch (err) {
    throw new Error(`Failed to stash changes: ${getErrorMessage(err)}`);
  }
}

/**
 * Testable popStash with dependency injection
 */
export async function popStashWithDepsImpl(
  workdir: string,
  deps: BasicGitDependencies
): Promise<StashResult> {
  try {
    const { stdout: stashList } = await deps.execAsync(`git -C ${workdir} stash list`);
    if (!stashList.trim()) {
      return { workdir, stashed: false };
    }
    await deps.execAsync(`git -C ${workdir} stash pop`);
    return { workdir, stashed: true };
  } catch (err) {
    throw new Error(`Failed to pop stash: ${getErrorMessage(err)}`);
  }
}

/**
 * Testable mergeBranch with dependency injection
 */
export async function mergeBranchWithDepsImpl(
  workdir: string,
  branch: string,
  deps: BasicGitDependencies
): Promise<MergeResult> {
  try {
    const { stdout: beforeHash } = await deps.execAsync(`git -C ${workdir} rev-parse HEAD`);

    try {
      await deps.execAsync(`git -C ${workdir} merge ${branch}`);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("Merge Conflicts Detected") || err.message.includes("CONFLICT"))
      ) {
        return { workdir, merged: false, conflicts: true };
      }

      const { stdout: status } = await deps.execAsync(`git -C ${workdir} status --porcelain`);
      if (status.includes("UU") || status.includes("AA") || status.includes("DD")) {
        await deps.execAsync(`git -C ${workdir} merge --abort`);
        return { workdir, merged: false, conflicts: true };
      }
      throw err;
    }

    const { stdout: afterHash } = await deps.execAsync(`git -C ${workdir} rev-parse HEAD`);

    return {
      workdir,
      merged: beforeHash.trim() !== afterHash.trim(),
      conflicts: false,
    };
  } catch (err) {
    throw new Error(`Failed to merge branch ${branch}: ${getErrorMessage(err)}`);
  }
}

/**
 * Testable stageAll with dependency injection
 */
export async function stageAllWithDepsImpl(
  workdir: string,
  deps: BasicGitDependencies
): Promise<void> {
  await deps.execAsync(`git -C ${workdir} add -A`);
}

/**
 * Testable stageModified with dependency injection
 */
export async function stageModifiedWithDepsImpl(
  workdir: string,
  deps: BasicGitDependencies
): Promise<void> {
  await deps.execAsync(`git -C ${workdir} add .`);
}

/**
 * Testable pullLatest with dependency injection
 */
export async function pullLatestWithDepsImpl(
  workdir: string,
  deps: BasicGitDependencies,
  remote: string = "origin"
): Promise<PullResult> {
  try {
    const { stdout: beforeHash } = await deps.execAsync(`git -C ${workdir} rev-parse HEAD`);
    await deps.execAsync(`git -C ${workdir} fetch ${remote}`);
    const { stdout: afterHash } = await deps.execAsync(`git -C ${workdir} rev-parse HEAD`);
    return { workdir, updated: beforeHash.trim() !== afterHash.trim() };
  } catch (err) {
    throw new Error(`Failed to pull latest changes: ${getErrorMessage(err)}`);
  }
}

/**
 * Testable branch with dependency injection
 */
export async function branchWithDepsImpl(
  options: BranchOptions,
  deps: PrDependencies
): Promise<BranchResult> {
  const record = await deps.getSession(options.session);
  if (!record) {
    throw new Error(`Session '${options.session}' not found.`);
  }

  const workdir = deps.getSessionWorkdir(options.session);

  await deps.execAsync(`git -C ${workdir} checkout -b ${options.branch}`);
  return {
    workdir,
    branch: options.branch,
  };
}

/**
 * Testable fetchDefaultBranch with dependency injection
 */
export async function fetchDefaultBranchWithDepsImpl(
  repoPath: string,
  deps: BasicGitDependencies
): Promise<string> {
  try {
    const { stdout } = await deps.execAsync(
      `git -C ${repoPath} symbolic-ref refs/remotes/origin/HEAD --short`
    );
    const result = stdout.trim().replace(/^origin\//, "");
    return result;
  } catch (error) {
    log.error("Could not determine default branch, falling back to 'main'", {
      error: getErrorMessage(error),
      repoPath,
    });
    return "main";
  }
}
