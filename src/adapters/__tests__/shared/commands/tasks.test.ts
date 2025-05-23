/**
 * Shared Tasks Commands Tests
 * @migrated Migrated to native Bun patterns
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { registerTasksCommands } from "../../../../adapters/shared/commands/tasks.js";
import {
  sharedCommandRegistry,
  CommandCategory,
} from "../../../../adapters/shared/command-registry.js";
import * as tasksDomain from "../../../../domain/tasks.js";
import {
  expectToHaveLength,
  expectToHaveBeenCalled,
  getMockCallArg,
} from "../../../../utils/test-utils/assertions.js";

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
    mock.restore();
  });

  test("DEBUG: check what commands are in registry", () => {
    console.log("All commands in registry:");
    const allCommands = sharedCommandRegistry.getAllCommands();
    console.log("Total commands:", allCommands.length);
    allCommands.forEach((cmd) => {
      console.log(`- ${cmd.id} (${cmd.category})`);
    });

    console.log("\nTasks category commands:");
    const tasksCommands = sharedCommandRegistry.getCommandsByCategory(CommandCategory.TASKS);
    console.log("Tasks commands count:", tasksCommands.length);
    tasksCommands.forEach((cmd) => {
      console.log(`- ${cmd.id} (${cmd.name})`);
    });
  });

  test("registerTasksCommands should register tasks commands in registry", () => {
    // Register commands
    registerTasksCommands();

    // Verify commands were registered
    const tasksCommands = sharedCommandRegistry.getCommandsByCategory(CommandCategory.TASKS);
    expectToHaveLength(tasksCommands, 5); // 2 status commands (inline) + 3 from registerTasksCommands

    // Verify list command
    const listCommand = sharedCommandRegistry.getCommand("tasks.list");
    expect(listCommand).toBeDefined();
    expect(listCommand?.name).toBe("list");
    expect(listCommand?.category).toBe(CommandCategory.TASKS);

    // Verify get command
    const getCommand = sharedCommandRegistry.getCommand("tasks.get");
    expect(getCommand).toBeDefined();
    expect(getCommand?.name).toBe("get");
    expect(getCommand?.category).toBe(CommandCategory.TASKS);

    // Verify create command
    const createCommand = sharedCommandRegistry.getCommand("tasks.create");
    expect(createCommand).toBeDefined();
    expect(createCommand?.name).toBe("create");
    expect(createCommand?.category).toBe(CommandCategory.TASKS);
  });

  test("tasks.status.get command should call domain function with correct params", async () => {
    // The status commands are registered inline when the module loads, not by registerTasksCommands
    // So we don't need to call registerTasksCommands() for these

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
    expectToHaveBeenCalled(getTaskStatusSpy);
    expect(getMockCallArg(getTaskStatusSpy, 0, 0)).toEqual({
      taskId: "123",
      repo: "/test/repo",
      session: undefined,
    });

    // Verify result
    expect(result).toBe("TODO");
  });

  test("tasks.status.set command should call domain function with correct params", async () => {
    // The status commands are registered inline when the module loads, not by registerTasksCommands
    // So we don't need to call registerTasksCommands() for these

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

    // Verify domain function was called to set status
    expectToHaveBeenCalled(setTaskStatusSpy);
    expect(getMockCallArg(setTaskStatusSpy, 0, 0)).toEqual({
      taskId: "123",
      status: "IN-PROGRESS",
      repo: undefined,
      session: "test-session",
    });

    // The setTaskStatusFromParams function doesn't return the previous status,
    // so we just verify it was called
    expect(result).toBeUndefined();
  });
});
