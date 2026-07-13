import { MinskyError } from "../errors/index";
import { getErrorMessage } from "../errors/index";
import { log } from "@minsky/shared/logger";
import { NothingToCommitError } from "../errors/index";
import { safeShellQuote } from "@minsky/shared/exec";
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
  const qWorkdir = safeShellQuote(workdir);

  const { stdout: modifiedOutput } = await execAsync(`git -C ${qWorkdir} diff --name-only`);
  const modified = modifiedOutput.trim().split("\n").filter(Boolean);

  const { stdout: untrackedOutput } = await execAsync(
    `git -C ${qWorkdir} ls-files --others --exclude-standard`
  );
  const untracked = untrackedOutput.trim().split("\n").filter(Boolean);

  const { stdout: deletedOutput } = await execAsync(`git -C ${qWorkdir} ls-files --deleted`);
  const deleted = deletedOutput.trim().split("\n").filter(Boolean);

  return { modified, untracked, deleted };
}

/**
 * Stage all changes including deletions
 */
export async function stageAllImpl(execAsync: ExecAsyncFn, repoPath?: string): Promise<void> {
  const workdir = repoPath || process.cwd();
  await execAsync(`git -C ${safeShellQuote(workdir)} add -A`);
}

/**
 * Stage modified files
 */
export async function stageModifiedImpl(execAsync: ExecAsyncFn, repoPath?: string): Promise<void> {
  const workdir = repoPath || process.cwd();
  await execAsync(`git -C ${safeShellQuote(workdir)} add .`);
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
  await execAsync(`git -C ${safeShellQuote(workdir)} add -- ${quoted}`);
}

/**
 * Commit staged changes.
 *
 * `allowEmpty` (mt#2635) passes `--allow-empty` through to `git commit` so a
 * commit can be created on a clean tree (used by `sessionCommit`'s
 * `noFiles: true` webhook-wake path). Routing the empty-commit case through
 * THIS function — instead of a bespoke `execInRepository` call, as the code
 * did before mt#2635 — matters because this function's catch block re-throws
 * the ORIGINAL execAsync error unmodified, preserving `.stdout`/`.stderr` so
 * `classifyHookFailure` (workflow-commands.ts) can still detect and report a
 * hook failure. `execInRepositoryImpl` below discards that detail when it
 * wraps failures in a fresh `MinskyError`.
 */
export async function commitImpl(
  execAsync: ExecAsyncFn,
  message: string,
  repoPath?: string,
  amend: boolean = false,
  allowEmpty: boolean = false
): Promise<string> {
  const workdir = repoPath || process.cwd();
  const amendFlag = amend ? "--amend" : "";
  const allowEmptyFlag = allowEmpty ? "--allow-empty" : "";
  const flags = [amendFlag, allowEmptyFlag].filter(Boolean).join(" ");

  let stdout: string;
  let stderr: string;
  try {
    // mt#1742: commit messages can contain markdown backticks, $-prefixed
    // identifiers, and other shell metacharacters. `safeShellQuote` wraps
    // both the message AND the workdir in POSIX single quotes so /bin/sh -c
    // does not perform command substitution or variable expansion on either.
    // PR #1058 R1: extended workdir quoting per class-not-instance — same
    // shell-safety treatment for every interpolation in this template.
    ({ stdout, stderr } = await execAsync(
      `git -C ${safeShellQuote(workdir)} commit ${flags} -m ${safeShellQuote(message)}`
    ));
  } catch (err: unknown) {
    // --allow-empty makes "nothing to commit" impossible, so this check is a
    // no-op for that case and unchanged for the normal-commit case.
    if (classifyNothingToCommit(err)) {
      throw new NothingToCommitError();
    }
    throw err;
  }

  return extractCommitHash(stdout, stderr, async () => {
    const { stdout: logOutput } = await execAsync(
      `git -C ${safeShellQuote(workdir)} log -1 --pretty=format:%H`
    );
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
  const qWorkdir = safeShellQuote(workdir);
  try {
    const { stdout: status } = await execAsync(`git -C ${qWorkdir} status --porcelain`);
    if (!status.trim()) {
      return { workdir, stashed: false };
    }
    await execAsync(`git -C ${qWorkdir} stash push -m "minsky session update"`);
    return { workdir, stashed: true };
  } catch (err) {
    throw new Error(`Failed to stash changes: ${getErrorMessage(err)}`);
  }
}

/**
 * Pop stashed changes
 */
export async function popStashImpl(execAsync: ExecAsyncFn, workdir: string): Promise<StashResult> {
  const qWorkdir = safeShellQuote(workdir);
  try {
    const { stdout: stashList } = await execAsync(`git -C ${qWorkdir} stash list`);
    if (!stashList.trim()) {
      return { workdir, stashed: false };
    }
    await execAsync(`git -C ${qWorkdir} stash pop`);
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
  const qWorkdir = safeShellQuote(workdir);
  try {
    const { stdout: beforeHash } = await execAsync(`git -C ${qWorkdir} rev-parse HEAD`);
    // mt#1829: remote defaults to "origin" but is operator-overridable; quote it.
    await execAsync(`git -C ${qWorkdir} fetch ${safeShellQuote(remote)}`);
    const { stdout: afterHash } = await execAsync(`git -C ${qWorkdir} rev-parse HEAD`);
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
  const { stdout } = await execAsync(
    `git -C ${safeShellQuote(repoPath)} rev-parse --abbrev-ref HEAD`
  );
  return stdout.trim();
}

/**
 * Check if repository has uncommitted changes
 */
export async function hasUncommittedChangesImpl(
  execAsync: ExecAsyncFn,
  repoPath: string
): Promise<boolean> {
  const { stdout } = await execAsync(`git -C ${safeShellQuote(repoPath)} status --porcelain`);
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

    // mt#2635: preserve the ORIGINAL error (with its `.stdout`/`.stderr`, if
    // any) as `cause` rather than discarding it. MinskyError's constructor
    // already accepts a `cause`; this is purely additive (nothing previously
    // read `.cause` here) and gives any future execInRepository-based
    // consumer a way to recover full subprocess output for diagnostics
    // instead of only the one-line `cleanError` summary.
    throw new MinskyError(`Failed to execute command in repository: ${cleanError}`, error);
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
