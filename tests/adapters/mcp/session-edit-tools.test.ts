/**
 * Tests for session-aware edit tools
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { CommandMapper } from "../../../src/mcp/command-mapper";
import { createMock, setupTestMocks, mockModule } from "../../../src/utils/test-utils/mocking";
import { readFile, writeFile } from "fs/promises";

// Set up automatic mock cleanup
setupTestMocks();

// Mock fs operations
const mockReadFile = createMock() as any;
const mockWriteFile = createMock() as any;
const mockMkdir = createMock() as any;
const mockStat = createMock() as any;

mockModule("fs/promises", () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  stat: mockStat,
}));

// Mock the logger module
mockModule("../../../src/utils/logger", () => ({
  log: {
    debug: createMock(),
    warn: createMock(),
    error: createMock(),
    cli: createMock(),
  },
}));

// CRITICAL: Mock SessionPathResolver at module level to control its behavior
const mockResolvePath = createMock() as any;
const mockValidatePath = createMock() as any;
const mockValidatePathExists = createMock() as any;

mockModule("../../../src/adapters/mcp/session-files", () => ({
  SessionPathResolver: class MockSessionPathResolver {
    resolvePath = mockResolvePath;
    validatePath = mockValidatePath;
    validatePathExists = mockValidatePathExists;
    
    constructor() {
      // Set default successful behavior
      this.resolvePath = mock(() => Promise.resolve("/mock/session/path/file.txt"));
      this.validatePath = mock(() => true);
      this.validatePathExists = mock(() => Promise.resolve(undefined));
    }
  },
}));

// Import after mocking to ensure mocks are applied
import { registerSessionEditTools } from "../../../src/adapters/mcp/session-edit-tools";

describe("Session Edit Tools", () => {
  let commandMapper: any;
  let registeredTools: any;

  beforeEach(() => {
    // Reset mocks
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockMkdir.mockReset();
    mockStat.mockReset();
    mockResolvePath.mockReset();
    mockValidatePath.mockReset();
    mockValidatePathExists.mockReset();

    // Set default successful behavior for path resolution
    mockResolvePath = mock(() => Promise.resolve("/mock/session/path/file.txt"));
    mockValidatePath = mock(() => true);
    mockValidatePathExists = mock(() => Promise.resolve(undefined));

    // Create mock command mapper
    commandMapper = {
      addCommand: createMock(),
    };
    registeredTools = {};

    // Mock addTool to capture registered tools
    commandMapper.addCommand = mock((command: { name: string; description: string; parameters?: any; handler: any }) => {
            registeredTools[command.name] = {
              name: command.name,
              description: command.description,
              schema: command.parameters,
              handler: command.handler,
            };
          });

    // Register the tools
    registerSessionEditTools(commandMapper);
  });

  describe("session_edit_file", () => {
    test("should be registered with correct schema", () => {
      expect(registeredTools["session_edit_file"]).toBeDefined();
      expect(registeredTools["session_edit_file"].name).toBe("session_edit_file");
      expect(registeredTools["session_edit_file"].description).toContain("Edit a file");
    });

    test("should create new file when it doesn't exist", async () => {
      const handler = registeredTools["session_edit_file"].handler;

      // Mock file doesn't exist
      mockReadFile = mock(() => Promise.reject(new Error("ENOENT: no such file or directory")));
      mockWriteFile = mock(() => Promise.resolve(undefined));

      const result = await handler({
        session: "test-session",
        path: "new-file.txt",
        instructions: "Create new file",
        content: "console.log('Hello, world!');",
        createDirs: false,
      });

      expect(result.success).toBe(true);
      expect(result.edited).toBe(true);
    });

    test("should handle errors gracefully", async () => {
      const handler = registeredTools["session_edit_file"].handler;

      // FIXED: Mock SessionPathResolver to reject with error
      mockResolvePath = mock(() => Promise.reject(new Error("Invalid path")));

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
      mockReadFile = mock(() => Promise.resolve("This is oldText in the file"));

      // Mock successful write
      const mockWriteFile = writeFile as unknown;
      mockWriteFile = mock(() => Promise.resolve(undefined));

      // Mock path resolver - use module-level mocks
      mockResolvePath = mock(() => Promise.resolve("/session/path/test.ts"));
      mockValidatePath = mock(() => Promise.resolve(undefined));

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
      mockReadFile = mock(() => Promise.resolve("This is some text in the file"));

      // Mock path resolver - use module-level mocks
      mockResolvePath = mock(() => Promise.resolve("/session/path/test.ts"));
      mockValidatePath = mock(() => Promise.resolve(undefined));

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
      mockReadFile = mock(() => Promise.resolve("This is oldText and another oldText in the file"));

      // Mock path resolver - use module-level mocks
      mockResolvePath = mock(() => Promise.resolve("/session/path/test.ts"));
      mockValidatePath = mock(() => Promise.resolve(undefined));

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
