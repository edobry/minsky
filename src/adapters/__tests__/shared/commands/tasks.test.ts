/**
 * Shared Tasks Commands Tests
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { registerTasksCommands } from "../../../../adapters/shared/commands/tasks.js";
import { sharedCommandRegistry, CommandCategory } from "../../../../adapters/shared/command-registry.js";
import * as tasksDomain from "../../../../domain/tasks.js";

describe("Shared Tasks Commands", () => {
  // Set up spies for domain functions
  let getTaskStatusSpy: ReturnType<typeof spyOn>;
  let setTaskStatusSpy: ReturnType<typeof spyOn>;
  
  beforeEach(() => {
    // Set up spies
    getTaskStatusSpy = spyOn(tasksDomain, "getTaskStatusFromParams").mockImplementation(() => 
      Promise.resolve("TODO")
    );
    
    setTaskStatusSpy = spyOn(tasksDomain, "setTaskStatusFromParams").mockImplementation(() => 
      Promise.resolve()
    );
    
    // Clear the registry (this is a hacky way to do it since there's no clear method,
    // but it works for testing)
    (sharedCommandRegistry as any).commands = new Map();
  });

  afterEach(() => {
    // Restore original functions
    getTaskStatusSpy.mockRestore();
    setTaskStatusSpy.mockRestore();
  });

  test("registerTasksCommands should register tasks commands in registry", () => {
    // Register commands
    registerTasksCommands();
    
    // Verify commands were registered
    const tasksCommands = sharedCommandRegistry.getCommandsByCategory(CommandCategory.TASKS);
    expect(tasksCommands.length).toBe(2);
    
    // Verify status get command
    const getCommand = sharedCommandRegistry.getCommand("tasks.status.get");
    expect(getCommand).toBeDefined();
    expect(getCommand?.name).toBe("status get");
    expect(getCommand?.category).toBe(CommandCategory.TASKS);
    
    // Verify status set command
    const setCommand = sharedCommandRegistry.getCommand("tasks.status.set");
    expect(setCommand).toBeDefined();
    expect(setCommand?.name).toBe("status set");
    expect(setCommand?.category).toBe(CommandCategory.TASKS);
  });

  test("tasks.status.get command should call domain function with correct params", async () => {
    // Register commands
    registerTasksCommands();
    
    // Get command
    const getCommand = sharedCommandRegistry.getCommand("tasks.status.get");
    expect(getCommand).toBeDefined();
    
    // Execute command
    const params = {
      taskId: "123",
      repo: "/test/repo",
    };
    const context = { interface: "test" };
    const result = await getCommand!.execute(params, context);
    
    // Verify domain function was called with correct params
    expect(getTaskStatusSpy).toHaveBeenCalledWith({
      taskId: "123",
      repo: "/test/repo",
      session: undefined,
    });
    
    // Verify result
    expect(result).toEqual({
      success: true,
      taskId: "123",
      status: "TODO",
    });
  });

  test("tasks.status.set command should call domain function with correct params", async () => {
    // Register commands
    registerTasksCommands();
    
    // Get command
    const setCommand = sharedCommandRegistry.getCommand("tasks.status.set");
    expect(setCommand).toBeDefined();
    
    // Execute command
    const params = {
      taskId: "123",
      status: "IN-PROGRESS",
      session: "test-session",
    };
    const context = { interface: "test" };
    const result = await setCommand!.execute(params, context);
    
    // Verify domain function was called to get previous status
    expect(getTaskStatusSpy).toHaveBeenCalledWith({
      taskId: "123",
      repo: undefined,
      session: "test-session",
    });
    
    // Verify domain function was called to set status
    expect(setTaskStatusSpy).toHaveBeenCalledWith({
      taskId: "123",
      status: "IN-PROGRESS",
      repo: undefined,
      session: "test-session",
    });
    
    // Verify result
    expect(result).toEqual({
      success: true,
      taskId: "123",
      status: "IN-PROGRESS",
      previousStatus: "TODO",
    });
  });
}); 
