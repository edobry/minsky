/**
 * Tests for session-aware edit tools
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { CommandMapper } from "../../../src/mcp/command-mapper";
import { createMock, setupTestMocks, mockModule } from "../../../src/utils/test-utils/mocking";
import { readFile, writeFile } from "fs/promises";

// Set up automatic mock cleanup
setupTestMocks();

// Mock fs operations - use dynamic mocks that can be reconfigured
const mockReadFile = mock(() => Promise.resolve("default content"));
const mockWriteFile = mock(() => Promise.resolve(undefined));
const mockMkdir = mock(() => Promise.resolve(undefined));
const mockStat = mock(() => Promise.resolve({ isFile: () => true }));

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
let mockResolvePath = createMock() as any;
let mockValidatePath = createMock() as any;
let mockValidatePathExists = createMock() as any;

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

    // Set up default successful behavior for most tests
    mockReadFile.mockImplementation(() => Promise.resolve("original content with oldText"));
    mockWriteFile.mockImplementation(() => Promise.resolve(undefined));
    mockResolvePath.mockImplementation(() => Promise.resolve("/mock/session/path/file.txt"));
    mockValidatePath.mockImplementation(() => true);
    mockValidatePathExists.mockImplementation(() => Promise.resolve(undefined));

    // Create mock command mapper
    registeredTools = {};

    // Mock addCommand to capture registered tools
    const mockAddCommand = mock(
      (command: { name: string; description: string; parameters?: any; handler: any }) => {
        registeredTools[command.name] = {
          name: command.name,
          description: command.description,
          schema: command.parameters,
          handler: command.handler,
        };
      }
    );

    commandMapper = {
      addCommand: mockAddCommand,
    };

    // Register the tools
    registerSessionEditTools(commandMapper);
  });

  describe("session_edit_file", () => {
    test("should be registered with correct schema", () => {
      expect(registeredTools["session.edit_file"]).toBeDefined();
      expect(registeredTools["session.edit_file"].name).toBe("session.edit_file");
      expect(registeredTools["session.edit_file"].description).toContain("Edit a file");
    });

    test("should create new file when it doesn't exist", async () => {
      const handler = registeredTools["session.edit_file"].handler;

      const result = await handler({
        sessionName: "test-session",
        path: "new-file.txt",
        instructions: "Create new file",
        content: "console.log('Hello, world!');",
        createDirs: false,
      });

      expect(result.success).toBe(true);
      expect(result.edited).toBe(true);
    });

    test("should handle edit operations with mock setup", async () => {
      const handler = registeredTools["session.edit_file"].handler;

      const result = await handler({
        sessionName: "test-session",
        path: "test-file.ts",
        instructions: "Add content",
        content: "console.log('test');",
        createDirs: false,
      });

      // With our mock setup, operations succeed and create files
      expect(result.success).toBe(true);
      expect(result.edited).toBe(true);
    });
  });

  describe("session_search_replace", () => {
    test("should be registered with correct schema", () => {
      expect(registeredTools["session.search_replace"]).toBeDefined();
      expect(registeredTools["session.search_replace"].name).toBe("session.search_replace");
      expect(registeredTools["session.search_replace"].description).toContain(
        "Replace a single occurrence"
      );

      // Validate schema
      const schema = registeredTools["session.search_replace"].schema;
      const testData = {
        sessionName: "test-session",
        path: "test.ts",
        search: "oldText",
        replace: "newText",
      };

      const result = schema.safeParse(testData);
      expect(result.success).toBe(true);
    });

    test("should replace single occurrence successfully", async () => {
      const handler = registeredTools["session.search_replace"].handler;

      const result = await handler({
        sessionName: "test-session",
        path: "test.ts",
        search: "oldText",
        replace: "newText",
      });

      expect(result.success).toBe(true);
      expect(result.replaced).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledWith(
        "/mock/session/path/file.txt",
        "original content with newText",
        "utf8"
      );
    });

    test("should error when text not found", async () => {
      const handler = registeredTools["session.search_replace"].handler;

      // Mock file content that doesn't contain search text
      mockReadFile.mockImplementation(() => Promise.resolve("content without target"));

      const result = await handler({
        sessionName: "test-session",
        path: "test.ts",
        search: "notFound",
        replace: "newText",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Search text not found");
    });

    test("should error when multiple occurrences found", async () => {
      const handler = registeredTools["session.search_replace"].handler;

      // Mock file content with multiple occurrences
      mockReadFile.mockImplementation(() => Promise.resolve("oldText and oldText again"));

      const result = await handler({
        sessionName: "test-session",
        path: "test.ts",
        search: "oldText",
        replace: "newText",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("found 2 times");
    });
  });
});
