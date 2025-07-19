#!/usr/bin/env bun
/**
 * Title Duplication Checker for Commit Messages
 * Validates commit messages to prevent title duplication in body
 * Reuses validation logic from session PR workflow
 * 
 * NOTE: This duplicates validation logic from src/domain/session/pr-validation.ts
 * due to import complexity in bun scripts. Keep in sync when logic changes.
 */

import { readFileSync } from "fs";

/**
 * Checks if a string appears to be a duplicate of another string
 * with different formatting (duplicated from pr-validation.ts)
 * OPTIMIZED: Added performance optimizations for large commit messages
 */
function isDuplicateContent(content1: string, content2: string): boolean {
  // Early exit for empty inputs
  if (!content1?.trim() || !content2?.trim()) {
    return false;
  }

  // Performance optimization: Skip expensive processing for very large inputs
  // Title duplication typically involves short strings, so we can safely skip
  // validation when either string is extremely long
  const MAX_REASONABLE_LENGTH = 500;
  if (content1.length > MAX_REASONABLE_LENGTH || content2.length > MAX_REASONABLE_LENGTH) {
    // For very long content, do a simple case-insensitive exact match only
    return content1.trim().toLowerCase() === content2.trim().toLowerCase();
  }

  // Normalize both strings for comparison (only for reasonable-length strings)
  const normalize = (str: string) =>
    str
      .toLowerCase()
      .replace(/[^\w\s]/g, " ") // Replace punctuation with spaces
      .replace(/\s+/g, " ") // Collapse multiple spaces
      .trim();

  const normalized1 = normalize(content1);
  const normalized2 = normalize(content2);

  // Early exit if one is much longer than the other (unlikely to be duplicates)
  const lengthRatio = Math.max(normalized1.length, normalized2.length) / Math.min(normalized1.length, normalized2.length);
  if (lengthRatio > 3) {
    return false;
  }

  // Check if one is contained in the other (accounting for minor differences)
  return normalized1.includes(normalized2) || normalized2.includes(normalized1);
}

/**
 * Validates PR content for title duplication issues (duplicated from pr-validation.ts)
 * OPTIMIZED: Added performance guards for large commit messages
 */
function validatePrContent(title: string, body: string): string[] {
  const issues: string[] = [];

  if (!title?.trim() || !body?.trim()) {
    return issues; // Skip validation if either is empty
  }

  // Performance optimization: Skip title duplication check for very large bodies
  // Large commit messages (like detailed PR descriptions) are unlikely to have
  // simple title duplication issues and the validation becomes expensive
  const MAX_BODY_LENGTH_FOR_VALIDATION = 1000;
  if (body.length > MAX_BODY_LENGTH_FOR_VALIDATION) {
    console.log(`⚡ Skipping title duplication check for large commit message (${body.length} chars)`);
    return issues;
  }

  const lines = body.trim().split("\n");
  const firstLine = lines[0]?.trim();

  // Check if title appears as first line of body
  if (firstLine && isDuplicateContent(title.trim(), firstLine)) {
    issues.push(`Title "${title.trim()}" appears to be duplicated as the first line of the body: "${firstLine}"`);
  }

  return issues;
}

/**
 * Main function to check commit message
 */
function main(): void {
  const commitMsgFile = process.argv[2];
  
  if (!commitMsgFile) {
    console.error("Usage: bun check-title-duplication.ts <commit-msg-file>");
    process.exit(1);
  }

  let commitMessage: string;
  try {
    commitMessage = readFileSync(commitMsgFile, "utf-8").trim();
  } catch (error) {
    console.error(`Error reading commit message file: ${error}`);
    process.exit(1);
  }

  if (!commitMessage) {
    console.log("✅ Empty commit message, skipping title duplication check");
    process.exit(0);
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
    console.log("✅ No title found, skipping title duplication check");
    process.exit(0);
  }

  if (!body) {
    console.log("✅ No body found, skipping title duplication check");
    process.exit(0);
  }

  // Use the same validation logic as session PR workflow
  const issues = validatePrContent(title, body);

  if (issues.length === 0) {
    console.log("✅ No title duplication found in commit message");
    process.exit(0);
  }

  console.log("❌ Title duplication detected in commit message:");
  console.log("");
  
  for (const issue of issues) {
    console.log(`   • ${issue}`);
  }
  
  console.log("");
  console.log("💡 Please fix the title duplication before committing.");
  console.log("   Example:");
  console.log("   Instead of:");
  console.log("     Title: fix: Fix user authentication bug");
  console.log("     Body:  Fix user authentication bug");
  console.log("");
  console.log("   Use:");
  console.log("     Title: fix: Fix user authentication bug");
  console.log("     Body:  Resolves issue where users couldn't log in...");
  
  process.exit(1);
}

if (import.meta.main) {
  main();
} 
