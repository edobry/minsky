#!/usr/bin/env bun

/**
 * Placeholder Test Detector
 *
 * This script scans the codebase for placeholder/mock tests that don't actually
 * test any functionality. It looks for patterns like:
 * - expect(true).toBe(true)
 * - Tests with no assertions
 * - Tests that are commented out
 * - Tests marked as "TODO" without implementation
 */

import * as fs from "fs/promises";
import * as path from "path";

// Suspicious patterns to detect
const PLACEHOLDER_PATTERNS = [
  /expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/,
  /\/\/\s*Test is disabled/i,
  /\/\/\s*TODO/i,
  /test\s*\(\s*['"].*todo.*['"]/i,
  /test\s*\(\s*['"].*placeholder.*['"]/i,
  /test\s*\(\s*['"].*mock.*['"]/i,
  /test\s*\(\s*['"].*skip.*['"]/i,
  /\btest\.skip\s*\(/i,
];

async function scanFile(filePath: string): Promise<{ file: string; issues: string[] }> {
  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const issues: string[] = [];

  // Check for suspicious patterns
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const matches = content.match(pattern);
    if (matches) {
      for (const match of matches) {
        // Find the line number for the match
        const lineNumber = lines.findIndex((line) => line.includes(match));
        issues.push(`Line ${lineNumber + 1}: Found placeholder pattern: ${match.trim()}`);
      }
    }
  }

  // Check if there are test blocks with no assertions
  const testBlocksCount = (content.match(/test\s*\(/g) || []).length;
  const assertionsCount = (content.match(/expect\s*\(/g) || []).length;

  if (testBlocksCount > 0 && assertionsCount === 0) {
    issues.push(`Found ${testBlocksCount} test blocks but no assertions`);
  }

  // Check for tests with suspiciously low assertions ratio
  if (testBlocksCount > 0 && assertionsCount > 0 && assertionsCount / testBlocksCount < 0.5) {
    issues.push(`Low assertion ratio: ${assertionsCount} assertions for ${testBlocksCount} tests`);
  }

  return {
    file: filePath,
    issues,
  };
}

async function findTestFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip node_modules and other irrelevant directories
      if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
        const subFiles = await findTestFiles(fullPath);
        files.push(...subFiles);
      }
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

async function main() {
  const testFiles = await findTestFiles("src");
  let hasIssues = false;
  let totalIssues = 0;

  for (const file of testFiles) {
    const result = await scanFile(file);
    if (result.issues.length > 0) {
      hasIssues = true;
      totalIssues += result.issues.length;
      console.log(`\n${result.file}:`);
      for (const issue of result.issues) {
        console.log(`  - ${issue}`);
      }
    }
  }

  console.log("\n------------------------------");
  if (hasIssues) {
    console.log(
      `❌ Found ${totalIssues} potential placeholder test issues in ${testFiles.length} test files`
    );
    process.exit(1);
  } else {
    console.log(`✅ No placeholder test issues found in ${testFiles.length} test files`);
    process.exit(0);
  }
}

main().catch((error) => {
  console.error("Error scanning for placeholder tests:", error);
  process.exit(1);
});
