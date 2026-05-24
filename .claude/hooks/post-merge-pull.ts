#!/usr/bin/env bun
// PostToolUse hook: pull latest main and warn if MCP server code changed
// Called by PostToolUse hook on session_pr_merge

import { execSync } from "./types";

const projectDir = process.env.CLAUDE_PROJECT_DIR || ".";

/** Stale-lock signature strings — matched against stderr to detect index.lock contention. */
const STALE_LOCK_STDERR_MARKERS = ["index.lock", "Another git process"];

/** Dirty-tree signature — git pull refuses when local changes would be overwritten. */
const DIRTY_TREE_STDERR_MARKER = "Your local changes to the following files would be overwritten";

/**
 * Core hook logic, parameterized for testability.
 *
 * Strategy: if the working tree is dirty, stash before pulling and pop after.
 * This handles the common case where local experimental files (e.g., scripts/cli-entry.ts)
 * block the ff-only pull. If stash pop conflicts, warn explicitly but leave main advanced.
 */
export function runHook(
  exec: typeof execSync,
  cwd: string,
  writeStderr: (msg: string) => void,
  exit: (code: number) => void
): void {
  // Record current HEAD before pull
  const beforeResult = exec(["git", "rev-parse", "HEAD"], { cwd });
  const before = beforeResult.exitCode === 0 ? beforeResult.stdout : "unknown";

  // Check if working tree is dirty
  const statusResult = exec(["git", "status", "--porcelain"], { cwd });
  const isDirty = statusResult.exitCode === 0 && statusResult.stdout.trim().length > 0;

  // Stash if dirty
  let stashed = false;
  if (isDirty) {
    const stashResult = exec(
      ["git", "stash", "--include-untracked", "-m", "post-merge-pull: auto-stash"],
      { cwd }
    );
    stashed = stashResult.exitCode === 0 && !stashResult.stdout.includes("No local changes");
  }

  // Pull latest main
  const pullResult = exec(["git", "pull", "--ff-only", "origin", "main"], { cwd });

  if (pullResult.exitCode !== 0) {
    // Restore stash before reporting failure
    if (stashed) {
      exec(["git", "stash", "pop"], { cwd });
    }

    const isStaleLock = STALE_LOCK_STDERR_MARKERS.every((marker) =>
      pullResult.stderr.includes(marker)
    );

    if (isStaleLock) {
      writeStderr(
        "Stale `.git/index.lock` blocking pull. " +
          "If no git process is running, remove it manually: `rm .git/index.lock`\n"
      );
    } else if (pullResult.stderr.includes(DIRTY_TREE_STDERR_MARKER)) {
      writeStderr(
        "Post-merge pull failed: local changes conflict even after stash attempt.\n" +
          "Run `git pull --ff-only origin main` manually after resolving.\n"
      );
    } else {
      if (pullResult.stderr) {
        writeStderr(`${pullResult.stderr}\n`);
      }
      if (pullResult.stdout) {
        writeStderr(`${pullResult.stdout}\n`);
      }
    }

    exit(1);
    return;
  }

  // Pop stash if we stashed
  if (stashed) {
    const popResult = exec(["git", "stash", "pop"], { cwd });
    if (popResult.exitCode !== 0) {
      writeStderr(
        "Post-merge pull succeeded but stash pop had conflicts.\n" +
          "Your changes are in `git stash list`. Resolve with:\n" +
          "  git stash pop  (then fix conflicts)\n" +
          "  -- or --\n" +
          "  git stash drop (to discard the stashed changes)\n"
      );
    }
  }

  // Record HEAD after pull
  const afterResult = exec(["git", "rev-parse", "HEAD"], { cwd });
  const after = afterResult.exitCode === 0 ? afterResult.stdout : "unknown";

  // If HEAD changed, check if src/ files were modified
  if (before !== after && before !== "unknown") {
    const diffResult = exec(["git", "diff", "--name-only", before, after, "--", "src/"], {
      cwd,
    });
    if (diffResult.stdout) {
      process.stdout.write(
        "\n⚠️  Minsky source code updated by this merge.\n" +
          "   The running MCP server is using stale code.\n" +
          "   Run: /mcp then reconnect minsky\n\n"
      );
    }
  }

  exit(0);
}

// Main entrypoint — only runs when executed directly, not when imported by tests
if (import.meta.main) {
  runHook(execSync, projectDir, (s) => process.stderr.write(s), process.exit.bind(process));
}
