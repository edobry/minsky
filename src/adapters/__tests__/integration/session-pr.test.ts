import { describe, test, expect, beforeEach, afterEach, jest } from "bun:test";
import { createPrCommand } from "../../../adapters/cli/session";
import { Command } from "commander";
import * as domain from "../../../domain";
import * as workspace from "../../../domain/workspace";

describe("Session PR Command", () => {
  // Mock domain dependencies
  const preparePrFromParamsMock = jest.fn().mockResolvedValue({
    prBranch: "pr/test-branch",
    baseBranch: "main",
    title: "Test PR Title"
  });
  
  // Mock workspace dependencies
  const getCurrentSessionContextMock = jest.fn().mockResolvedValue({
    sessionId: "test-session",
    workspacePath: "/test/session/path"
  });
  
  // Capture console output
  const originalConsoleLog = console.log;
  const consoleOutput: string[] = [];

  beforeEach(() => {
    // Set up mocks
    (domain as any).preparePrFromParams = preparePrFromParamsMock;
    (workspace as any).getCurrentSessionContext = getCurrentSessionContextMock;
    
    // Mock console.log to capture output
    console.log = (...args: any[]) => {
      consoleOutput.push(args.join(" "));
    };
    consoleOutput.length = 0;
    
    // Clear mock call history
    preparePrFromParamsMock.mockClear();
    getCurrentSessionContextMock.mockClear();
  });

  afterEach(() => {
    // Restore original console.log
    console.log = originalConsoleLog;
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
    expect(actionFn !== null).toBe(true);
    
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
    expect(getCurrentSessionContextMock.mock.calls.length).toBeGreaterThan(0);
    
    // Verify that preparePrFromParams was called with expected parameters
    expect(preparePrFromParamsMock.mock.calls.length).toBeGreaterThan(0);
    expect(preparePrFromParamsMock.mock.calls[0][0]).toEqual({
      session: "test-session",
      baseBranch: "main",
      title: "Test PR Title",
      body: undefined,
      branchName: undefined,
      debug: false
    });
    
    // Verify appropriate output was produced
    expect(consoleOutput.length).toBeGreaterThan(0);
    
    // Find lines containing expected output
    const sessionDetectedLine = consoleOutput.find(line => line.includes("Auto-detected session: test-session"));
    const branchCreatedLine = consoleOutput.find(line => line.includes("Created PR branch pr/test-branch"));
    
    expect(sessionDetectedLine !== undefined).toBe(true);
    expect(branchCreatedLine !== undefined).toBe(true);
  });

  test("session pr command handles missing session context", async () => {
    // Override getCurrentSessionContext to return null
    getCurrentSessionContextMock.mockResolvedValueOnce(null);
    
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
    
    expect(actionFn !== null).toBe(true);
    
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
      expect(error !== null).toBe(true);
      if (error) {
        expect(error.message.includes("Could not auto-detect session")).toBe(true);
      }
    }
  });
}); 
