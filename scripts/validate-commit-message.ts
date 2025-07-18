#!/usr/bin/env bun

/**
 * Validates commit messages to prevent placeholder/test messages
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";

const FORBIDDEN_MESSAGES = [
  "minimal commit",
  "amended commit",
  "test commit",
  "placeholder commit",
  "temp commit",
  "temporary commit",
  "wip",
  "work in progress",
  "fix",
  "update",
  "change",
];

const CONVENTIONAL_COMMIT_PATTERN = /^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\(.+\))?: .{1,50}/;

function getCurrentBranch(): string {
  try {
    return execSync("git branch --show-current", { encoding: "utf8" }).trim();
  } catch (error) {
    // Fallback to checking if we're in main/master
    try {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
      return branch;
    } catch {
      return "unknown";
    }
  }
}

function isMergeCommit(message: string): boolean {
  return message.trim().startsWith("Merge ");
}

function validateCommitMessage(message: string): { valid: boolean; error?: string } {
  const normalizedMessage = message.trim().toLowerCase();

  // Check for forbidden placeholder messages
  if (FORBIDDEN_MESSAGES.includes(normalizedMessage)) {
    return {
      valid: false,
      error: `Forbidden placeholder message: "${message}". Please use a descriptive conventional commit message.`
    };
  }

  // Allow merge commits except when merging into main/master
  if (isMergeCommit(message)) {
    const currentBranch = getCurrentBranch();

    if (currentBranch === "main" || currentBranch === "master") {
      return {
        valid: false,
        error: `Merge commits into ${currentBranch} must use conventional commit format. Use squash merge or reword the commit message.`
      };
    }

    // Allow merge commits for all other branches (session branches, PR branches, etc.)
    console.log(`✅ Merge commit allowed on branch: ${currentBranch}`);
    return { valid: true };
  }

  // Check for conventional commit format for regular commits
  if (!CONVENTIONAL_COMMIT_PATTERN.test(message.trim())) {
    return {
      valid: false,
      error: `Invalid commit message format. Please use conventional commits format: "type(scope): description"
Examples:
  feat(auth): add user authentication
  fix(#123): resolve login validation issue
  docs: update README with new features`
    };
  }

  return { valid: true };
}

function main() {
  const commitMsgFile = process.argv[2];

  if (!commitMsgFile) {
    console.error("Usage: validate-commit-message.ts <commit-msg-file>");
    process.exit(1);
  }

  try {
    const commitMessage = readFileSync(resolve(commitMsgFile), "utf8");
    const result = validateCommitMessage(commitMessage);

    if (!result.valid) {
      console.error("❌ Invalid commit message:");
      console.error(result.error);
      console.error(`\nCommit message: "${commitMessage.trim()}"`);
      process.exit(1);
    }

    console.log("✅ Commit message is valid");
    process.exit(0);
  } catch (error) {
    console.error("Error reading commit message file:", error);
    process.exit(1);
  }
}

main();
