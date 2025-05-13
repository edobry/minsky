import { describe, it, expect, mock, beforeEach, afterEach, jest, spyOn } from "bun:test";
import type { Mock } from "bun:test";
import * as testUtils from "../../../utils/test-utils";
import { execSync } from "child_process";
import { CommandMapper } from "../../../mcp/command-mapper";
import * as fs from "fs";
import * as path from "path";
import type { FastMCP } from "fastmcp";

/**
 * Integration tests for session commands.
 * These tests verify that both CLI and MCP interfaces return consistent results.
 * We use mocking to avoid actual command execution.
 */
describe("Session Command Integration Tests", () => {
  let execSyncMock: jest.Mock<typeof execSync>;
  let consoleErrorSpy: jest.Mock<typeof console.error>;
  let mockCommandMapper: CommandMapper;
  let mockServerTools: any[];

  const originalConsoleError = console.error;

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

  const mockSessionGetResponse = JSON.stringify({
    id: "test-session-1",
    name: "Test Session 1",
    repo: "/path/to/repo1",
    branch: "session/test-1",
    createdAt: "2025-05-01T12:00:00.000Z",
  });

  beforeEach(async () => {
    execSyncMock = jest.fn<typeof execSync>();
    execSyncMock.mockImplementation(() => "" as any);

    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});

    mockServerTools = [];
    const mockServerInstance: any = {
      addTool: jest.fn((tool: any) => {
        mockServerTools.push(tool);
      }),
    };
    mockCommandMapper = new CommandMapper(mockServerInstance as FastMCP);

    const { registerSessionTools: dynamicRegisterSessionTools } = await import("../../../mcp/tools/session");
    dynamicRegisterSessionTools(mockCommandMapper);
  });

  afterEach(() => {
    console.error = originalConsoleError;
    execSyncMock.mockReset();
    jest.clearAllMocks();
  });

  describe("session.list command", () => {
    it("should return the same data for CLI and MCP interfaces", async () => {
      execSyncMock.mockImplementation(() => mockSessionListResponse as any);
      const listSessionTool = mockServerTools.find(
        (tool: any) => tool.name === "session.list"
      );
      expect(listSessionTool).toBeDefined();
      const mcpResult = await listSessionTool.execute({});
      const mcpSessions = JSON.parse(mcpResult);
      const cliSessions = JSON.parse(mockSessionListResponse);
      expect(mcpSessions).toEqual(cliSessions);
      expect(execSyncMock).toHaveBeenCalledWith("minsky session list --json");
    });

    it("should handle error conditions consistently", async () => {
      const testError = new Error("Command failed");
      execSyncMock.mockImplementation(() => { throw testError; });
      const listSessionTool = mockServerTools.find(
        (tool: any) => tool.name === "session.list"
      );
      try {
        await listSessionTool.execute({});
        expect(true).toBe(false);
      } catch (error) {
        expect(String(error)).toContain("Failed to list sessions");
      }
      expect(consoleErrorSpy.mock.calls.length).toBeGreaterThan(0);
    });
  });

  describe("session.get command", () => {
    it("should return the same data for CLI and MCP interfaces", async () => {
      execSyncMock.mockImplementation(() => mockSessionGetResponse as any);
      const getSessionTool = mockServerTools.find(
        (tool: any) => tool.name === "session.get"
      );
      expect(getSessionTool).toBeDefined();
      const mcpResult = await getSessionTool.execute({ session: "test-session-1" });
      const mcpSession = JSON.parse(mcpResult);
      const cliSession = JSON.parse(mockSessionGetResponse);
      expect(mcpSession).toEqual(cliSession);
      expect(execSyncMock).toHaveBeenCalledWith("minsky session get test-session-1 --json");
    });

    it("should handle error conditions consistently", async () => {
      const testError = new Error("Session not found");
      execSyncMock.mockImplementation(() => { throw testError; });
      const getSessionTool = mockServerTools.find(
        (tool: any) => tool.name === "session.get"
      );
      try {
        await getSessionTool.execute({ session: "non-existent" });
        expect(true).toBe(false);
      } catch (error) {
        expect(String(error)).toContain("Failed to get session non-existent");
      }
      expect(consoleErrorSpy.mock.calls.length).toBeGreaterThan(0);
    });
  });

  describe("session.start command", () => {
    it("should start a session correctly", async () => {
      execSyncMock.mockImplementation(() => "Session 'test-session' started" as any);
      const startSessionTool = mockServerTools.find(
        (tool: any) => tool.name === "session.start"
      );
      const result = await startSessionTool.execute({ name: "test-session" });
      const parsedResult = JSON.parse(result);
      expect(parsedResult).toEqual({
        success: true,
        message: "Session 'test-session' started",
        session: "test-session",
      });
      expect(execSyncMock).toHaveBeenCalledWith("minsky session start --name test-session --quiet");
    });

    it("should handle task-associated sessions", async () => {
      execSyncMock.mockImplementation(() => "Session 'task#123' started" as any);
      const startSessionTool = mockServerTools.find(
        (tool: any) => tool.name === "session.start"
      );
      const result = await startSessionTool.execute({ task: "123" });
      const parsedResult = JSON.parse(result);
      expect(parsedResult).toEqual({
        success: true,
        message: "Session 'task#123' started",
        session: "task#123",
      });
      expect(execSyncMock).toHaveBeenCalledWith("minsky session start --task 123 --quiet");
    });
  });
});
