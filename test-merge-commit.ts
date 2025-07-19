#!/usr/bin/env bun

/**
 * Test script to verify merge commit validation works correctly
 */

import { writeFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";

function testCommitMessage(message: string, expectedValid: boolean, testName: string) {
  const tempFile = "/tmp/test-commit-msg.txt";

  try {
    writeFileSync(tempFile, message);

    const result = execSync(`cd /Users/edobry/Projects/minsky && bun scripts/validate-commit-message.ts ${tempFile}`, {
      encoding: "utf8",
      stdio: "pipe"
    });

    if (expectedValid) {
      console.log(`✅ ${testName}: PASSED - Message accepted as expected`);
      console.log(`   Output: ${result.trim()}`);
    } else {
      console.log(`❌ ${testName}: FAILED - Message should have been rejected but was accepted`);
    }
  } catch (error: any) {
    if (!expectedValid) {
      console.log(`✅ ${testName}: PASSED - Message rejected as expected`);
      console.log(`   Error: ${error.message.split("\n")[0]}`);
    } else {
      console.log(`❌ ${testName}: FAILED - Message should have been accepted but was rejected`);
      console.log(`   Error: ${error.message}`);
    }
  } finally {
    try { unlinkSync(tempFile); } catch { /* ignore cleanup errors */ }
  }
}

console.log("Testing merge commit validation fix...\n");

// Test cases
testCommitMessage(
  "Merge remote-tracking branch \"origin/main\" into task#280",
  true,
  "Session update merge commit"
);

testCommitMessage(
  "feat(#280): Complete \"as unknown\" cleanup with 100% code elimination",
  true,
  "Regular conventional commit"
);

testCommitMessage(
  "fix",
  false,
  "Forbidden placeholder message"
);

testCommitMessage(
  "some random commit message",
  false,
  "Non-conventional commit message"
);

console.log("\nTest completed!");
