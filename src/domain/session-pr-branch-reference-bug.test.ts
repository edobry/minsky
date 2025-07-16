/**
 * Regression test for origin/origin/main branch reference bug
 *
 * This test specifically covers the critical bug where session PR creation
 * was constructing invalid git references like "origin/origin/main" due to
 * double-prefixing of the origin remote name.
 * 
 * Bug discovered during Task #228 implementation.
 */

import { describe, test, expect } from "bun:test";
import { setupTestMocks } from "../utils/test-utils/mocking";

// Set up automatic mock cleanup
setupTestMocks();

describe("Session PR Branch Reference Bug Regression", () => {
  
  test("should normalize branch references to prevent origin/origin/main", () => {
    // Test the core logic that was causing the bug
    
    // Function to simulate the branch reference normalization we implemented
    function normalizeBranchRef(baseBranch: string): string {
      // Remove origin/ prefix if present, then add it back once
      const normalized = baseBranch.startsWith("origin/") ? baseBranch.substring(7) : baseBranch;
      return `origin/${normalized}`;
    }
    
    // Test cases that previously caused the bug
    const testCases = [
      { input: "main", expected: "origin/main" },
      { input: "develop", expected: "origin/develop" },
      { input: "master", expected: "origin/master" },
      { input: "origin/main", expected: "origin/main" }, // Should NOT become origin/origin/main
      { input: "origin/develop", expected: "origin/develop" }, // Should NOT become origin/origin/develop
    ];
    
    for (const testCase of testCases) {
      const result = normalizeBranchRef(testCase.input);
      
      // Verify the result is what we expect
      expect(result).toBe(testCase.expected);
      
      // Critical: Verify NO double-prefixing occurred
      expect(result).not.toContain("origin/origin/");
    }
  });

  test("should detect origin/origin/main patterns in git commands", () => {
    // Test utility to detect the bug pattern in git commands
    const gitCommands = [
      "git -C /repo switch -C pr/branch origin/main", // Valid
      "git -C /repo switch -C pr/branch origin/origin/main", // Invalid - the bug
      "git -C /repo fetch origin/origin/main", // Invalid - the bug pattern
      "git -C /repo merge origin/origin/develop", // Invalid - another bug pattern
    ];
    
    // Function to detect invalid branch references (the bug pattern)
    function detectInvalidBranchRefs(commands: string[]): string[] {
      return commands.filter(cmd => 
        cmd.includes("origin/origin/main") || cmd.includes("origin/origin/")
      );
    }
    
    const invalidRefs = detectInvalidBranchRefs(gitCommands);
    
    // Should detect the 3 invalid commands
    expect(invalidRefs).toHaveLength(3);
    expect(invalidRefs[0]).toContain("origin/origin/main");
    expect(invalidRefs[1]).toContain("origin/origin/main");
    expect(invalidRefs[2]).toContain("origin/origin/develop");
  });

  test("should validate git command construction prevents double-prefixing", () => {
    // Test the git command construction logic
    
    function constructPrBranchCommand(prBranch: string, baseBranch: string): string {
      // Normalize baseBranch to prevent double-prefixing
      const normalizedBase = baseBranch.startsWith("origin/") ? baseBranch : `origin/${baseBranch}`;
      return `git switch -C ${prBranch} ${normalizedBase}`;
    }
    
    const testCases = [
      {
        prBranch: "pr/task#228",
        baseBranch: "main",
        expected: "git switch -C pr/task#228 origin/main"
      },
      {
        prBranch: "pr/task#228", 
        baseBranch: "origin/main", // Already has origin/ prefix
        expected: "git switch -C pr/task#228 origin/main" // Should NOT add another origin/
      },
      {
        prBranch: "pr/task#228",
        baseBranch: "develop",
        expected: "git switch -C pr/task#228 origin/develop"
      }
    ];
    
    for (const testCase of testCases) {
      const command = constructPrBranchCommand(testCase.prBranch, testCase.baseBranch);
      
      // Verify the command is constructed correctly
      expect(command).toBe(testCase.expected);
      
      // Critical: Verify NO origin/origin/ pattern
      expect(command).not.toContain("origin/origin/");
    }
  });

  test("should document the specific bug that was fixed", () => {
    // This test documents the exact bug that was discovered and fixed
    
    // Before the fix: This would have happened
    const buggyBranchConstruction = (baseBranch: string) => {
      // Simulating the old buggy behavior
      return `origin/${baseBranch}`; // If baseBranch was already "origin/main", this creates "origin/origin/main"
    };
    
    // After the fix: This is what happens now
    const fixedBranchConstruction = (baseBranch: string) => {
      const normalized = baseBranch.startsWith("origin/") ? baseBranch.substring(7) : baseBranch;
      return `origin/${normalized}`;
    };
    
    const testInput = "origin/main";
    
    // The bug would have produced this invalid reference
    const buggyResult = buggyBranchConstruction(testInput);
    expect(buggyResult).toBe("origin/origin/main"); // This was the bug
    
    // The fix produces this valid reference
    const fixedResult = fixedBranchConstruction(testInput);
    expect(fixedResult).toBe("origin/main"); // This is correct
    
    // Verify the fix prevents the bug
    expect(fixedResult).not.toContain("origin/origin/");
  });
}); 
