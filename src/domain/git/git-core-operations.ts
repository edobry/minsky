import { MinskyError } from "../../errors/index";
import { getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import { NothingToCommitError } from "../../errors/index";
import { classifyNothingToCommit, extractCommitHash } from "./git-with-deps";
import type { GitStatus, StashResult, PullResult } from "./types";

type ExecAsyncFn = (
  command: string,
  options?: Record<string, unknown>
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Get the status of a repository (modified, untracked, deleted files)
 */
export async function getStatusImpl(execAsync: ExecAsyncFn, repoPath?: string): Promise<GitStatus> {
  const workdir = repoPath || process.cwd();

  const { stdout: modifiedOutput } = await execAsync(`git -C ${workdir} diff --name-only`);
  const modified = modifiedOutput.trim().split("\n").filter(Boolean);

  const { stdout: untrackedOutput } = await execAsync(
    `git -C ${workdir} ls-files --others --exclude-standard`
  );
  const untracked = untrackedOutput.trim().split("\n").filter(Boolean);

  const { stdout: deletedOutput } = await execAsync(`git -C ${workdir} ls-files --deleted`);
  const deleted = deletedOutput.trim().split("\n").filter(Boolean);

  return { modified, untracked, deleted };
}

/**
 * Stage all changes including deletions
 */
export async function stageAllImpl(execAsync: ExecAsyncFn, repoPath?: string): Promise<void> {
  const workdir = repoPath || process.cwd();
  await execAsync(`git -C ${workdir} add -A`);
}

/**
 * Stage modified files
 */
export async function stageModifiedImpl(execAsync: ExecAsyncFn, repoPath?: string): Promise<void> {
  const workdir = repoPath || process.cwd();
  await execAsync(`git -C ${workdir} add .`);
}

/**
 * Stage a specific set of files. Paths are POSIX shell-quoted and passed after
 * `--` so entries starting with a dash are not interpreted as options.
 */
export async function stageFilesImpl(
  execAsync: ExecAsyncFn,
  files: string[],
  repoPath?: string
): Promise<void> {
  if (files.length === 0) return;
  const workdir = repoPath || process.cwd();
  const quoted = files.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(" ");
  await execAsync(`git -C ${workdir} add -- ${quoted}`);
}

/**
 * Commit staged changes
 */
export async function commitImpl(
  execAsync: ExecAsyncFn,
  message: string,
  repoPath?: string,
  amend: boolean = false
): Promise<string> {
  const workdir = repoPath || process.cwd();
  const amendFlag = amend ? "--amend" : "";

  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execAsync(`git -C ${workdir} commit ${amendFlag} -m "${message}"`));
  } catch (err: unknown) {
    if (classifyNothingToCommit(err)) {
      throw new NothingToCommitError();
    }
    throw err;
  }

  return extractCommitHash(stdout, stderr, async () => {
    const { stdout: logOutput } = await execAsync(`git -C ${workdir} log -1 --pretty=format:%H`);
    return logOutput;
  });
}

/**
 * Stash changes in a repository
 */
export async function stashChangesImpl(
  execAsync: ExecAsyncFn,
  workdir: string
): Promise<StashResult> {
  try {
    const { stdout: status } = await execAsync(`git -C ${workdir} status --porcelain`);
    if (!status.trim()) {
      return { workdir, stashed: false };
    }
    await execAsync(`git -C ${workdir} stash push -m "minsky session update"`);
    return { workdir, stashed: true };
  } catch (err) {
    throw new Error(`Failed to stash changes: ${getErrorMessage(err)}`);
  }
}

/**
 * Pop stashed changes
 */
export async function popStashImpl(execAsync: ExecAsyncFn, workdir: string): Promise<StashResult> {
  try {
    const { stdout: stashList } = await execAsync(`git -C ${workdir} stash list`);
    if (!stashList.trim()) {
      return { workdir, stashed: false };
    }
    await execAsync(`git -C ${workdir} stash pop`);
    return { workdir, stashed: true };
  } catch (err) {
    throw new Error(`Failed to pop stash: ${getErrorMessage(err)}`);
  }
}

/**
 * Fetch latest changes from a remote
 */
export async function fetchLatestImpl(
  execAsync: ExecAsyncFn,
  workdir: string,
  remote: string = "origin"
): Promise<PullResult> {
  try {
    const { stdout: beforeHash } = await execAsync(`git -C ${workdir} rev-parse HEAD`);
    await execAsync(`git -C ${workdir} fetch ${remote}`);
    const { stdout: afterHash } = await execAsync(`git -C ${workdir} rev-parse HEAD`);
    return { workdir, updated: beforeHash.trim() !== afterHash.trim() };
  } catch (err) {
    throw new Error(`Failed to fetch latest changes: ${getErrorMessage(err)}`);
  }
}

/**
 * Get the current branch name
 */
export async function getCurrentBranchImpl(
  execAsync: ExecAsyncFn,
  repoPath: string
): Promise<string> {
  const { stdout } = await execAsync(`git -C ${repoPath} rev-parse --abbrev-ref HEAD`);
  return stdout.trim();
}

/**
 * Check if repository has uncommitted changes
 */
export async function hasUncommittedChangesImpl(
  execAsync: ExecAsyncFn,
  repoPath: string
): Promise<boolean> {
  const { stdout } = await execAsync(`git -C ${repoPath} status --porcelain`);
  return stdout.trim().length > 0;
}

/**
 * Fetch the default branch for a repository
 */
export async function fetchDefaultBranchImpl(
  execInRepository: (workdir: string, command: string) => Promise<string>,
  repoPath: string
): Promise<string> {
  try {
    const defaultBranchCmd = "git symbolic-ref refs/remotes/origin/HEAD --short";
    const defaultBranch = await execInRepository(repoPath, defaultBranchCmd);
    const result = defaultBranch.trim().replace(/^origin\//, "");
    return result;
  } catch (error) {
    log.error("Could not determine default branch, falling back to 'main'", {
      error: getErrorMessage(error),
      repoPath,
    });
    return "main";
  }
}

/**
 * Execute a command in a repository directory
 */
export async function execInRepositoryImpl(
  execAsync: ExecAsyncFn,
  workdir: string,
  command: string
): Promise<string> {
  try {
    const { stdout } = await execAsync(command, { cwd: workdir });
    return stdout;
  } catch (error) {
    log.debug("Command execution failed", {
      error: getErrorMessage(error),
      command,
      workdir,
    });

    const fullError = getErrorMessage(error);
    const cleanError = extractCleanGitError(fullError, command);

    throw new MinskyError(`Failed to execute command in repository: ${cleanError}`);
  }
}

/**
 * Extract a clean, concise error message from git command failures.
 * Filters out verbose linting/hook output.
 */
export function extractCleanGitError(fullError: string, command: string): string {
  const gitErrorPatterns = [/fatal: (.+)/i, /error: (.+)/i, /Command failed: (.+?)(?:\n|$)/i];

  for (const pattern of gitErrorPatterns) {
    const match = fullError.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  if (fullError.includes("Command failed:")) {
    const commandMatch = fullError.match(/Command failed: (.+?)(?:\s|$)/);
    if (commandMatch) {
      return commandMatch[1] || "";
    }
  }

  const lines = fullError.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed &&
      !trimmed.includes("husky") &&
      !trimmed.includes("eslint") &&
      !trimmed.includes("prettier") &&
      !trimmed.includes("gitleaks") &&
      !trimmed.includes("🔍") &&
      !trimmed.includes("✅") &&
      !trimmed.includes("❌")
    ) {
      return trimmed;
    }
  }

  return `Command "${command}" failed`;
}

/**
 * Convert a PR title to a branch name
 * e.g. "feat: add new feature" -> "feat-add-new-feature"
 */
export function titleToBranchName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s:/#]+/g, "-")
    .replace(/[^\w-]/g, "")
    .replace(/--+/g, "-")
    .replace(/^-|-$/g, "");
}
