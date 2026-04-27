#!/usr/bin/env bun
// PostToolUse hook: pull latest main and warn if MCP server code changed
// Called by PostToolUse hook on session_pr_merge

import { execSync } from "./types";

const projectDir = process.env.CLAUDE_PROJECT_DIR || ".";

/** Stale-lock signature strings — matched against stderr to detect index.lock contention. */
const STALE_LOCK_STDERR_MARKERS = ["index.lock", "Another git process"];

/**
 * Core hook logic, parameterized for testability.
 *
 * @param exec    - execSync-compatible function (stubbed in tests)
 * @param cwd     - project directory to run git commands in
 * @param writeStderr - function to write diagnostic messages to stderr
 * @param exit    - function to exit the process (stubbed in tests)
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

  // Pull latest main
  const pullResult = exec(["git", "pull", "--ff-only", "origin", "main"], { cwd });

  if (pullResult.exitCode !== 0) {
    const isStaleLock = STALE_LOCK_STDERR_MARKERS.every((marker) =>
      pullResult.stderr.includes(marker)
    );

    if (isStaleLock) {
      writeStderr(
        "Stale `.git/index.lock` blocking pull. " +
          "If no git process is running, remove it manually: `rm .git/index.lock`\n"
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
