/**
 * Workspace outcome classifier for subagent sessions.
 *
 * Inspects a subagent's session workspace (git status, handoff.md, GitHub PR)
 * and maps the observed state to one of the 6 outcome classes defined in the
 * mt#1005 spec:
 *
 *   - completed-with-pr
 *   - committed-no-pr
 *   - partial-committed-handoff-written
 *   - partial-uncommitted-no-handoff
 *   - crashed-no-output
 *   - rate-limited
 *
 * NOTE: `rate-limited` detection requires error-class signals not present in
 * the SubagentStop hook payload. It is deferred to a follow-up task (mt#1739).
 * The classifier currently returns `crashed-no-output` for workspaces with no
 * commits or transport errors.
 *
 * @see mt#1005 — Persist subagent execution history (parent epic)
 * @see mt#1737 — This file
 */

import { existsSync } from "fs";
import { join } from "path";
import type { SubagentInvocationOutcome } from "../storage/schemas/subagent-invocations-schema";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorkspaceClassification {
  /** One of the 6 outcome classes from the mt#1005 spec. */
  outcome: SubagentInvocationOutcome;
  /** URL of the open/recent PR for the task, if found. */
  prUrl?: string;
  /** SHA of the last commit in the workspace, if any. */
  lastCommitHash?: string;
  /** Whether a handoff.md file exists in the workspace. */
  handoffWritten: boolean;
}

// ---------------------------------------------------------------------------
// Sync exec helper (mirrors types.ts pattern)
// ---------------------------------------------------------------------------

function runGit(args: string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env["PATH"] ?? ""}` },
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function runGh(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env["PATH"] ?? ""}` },
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

// ---------------------------------------------------------------------------
// Core classifier
// ---------------------------------------------------------------------------

/**
 * Classify the outcome of a subagent workspace.
 *
 * Classification algorithm:
 *  1. Workspace missing → `crashed-no-output`
 *  2. No git repo in workspace → `crashed-no-output`
 *  3. No commits in workspace → `crashed-no-output`
 *  4. GitHub PR open/merged for `task/<id>` branch → `completed-with-pr`
 *  5. Clean workspace (no uncommitted changes) + commits → `committed-no-pr`
 *  6. Uncommitted residue + handoff.md exists → `partial-committed-handoff-written`
 *  7. Uncommitted residue + no handoff.md → `partial-uncommitted-no-handoff`
 *
 * @param workspace  Absolute path to the subagent's session workspace.
 * @param taskId     Minsky task ID (e.g., "mt#1735"). Used to construct
 *                   the branch name for the PR query.
 */
export async function classifyWorkspaceOutcome(
  workspace: string,
  taskId: string
): Promise<WorkspaceClassification> {
  // 1. Workspace exists?
  if (!existsSync(workspace)) {
    return { outcome: "crashed-no-output", handoffWritten: false };
  }

  // 2. Is it a git repo with commits?
  const gitStatusResult = runGit(["status", "--porcelain"], workspace);
  if (gitStatusResult.exitCode !== 0) {
    // Not a git repo or git error — treat as crashed
    return { outcome: "crashed-no-output", handoffWritten: false };
  }

  // 3. Get last commit hash (empty if no commits)
  const logResult = runGit(["log", "-1", "--format=%H"], workspace);
  const lastCommitHash =
    logResult.exitCode === 0 && logResult.stdout ? logResult.stdout : undefined;

  if (!lastCommitHash) {
    // No commits → crashed / never started real work
    return { outcome: "crashed-no-output", handoffWritten: false };
  }

  // 4. Check for handoff.md (two candidate paths)
  const handoffAtRoot = join(workspace, "handoff.md");
  const handoffAlt = join(workspace, ".minsky", "sessions", taskId, "handoff.md");
  const handoffWritten = existsSync(handoffAtRoot) || existsSync(handoffAlt);

  // 5. Detect uncommitted changes
  const hasUncommittedChanges = gitStatusResult.stdout.trim().length > 0;

  // 6. Query GitHub for an open or recently merged PR on the task branch
  const { prUrl } = await queryGitHubPr(taskId);

  // 7. Classify
  if (prUrl) {
    return { outcome: "completed-with-pr", prUrl, lastCommitHash, handoffWritten };
  }

  if (!hasUncommittedChanges) {
    // Clean workspace, commits present, no PR
    return { outcome: "committed-no-pr", lastCommitHash, handoffWritten };
  }

  // Uncommitted changes present
  if (handoffWritten) {
    return {
      outcome: "partial-committed-handoff-written",
      lastCommitHash,
      handoffWritten: true,
    };
  }

  return { outcome: "partial-uncommitted-no-handoff", lastCommitHash, handoffWritten: false };
}

// ---------------------------------------------------------------------------
// GitHub PR query
// ---------------------------------------------------------------------------

/**
 * Query GitHub for an open or recently-closed PR on the task branch.
 *
 * Uses `gh pr list --head task/<id> --state all --limit 1 --json url`.
 * Fails open: returns `{}` on any gh error so classification continues.
 *
 * Branch naming convention: `task/mt-<digits>` (matching how Minsky creates
 * session branches) is checked first; plain `task/<taskId>` is the fallback.
 */
async function queryGitHubPr(taskId: string): Promise<{ prUrl?: string }> {
  // Normalise task ID to the branch convention (mt#1735 → task/mt-1735)
  const branchName = taskId.replace(/^mt#/, "task/mt-").replace(/^#/, "task/mt-");

  try {
    const result = runGh([
      "pr",
      "list",
      "--head",
      branchName,
      "--state",
      "all",
      "--limit",
      "1",
      "--json",
      "url",
    ]);

    if (result.exitCode !== 0 || !result.stdout) {
      return {};
    }

    // Parse JSON output: [{url: "..."}] or []
    const parsed = JSON.parse(result.stdout) as Array<{ url?: string }>;
    const firstPr = parsed[0];
    if (firstPr?.url) {
      return { prUrl: firstPr.url };
    }
    return {};
  } catch {
    // Fail open — gh not available, network error, parse error
    return {};
  }
}
