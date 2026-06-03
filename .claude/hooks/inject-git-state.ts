#!/usr/bin/env bun
// UserPromptSubmit hook: inject the current git state (branch, working-tree
// status, recent commits, ahead/behind main) into every turn's context
// (mt#2275). Generalizes the structural-injection pattern from mt#2181
// (current time) to git state — another session-start anchor that the
// Claude Code system reminder captures once and never refreshes.
//
// Why this exists. Claude Code's session-start system reminder includes a
// `gitStatus` block (current branch, main branch, status, recent commits).
// These values are captured at session start and never re-injected. Long
// sessions accumulate divergence: branch switches, new merges to main, file
// edits — none of which update the anchor. The agent then asserts stale
// state ("we're on main", "the most recent commit was X") without any
// failure signal until a user catches it.
//
// Per memory `08606f7c` (Structural injection beats retrieval discipline):
// the trigger condition for "fetch git state now" lives inside the agent's
// reasoning, where recognition cost equals the cost of the action being
// fixed. Memory-tier discipline fails. Hook-tier injection makes the value
// PRESENT in every turn whether the agent looks for it or not.
//
// Override: MINSKY_SKIP_GIT_STATE_INJECTION=1|true|yes skips injection with
// an audit-log line to stdout.
//
// @see mt#2275 — this hook
// @see mt#2181 — `inject-current-time.ts` (architectural template)
// @see memory 08606f7c — synthesis-level rule this hook instantiates

import { deriveBudgets, execWithPath, readHostCap, readInput, writeOutput } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";

export const GIT_STATE_INJECTION_OVERRIDE_ENV = "MINSKY_SKIP_GIT_STATE_INJECTION";

/**
 * Per-git-command timeout. Derived from the host-imposed cap in settings.json
 * via `readHostCap`/`deriveBudgets` to match the budget-derivation convention
 * sibling hooks follow (see hook-files.mdc §Branch Freshness Guard). The read
 * is deferred from module-load to entrypoint time so importing the module
 * (e.g., from tests) has no fs/env side effects.
 *
 * Architectural note: this hook intentionally does NOT run `git fetch` —
 * it fires on every UserPromptSubmit (potentially hundreds of times per
 * session), and per-turn network calls would regress the <50ms budget by
 * orders of magnitude. Sibling hooks like `check-branch-fresh.ts` fetch
 * because they run once per merge attempt, not per turn. The output
 * acknowledges this by labelling ahead/behind as "vs last-fetched origin"
 * so the agent doesn't over-interpret the staleness.
 */
function computeGitTimeoutMs(): number {
  const hostCapSec = readHostCap("inject-git-state.ts");
  return deriveBudgets(hostCapSec).gitTimeoutMs;
}

export interface UserPromptSubmitInput extends ClaudeHookInput {
  prompt: string;
}

export interface GitStateSnapshot {
  branch: string;
  // Counts vs the default branch (main / master). `null` when the comparison
  // can't be computed (default branch unknown, fresh branch, etc.).
  aheadMain: number | null;
  behindMain: number | null;
  // Working-tree counts derived from `git status --porcelain`. Three buckets:
  //   modified  — files with index OR worktree modifications (M/D/R/C in either column)
  //   untracked — files with `??` status
  //   staged    — files with index modifications (first column non-space, non-?)
  modified: number;
  untracked: number;
  staged: number;
  recentCommits: string[]; // oneline format: "<sha7> <subject>"
  defaultBranch: string | null; // "main" / "master" / null when undetectable
}

/**
 * Format a snapshot into the additionalContext payload.
 *
 * Two shapes:
 *   - Collapsed (single line): when working tree is clean AND not ahead/behind main.
 *     Example: "Current git state: on main, clean, in sync with main."
 *   - Expanded (multi-line): otherwise.
 *
 * Pure function for testability; the entrypoint feeds it a snapshot built from
 * live `git` calls.
 */
export function formatGitState(snap: GitStateSnapshot): string {
  const wtClean = snap.modified === 0 && snap.untracked === 0 && snap.staged === 0;
  const inSyncWithMain = snap.aheadMain === 0 && snap.behindMain === 0;

  if (wtClean && inSyncWithMain && snap.defaultBranch !== null) {
    return `Current git state: on ${snap.branch}, clean, in sync with last-fetched origin/${snap.defaultBranch}.`;
  }

  const lines: string[] = ["Current git state:"];

  // Branch line, with optional ahead/behind (labelled "last-fetched" because
  // this hook does NOT run `git fetch` per turn — see computeGitTimeoutMs).
  if (snap.aheadMain !== null && snap.behindMain !== null && snap.defaultBranch !== null) {
    lines.push(
      `- Branch: ${snap.branch} (vs last-fetched origin/${snap.defaultBranch}: ${snap.aheadMain} ahead, ${snap.behindMain} behind)`
    );
  } else if (snap.defaultBranch !== null) {
    // Default branch detected but ahead/behind couldn't be computed (e.g.,
    // origin/<default> not fetched locally yet)
    lines.push(
      `- Branch: ${snap.branch} (origin/${snap.defaultBranch} not available locally — ahead/behind unknown)`
    );
  } else {
    // Default branch couldn't be detected — surface that explicitly so the agent
    // doesn't silently assume in-sync from a missing comparison
    lines.push(`- Branch: ${snap.branch} (default branch undetectable — ahead/behind omitted)`);
  }

  // Working tree
  if (wtClean) {
    lines.push(`- Working tree: clean`);
  } else {
    const parts: string[] = [];
    if (snap.modified > 0) parts.push(`${snap.modified} modified`);
    if (snap.untracked > 0) parts.push(`${snap.untracked} untracked`);
    if (snap.staged > 0) parts.push(`${snap.staged} staged`);
    lines.push(`- Working tree: ${parts.join(", ")}`);
  }

  // Recent commits
  if (snap.recentCommits.length > 0) {
    lines.push(`- Recent commits on branch:`);
    for (const commit of snap.recentCommits) {
      lines.push(`  ${commit}`);
    }
  }

  return lines.join("\n");
}

/**
 * Parse `git status --porcelain=v1` output into modified/untracked/staged counts.
 * The porcelain format gives two-character status codes per file:
 *   - First column: index status (staged)
 *   - Second column: worktree status (unstaged modifications)
 *   - "??" means untracked
 *
 * Pure function for testability.
 */
export function parsePorcelainStatus(stdout: string): {
  modified: number;
  untracked: number;
  staged: number;
} {
  let modified = 0;
  let untracked = 0;
  let staged = 0;
  for (const line of stdout.split("\n")) {
    if (line.length < 2) continue;
    const idx = line[0];
    const wt = line[1];
    if (idx === "?" && wt === "?") {
      untracked++;
      continue;
    }
    // Index column non-space, non-? → staged
    if (idx !== " " && idx !== "?") staged++;
    // Worktree column non-space, non-? → modified (unstaged)
    if (wt !== " " && wt !== "?") modified++;
  }
  return { modified, untracked, staged };
}

/**
 * Detect the default branch. Tries three paths in order:
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` — canonical when origin/HEAD is set
 *   2. `git config remote.origin.head` — works for non-main/master defaults
 *      (e.g., `develop`) and for repos where path 1 failed
 *   3. Probe for `origin/main` then `origin/master` — last-resort local-only check
 *
 * Returns null when nothing matches; the caller emits an explicit
 * "(default branch undetectable)" note in the output so the agent doesn't
 * over-interpret the omission.
 */
function detectDefaultBranch(cwd: string, gitTimeoutMs: number): string | null {
  const sym = execWithPath(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    cwd,
    timeout: gitTimeoutMs,
  });
  if (sym.exitCode === 0) {
    const name = sym.stdout.replace(/^origin\//, "");
    if (name) return name;
  }
  const cfg = execWithPath(["git", "config", "--get", "remote.origin.head"], {
    cwd,
    timeout: gitTimeoutMs,
  });
  if (cfg.exitCode === 0 && cfg.stdout) {
    const name = cfg.stdout.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
    if (name) return name;
  }
  for (const candidate of ["main", "master"]) {
    const probe = execWithPath(
      ["git", "show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
      { cwd, timeout: gitTimeoutMs }
    );
    if (probe.exitCode === 0) return candidate;
  }
  return null;
}

/**
 * Compute ahead/behind counts for `HEAD` vs `origin/<defaultBranch>` using the
 * `--left-right --count` formulation. One git call instead of two.
 *
 * IMPORTANT: this compares against the LOCAL CACHE of `origin/<defaultBranch>`.
 * The hook does NOT fetch — see `computeGitTimeoutMs` for the architectural
 * justification. The formatter labels this as "vs last-fetched origin/<X>"
 * so the agent doesn't over-interpret the result as live-remote-current.
 *
 * Returns [ahead, behind] or [null, null] if the comparison can't be computed.
 */
function computeAheadBehind(
  cwd: string,
  defaultBranch: string,
  gitTimeoutMs: number
): [number | null, number | null] {
  const refCheck = execWithPath(
    ["git", "show-ref", "--verify", "--quiet", `refs/remotes/origin/${defaultBranch}`],
    { cwd, timeout: gitTimeoutMs }
  );
  if (refCheck.exitCode !== 0) return [null, null];

  const result = execWithPath(
    ["git", "rev-list", "--left-right", "--count", `HEAD...origin/${defaultBranch}`],
    { cwd, timeout: gitTimeoutMs }
  );
  if (result.exitCode !== 0 || result.timedOut) return [null, null];
  const parts = result.stdout.trim().split(/\s+/);
  if (parts.length !== 2) return [null, null];
  const ahead = parseInt(parts[0], 10);
  const behind = parseInt(parts[1], 10);
  if (Number.isNaN(ahead) || Number.isNaN(behind)) return [null, null];
  return [ahead, behind];
}

/**
 * Build a GitStateSnapshot by invoking git commands in the given cwd.
 * Returns null when:
 *   - cwd is not a git repository (per `git rev-parse --is-inside-work-tree`)
 *   - the `HEAD` symbolic-ref lookup fails (detached HEAD, broken repo)
 *   - any individual git command times out
 *
 * Subsidiary failures (default-branch detection, ahead/behind computation) are
 * tolerated — the snapshot returns with sensible defaults (null counts) and the
 * formatter surfaces an explicit note so the agent doesn't over-interpret.
 *
 * @param gitTimeoutMs Optional per-command timeout (default derived from host cap).
 *                     Tests may pass an explicit value for determinism.
 */
export function buildGitStateSnapshot(
  cwd: string,
  gitTimeoutMs: number = computeGitTimeoutMs()
): GitStateSnapshot | null {
  // Canonical repo check via git itself. Handles worktrees (where `.git` is a
  // file with `gitdir:` indirection), submodules, and deeply-nested checkouts
  // that a `.git`-existence walker would miss or false-positive.
  const isRepoResult = execWithPath(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd,
    timeout: gitTimeoutMs,
  });
  if (
    isRepoResult.exitCode !== 0 ||
    isRepoResult.timedOut ||
    isRepoResult.stdout.trim() !== "true"
  ) {
    return null;
  }

  // Branch name
  const branchResult = execWithPath(["git", "symbolic-ref", "--short", "HEAD"], {
    cwd,
    timeout: gitTimeoutMs,
  });
  if (branchResult.exitCode !== 0 || branchResult.timedOut) return null;
  const branch = branchResult.stdout.trim();
  if (!branch) return null;

  // Default branch (for ahead/behind comparison)
  const defaultBranch = detectDefaultBranch(cwd, gitTimeoutMs);

  // Working tree status
  let modified = 0;
  let untracked = 0;
  let staged = 0;
  const statusResult = execWithPath(["git", "status", "--porcelain=v1"], {
    cwd,
    timeout: gitTimeoutMs,
  });
  if (statusResult.exitCode === 0 && !statusResult.timedOut) {
    const parsed = parsePorcelainStatus(statusResult.stdout);
    modified = parsed.modified;
    untracked = parsed.untracked;
    staged = parsed.staged;
  }

  // Ahead / behind vs origin/<defaultBranch>. Same formulation on the default
  // branch as on non-default branches — if local main is ahead of origin/main
  // (commits not yet pushed), we report that honestly instead of falsely
  // claiming "in sync".
  let aheadMain: number | null = null;
  let behindMain: number | null = null;
  if (defaultBranch) {
    [aheadMain, behindMain] = computeAheadBehind(cwd, defaultBranch, gitTimeoutMs);
  }

  // Recent commits on branch (oneline, last 5)
  let recentCommits: string[] = [];
  const logResult = execWithPath(["git", "log", "--oneline", "-5", "HEAD"], {
    cwd,
    timeout: gitTimeoutMs,
  });
  if (logResult.exitCode === 0 && !logResult.timedOut) {
    recentCommits = logResult.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  return {
    branch,
    aheadMain,
    behindMain,
    modified,
    untracked,
    staged,
    recentCommits,
    defaultBranch,
  };
}

function isOverrideTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function main(): Promise<void> {
  if (isOverrideTruthy(process.env[GIT_STATE_INJECTION_OVERRIDE_ENV])) {
    const auditLine = `[inject-git-state] override active: ${GIT_STATE_INJECTION_OVERRIDE_ENV}=${process.env[GIT_STATE_INJECTION_OVERRIDE_ENV]} at ${new Date().toISOString()}`;
    process.stdout.write(`${auditLine}\n`);
    return;
  }

  // Read input. If parsing fails or the event isn't UserPromptSubmit, bail
  // silently — matches the sibling-hook convention (inject-current-time.ts,
  // memory-search.ts, skill-staleness-detector.ts).
  let input: UserPromptSubmitInput;
  try {
    input = await readInput<UserPromptSubmitInput>();
  } catch {
    return;
  }
  if (input.hook_event_name !== "UserPromptSubmit") return;

  // Build snapshot from the input's cwd (the Claude Code-reported working dir)
  let snap: GitStateSnapshot | null;
  try {
    snap = buildGitStateSnapshot(input.cwd);
  } catch {
    // Defensive: any unexpected error → silent skip. Hook is informational.
    return;
  }
  if (snap === null) return;

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: formatGitState(snap),
    },
  };
  writeOutput(output);
}

if (import.meta.main) {
  await main();
}
