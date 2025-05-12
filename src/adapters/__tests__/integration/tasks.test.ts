const { describe, it, expect, mock, beforeEach, afterEach } = require("bun:test");
const { mockDateFunctions, setupConsoleSpy, createTempTestDir } = require("../../../utils/test-utils");
const { execSync } = require("child_process");
const { registerTaskTools } = require("../../../mcp/tools/tasks");
const { CommandMapper } = require("../../../mcp/command-mapper");
const fs = require("fs");
const path = require("path");
const { z } = require("zod");

/**
 * Integration tests for tasks commands.
 * These tests verify that both CLI and MCP interfaces return consistent results.
 * We use mocking to avoid actual command execution.
 */
describe("Tasks Command Integration Tests", () => {
  // Mock dependencies
  let execSyncMock;
  
  // Store original console.error and execSync
  const originalExecSync = execSync;
  const originalConsoleError = console.error;

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
  /** @type {any} */
  let mockCommandMapper;

  beforeEach(() => {
    // Set up mock function
    execSyncMock = mock(execSync);
    
    // Mock console.error
    console.error = mock(() => {});

    // Set up FastMCP mock
    const mockServer = {
      addTool: mock(() => {}),
      tools: []
    };
    
    mockCommandMapper = new CommandMapper(mockServer);
    
    // For testing, manually add tools array that we can access
    mockCommandMapper.server = {
      tools: []
    };
    
    // Mock the addTool method
    mockCommandMapper.server.addTool = (tool) => {
      mockCommandMapper.server.tools.push(tool);
    };

    // Register task tools with mock command mapper
    registerTaskTools(mockCommandMapper);
  });

  afterEach(() => {
    // Restore original functions
    console.error = originalConsoleError;
    mock.restore();
  });

  describe("tasks.list command", () => {
    it("should return the same data for CLI and MCP interfaces", async () => {
      // Mock execSync to return our predetermined response for tasks list
      execSyncMock.mockImplementation(() => mockTaskListResponse);

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
      // Mock execSync to return our predetermined response
      execSyncMock.mockImplementation(() => mockTaskListResponse);

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

    it("should handle error conditions consistently", async () => {
      // Mock execSync to throw an error
      const testError = new Error("Command failed");
      execSyncMock.mockImplementation(() => {
        throw testError;
      });

      // Get the tasks.list tool
      const listTasksTool = mockCommandMapper.server.tools.find(
        /** @param {any} tool */
        (tool) => tool.name === "tasks.list"
      );

      // Expect the MCP tool to propagate the error
      try {
        await listTasksTool.execute({});
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(String(error)).toContain("Failed to list tasks");
      }

      // Verify error handling occurred using a more compatible approach
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe("tasks.get command", () => {
    it("should return the same data for CLI and MCP interfaces", async () => {
      // Mock execSync to return our predetermined response for tasks get
      execSyncMock.mockImplementation(() => mockTaskGetResponse);

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

    it("should handle error conditions consistently", async () => {
      // Mock execSync to throw an error
      const testError = new Error("Task not found");
      execSyncMock.mockImplementation(() => {
        throw testError;
      });

      // Get the tasks.get tool
      const getTaskTool = mockCommandMapper.server.tools.find(
        /** @param {any} tool */
        (tool) => tool.name === "tasks.get"
      );

      // Expect the MCP tool to propagate the error
      try {
        await getTaskTool.execute({ taskId: "999" });
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(String(error)).toContain("Failed to get task 999");
      }

      // Verify error handling occurred
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe("tasks.status commands", () => {
    it("should get task status consistently", async () => {
      // Mock execSync to return a status response
      execSyncMock.mockImplementation(() => "Status: TODO");

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
      // Mock execSync to return success
      execSyncMock.mockImplementation(() => "Status updated");

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
