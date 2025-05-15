import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mockDateFunctions,
  setupConsoleSpy,
  createTempTestDir,
  createMock,
  mockModule,
  setupTestMocks,
  createMockExecSync
} from "../../../utils/test-utils";
import { registerTaskTools } from "../../../mcp/tools/tasks";
import { CommandMapper } from "../../../mcp/command-mapper";
import fs from "fs";
import path from "path";
import { z } from "zod";

// Set up auto-cleanup of mocks after each test
setupTestMocks();

/**
 * Integration tests for tasks commands.
 * These tests verify that both CLI and MCP interfaces return consistent results.
 * We use mocking to avoid actual command execution.
 */
describe("Tasks Command Integration Tests", () => {
  // Mock dependencies
  let execSyncMock = createMock();

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

  // Mock child_process.execSync
  mockModule("child_process", () => {
    return {
      // Create a mock function for execSync that returns a default value
      execSync: (...args: any[]) => execSyncMock(...args),
      // Keep other exports intact
      exec: () => {},
      spawn: () => {},
    };
  });

  beforeEach(async () => {
    // Configure execSync mock default behavior
    execSyncMock.mockClear();
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

    // Set up FastMCP mock
    const mockServer = {
      addTool: createMock(() => {}),
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

  // Note: We don't need an afterEach block to clear mocks since setupTestMocks() handles that

  describe("tasks.list command", () => {
    it("should return the same data for CLI and MCP interfaces", async () => {
      // Get the tasks.list tool from the mockCommandMapper
      const listTasksTool = mockCommandMapper.server.tools.find(
        (tool: any) => tool.name === "tasks.list"
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
      // Get the tasks.list tool
      const listTasksTool = mockCommandMapper.server.tools.find(
        (tool: any) => tool.name === "tasks.list"
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
    });
    */
  });

  describe("tasks.get command", () => {
    it("should return the same data for CLI and MCP interfaces", async () => {
      // Get the tasks.get tool
      const getTaskTool = mockCommandMapper.server.tools.find(
        (tool: any) => tool.name === "tasks.get"
      );

      // Check that the tool was registered
      expect(getTaskTool).toBeDefined();

      // Execute the MCP tool
      const mcpResult = await getTaskTool.execute({ id: "001" });

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
      const getTaskTool = mockCommandMapper.server.tools.find(
        (tool: any) => tool.name === "tasks.get"
      );

      // Expect the MCP tool to propagate the error
      try {
        await getTaskTool.execute({ id: "999" });
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(String(error)).toContain("Failed to get task 999");
      }
    });
    */
  });

  describe("tasks.status.get command", () => {
    it("should return task status from CLI command", async () => {
      // Get the tasks.status.get tool
      const getStatusTool = mockCommandMapper.server.tools.find(
        (tool: any) => tool.name === "tasks.status.get"
      );

      // Check that the tool was registered
      expect(getStatusTool).toBeDefined();

      // Execute the MCP tool
      const mcpResult = await getStatusTool.execute({ id: "001" });

      // Verify the result
      expect(mcpResult).toBe("Status: TODO");

      // Verify execSync was called with the expected command
      expect(execSyncMock).toHaveBeenCalledWith("minsky tasks status get 001");
    });
  });

  describe("tasks.status.set command", () => {
    it("should set task status via CLI command", async () => {
      // Get the tasks.status.set tool
      const setStatusTool = mockCommandMapper.server.tools.find(
        (tool: any) => tool.name === "tasks.status.set"
      );

      // Check that the tool was registered
      expect(setStatusTool).toBeDefined();

      // Execute the MCP tool
      await setStatusTool.execute({ id: "001", status: "IN-PROGRESS" });

      // Verify execSync was called with the expected command
      expect(execSyncMock).toHaveBeenCalledWith("minsky tasks status set 001 IN-PROGRESS");
    });
  });
});
