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

import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync, readInput, writeOutput } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";

export const GIT_STATE_INJECTION_OVERRIDE_ENV = "MINSKY_SKIP_GIT_STATE_INJECTION";

/** Per-git-command timeout. Keeps the hook well under its 5-second total budget. */
const GIT_TIMEOUT_MS = 800;

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
    return `Current git state: on ${snap.branch}, clean, in sync with ${snap.defaultBranch}.`;
  }

  const lines: string[] = ["Current git state:"];

  // Branch line, with optional ahead/behind
  if (snap.aheadMain !== null && snap.behindMain !== null && snap.defaultBranch !== null) {
    lines.push(
      `- Branch: ${snap.branch} (vs ${snap.defaultBranch}: ${snap.aheadMain} ahead, ${snap.behindMain} behind)`
    );
  } else {
    lines.push(`- Branch: ${snap.branch}`);
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
 * Detect the default branch by trying common candidates. Mirrors the resolution
 * approach in check-branch-fresh.ts. Returns null when nothing matches (and the
 * caller should skip the ahead/behind calculation).
 */
function detectDefaultBranch(cwd: string): string | null {
  // First try symbolic-ref on origin/HEAD (canonical answer when origin is set up)
  const sym = execSync(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
  });
  if (sym.exitCode === 0) {
    // Output is "origin/main" — strip the "origin/" prefix
    const name = sym.stdout.replace(/^origin\//, "");
    if (name) return name;
  }
  // Fallback: probe for origin/main and origin/master
  for (const candidate of ["main", "master"]) {
    const probe = execSync(
      ["git", "show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
      { cwd, timeout: GIT_TIMEOUT_MS }
    );
    if (probe.exitCode === 0) return candidate;
  }
  return null;
}

/**
 * Build a GitStateSnapshot by invoking git commands in the given cwd.
 * Returns null when:
 *   - cwd is not a git repository (no `.git` directory anywhere up the chain)
 *   - the `HEAD` symbolic-ref lookup fails (detached HEAD, broken repo)
 *   - any individual git command times out
 *
 * Subsidiary failures (e.g., ahead/behind can't be computed because the branch
 * has no upstream) are tolerated — the snapshot still returns with the missing
 * fields filled with sensible defaults (null counts, empty arrays).
 */
export function buildGitStateSnapshot(cwd: string): GitStateSnapshot | null {
  // Quick check: is this a git repo? Walk up looking for a `.git` directory.
  // Avoids spawning a subprocess in the common non-repo case (e.g., /tmp).
  if (!isInGitRepo(cwd)) return null;

  // Branch name
  const branchResult = execSync(["git", "symbolic-ref", "--short", "HEAD"], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
  });
  if (branchResult.exitCode !== 0 || branchResult.timedOut) return null;
  const branch = branchResult.stdout.trim();
  if (!branch) return null;

  // Default branch (for ahead/behind comparison)
  const defaultBranch = detectDefaultBranch(cwd);

  // Working tree status
  let modified = 0;
  let untracked = 0;
  let staged = 0;
  const statusResult = execSync(["git", "status", "--porcelain=v1"], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
  });
  if (statusResult.exitCode === 0 && !statusResult.timedOut) {
    const parsed = parsePorcelainStatus(statusResult.stdout);
    modified = parsed.modified;
    untracked = parsed.untracked;
    staged = parsed.staged;
  }

  // Ahead / behind vs default branch
  let aheadMain: number | null = null;
  let behindMain: number | null = null;
  if (defaultBranch && branch !== defaultBranch) {
    const aheadResult = execSync(["git", "rev-list", "--count", `origin/${defaultBranch}..HEAD`], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    if (aheadResult.exitCode === 0 && !aheadResult.timedOut) {
      aheadMain = parseInt(aheadResult.stdout.trim(), 10);
      if (Number.isNaN(aheadMain)) aheadMain = null;
    }
    const behindResult = execSync(["git", "rev-list", "--count", `HEAD..origin/${defaultBranch}`], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    if (behindResult.exitCode === 0 && !behindResult.timedOut) {
      behindMain = parseInt(behindResult.stdout.trim(), 10);
      if (Number.isNaN(behindMain)) behindMain = null;
    }
  } else if (defaultBranch && branch === defaultBranch) {
    // On the default branch — "ahead/behind" is vs origin/<default>
    aheadMain = 0;
    behindMain = 0;
  }

  // Recent commits on branch (oneline, last 5)
  let recentCommits: string[] = [];
  const logResult = execSync(["git", "log", "--oneline", "-5", "HEAD"], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
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

/**
 * Walk up from `cwd` looking for a `.git` directory or file (the latter for
 * git worktrees). Returns true if found. Bounded at 50 parent traversals to
 * avoid pathological loops.
 */
function isInGitRepo(cwd: string): boolean {
  let dir = cwd;
  for (let i = 0; i < 50; i++) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = join(dir, "..");
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
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
