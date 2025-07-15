#!/usr/bin/env bun

/**
 * Validates commit messages to prevent placeholder/test messages
 */

import { readFileSync } from "fs";
import { resolve } from "path";

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

function validateCommitMessage(message: string): { valid: boolean; error?: string } {
  const normalizedMessage = message.trim().toLowerCase();

  // Check for forbidden placeholder messages
  if (FORBIDDEN_MESSAGES.includes(normalizedMessage)) {
    return {
      valid: false,
      error: `Forbidden placeholder message: "${message}". Please use a descriptive conventional commit message.`
    };
  }

  // Check for conventional commit format
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
