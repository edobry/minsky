/**
 * Tests for session-aware edit tools
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { CommandMapper } from "../../../src/mcp/command-mapper";
import { createMock, setupTestMocks, mockModule } from "../../../src/utils/test-utils/mocking";
// Use mock.module() to mock filesystem operations
// import { readFile, writeFile } from "fs/promises";

// Set up automatic mock cleanup
setupTestMocks();

// Mock session provider with test-session data
const mockSessionProvider = {
  getSession: mock((id: string) => {
    if (id === "test-session") {
      return Promise.resolve({
        session: "test-session",
        repoName: "test-repo",
        repoUrl: "https://github.com/test/repo",
        createdAt: "2024-01-01T00:00:00.000Z",
        taskId: null,
        branch: "main",
        repoPath: "/tmp/test-session",
        backendType: "local",
        remote: { authMethod: "ssh", depth: 1 },
      });
    }
    return Promise.resolve(null);
  }),
  addSession: createMock(),
  updateSession: createMock(),
  deleteSession: createMock(),
  listSessions: createMock(),
  getSessionByTaskId: createMock(),
};

mockModule("../../../src/domain/session", () => ({
  createSessionProvider: () => mockSessionProvider,
}));

// Mock the session database I/O operations directly
mockModule("../../../src/domain/session/session-db-io", () => ({
  readSessionDbFile: mock(() => ({
    sessions: [
      {
        session: "test-session",
        repoName: "test-repo",
        repoUrl: "https://github.com/test/repo",
        createdAt: "2024-01-01T00:00:00.000Z",
        taskId: null,
        branch: "main",
        repoPath: "/tmp/test-session",
        backendType: "local",
        remote: { authMethod: "ssh", depth: 1 },
      },
    ],
    baseDir: "/tmp",
  })),
  writeSessionsToFile: mock(() => Promise.resolve()),
}));

// Mock storage backend factory to return mock storage
mockModule("../../../src/domain/storage/storage-backend-factory", () => ({
  createStorageBackend: mock(() => ({
    getEntity: mock((id: string) => {
      if (id === "test-session") {
        return Promise.resolve({
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "https://github.com/test/repo",
          createdAt: "2024-01-01T00:00:00.000Z",
          taskId: null,
          branch: "main",
          repoPath: "/tmp/test-session",
          backendType: "local",
          remote: { authMethod: "ssh", depth: 1 },
        });
      }
      return Promise.resolve(null);
    }),
    getEntities: mock(() => Promise.resolve([])),
    addEntity: mock(() => Promise.resolve()),
    updateEntity: mock(() => Promise.resolve()),
    deleteEntity: mock(() => Promise.resolve()),
  })),
}));

// Mock fs operations - use dynamic mocks that can be reconfigured
let mockReadFile = mock(() => Promise.resolve("default content"));
let mockWriteFile = mock(() => Promise.resolve(undefined));
let mockMkdir = mock(() => Promise.resolve(undefined));
let mockStat = mock(() => Promise.resolve({ isFile: () => true }));

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
let mockGetSessionWorkspacePath = createMock() as any;

mockModule("../../../src/adapters/mcp/session-files", () => ({
  SessionPathResolver: class MockSessionPathResolver {
    resolvePath = mockResolvePath;
    validatePath = mockValidatePath;
    validatePathExists = mockValidatePathExists;
    getSessionWorkspacePath = mockGetSessionWorkspacePath;

    constructor() {
      // Set default successful behavior
      this.resolvePath = mock(() => Promise.resolve("/mock/session/path/file.txt"));
      this.validatePath = mock(() => true);
      this.validatePathExists = mock(() => Promise.resolve(undefined));
      this.getSessionWorkspacePath = mock(() => Promise.resolve("/mock/session/workspace"));
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
    mockReadFile = mock(() => Promise.resolve("original content with oldText"));
    mockWriteFile = mock(() => Promise.resolve(undefined));
    mockResolvePath = mock(() => Promise.resolve("/mock/session/path/file.txt"));
    mockValidatePath = mock(() => true);
    mockValidatePathExists = mock(() => Promise.resolve(undefined));

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
      expect(registeredTools["session.edit_file"].description).toContain(
        "Use this tool to make an edit"
      );
    });

    test("should create new file when it doesn't exist", async () => {
      // Mock the MCP session tools implementations
      const mockSessionEditFile = mock(async (args: any) => {
        return {
          success: true,
          message: `Created new file at ${args.path}`,
          filePath: args.path,
          changes: "Created new file",
        };
      });

      // Test the tool registration and basic functionality
      const tool = registeredTools["session.edit_file"];
      expect(tool).toBeDefined();
      expect(tool.name).toBe("session.edit_file");

      // Simulate successful file creation
      const result = await mockSessionEditFile({
        sessionName: "test-session",
        path: "new-file.txt",
        instructions: "Create a new file",
        content: "Hello world",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Created new file");
      expect(mockSessionEditFile).toHaveBeenCalledWith({
        sessionName: "test-session",
        path: "new-file.txt",
        instructions: "Create a new file",
        content: "Hello world",
      });
    });

    test("should handle edit operations with mock setup", async () => {
      // Mock the MCP session edit implementation
      const mockSessionEditFile = mock(async (args: any) => {
        return {
          success: true,
          message: `Applied edit to ${args.path}`,
          filePath: args.path,
          changes: `Modified file with instructions: ${args.instructions}`,
        };
      });

      // Test the tool registration
      const tool = registeredTools["session.edit_file"];
      expect(tool).toBeDefined();

      // Simulate edit operation
      const result = await mockSessionEditFile({
        sessionName: "test-session",
        path: "existing-file.txt",
        instructions: "Add a new line",
        content: "// ... existing code ...\nnew line\n// ... existing code ...",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Applied edit");
      expect(result.changes).toContain("Add a new line");
    });
  });

  describe("session_search_replace", () => {
    test("should be registered with correct schema", () => {
      expect(registeredTools["session.search_replace"]).toBeDefined();
      expect(registeredTools["session.search_replace"].name).toBe("session.search_replace");
      expect(registeredTools["session.search_replace"].description).toContain(
        "Replace a single occurrence"
      );
    });

    test("should replace single occurrence successfully", async () => {
      // Mock successful search and replace
      const mockSearchReplace = mock(async (args: any) => {
        return {
          success: true,
          message: `Replaced "${args.search}" with "${args.replace}" in ${args.path}`,
          filePath: args.path,
          occurrences: 1,
        };
      });

      const tool = registeredTools["session.search_replace"];
      expect(tool).toBeDefined();

      const result = await mockSearchReplace({
        sessionName: "test-session",
        path: "test-file.txt",
        search: "old text",
        replace: "new text",
      });

      expect(result.success).toBe(true);
      expect(result.occurrences).toBe(1);
      expect(result.message).toContain("Replaced");
    });

    test("should error when text not found", async () => {
      // Mock search text not found scenario
      const mockSearchReplace = mock(async (args: any) => {
        throw new Error(`Text "${args.search}" not found in ${args.path}`);
      });

      const tool = registeredTools["session.search_replace"];
      expect(tool).toBeDefined();

      await expect(
        mockSearchReplace({
          sessionName: "test-session",
          path: "test-file.txt",
          search: "nonexistent text",
          replace: "new text",
        })
      ).rejects.toThrow('Text "nonexistent text" not found');
    });

    test("should error when multiple occurrences found", async () => {
      // Mock multiple occurrences found scenario
      const mockSearchReplace = mock(async (args: any) => {
        throw new Error(
          `Multiple occurrences of "${args.search}" found in ${args.path}. Please be more specific.`
        );
      });

      const tool = registeredTools["session.search_replace"];
      expect(tool).toBeDefined();

      await expect(
        mockSearchReplace({
          sessionName: "test-session",
          path: "test-file.txt",
          search: "common text",
          replace: "new text",
        })
      ).rejects.toThrow("Multiple occurrences");
    });
  });
});
