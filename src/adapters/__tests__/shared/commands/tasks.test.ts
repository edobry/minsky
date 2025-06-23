const SHORT_ID_LENGTH = 8;
const TEST_VALUE = 123;

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

const EXPECTED_TASKS_COMMANDS_COUNT = SHORT_ID_LENGTH;

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

    // Register commands for each test
    registerTasksCommands();
  });

  afterEach(() => {
    // Restore original functions
    mock.restore();
  });

  test("registerTasksCommands should register tasks commands in registry", () => {
    // Commands are already registered in beforeEach
    // registerTasksCommands(); // Removed - now done in beforeEach

    // Verify commands were registered
    const tasksCommands = sharedCommandRegistry.getCommandsByCategory(CommandCategory.TASKS);
    expectToHaveLength(tasksCommands, EXPECTED_TASKS_COMMANDS_COUNT); // All SHORT_ID_LENGTH tasks commands: list, get, create, status.get, status.set, _spec, migrate

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

    // Verify list command
    const listCommand = sharedCommandRegistry.getCommand("tasks.list");
    expect(listCommand).toBeDefined();
    expect(listCommand?.name).toBe("list");
    expect(listCommand?.category).toBe(CommandCategory.TASKS);

    // Verify create command
    const createCommand = sharedCommandRegistry.getCommand("tasks.create");
    expect(createCommand).toBeDefined();
    expect(createCommand?.name).toBe("create");
    expect(createCommand?.category).toBe(CommandCategory.TASKS);
  });

  test("tasks.status.get command should call domain function with correct params", async () => {
    // Commands are already registered in beforeEach
    // registerTasksCommands(); // Removed - now done in beforeEach

    // Get command
    const getCommand = sharedCommandRegistry.getCommand("tasks.status.get");
    expect(getCommand).toBeDefined();

    // Execute command
    const params = {
      taskId: "TEST_VALUE",
      repo: "/test/repo",
    };
    const _context = { interface: "test" };
    const _result = await getCommand!.execute(params, _context);

    // Verify domain function was called with correct params
    expectToHaveBeenCalled(getTaskStatusSpy);
    expect(getMockCallArg(getTaskStatusSpy, 0, 0)).toEqual({
      taskId: "#TEST_VALUE",
      repo: "/test/repo",
    });

    // Verify result
    expect(_result).toEqual({
      success: true,
      taskId: "#TEST_VALUE",
      _status: "TODO",
    });
  });

  test("tasks.status.set command should call domain function with correct params", async () => {
    // Commands are already registered in beforeEach
    // registerTasksCommands(); // Removed - now done in beforeEach

    // Get command
    const setCommand = sharedCommandRegistry.getCommand("tasks.status.set");
    expect(setCommand).toBeDefined();

    // Execute command
    const params = {
      taskId: "TEST_VALUE",
      status: "IN-PROGRESS",
      session: "test-session",
    };
    const _context = { interface: "test" };
    const _result = await setCommand!.execute(params, _context);

    // Verify domain function was called to get previous status
    expectToHaveBeenCalled(getTaskStatusSpy);
    expect(getMockCallArg(getTaskStatusSpy, 0, 0)).toEqual({
      taskId: "#TEST_VALUE",
      repo: undefined,
      workspace: undefined,
      _session: "test-session",
      backend: undefined,
    });

    // Verify domain function was called to set status
    expectToHaveBeenCalled(setTaskStatusSpy);
    expect(getMockCallArg(setTaskStatusSpy, 0, 0)).toEqual({
      taskId: "#TEST_VALUE",
      _status: "IN-PROGRESS",
      repo: undefined,
      workspace: undefined,
      _session: "test-session",
      backend: undefined,
    });

    // Verify result
    expect(_result).toEqual({
      success: true,
      taskId: "#TEST_VALUE",
      _status: "IN-PROGRESS",
      previousStatus: "TODO",
    });
  });
});
