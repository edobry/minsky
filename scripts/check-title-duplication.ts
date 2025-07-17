#!/usr/bin/env bun
/**
 * Title Duplication Checker
 * Checks staged files for title duplication patterns in PR descriptions and commit messages
 * Uses the same validation logic as the session PR workflow
 */

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";

interface ValidationResult {
  file: string;
  issues: string[];
}

/**
 * Checks if a string appears to be a duplicate of another string
 * with different formatting (reused from pr-validation.ts)
 */
function isDuplicateContent(content1: string, content2: string): boolean {
  if (!content1 || !content2) return false;

  // Normalize both strings for comparison
  const normalize = (str: string) => 
    str.trim().toLowerCase().replace(/\s+/g, " ");

  return normalize(content1) === normalize(content2);
}

/**
 * Validates PR title and body to prevent duplication patterns
 * (reused from pr-validation.ts)
 */
function validatePrContent(title: string, body?: string): {
  isValid: boolean;
  errors: string[];
  sanitizedBody?: string;
} {
  const errors: string[] = [];
  let sanitizedBody = body;

  if (!title.trim()) {
    errors.push("PR title cannot be empty");
    return { isValid: false, errors };
  }

  // Check if body starts with the title (duplication pattern)
  if (body && body.trim()) {
    const bodyLines = body.trim().split("\n");
    const firstBodyLine = bodyLines[0]?.trim();

    if (firstBodyLine === title.trim()) {
      // Remove the duplicated title from body
      sanitizedBody = bodyLines.slice(1).join("\n").trim();
      console.log(`⚠️  Detected duplicate title in body: "${firstBodyLine}"`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    sanitizedBody,
  };
}

function getStagedFiles(): string[] {
  try {
    const output = execSync("git diff --cached --name-only", { encoding: "utf8" });
    return output.trim().split("\n").filter(Boolean);
  } catch (error) {
    console.error("Failed to get staged files:", error);
    return [];
  }
}

function checkPrDescriptionFile(filePath: string): string[] {
  const issues: string[] = [];
  
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n");
    
    if (lines.length < 2) return issues;
    
    const title = lines[0]?.trim();
    const body = lines.slice(1).join("\n").trim();
    
    if (!title) return issues;
    
    // Use our existing validation logic
    const validation = validatePrContent(title, body);
    
    if (!validation.isValid) {
      issues.push(...validation.errors);
    }
    
    // Additional check: if sanitized body is different, there was duplication
    if (validation.sanitizedBody !== undefined && validation.sanitizedBody !== body) {
      issues.push(`Title duplication detected: "${title}" appears both as title and first line of body`);
    }
    
    // Check for title repeated multiple times in body
    if (body) {
      const bodyLines = body.split("\n");
      let duplicateCount = 0;
      
      for (const line of bodyLines) {
        if (line.trim() && isDuplicateContent(line, title)) {
          duplicateCount++;
        }
      }
      
      if (duplicateCount > 1) {
        issues.push(`Title "${title}" appears ${duplicateCount} times in the body (should appear 0 times)`);
      }
    }
    
  } catch (error) {
    issues.push(`Failed to read file: ${error}`);
  }
  
  return issues;
}

function checkMarkdownFile(filePath: string): string[] {
  const issues: string[] = [];
  
  try {
    const content = readFileSync(filePath, "utf8");
    
    // Look for PR description patterns in markdown files
    const prSectionMatch = content.match(/^#\s+(.+?)$/m);
    if (!prSectionMatch) return issues;
    
    const title = prSectionMatch[1]?.trim();
    if (!title) return issues;
    
    // Extract content after the title
    const titleIndex = content.indexOf(prSectionMatch[0]);
    const afterTitle = content.slice(titleIndex + prSectionMatch[0].length).trim();
    
    if (afterTitle) {
      const validation = validatePrContent(title, afterTitle);
      
      if (!validation.isValid) {
        issues.push(...validation.errors.map(err => `In markdown section: ${err}`));
      }
      
      if (validation.sanitizedBody !== undefined && validation.sanitizedBody !== afterTitle) {
        issues.push(`Title duplication in markdown: "${title}" appears in both heading and content`);
      }
    }
    
  } catch (error) {
    issues.push(`Failed to read markdown file: ${error}`);
  }
  
  return issues;
}

function checkCommitMessage(): string[] {
  const issues: string[] = [];
  
  try {
    // Check if we're in a commit context by looking for COMMIT_EDITMSG
    const commitMsgPath = ".git/COMMIT_EDITMSG";
    if (!existsSync(commitMsgPath)) return issues;
    
    const content = readFileSync(commitMsgPath, "utf8");
    const lines = content.trim().split("\n").filter(line => !line.startsWith("#"));
    
    if (lines.length < 2) return issues;
    
    const title = lines[0]?.trim();
    const body = lines.slice(1).join("\n").trim();
    
    if (!title || !body) return issues;
    
    const validation = validatePrContent(title, body);
    
    if (!validation.isValid) {
      issues.push(...validation.errors.map(err => `In commit message: ${err}`));
    }
    
    if (validation.sanitizedBody !== undefined && validation.sanitizedBody !== body) {
      issues.push(`Commit message title duplication: "${title}" appears in both subject and body`);
    }
    
  } catch (error) {
    // Silently ignore if we can't read commit message (not in commit context)
  }
  
  return issues;
}

function main(): void {
  console.log("🔍 Checking for title duplication patterns...");
  
  const stagedFiles = getStagedFiles();
  const results: ValidationResult[] = [];
  
  // Check staged files for potential PR description patterns
  for (const file of stagedFiles) {
    const issues: string[] = [];
    
    if (file.endsWith("/pr.md") || file.includes("pr-description") || file.includes("pull-request")) {
      issues.push(...checkPrDescriptionFile(file));
    } else if (file.endsWith(".md") && (file.includes("task") || file.includes("spec"))) {
      issues.push(...checkMarkdownFile(file));
    }
    
    if (issues.length > 0) {
      results.push({ file, issues });
    }
  }
  
  // Check commit message if we're in a commit context
  const commitIssues = checkCommitMessage();
  if (commitIssues.length > 0) {
    results.push({ file: "commit message", issues: commitIssues });
  }
  
  // Report results
  if (results.length === 0) {
    console.log("✅ No title duplication patterns found!");
    process.exit(0);
  }
  
  console.log("❌ Title duplication issues found:");
  console.log("");
  
  for (const result of results) {
    console.log(`📄 ${result.file}:`);
    for (const issue of result.issues) {
      console.log(`   • ${issue}`);
    }
    console.log("");
  }
  
  console.log("💡 Please fix these title duplication issues before committing.");
  console.log("   The same logic used by the session PR workflow will detect and prevent these patterns.");
  
  process.exit(1);
}

if (import.meta.main) {
  main();
} 
