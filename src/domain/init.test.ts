import { describe, test, expect } from "bun:test";
import { initializeProject, initializeProjectWithFS } from "./init";
import type { FileSystem } from "./init";
import fs from "fs";
import path from "path";

describe("initializeProject", () => {
  // Test utility to create mocks that track calls
  function createMockFunction() {
    const calls: any[][] = [];
    const mockFn = (...args: any[]) => {
      calls.push(args);
      if (typeof mockFn.implementation === 'function') {
        return mockFn.implementation(...args);
      }
      return mockFn.returnValue;
    };
    
    mockFn.calls = calls;
    mockFn.returnValue = undefined;
    mockFn.implementation = undefined as any;
    
    mockFn.mockReturnValue = (val: any) => {
      mockFn.returnValue = val;
      mockFn.implementation = undefined;
      return mockFn;
    };
    
    mockFn.mockImplementation = (impl: Function) => {
      mockFn.implementation = impl;
      return mockFn;
    };
    
    mockFn.mockReset = () => {
      calls.length = 0;
      mockFn.returnValue = undefined;
      mockFn.implementation = undefined;
    };
    
    return mockFn;
  }

  const repoPath = "/test/repo";

  test("should create directories and files for tasks.md backend and cursor rule format", async () => {
    // Set up mocks
    const mockExistsSync = createMockFunction();
    mockExistsSync.mockReturnValue(false);
    
    const mockMkdirSync = createMockFunction();
    const mockWriteFileSync = createMockFunction();
    
    // Set up mock file system
    const mockFileSystem: FileSystem = {
      existsSync: mockExistsSync as any,
      mkdirSync: mockMkdirSync as any,
      writeFileSync: mockWriteFileSync as any,
    };
    
    // Run the test
    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "cursor",
      },
      mockFileSystem
    );

    // Verify the results
    expect(mockExistsSync.calls.length).toBeGreaterThan(0);
    expect(mockMkdirSync.calls.length).toBeGreaterThan(0);
    expect(mockWriteFileSync.calls.length).toBeGreaterThan(0);
    
    // Check specific paths were created
    expect(mockMkdirSync.calls.some((args: any[]) => 
      args[0] === path.join(repoPath, "process", "tasks")
    )).toBe(true);
    
    expect(mockMkdirSync.calls.some((args: any[]) => 
      args[0] === path.join(repoPath, ".cursor", "rules")
    )).toBe(true);
    
    // Check that files were written
    expect(mockWriteFileSync.calls.some((args: any[]) => 
      args[0] === path.join(repoPath, "process", "tasks.md") && 
      String(args[1]).includes("# Minsky Tasks")
    )).toBe(true);
    
    expect(mockWriteFileSync.calls.some((args: any[]) => 
      args[0] === path.join(repoPath, ".cursor", "rules", "minsky-workflow.mdc") && 
      String(args[1]).includes("# Minsky Workflow")
    )).toBe(true);
    
    expect(mockWriteFileSync.calls.some((args: any[]) => 
      args[0] === path.join(repoPath, ".cursor", "mcp.json") && 
      String(args[1]).includes("mcpServers")
    )).toBe(true);
  });

  test("should create directories and files for tasks.md backend and generic rule format", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;

    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "generic",
      },
      mockFileSystem
    );

    // Should check directories/files
    const existsCalls = mockExistsSync.calls.map((args) => args[0]);
    expect(existsCalls).toContain(path.join(repoPath, ".ai", "rules"));
    expect(existsCalls).toContain(path.join(repoPath, ".ai", "rules", "minsky-workflow.mdc"));
    expect(existsCalls).toContain(path.join(repoPath, ".ai", "rules", "index.mdc"));

    // Should create directories
    const mkdirCalls = mockMkdirSync.calls.map((args) => args[0]);
    expect(mkdirCalls).toContain(path.join(repoPath, ".ai", "rules"));

    // Should create files
    const writeRuleCheck = mockWriteFileSync.calls.some(
      (args) =>
        args[0] === path.join(repoPath, ".ai", "rules", "minsky-workflow.mdc") &&
        String(args[1]).includes("# Minsky Workflow")
    );
    expect(writeRuleCheck).toBe(true);

    const writeIndexCheck = mockWriteFileSync.calls.some(
      (args) =>
        args[0] === path.join(repoPath, ".ai", "rules", "index.mdc") &&
        String(args[1]).includes("# Minsky Rules Index")
    );
    expect(writeIndexCheck).toBe(true);

    // Should still create MCP config with generic rule format
    const mcpConfigCheck = mockWriteFileSync.calls.some(
      (args) =>
        args[0] === path.join(repoPath, ".cursor", "mcp.json") &&
        String(args[1]).includes("mcpServers")
    );
    expect(mcpConfigCheck).toBe(true);

    // Should create MCP usage rule in generic format
    const mcpRuleCheck = mockWriteFileSync.calls.some(
      (args) =>
        args[0] === path.join(repoPath, ".ai", "rules", "mcp-usage.mdc") &&
        String(args[1]).includes("# MCP Usage")
    );
    expect(mcpRuleCheck).toBe(true);
  });

  test("should create project without MCP configuration when disabled", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;

    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "cursor",
        mcp: {
          enabled: false,
          transport: "stdio",
        },
      },
      mockFileSystem
    );

    // Should not create MCP config when disabled
    const mcpConfigCheck = mockWriteFileSync.calls.some(
      (args) => args[0] === path.join(repoPath, ".cursor", "mcp.json")
    );
    expect(mcpConfigCheck).toBe(false);

    // Should not create MCP usage rule when disabled
    const mcpRuleCheck = mockWriteFileSync.calls.some(
      (args) => args[0] === path.join(repoPath, ".cursor", "rules", "mcp-usage.mdc")
    );
    expect(mcpRuleCheck).toBe(false);
  });

  test("should create MCP config with stdio transport by default", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;

    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "cursor",
        mcp: {
          enabled: true,
          transport: "stdio",
        },
      },
      mockFileSystem
    );

    // Check that MCP config is created with stdio transport
    const mcpConfigCheck = mockWriteFileSync.calls.some(
      (args) =>
        args[0] === path.join(repoPath, ".cursor", "mcp.json") &&
        String(args[1]).includes("\"transport\": \"stdio\"")
    );
    expect(mcpConfigCheck).toBe(true);
  });

  test("should create MCP config with SSE transport and custom port/host", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;

    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "cursor",
        mcp: {
          enabled: true,
          transport: "sse",
          port: 8080,
          host: "localhost",
        },
      },
      mockFileSystem
    );

    // Check that MCP config is created with SSE transport and custom port/host
    const mcpConfigCheck = mockWriteFileSync.calls.some(
      (args) =>
        args[0] === path.join(repoPath, ".cursor", "mcp.json") &&
        String(args[1]).includes("\"transport\": \"sse\"") &&
        String(args[1]).includes("\"port\": 8080") &&
        String(args[1]).includes("\"host\": \"localhost\"")
    );
    expect(mcpConfigCheck).toBe(true);
  });

  test("should create MCP config with HTTP Stream transport", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;

    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "cursor",
        mcp: {
          enabled: true,
          transport: "httpStream",
        },
      },
      mockFileSystem
    );

    // Check that MCP config is created with HTTP Stream transport
    const mcpConfigCheck = mockWriteFileSync.calls.some(
      (args) =>
        args[0] === path.join(repoPath, ".cursor", "mcp.json") &&
        String(args[1]).includes("\"transport\": \"httpStream\"")
    );
    expect(mcpConfigCheck).toBe(true);
  });

  test("should throw error for unimplemented backend", async () => {
    // Set up mocks
    const mockExistsSync = createMockFunction();
    const mockMkdirSync = createMockFunction();
    const mockWriteFileSync = createMockFunction();
    
    // Set up mock file system
    const mockFileSystem: FileSystem = {
      existsSync: mockExistsSync as any,
      mkdirSync: mockMkdirSync as any,
      writeFileSync: mockWriteFileSync as any,
    };
    
    // Test that it throws an error for unimplemented backend
    try {
      await initializeProjectWithFS(
        {
          repoPath,
          backend: "tasks.csv" as any,
          ruleFormat: "cursor",
        },
        mockFileSystem
      );
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(String(error)).toContain("not implemented yet");
    }
  });

  test("should throw error if file already exists", async () => {
    // Set up mocks
    const mockExistsSync = createMockFunction();
    // Mock file exists for specific path
    mockExistsSync.mockImplementation((filePath: string) => {
      if (filePath === path.join(repoPath, "process", "tasks.md")) {
        return true;
      }
      return false;
    });
    
    const mockMkdirSync = createMockFunction();
    const mockWriteFileSync = createMockFunction();
    
    // Set up mock file system
    const mockFileSystem: FileSystem = {
      existsSync: mockExistsSync as any,
      mkdirSync: mockMkdirSync as any,
      writeFileSync: mockWriteFileSync as any,
    };
    
    // Test that it throws an error when file exists
    try {
      await initializeProjectWithFS(
        {
          repoPath,
          backend: "tasks.md",
          ruleFormat: "cursor",
        },
        mockFileSystem
      );
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(String(error)).toContain("File already exists");
    }
  });

  test("should create parent directories if they don't exist", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;

    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "cursor",
      },
      mockFileSystem
    );

    // Check that parent directories were created
    expect(mockMkdirSync.calls.length).toBeGreaterThan(0);
  });

  test("should only configure MCP when mcpOnly is true", async () => {
    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "cursor",
        mcpOnly: true,
      },
      mockFileSystem
    );

    // Should not create tasks.md
    const tasksFileCheck = mockWriteFileSync.calls.filter(
      (args) => String(args[0]).includes("tasks.md")
    );
    expect(tasksFileCheck.length).toBe(0);

    // Should create MCP config
    const mcpConfigCheck = mockWriteFileSync.calls.filter(
      (args) => String(args[0]).includes("mcp.json")
    );
    expect(mcpConfigCheck.length).toBe(1);
  });

  test("should overwrite existing files when overwrite is true", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    
    // Make it look like all files already exist
    mockExistsSync.returnValue = true;

    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "cursor",
        overwrite: true,
      },
      mockFileSystem
    );

    // Files should still have been written even though they "existed"
    expect(mockWriteFileSync.calls.length).toBeGreaterThan(0);
  });

  test("should only configure MCP and overwrite existing files when both options are true", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    
    // Make it look like all files already exist
    mockExistsSync.returnValue = true;

    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "cursor",
        mcpOnly: true,
        overwrite: true,
      },
      mockFileSystem
    );

    // Only MCP config should be written, and it should be overwritten
    const mcpConfigCheck = mockWriteFileSync.calls.some(
      (args) => args[0] === path.join(repoPath, ".cursor", "mcp.json")
    );
    expect(mcpConfigCheck).toBe(true);

    // Task backend file should not be created when mcpOnly is true
    const taskFileCheck = mockWriteFileSync.calls.some(
      (args) => args[0] === path.join(repoPath, "process", "tasks.md")
    );
    expect(taskFileCheck).toBe(false);
  });
});
