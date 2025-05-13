import { describe, it, expect, mock, beforeEach, afterEach, jest, spyOn } from "bun:test";
import { mockDateFunctions, setupConsoleSpy, createTempTestDir } from "../../../utils/test-utils";
import { execSync } from "child_process";
import type { ExecSyncOptionsWithStringEncoding } from "child_process";
import { registerTaskTools } from "../../../mcp/tools/tasks";
import { CommandMapper } from "../../../mcp/command-mapper";
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";

/**
 * Integration tests for tasks commands.
 * These tests verify that both CLI and MCP interfaces return consistent results.
 * We use mocking to avoid actual command execution.
 */
describe("Tasks Command Integration Tests", () => {
  // Mock dependencies
  let execSyncMock: jest.Mock<typeof execSync>;
  let consoleErrorSpy: any; // Simplify type to bypass complex type issues for now

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
  let mockServerInstance: { addTool: jest.Mock, tools?: any[] }; // Simpler Mock type

  beforeEach(() => {
    // Set up mock function. Default to returning string, as most CLI --json commands do.
    execSyncMock = jest.fn<typeof execSync>((command: string, options?: any) => {
      // This is a simplified mock implementation.
      // It assumes commands being tested return strings (e.g., JSON output).
      // If a test needs Buffer output, this mock would need to be more specific for that call.
      if (command.includes("minsky tasks list")) return mockTaskListResponse as any;
      if (command.includes("minsky tasks get")) return mockTaskGetResponse as any;
      if (command.includes("minsky tasks status get")) return "Status: TODO" as any;
      if (command.includes("minsky tasks status set")) return "Status updated" as any;
      return Buffer.from("") as any; // Default fallback for other commands
    });

    // Mock console.error
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});

    // Set up FastMCP mock
    mockServerInstance = {
      addTool: jest.fn<any>(() => {}),
    };

    mockCommandMapper = new CommandMapper(mockServerInstance as any);

    // Register task tools with mock command mapper
    registerTaskTools(mockCommandMapper);
  });

  afterEach(() => {
    execSyncMock.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe("tasks.list command", () => {
    it("should return the same data for CLI and MCP interfaces", async () => {
      expect(mockServerInstance.addTool.mock.calls.length).toBeGreaterThan(0);
      const listToolCallArgs = mockServerInstance.addTool.mock.calls.find((call: any) => call[0].name === "tasks.list")?.[0];
      expect(listToolCallArgs).toBeDefined();
      expect(listToolCallArgs.name).toBe("tasks.list");
      
      const addToolCalls = mockServerInstance.addTool.mock.calls;
      const listToolCall = addToolCalls.find((call: any) => call[0].name === "tasks.list");
      expect(listToolCall).toBeDefined();
      const listToolDefinition = listToolCall![0];

      const mcpResult = await listToolDefinition.execute({});
      const mcpTasks = JSON.parse(mcpResult);
      const cliTasks = JSON.parse(mockTaskListResponse);
      expect(mcpTasks).toEqual(cliTasks);
      expect(execSyncMock).toHaveBeenCalledWith("minsky tasks list --json");
    });

    it("should handle filtering by status properly", async () => {
      expect(mockServerInstance.addTool.mock.calls.length).toBeGreaterThan(0);
      const listToolCallArgs = mockServerInstance.addTool.mock.calls.find((call: any) => call[0].name === "tasks.list")?.[0];
      expect(listToolCallArgs).toBeDefined(); 
      expect(listToolCallArgs.name).toBe("tasks.list"); 

      const addToolCalls = mockServerInstance.addTool.mock.calls;
      const listToolCall = addToolCalls.find((call: any) => call[0].name === "tasks.list");
      expect(listToolCall).toBeDefined();
      const listToolDefinition = listToolCall![0];

      await listToolDefinition.execute({ filter: "TODO" });
      expect(execSyncMock).toHaveBeenCalledWith("minsky tasks list --filter TODO --json");
    });

    it("should handle error conditions consistently", async () => {
      const testError = new Error("Command failed");
      execSyncMock.mockImplementation(() => { throw testError; });

      const addToolCalls = mockServerInstance.addTool.mock.calls;
      const listToolCall = addToolCalls.find((call: any) => call[0].name === "tasks.list");
      expect(listToolCall).toBeDefined();
      const listToolDefinition = listToolCall![0];

      try {
        await listToolDefinition.execute({});
        expect(true).toBe(false); 
      } catch (error) {
        expect(String(error)).toContain("Error executing command tasks.list"); 
      }
      expect(consoleErrorSpy.mock.calls.length).toBeGreaterThan(0);
    });
  });

  describe("tasks.get command", () => {
    it("should return the same data for CLI and MCP interfaces", async () => {
      expect(mockServerInstance.addTool.mock.calls.length).toBeGreaterThan(0);
      const getToolCallArgs = mockServerInstance.addTool.mock.calls.find((call: any) => call[0].name === "tasks.get")?.[0];
      expect(getToolCallArgs).toBeDefined();
      expect(getToolCallArgs.name).toBe("tasks.get");

      const addToolCalls = mockServerInstance.addTool.mock.calls;
      const getToolCall = addToolCalls.find((call: any) => call[0].name === "tasks.get");
      expect(getToolCall).toBeDefined();
      const getToolDefinition = getToolCall![0];

      const mcpResult = await getToolDefinition.execute({ taskId: "001" });
      const mcpTask = JSON.parse(mcpResult);
      const cliTask = JSON.parse(mockTaskGetResponse);
      expect(mcpTask).toEqual(cliTask);
      expect(execSyncMock).toHaveBeenCalledWith("minsky tasks get 001 --json");
    });

    it("should handle error conditions consistently", async () => {
      const testError = new Error("Task not found");
      execSyncMock.mockImplementation(() => { throw testError; });

      const addToolCalls = mockServerInstance.addTool.mock.calls;
      const getToolCall = addToolCalls.find((call: any) => call[0].name === "tasks.get");
      expect(getToolCall).toBeDefined();
      const getToolDefinition = getToolCall![0];

      try {
        await getToolDefinition.execute({ taskId: "999" });
        expect(true).toBe(false); 
      } catch (error) {
        expect(String(error)).toContain("Error executing command tasks.get");
      }
      expect(consoleErrorSpy.mock.calls.length).toBeGreaterThan(0);
    });
  });

  describe("tasks.status commands", () => {
    it("should get task status consistently", async () => {
      expect(mockServerInstance.addTool.mock.calls.length).toBeGreaterThan(0);
      const getStatusToolCallArgs = mockServerInstance.addTool.mock.calls.find((call: any) => call[0].name === "tasks.status.get")?.[0];
      expect(getStatusToolCallArgs).toBeDefined();
      expect(getStatusToolCallArgs.name).toBe("tasks.status.get");
      
      const addToolCalls = mockServerInstance.addTool.mock.calls;
      const getStatusToolCall = addToolCalls.find((call: any) => call[0].name === "tasks.status.get");
      expect(getStatusToolCall).toBeDefined();
      const getStatusToolDefinition = getStatusToolCall![0];

      const result = await getStatusToolDefinition.execute({ taskId: "001" });
      expect(result).toEqual({
        taskId: "001",
        status: "TODO",
      });
      expect(execSyncMock).toHaveBeenCalledWith("minsky tasks status get 001");
    });

    it("should set task status consistently", async () => {
      expect(mockServerInstance.addTool.mock.calls.length).toBeGreaterThan(0);
      const setStatusToolCallArgs = mockServerInstance.addTool.mock.calls.find((call: any) => call[0].name === "tasks.status.set")?.[0];
      expect(setStatusToolCallArgs).toBeDefined();
      expect(setStatusToolCallArgs.name).toBe("tasks.status.set");

      const addToolCalls = mockServerInstance.addTool.mock.calls;
      const setStatusToolCall = addToolCalls.find((call: any) => call[0].name === "tasks.status.set");
      expect(setStatusToolCall).toBeDefined();
      const setStatusToolDefinition = setStatusToolCall![0];

      const result = await setStatusToolDefinition.execute({ taskId: "001", status: "IN_PROGRESS" });
      expect(result).toEqual({
        success: true,
        taskId: "001",
        status: "IN_PROGRESS",
      });
      expect(execSyncMock).toHaveBeenCalledWith("minsky tasks status set 001 IN_PROGRESS");
    });
  });
});
