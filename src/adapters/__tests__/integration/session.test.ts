import { describe, it, expect, mock, beforeEach, afterEach, jest } from "bun:test";
import type { Mock } from "bun:test"; // Import Mock as type
import * as testUtils from "../../../utils/test-utils";
import { execSync } from "child_process";
import { registerSessionTools } from "../../../mcp/tools/session";
import { CommandMapper } from "../../../mcp/command-mapper";
import * as fs from "fs";
import * as path from "path";
// vi is a global in bun:test environment, no explicit import needed sometimes

/**
 * Integration tests for session commands.
 * These tests verify that both CLI and MCP interfaces return consistent results.
 * We use mocking to avoid actual command execution.
 */
describe("Session Command Integration Tests", () => {
  // Mock dependencies
  let execSyncMock: Mock<typeof execSync>;
  let consoleErrorMock: Mock<typeof console.error>;

  // Store original execSync
  const originalExecSync = execSync;
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

  // Set up mock FastMCP server for testing
  let mockCommandMapper: CommandMapper;

  beforeEach(() => {
    // Set up mock function
    execSyncMock = jest.fn(execSync);

    // Mock console.error
    consoleErrorMock = jest.fn(() => {});
    console.error = consoleErrorMock;

    // Set up FastMCP mock
    const mockServer = {
      addTool: jest.fn(() => {}),
      tools: [],
    };
    mockCommandMapper = new CommandMapper(mockServer as any); // cast mockServer to any for now to deal with FastMCP type

    // For testing, manually add tools array that we can access
    (mockCommandMapper as any).server = {
      tools: [],
    };

    // Mock the addTool method
    (mockCommandMapper as any).server.addTool = (tool: any) => {
      (mockCommandMapper as any).server.tools.push(tool);
    };

    // Register session tools with mock command mapper
    registerSessionTools(mockCommandMapper);
  });

  afterEach(() => {
    // Restore original functions
    console.error = originalConsoleError;
    jest.restoreAllMocks(); // Use jest.restoreAllMocks()
  });

  describe("session.list command", () => {
    it("should return the same data for CLI and MCP interfaces", async () => {
      // Mock execSync to return our predetermined response
      execSyncMock.mockImplementation(() => mockSessionListResponse as any);

      // Get the session.list tool from the mockCommandMapper
      const listSessionTool = (mockCommandMapper as any).server.tools.find(
        (tool: any) => tool.name === "session.list"
      );

      // Check that the tool was registered
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
      // Mock execSync to throw an error
      const testError = new Error("Command failed");
      execSyncMock.mockImplementation(() => {
        throw testError;
      });

      // Get the session.list tool
      const listSessionTool = (mockCommandMapper as any).server.tools.find(
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
      expect(consoleErrorMock.mock.calls.length).toBeGreaterThan(0);
    });
  });

  describe("session.get command", () => {
    it("should return the same data for CLI and MCP interfaces", async () => {
      // Mock execSync to return our predetermined response
      execSyncMock.mockImplementation(() => mockSessionGetResponse as any);

      // Get the session.get tool
      const getSessionTool = (mockCommandMapper as any).server.tools.find(
        (tool: any) => tool.name === "session.get"
      );

      // Check that the tool was registered
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
      // Mock execSync to throw an error
      const testError = new Error("Session not found");
      execSyncMock.mockImplementation(() => {
        throw testError;
      });

      // Get the session.get tool
      const getSessionTool = (mockCommandMapper as any).server.tools.find(
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
      expect(consoleErrorMock.mock.calls.length).toBeGreaterThan(0);
    });
  });

  describe("session.start command", () => {
    it("should start a session correctly", async () => {
      // Mock execSync to return success
      execSyncMock.mockImplementation(() => "Session 'test-session' started" as any);

      // Get the session.start tool
      const startSessionTool = (mockCommandMapper as any).server.tools.find(
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
      // Mock execSync to return success
      execSyncMock.mockImplementation(() => "Session 'task#123' started" as any);

      // Get the session.start tool
      const startSessionTool = (mockCommandMapper as any).server.tools.find(
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
