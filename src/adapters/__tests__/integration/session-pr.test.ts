import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { createPrCommand } from "../../../adapters/cli/session";
import { Command } from "commander";
import * as domain from "../../../domain"; 
import { getCurrentSessionContext } from "../../../domain/workspace";

// Mock the domain module
mock.module("../../../domain/index.js", () => ({
  preparePrFromParams: mock(() => Promise.resolve({
    prBranch: "pr/test-branch",
    baseBranch: "main",
    title: "Test PR Title"
  })),
  // Include other exports that might be used
  ...domain
}));

// Mock the workspace module
mock.module("../../../domain/workspace.js", () => ({
  getCurrentSessionContext: mock(() => Promise.resolve({
    sessionId: "test-session",
    workspacePath: "/test/session/path"
  }))
}));

describe("Session PR Command", () => {
  // Capture console output
  const originalConsoleLog = console.log;
  const consoleOutput: string[] = [];

  beforeEach(() => {
    // Mock console.log to capture output
    console.log = (...args: any[]) => {
      consoleOutput.push(args.join(" "));
    };
    consoleOutput.length = 0;
  });

  afterEach(() => {
    // Restore original console.log
    console.log = originalConsoleLog;
    mock.restoreAll();
  });

  test("session pr command creates PR with auto-detected session", async () => {
    // Create the command
    const command = createPrCommand();
    
    // Mock the action execution to capture the action function
    const originalAction = command.action;
    let actionFn: Function | null = null;
    
    // Override action to capture the function
    command.action = function(fn: Function) {
      actionFn = fn;
      return this;
    };
    
    // Call the override
    createPrCommand();
    
    // Restore the original action
    command.action = originalAction;
    
    // Make sure we captured the action function
    expect(actionFn).not.toBeNull();
    
    // Call the action function with sample options
    if (actionFn) {
      await actionFn({
        title: "Test PR Title",
        base: "main",
        debug: false,
        json: false
      });
    }
    
    // Verify that getCurrentSessionContext was called
    expect((getCurrentSessionContext as any).mock.calls.length).toBe(1);
    
    // Verify that preparePrFromParams was called with expected parameters
    expect((domain.preparePrFromParams as any).mock.calls.length).toBe(1);
    expect((domain.preparePrFromParams as any).mock.calls[0][0]).toEqual({
      session: "test-session",
      baseBranch: "main",
      title: "Test PR Title",
      body: undefined,
      branchName: undefined,
      debug: false
    });
    
    // Verify appropriate output was produced
    expect(consoleOutput.length).toBeGreaterThan(0);
    expect(consoleOutput.some(line => line.includes("Auto-detected session: test-session"))).toBe(true);
    expect(consoleOutput.some(line => line.includes("Created PR branch pr/test-branch"))).toBe(true);
  });

  test("session pr command handles missing session context", async () => {
    // Override getCurrentSessionContext to return null
    (getCurrentSessionContext as any).mockImplementation(() => Promise.resolve(null));
    
    // Create and capture the command action
    const command = createPrCommand();
    const originalAction = command.action;
    let actionFn: Function | null = null;
    
    command.action = function(fn: Function) {
      actionFn = fn;
      return this;
    };
    
    createPrCommand();
    command.action = originalAction;
    
    expect(actionFn).not.toBeNull();
    
    // Execute the action with no session context
    if (actionFn) {
      let error: Error | null = null;
      try {
        await actionFn({
          title: "Test PR Title",
          base: "main"
        });
      } catch (e) {
        error = e as Error;
      }
      
      // Should throw an error about missing session
      expect(error).not.toBeNull();
      expect(error?.message).toContain("Could not auto-detect session");
    }
  });
}); 
