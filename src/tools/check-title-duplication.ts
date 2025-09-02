#!/usr/bin/env bun
/**
 * Title Duplication Checker for Commit Messages (True Code Reuse Version)
 * Validates commit messages using imported validation logic from session PR workflow
 *
 * This demonstrates the DRY approach - importing actual functions instead of duplicating logic
 */

import { readFileSync } from "fs";
import { validatePrContent } from "../domain/session/pr-validation";

import { log } from "../utils/logger";

/**
 * Main function to check commit message using imported validation
 */
function main(): void {
  const commitMsgFile = Bun.argv[2];

  if (!commitMsgFile) {
    log.error("Usage: bun check-title-duplication.ts <commit-msg-file>");
    Bun.exit(1);
  }

  let commitMessage: string;
  try {
    const content = readFileSync(commitMsgFile, "utf-8");
    commitMessage = typeof content === "string" ? content.trim() : content.toString().trim();
  } catch (error) {
    log.error(`Error reading commit message file: ${error}`);
    Bun.exit(1);
  }

  if (!commitMessage) {
    log.info("✅ Empty commit message, skipping title duplication check");
    Bun.exit(0);
  }

  // Parse commit message into title and body
  const lines = commitMessage.split("\n");
  const title = lines[0]?.trim();

  // Body starts after the first blank line (standard git commit format)
  let bodyStartIndex = 1;
  while (bodyStartIndex < lines.length && lines[bodyStartIndex]?.trim() === "") {
    bodyStartIndex++;
  }

  const body = lines.slice(bodyStartIndex).join("\n").trim();

  if (!title) {
    log.info("✅ No title found, skipping title duplication check");
    Bun.exit(0);
  }

  if (!body) {
    log.info("✅ No body found, skipping title duplication check");
    Bun.exit(0);
  }

  // 🎯 TRUE CODE REUSE: Import and use the actual validation function
  const validation = validatePrContent(title, body);

  if (validation.isValid) {
    log.info("✅ No title duplication found in commit message");
    Bun.exit(0);
  }

  log.info("❌ Title duplication detected in commit message:");
  log.info("");

  for (const error of validation.errors) {
    log.info(`   • ${error}`);
  }

  log.info("");
  log.info("💡 Please fix the title duplication before committing.");
  log.info("   Example:");
  log.info("   Instead of:");
  log.info("     Title: fix: Fix user authentication bug");
  log.info("     Body:  Fix user authentication bug");
  log.info("");
  log.info("   Use:");
  log.info("     Title: fix: Fix user authentication bug");
  log.info("     Body:  Resolves issue where users couldn't log in...");

  Bun.exit(1);
}

if (import.meta.main) {
  main();
}
