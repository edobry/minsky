import { describe, it, expect, mock, beforeEach, afterEach, jest, spyOn } from "bun:test";
import * as testUtils from "../../../utils/test-utils";
import { execSync } from "child_process";
import { registerSessionTools } from "../../../mcp/tools/session";
import { CommandMapper } from "../../../mcp/command-mapper";
import type { FastMCP } from "fastmcp"; // Import FastMCP type if available, otherwise use any
import fs from "fs";
import path from "path";

/**
 * Integration tests for session commands.
 * These tests verify that both CLI and MCP interfaces return consistent results.
 * We use mocking to avoid actual command execution.
 */
describe("Session Command Integration Tests", () => {
  // Mock dependencies
  let execSyncMock: jest.Mock;
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
    execSyncMock = jest.fn();
    execSyncMock.mockImplementation(() => ""); // Default implementation

    spyOn(console, "error").mockImplementation(() => {});

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
    console.error = originalConsoleError;
    execSyncMock.mockReset(); // Changed from mockRestore to mockReset for jest.fn
    // mock.restore(); // This was for bun's module mocking, may not be needed if not using mock.module
    jest.clearAllMocks(); // Clear all jest mocks
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

    it("should handle error conditions consistently", async () => {
      const testError = new Error("Command failed");
      execSyncMock.mockImplementation(() => { throw testError; });

      const listSessionTool = mockServerTools.find(
        (tool: any) => tool.name === "session.list"
      );
      // Expect the MCP tool to propagate the error
      try {
        await listSessionTool.execute({});
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(String(error)).toContain("Failed to list sessions");
      }

      // Verify error handling occurred
      expect(console.error).toHaveBeenCalledTimes(1);
    });
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

    it("should handle error conditions consistently", async () => {
      const testError = new Error("Session not found");
      execSyncMock.mockImplementation(() => { throw testError; });
      const getSessionTool = mockServerTools.find(
        (tool: any) => tool.name === "session.get"
      );
      // Expect the MCP tool to propagate the error
      try {
        await getSessionTool.execute({ session: "non-existent" });
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(String(error)).toContain("Failed to get session non-existent");
      }

      // Verify error handling occurred
      expect(console.error).toHaveBeenCalledTimes(1);
    });
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
