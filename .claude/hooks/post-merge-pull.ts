#!/usr/bin/env bun
// PostToolUse hook: pull latest main and warn if MCP server code changed
// Called by PostToolUse hook on session_pr_merge

import { execSync } from "./types";

const projectDir = process.env.CLAUDE_PROJECT_DIR || ".";

// Record current HEAD before pull
const beforeResult = execSync(["git", "rev-parse", "HEAD"], { cwd: projectDir });
const before = beforeResult.exitCode === 0 ? beforeResult.stdout : "unknown";

// Pull latest main (ignore errors)
execSync(["git", "pull", "--ff-only", "origin", "main"], { cwd: projectDir });

// Record HEAD after pull
const afterResult = execSync(["git", "rev-parse", "HEAD"], { cwd: projectDir });
const after = afterResult.exitCode === 0 ? afterResult.stdout : "unknown";

// If HEAD changed, check if src/ files were modified
if (before !== after && before !== "unknown") {
  const diffResult = execSync(["git", "diff", "--name-only", before, after, "--", "src/"], {
    cwd: projectDir,
  });
  if (diffResult.stdout) {
    process.stdout.write(
      "\n⚠️  Minsky source code updated by this merge.\n" +
        "   The running MCP server is using stale code.\n" +
        "   Run: /mcp then reconnect minsky\n\n"
    );
  }
}
