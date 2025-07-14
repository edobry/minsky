/**
 * Tests for session-aware edit tools
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { registerSessionEditTools } from "../../../src/adapters/mcp/session-edit-tools";
import type { CommandMapper } from "../../../mcp/command-mapper";
import { z } from "zod";
import { mkdir, writeFile, readFile, stat } from "fs/promises";
import { SessionPathResolver } from "../session-files";
import { Buffer } from "buffer";

// Mock fs/promises
mock.module("fs/promises", () => ({
  readFile: mock(),
  writeFile: mock(),
  stat: mock(),
  mkdir: mock(),
}));

// Mock SessionPathResolver
mock.module("../session-files", () => ({
  SessionPathResolver: mock(() => ({
    resolvePath: mock(),
    validatePathExists: mock(),
    getSessionWorkspacePath: mock(),
  })),
}));

describe("Session Edit Tools", () => {
  let mockCommandMapper: CommandMapper;
  let registeredTools: Record<string, any> = {};

  beforeEach(() => {
    registeredTools = {};

    // Create mock command mapper
    mockCommandMapper = {
      addTool: mock((name: string, description: string, schema: any, handler: any) => {
        registeredTools[name] = { name, description, schema, handler };
      }),
    } as unknown;

    // Register the tools
    registerSessionEditTools(mockCommandMapper);
  });

  describe("session_edit_file", () => {
    test("should be registered with correct schema", () => {
      expect(registeredTools["session_edit_file"]).toBeDefined();
      expect(registeredTools["session_edit_file"].name).toBe("session_edit_file");
      expect(registeredTools["session_edit_file"].description).toContain("Edit a file");

      // Validate schema
      const schema = registeredTools["session_edit_file"].schema;
      const testData = {
        session: "test-session",
        path: "test.ts",
        instructions: "Add a new function",
        content: "function newFunc() {}",
        createDirs: true,
      };

      const result = schema.safeParse(testData);
      expect(result.success).toBe(true);
    });

    test("should create new file when it doesn't exist", async () => {
      const handler = registeredTools["session_edit_file"].handler;

      // Mock file doesn't exist
      const mockStat = stat as unknown;
      mockStat.mockRejectedValueOnce(new Error("ENOENT"));

      // Mock successful write
      const mockWriteFile = writeFile as unknown;
      mockWriteFile.mockResolvedValueOnce(undefined);

      // Mock path resolver
      const mockPathResolver = new SessionPathResolver() as unknown;
      mockPathResolver.resolvePath.mockResolvedValue("/session/path/test.ts");
      mockPathResolver.getSessionWorkspacePath.mockResolvedValue("/session/path");

      const result = await handler({
        session: "test-session",
        path: "test.ts",
        instructions: "Create new file",
        content: "console.log('hello');",
        createDirs: true,
      });

      expect(result.success).toBe(true);
      expect(result.created).toBe(true);
      expect(result.edited).toBe(true);
    });

    test("should apply edit pattern with existing code markers", async () => {
      const handler = registeredTools["session_edit_file"].handler;

      // Mock file exists
      const mockStat = stat as unknown;
      mockStat.mockResolvedValueOnce({ isFile: () => true });

      // Mock file content
      const mockReadFile = readFile as unknown;
      mockReadFile.mockResolvedValueOnce(`function oldFunc() {
  console.log('old');
}

function keepFunc() {
  console.log('keep');
}`);

      // Mock successful write
      const mockWriteFile = writeFile as unknown;
      mockWriteFile.mockResolvedValueOnce(undefined);

      // Mock path resolver
      const mockPathResolver = new SessionPathResolver() as unknown;
      mockPathResolver.resolvePath.mockResolvedValue("/session/path/test.ts");
      mockPathResolver.getSessionWorkspacePath.mockResolvedValue("/session/path");

      const result = await handler({
        session: "test-session",
        path: "test.ts",
        instructions: "Replace oldFunc with newFunc",
        content: `function newFunc() {
  console.log('new');
}
// ... existing code ...
function keepFunc() {
  console.log('keep');
}`,
        createDirs: false,
      });

      expect(result.success).toBe(true);
      expect(result.created).toBe(false);
      expect(result.edited).toBe(true);
    });

    test("should handle errors gracefully", async () => {
      const handler = registeredTools["session_edit_file"].handler;

      // Mock path resolver error
      const mockPathResolver = new SessionPathResolver() as unknown;
      mockPathResolver.resolvePath.mockRejectedValue(new Error("Invalid path"));

      const result = await handler({
        session: "test-session",
        path: "../../../etc/passwd",
        instructions: "Bad edit",
        content: "malicious content",
        createDirs: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid path");
    });
  });

  describe("session_search_replace", () => {
    test("should be registered with correct schema", () => {
      expect(registeredTools["session_search_replace"]).toBeDefined();
      expect(registeredTools["session_search_replace"].name).toBe("session_search_replace");
      expect(registeredTools["session_search_replace"].description).toContain(
        "Replace a single occurrence"
      );

      // Validate schema
      const schema = registeredTools["session_search_replace"].schema;
      const testData = {
        session: "test-session",
        path: "test.ts",
        search: "oldText",
        replace: "newText",
      };

      const result = schema.safeParse(testData);
      expect(result.success).toBe(true);
    });

    test("should replace single occurrence successfully", async () => {
      const handler = registeredTools["session_search_replace"].handler;

      // Mock file content
      const mockReadFile = readFile as unknown;
      mockReadFile.mockResolvedValueOnce("This is oldText in the file");

      // Mock successful write
      const mockWriteFile = writeFile as unknown;
      mockWriteFile.mockResolvedValueOnce(undefined);

      // Mock path resolver
      const mockPathResolver = new SessionPathResolver() as unknown;
      mockPathResolver.resolvePath.mockResolvedValue("/session/path/test.ts");
      mockPathResolver.validatePathExists.mockResolvedValue(undefined);

      const result = await handler({
        session: "test-session",
        path: "test.ts",
        search: "oldText",
        replace: "newText",
      });

      expect(result.success).toBe(true);
      expect(result.replaced).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledWith(
        "/session/path/test.ts",
        "This is newText in the file",
        "utf8"
      );
    });

    test("should error when text not found", async () => {
      const handler = registeredTools["session_search_replace"].handler;

      // Mock file content
      const mockReadFile = readFile as unknown;
      mockReadFile.mockResolvedValueOnce("This is some text in the file");

      // Mock path resolver
      const mockPathResolver = new SessionPathResolver() as unknown;
      mockPathResolver.resolvePath.mockResolvedValue("/session/path/test.ts");
      mockPathResolver.validatePathExists.mockResolvedValue(undefined);

      const result = await handler({
        session: "test-session",
        path: "test.ts",
        search: "notFound",
        replace: "newText",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Search text not found");
    });

    test("should error when multiple occurrences found", async () => {
      const handler = registeredTools["session_search_replace"].handler;

      // Mock file content with multiple occurrences
      const mockReadFile = readFile as unknown;
      mockReadFile.mockResolvedValueOnce("This is oldText and another oldText in the file");

      // Mock path resolver
      const mockPathResolver = new SessionPathResolver() as unknown;
      mockPathResolver.resolvePath.mockResolvedValue("/session/path/test.ts");
      mockPathResolver.validatePathExists.mockResolvedValue(undefined);

      const result = await handler({
        session: "test-session",
        path: "test.ts",
        search: "oldText",
        replace: "newText",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("found 2 times");
    });
  });
});
