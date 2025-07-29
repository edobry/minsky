/**
 * GIT COMMANDS IMPORT TESTS
 *
 * What this file tests:
 * - Git command module imports and exports
 * - Verification that all git command functions are properly exposed
 * - Basic import/export integrity of git command architecture
 * - Module structure and API surface validation
 *
 * Key functionality tested:
 * - Main git commands index file exports
 * - Individual command file imports
 * - Git types module imports
 * - Subcommand module structure
 *
 * NOTE: This tests module structure, not command functionality (see integration.test.ts)
 */

import { describe, test, expect } from "bun:test";

describe("Git Commands Import Tests", () => {
  test("should be able to import git command index", async () => {
    // Test that we can import the main index file
    const gitCommands = await import("./index.js");

    // Verify that the main command functions exist
    expect(typeof gitCommands.cloneFromParams).toBe("function");
    expect(typeof gitCommands.branchFromParams).toBe("function");
    expect(typeof gitCommands.commitChangesFromParams).toBe("function");
    expect(typeof gitCommands.pushFromParams).toBe("function");
    expect(typeof gitCommands.mergeFromParams).toBe("function");
    expect(typeof gitCommands.checkoutFromParams).toBe("function");
    expect(typeof gitCommands.rebaseFromParams).toBe("function");
    expect(typeof gitCommands.createPullRequestFromParams).toBe("function");
  });

  test("should be able to import git types", async () => {
    // Test that we can import the types file
    const gitTypes = await import("./types.js");

    // Verify that the types module exports something
    expect(gitTypes).toBeDefined();
  });

  test("should be able to import individual command files", async () => {
    // Test individual command imports
    const cloneCommand = await import("./clone-command.js");
    const branchCommand = await import("./branch-command.js");
    const commitCommand = await import("./commit-command.js");
    const pushCommand = await import("./push-command.js");

    expect(cloneCommand).toBeDefined();
    expect(branchCommand).toBeDefined();
    expect(commitCommand).toBeDefined();
    expect(pushCommand).toBeDefined();
  });

  test("should be able to import subcommands", async () => {
    // Test subcommand imports
    const subcommands = await import("./subcommands/index.js");

    expect(subcommands).toBeDefined();
  });
});
