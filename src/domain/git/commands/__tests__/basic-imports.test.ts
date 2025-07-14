import { describe, test, expect } from "bun:test";

describe("Git Commands Import Tests", () => {
  test("should be able to import git command index", async () => {
    // Test that we can import the main index file
    const gitCommands = await import("../index");
    
    // Verify that the main command functions exist
    expect(typeof gitCommands.cloneRepository).toBe("function");
    expect(typeof gitCommands.createBranch).toBe("function");
    expect(typeof gitCommands.commitChanges).toBe("function");
    expect(typeof gitCommands.pushChanges).toBe("function");
    expect(typeof gitCommands.mergeChanges).toBe("function");
    expect(typeof gitCommands.checkoutBranch).toBe("function");
    expect(typeof gitCommands.rebaseChanges).toBe("function");
    expect(typeof gitCommands.generatePr).toBe("function");
  });

  test("should be able to import git types", async () => {
    // Test that we can import the types file
    const gitTypes = await import("../types");
    
    // Verify that the types module exports something
    expect(gitTypes).toBeDefined();
  });

  test("should be able to import individual command files", async () => {
    // Test individual command imports
    const cloneCommand = await import("../clone-command");
    const branchCommand = await import("../branch-command");
    const commitCommand = await import("../commit-command");
    const pushCommand = await import("../push-command");
    
    expect(cloneCommand).toBeDefined();
    expect(branchCommand).toBeDefined();
    expect(commitCommand).toBeDefined();
    expect(pushCommand).toBeDefined();
  });

  test("should be able to import subcommands", async () => {
    // Test subcommand imports
    const subcommands = await import("../subcommands/index");
    
    expect(subcommands).toBeDefined();
  });
}); 
