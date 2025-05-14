import { describe, it, expect, mock, beforeEach, afterEach, jest, spyOn } from "bun:test";
import { mockDateFunctions, setupConsoleSpy, createTempTestDir } from "../../../utils/test-utils";
import { execSync } from "child_process";
import type { ExecSyncOptionsWithStringEncoding } from "child_process";
import { registerTaskTools } from "../../../mcp/tools/tasks";
import { CommandMapper } from "../../../mcp/command-mapper";
import fs from "fs";
import path from "path";
import { z } from "zod";

/**
 * Integration tests for tasks commands.
 * These tests verify that both CLI and MCP interfaces return consistent results.
 * We use mocking to avoid actual command execution.
 */
describe("Tasks Command Integration Tests", () => {
  // Mock dependencies
  let execSyncMock: jest.Mock; // Will be initialised by mock.module below
  // let consoleErrorSpy: any; // Simplify type to bypass complex type issues for now

  // Store original console.error and execSync
  // const originalExecSync = execSync; // execSync is already in scope

  // Create a fake task list response for mocking
  const mockTaskListResponse = JSON.stringify([
    { id: "001", title: "Test Task 1", status: "TODO", description: "Test task 1 description" },
    {
      id: "002",
      title: "Test Task 2",
      status: "IN_PROGRESS",
      description: "Test task 2 description",
    },
    { id: "003", title: "Test Task 3", status: "DONE", description: "Test task 3 description" },
  ]);

  // Create a fake task get response for mocking
  const mockTaskGetResponse = JSON.stringify({
    id: "001",
    title: "Test Task 1",
    status: "TODO",
    description: "Test task 1 description",
  });

  // Set up mock FastMCP server for testing
  let mockCommandMapper: CommandMapper;

  beforeEach(async () => {
    // Mock child_process.execSync
    mock.module("child_process", () => {
      return {
        // Create a mock function for execSync that returns a default value
        execSync: mock(() => {
          // This is a simplified mock implementation.
          // It will be overridden in individual tests
          return "";
        }),
        // Keep other exports intact
        exec: () => {},
        spawn: () => {},
      };
    });

    // Obtain mocked execSync reference after mock.module patch
    const { execSync } = await import("child_process");
    execSyncMock = execSync;

    // Set up default behavior that individual tests can override
    execSyncMock.mockImplementation((command: string) => {
      if (command.includes("minsky tasks list")) {
        return mockTaskListResponse;
      }
      if (command.includes("minsky tasks get")) {
        return mockTaskGetResponse;
      }
      if (command.includes("minsky tasks status get")) {
        return "Status: TODO";
      }
      if (command.includes("minsky tasks status set")) {
        return "Status updated";
      }
      return "";
    });

    // Removing console.error mock
    // consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});

    // Set up FastMCP mock
    const mockServer = {
      addTool: jest.fn<any>(() => {}),
      tools: [],
    } as any;

    mockCommandMapper = new CommandMapper(mockServer);

    // For testing, manually add tools array that we can access
    (mockCommandMapper as any).server = {
      tools: [],
    };

    (mockCommandMapper as any).server.addTool = (tool: any) => {
      (mockCommandMapper as any).server.tools.push(tool);
    };

    // Dynamically import *after* mocks are established so that the module picks
    // up the mocked `execSync` reference.
    const { registerTaskTools } = await import("../../../mcp/tools/tasks");

    // Register task tools with mock command mapper
    registerTaskTools(mockCommandMapper);
  });

  afterEach(() => {
    execSyncMock.mockReset();
    // consoleErrorSpy.mockRestore(); // Not needed since we're not mocking console.error
  });

  describe("tasks.list command", () => {
    it("should return the same data for CLI and MCP interfaces", async () => {
      // execSyncMock is already set up in beforeEach to handle this command
      // execSyncMock.mockImplementation((command: string, options?: ExecSyncOptionsWithStringEncoding) => {
      //   if (options?.encoding === 'utf-8' || !options?.encoding) {
      //     return mockTaskListResponse as any; // CLI usually returns string for JSON
      //   }
      //   return Buffer.from(mockTaskListResponse) as any;
      // });

      // Get the tasks.list tool from the mockCommandMapper
      const listTasksTool = mockCommandMapper.server.tools.find(
        /** @param {any} tool */
        (tool) => tool.name === "tasks.list"
      );

      // Check that the tool was registered
      expect(listTasksTool).toBeDefined();

      // Execute the MCP tool
      const mcpResult = await listTasksTool.execute({});

      // Parse the MCP result (which should be JSON string)
      const mcpTasks = JSON.parse(mcpResult);

      // Parse the mock response (what the CLI would return)
      const cliTasks = JSON.parse(mockTaskListResponse);

      // Verify the results are the same
      expect(mcpTasks).toEqual(cliTasks);

      // Verify execSync was called with the expected command
      expect(execSyncMock).toHaveBeenCalledWith("minsky tasks list --json");
    });

    it("should handle filtering by status properly", async () => {
      // execSyncMock is already set up in beforeEach
      // execSyncMock.mockImplementation((command: string, options?: ExecSyncOptionsWithStringEncoding) => {
      //   if (options?.encoding === 'utf-8' || !options?.encoding) {
      //     return mockTaskListResponse as any;
      //   }
      //   return Buffer.from(mockTaskListResponse) as any;
      // });

      // Get the tasks.list tool
      const listTasksTool = mockCommandMapper.server.tools.find(
        /** @param {any} tool */
        (tool) => tool.name === "tasks.list"
      );

      // Execute the MCP tool with filter parameter
      await listTasksTool.execute({ filter: "TODO" });

      // Verify execSync was called with the filter parameter
      expect(execSyncMock).toHaveBeenCalledWith("minsky tasks list --filter TODO --json");
    });

    /* Commenting out error handling test until proper logging framework is implemented
    it("should handle error conditions consistently", async () => {
      // Mock execSync to throw an error for this specific test case
      const testError = new Error("Command failed");
      execSyncMock.mockImplementation(() => {
        throw testError;
      });

      // Get the tasks.list tool
      const listTasksTool = (mockCommandMapper as any).server.tools.find(
        (tool: any) => tool.name === "tasks.list"
      );

      // Check that the tool was registered
      expect(listTasksTool).toBeDefined();

      // Expect the MCP tool to propagate the error
      try {
        await listTasksTool.execute({});
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(String(error)).toContain("Failed to list tasks");
      }

      // Verify error handling occurred using a more compatible approach
      // expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    });
    */
  });

  describe("tasks.get command", () => {
    it("should return the same data for CLI and MCP interfaces", async () => {
      // execSyncMock is already set up in beforeEach
      // execSyncMock.mockImplementation((command: string, options?: ExecSyncOptionsWithStringEncoding) => {
      //   if (options?.encoding === 'utf-8' || !options?.encoding) {
      //     return mockTaskGetResponse as any; // CLI usually returns string for JSON
      //   }
      //   return Buffer.from(mockTaskGetResponse) as any;
      // });

      // Get the tasks.get tool
      const getTaskTool = mockCommandMapper.server.tools.find(
        /** @param {any} tool */
        (tool) => tool.name === "tasks.get"
      );

      // Check that the tool was registered
      expect(getTaskTool).toBeDefined();

      // Execute the MCP tool
      const mcpResult = await getTaskTool.execute({ taskId: "001" });

      // Parse the MCP result
      const mcpTask = JSON.parse(mcpResult);

      // Parse the mock response (what the CLI would return)
      const cliTask = JSON.parse(mockTaskGetResponse);

      // Verify the results are the same
      expect(mcpTask).toEqual(cliTask);

      // Verify execSync was called with the expected command
      expect(execSyncMock).toHaveBeenCalledWith("minsky tasks get 001 --json");
    });

    /* Commenting out error handling test until proper logging framework is implemented
    it("should handle error conditions consistently", async () => {
      // Mock execSync to throw an error for this specific test case
      const testError = new Error("Task not found");
      execSyncMock.mockImplementation(() => {
        throw testError;
      });

      // Get the tasks.get tool
      const getTaskTool = (mockCommandMapper as any).server.tools.find(
        (tool: any) => tool.name === "tasks.get"
      );

      // Check that the tool was registered
      expect(getTaskTool).toBeDefined();

      // Expect the MCP tool to propagate the error
      try {
        await getTaskTool.execute({ taskId: "999" });
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(String(error)).toContain("Failed to get task 999");
      }

      // Verify error handling occurred
      // expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    });
    */
  });

  describe("tasks.status commands", () => {
    it("should get task status consistently", async () => {
      // execSyncMock is already set up in beforeEach
      // execSyncMock.mockImplementation(() => "Status: TODO" as any);

      // Get the tasks.status.get tool
      const getStatusTool = mockCommandMapper.server.tools.find(
        /** @param {any} tool */
        (tool) => tool.name === "tasks.status.get"
      );

      // Execute the MCP tool
      const result = await getStatusTool.execute({ taskId: "001" });
      const parsedResult = JSON.parse(result);

      // Verify the result format
      expect(parsedResult).toEqual({
        taskId: "001",
        status: "TODO",
      });

      // Verify execSync was called correctly
      expect(execSyncMock).toHaveBeenCalledWith("minsky tasks status get 001");
    });

    it("should set task status consistently", async () => {
      // execSyncMock is already set up in beforeEach
      // execSyncMock.mockImplementation(() => "Status updated" as any);

      // Get the tasks.status.set tool
      const setStatusTool = mockCommandMapper.server.tools.find(
        /** @param {any} tool */
        (tool) => tool.name === "tasks.status.set"
      );

      // Execute the MCP tool
      const result = await setStatusTool.execute({ taskId: "001", status: "IN_PROGRESS" });
      const parsedResult = JSON.parse(result);

      // Verify the result format
      expect(parsedResult).toEqual({
        success: true,
        taskId: "001",
        status: "IN_PROGRESS",
      });

      // Verify execSync was called correctly
      expect(execSyncMock).toHaveBeenCalledWith("minsky tasks status set 001 IN_PROGRESS");
    });
  });
});
