/**
 * Command Mapper Tests
 * @migrated Already using native Bun patterns
 * @refactored Uses project utilities and proper TypeScript imports
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { CommandMapper } from "./command-mapper";
import { z } from "zod";
import type { ProjectContext } from "../types/project";
import type { MinskyMCPServer, ToolDefinition } from "./server";
import { createMock, setupTestMocks } from "../utils/test-utils/mocking";

// Mock MinskyMCPServer
const mockServer = {
  addTool: createMock(),
  getProjectContext: createMock(() => ({
    repositoryPath: "/test/repo",
    gitBranch: "main",
  })),
  start: createMock(),
  getServer: createMock(),
} as unknown as MinskyMCPServer;

describe("CommandMapper", () => {
  let commandMapper: CommandMapper;
  let mockProjectContext: ProjectContext;

  beforeEach(() => {
    setupTestMocks();

    mockProjectContext = {
      repositoryPath: "/test/repo",
      gitBranch: "main",
    } as ProjectContext;

    commandMapper = new CommandMapper(mockServer, mockProjectContext);
  });

  test("should initialize with server and project context", () => {
    expect(commandMapper).toBeDefined();
  });

  test("should add tool to server when addCommand is called", () => {
    const command = {
      name: "test-command",
      description: "Test command description",
      parameters: z.object({ test: z.string() }),
      execute: async () => "test result",
    };

    commandMapper.addCommand(command);

    const addToolMock = (mockServer as any).addTool;
    expect(addToolMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const firstCall = addToolMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const toolDefinition = firstCall?.[0] as ToolDefinition;
    expect(toolDefinition).toBeDefined();
    expect(toolDefinition?.name).toBe("test_command");
    expect(toolDefinition?.description).toBe("Test command description");
    expect(toolDefinition?.inputSchema).toBeDefined();
    expect(typeof toolDefinition?.handler).toBe("function");
  });
});
