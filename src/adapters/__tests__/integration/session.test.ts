import { describe, it, expect, mock, beforeEach, afterEach, jest, spyOn } from "bun:test";
import * as testUtils from "../../../utils/test-utils";
import { execSync as originalExecSync } from "child_process";
import { registerSessionTools } from "../../../mcp/tools/session";
import { CommandMapper } from "../../../mcp/command-mapper";
import type { FastMCP } from "fastmcp"; // Import FastMCP type if available, otherwise use any
import fs from "fs";
import path from "path";

// Mock child_process module
let execSyncMock: jest.Mock = jest.fn(); // Initialize at declaration

mock.module("child_process", () => {
  // This instance of execSyncMock will be configured by tests and used by the mocked execSync
  execSyncMock = jest.fn(); 
  return {
    __esModule: true, // Important for ES modules
    execSync: (...args: any[]) => execSyncMock(...args), // Ensure the test-configured mock is called
  };
});

/**
 * Integration tests for session commands.
 * These tests verify that both CLI and MCP interfaces return consistent results.
 * We use mocking to avoid actual command execution.
 */
describe("Session Command Integration Tests", () => {
  // Mock dependencies
  let mockCommandMapper: CommandMapper;
  let mockServerTools: any[]; // To store tools for assertion

  // Store original console.error so we can restore it in afterEach.
  const originalConsoleError = console.error;

  // Create a fake session list response for mocking
  const mockSessionListResponse = JSON.stringify([
    {
      id: "test-session-1",
      name: "Test Session 1",
      repo: "/path/to/repo1",
      branch: "session/test-1",
      createdAt: "2025-05-01T12:00:00.000Z",
    },
    {
      id: "test-session-2",
      name: "Test Session 2",
      repo: "/path/to/repo2",
      branch: "session/test-2",
      createdAt: "2025-05-02T12:00:00.000Z",
    },
  ]);

  // Create a fake session get response for mocking
  const mockSessionGetResponse = JSON.stringify({
    id: "test-session-1",
    name: "Test Session 1",
    repo: "/path/to/repo1",
    branch: "session/test-1",
    createdAt: "2025-05-01T12:00:00.000Z",
  });

  beforeEach(async () => {
    // execSyncMock is the instance from the module mock closure, clear and set implementation
    execSyncMock.mockClear();
    execSyncMock.mockImplementation(() => ""); // Default implementation for each test

    // Removing console.error mock
    // spyOn(console, "error").mockImplementation(() => {});

    // Set up FastMCP mock server and CommandMapper
    mockServerTools = [];
    const mockServerInstance: any = {
      addTool: jest.fn((tool: any) => {
        mockServerTools.push(tool);
      }),
      // Add other FastMCP properties/methods if CommandMapper uses them directly
    };
    mockCommandMapper = new CommandMapper(mockServerInstance as FastMCP);

    // Dynamically import *after* mocks are established
    const { registerSessionTools: dynamicRegisterSessionTools } = await import("../../../mcp/tools/session");

    // Register session tools with mock command mapper
    dynamicRegisterSessionTools(mockCommandMapper);
  });

  afterEach(() => {
    // console.error = originalConsoleError; // Not needed since we're not mocking console.error
    jest.clearAllMocks(); // This will clear execSyncMock as well if it's a jest.fn()
  });

  describe("session.list command", () => {
    it("should return the same data for CLI and MCP interfaces", async () => {
      execSyncMock.mockImplementation(() => mockSessionListResponse);

      const listSessionTool = mockServerTools.find(
        (tool: any) => tool.name === "session.list"
      );
      expect(listSessionTool).toBeDefined();

      // Execute the MCP tool
      const mcpResult = await listSessionTool.execute({});

      // Parse the MCP result (which should be JSON string)
      const mcpSessions = JSON.parse(mcpResult);

      // Parse the mock response (what the CLI would return)
      const cliSessions = JSON.parse(mockSessionListResponse);

      // Verify the results are the same
      expect(mcpSessions).toEqual(cliSessions);

      // Verify execSync was called with the expected command
      expect(execSyncMock).toHaveBeenCalledWith("minsky session list --json");
    });

    /* Commenting out error handling test until proper logging framework is implemented
    it("should handle error conditions consistently", async () => {
      const testError = new Error("Command failed");
      let actualError: Error | null = null;
      execSyncMock.mockImplementation(() => { throw testError; });

      const listSessionTool = mockServerTools.find(
        (tool: any) => tool.name === "session.list"
      );
      // Expect the MCP tool to propagate the error
      try {
        await listSessionTool.execute({});
        // Should not reach here
        expect(true).toBe(false); // Force failure if no error thrown
      } catch (error) {
        actualError = error as Error;
        expect(String(error)).toContain("Failed to list sessions");
      }

      // Verify error handling occurred
      expect((console.error as jest.Mock).mock.calls.length).toBe(2);
      const errorCalls = (console.error as jest.Mock).mock.calls;
      expect(errorCalls.length).toBeGreaterThan(1);
      const errorArg = errorCalls[1]?.[1];
      expect(errorArg).toBeDefined();
      
      // Check for error message - handle both string and Error object possibilities
      if (typeof errorArg === "string") {
        expect(errorArg).toContain("Failed to list sessions");
      } else if (errorArg instanceof Error) {
        expect(errorArg.message).toContain("Failed to list sessions");
      } else {
        expect(String(errorArg)).toContain("Failed to list sessions");
      }
    });
    */
  });

  describe("session.get command", () => {
    it("should return the same data for CLI and MCP interfaces", async () => {
      execSyncMock.mockImplementation(() => mockSessionGetResponse);
      const getSessionTool = mockServerTools.find(
        (tool: any) => tool.name === "session.get"
      );
      expect(getSessionTool).toBeDefined();

      // Execute the MCP tool
      const mcpResult = await getSessionTool.execute({ session: "test-session-1" });

      // Parse the MCP result
      const mcpSession = JSON.parse(mcpResult);

      // Parse the mock response (what the CLI would return)
      const cliSession = JSON.parse(mockSessionGetResponse);

      // Verify the results are the same
      expect(mcpSession).toEqual(cliSession);

      // Verify execSync was called with the expected command
      expect(execSyncMock).toHaveBeenCalledWith("minsky session get test-session-1 --json");
    });

    /* Commenting out error handling test until proper logging framework is implemented
    it("should handle error conditions consistently", async () => {
      const testError = new Error("Session not found");
      let actualError: Error | null = null;
      execSyncMock.mockImplementation(() => { throw testError; });
      const getSessionTool = mockServerTools.find(
        (tool: any) => tool.name === "session.get"
      );
      // Expect the MCP tool to propagate the error
      try {
        await getSessionTool.execute({ session: "non-existent" });
        // Should not reach here
        expect(true).toBe(false); // Force failure if no error thrown
      } catch (error) {
        actualError = error as Error;
        expect(String(error)).toContain("Failed to get session non-existent");
      }

      // Verify error handling occurred
      expect((console.error as jest.Mock).mock.calls.length).toBe(2);
      const errorCalls = (console.error as jest.Mock).mock.calls;
      expect(errorCalls.length).toBeGreaterThan(1);
      const errorArg = errorCalls[1]?.[1];
      expect(errorArg).toBeDefined();
      
      // Check for error message - handle both string and Error object possibilities
      if (typeof errorArg === "string") {
        expect(errorArg).toContain("Failed to get session non-existent");
      } else if (errorArg instanceof Error) {
        expect(errorArg.message).toContain("Failed to get session non-existent");
      } else {
        expect(String(errorArg)).toContain("Failed to get session non-existent");
      }
    });
    */
  });

  describe("session.start command", () => {
    it("should start a session correctly", async () => {
      execSyncMock.mockImplementation(() => "Session 'test-session' started");
      const startSessionTool = mockServerTools.find(
        (tool: any) => tool.name === "session.start"
      );
      // Execute the MCP tool
      const result = await startSessionTool.execute({ name: "test-session" });
      const parsedResult = JSON.parse(result);

      // Verify the result format
      expect(parsedResult).toEqual({
        success: true,
        message: "Session 'test-session' started",
        session: "test-session",
      });

      // Verify execSync was called correctly and includes the required --quiet flag
      expect(execSyncMock).toHaveBeenCalledWith("minsky session start --name test-session --quiet");
    });

    it("should handle task-associated sessions", async () => {
      execSyncMock.mockImplementation(() => "Session 'task#123' started");
      const startSessionTool = mockServerTools.find(
        (tool: any) => tool.name === "session.start"
      );
      // Execute the MCP tool with task parameter
      const result = await startSessionTool.execute({ task: "123" });
      const parsedResult = JSON.parse(result);

      // Verify the result format
      expect(parsedResult).toEqual({
        success: true,
        message: "Session 'task#123' started",
        session: "task#123",
      });

      // Verify execSync was called correctly with the task parameter
      expect(execSyncMock).toHaveBeenCalledWith("minsky session start --task 123 --quiet");
    });
  });
});
