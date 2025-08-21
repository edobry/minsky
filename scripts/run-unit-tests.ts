#!/usr/bin/env bun

/**
 * Unit test runner that explicitly excludes integration tests
 * This script dynamically finds unit test files and runs them with bun test
 */

import { execSync } from "child_process";
import { globSync } from "glob";

const unitTestPatterns = [
  "src/**/*.test.ts",
  "tests/adapters/**/*.test.ts",
  "tests/domain/**/*.test.ts",
];

const excludePatterns = ["**/*integration*", "tests/integration/**/*"];

console.log("🔍 Finding unit test files...");

// Find all test files
let testFiles: string[] = [];
for (const pattern of unitTestPatterns) {
  const files = globSync(pattern);
  testFiles.push(...files);
}

// Filter out integration tests
testFiles = testFiles.filter((file) => {
  return !excludePatterns.some((pattern) => {
    const regex = new RegExp(pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*"));
    return regex.test(file);
  });
});

console.log(`📊 Found ${testFiles.length} unit test files`);
console.log(`🚫 Excluded integration tests from tests/integration/`);

if (testFiles.length === 0) {
  console.error("❌ No test files found!");
  process.exit(1);
}

// Build the bun test command
const timeout = process.argv.includes("--timeout")
  ? process.argv[process.argv.indexOf("--timeout") + 1]
  : "15000";

const bailFlag = process.argv.includes("--bail") ? "--bail" : "";

const command = `bun test --timeout=${timeout} ${bailFlag} ${testFiles.join(" ")}`;

console.log("🧪 Running unit tests...");
console.log(`📝 Command: ${command.substring(0, 100)}...`);

try {
  execSync(command, {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  console.log("✅ All unit tests passed!");
} catch (error) {
  console.error("❌ Unit tests failed!");
  process.exit(1);
}
