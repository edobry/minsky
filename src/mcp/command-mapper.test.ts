/**
 * Command Mapper Tests
 * @migrated Already using native Bun patterns
 * @refactored Uses project utilities and proper TypeScript imports
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { CommandMapper } from "./command-mapper.ts";
import { z } from "zod";
import type { ProjectContext } from "../types/project.ts";
import { createMock, setupTestMocks } from "../utils/test-utils/mocking.ts";

// Mock FastMCP
const mockServer = {
  addTool: createMock(),
  start: createMock(),
  on: createMock(),
};

describe("CommandMapper", () => {
  let commandMapper: CommandMapper;
  let mockProjectContext: ProjectContext;

  beforeEach(() => {
    setupTestMocks();

    mockProjectContext = {
      repositoryPath: "/test/repo",
      gitBranch: "main",
    } as ProjectContext;

    commandMapper = new CommandMapper(mockServer as any, mockProjectContext);
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

    expect(mockServer.addTool).toHaveBeenCalledWith({
      name: "test-command",
      description: "Test command description",
      parameters: expect.any(Object),
      execute: expect.any(Function),
    });
  });
});
