import { describe, test, expect } from "bun:test";
import { initializeProject, initializeProjectWithFS } from "./init";
import type { FileSystem } from "./init";
import fs from "fs";
import path from "path";
import { createMockFileSystem, setupTestMocks } from "../utils/test-utils/mocking";

// Set up automatic mock cleanup
setupTestMocks();

describe("initializeProject", () => {
  const repoPath = "/test/repo";

  test("should create directories and files for tasks.md backend and cursor rule format", async () => {
    // Create a mock file system with initial empty state
    const mockFS = createMockFileSystem();
    
    // Set up mock file system
    const mockFileSystem: FileSystem = {
      existsSync: mockFS.existsSync,
      mkdirSync: mockFS.mkdirSync,
      writeFileSync: mockFS.writeFileSync,
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

    // Verify the results - check that directories were created
    expect(mockFS.mkdirSync).toHaveBeenCalledWith(
      path.join(repoPath, "process", "tasks"), 
      { recursive: true }
    );
    
    expect(mockFS.mkdirSync).toHaveBeenCalledWith(
      path.join(repoPath, ".cursor", "rules"), 
      { recursive: true }
    );
    
    // Verify files were written with correct content
    expect(mockFS.writeFileSync).toHaveBeenCalledWith(
      path.join(repoPath, "process", "tasks.md"),
      expect.stringContaining("# Minsky Tasks")
    );
    
    expect(mockFS.writeFileSync).toHaveBeenCalledWith(
      path.join(repoPath, ".cursor", "rules", "minsky-workflow.mdc"),
      expect.stringContaining("# Minsky Workflow")
    );
    
    expect(mockFS.writeFileSync).toHaveBeenCalledWith(
      path.join(repoPath, ".cursor", "mcp.json"),
      expect.stringContaining("mcpServers")
    );
  });

  test("should create directories and files for tasks.md backend and generic rule format", async () => {
    // Create a mock file system with initial empty state
    const mockFS = createMockFileSystem();
    
    // Set up mock file system
    const mockFileSystem: FileSystem = {
      existsSync: mockFS.existsSync,
      mkdirSync: mockFS.mkdirSync,
      writeFileSync: mockFS.writeFileSync,
    };

    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "generic",
      },
      mockFileSystem
    );

    // Verify directories were created
    expect(mockFS.mkdirSync).toHaveBeenCalledWith(
      path.join(repoPath, ".ai", "rules"), 
      { recursive: true }
    );

    // Verify files were written with correct content - check for calls containing the expected content
    const writeFileCalls = mockFS.writeFileSync.mock.calls;
    
    // Check minsky-workflow.mdc
    const workflowCall = writeFileCalls.find(
      call => String(call[0]) === path.join(repoPath, ".ai", "rules", "minsky-workflow.mdc")
    );
    expect(workflowCall).toBeTruthy();
    if (workflowCall) {
      expect(String(workflowCall[1])).toContain("# Minsky Workflow");
    }
    
    // Check index.mdc
    const indexCall = writeFileCalls.find(
      call => String(call[0]) === path.join(repoPath, ".ai", "rules", "index.mdc")
    );
    expect(indexCall).toBeTruthy();
    if (indexCall) {
      expect(String(indexCall[1])).toContain("# Minsky Rules Index");
    }
    
    // Check MCP config
    const mcpConfigCall = writeFileCalls.find(
      call => String(call[0]) === path.join(repoPath, ".cursor", "mcp.json")
    );
    expect(mcpConfigCall).toBeTruthy();
    if (mcpConfigCall) {
      expect(String(mcpConfigCall[1])).toContain("mcpServers");
    }
    
    // Check MCP usage rule
    const mcpRuleCall = writeFileCalls.find(
      call => String(call[0]) === path.join(repoPath, ".ai", "rules", "mcp-usage.mdc")
    );
    expect(mcpRuleCall).toBeTruthy();
    if (mcpRuleCall) {
      expect(String(mcpRuleCall[1])).toContain("# MCP Usage");
    }
  });

  test("should create project without MCP configuration when disabled", async () => {
    // Create a mock file system with initial empty state
    const mockFS = createMockFileSystem();
    
    // Set up mock file system
    const mockFileSystem: FileSystem = {
      existsSync: mockFS.existsSync,
      mkdirSync: mockFS.mkdirSync,
      writeFileSync: mockFS.writeFileSync,
    };

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

    // Verify MCP config was NOT created when disabled
    const mcpConfigCalls = mockFS.writeFileSync.mock.calls.filter(
      (args) => String(args[0]) === path.join(repoPath, ".cursor", "mcp.json")
    );
    expect(mcpConfigCalls.length).toBe(0);

    // Verify MCP usage rule was NOT created when disabled
    const mcpRuleCalls = mockFS.writeFileSync.mock.calls.filter(
      (args) => String(args[0]) === path.join(repoPath, ".cursor", "rules", "mcp-usage.mdc")
    );
    expect(mcpRuleCalls.length).toBe(0);
  });

  test("should create MCP config with stdio transport by default", async () => {
    // Create a mock file system with initial empty state
    const mockFS = createMockFileSystem();
    
    // Set up mock file system
    const mockFileSystem: FileSystem = {
      existsSync: mockFS.existsSync,
      mkdirSync: mockFS.mkdirSync,
      writeFileSync: mockFS.writeFileSync,
    };

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
    const mcpConfigCall = mockFS.writeFileSync.mock.calls.find(
      call => String(call[0]) === path.join(repoPath, ".cursor", "mcp.json")
    );
    
    expect(mcpConfigCall).toBeTruthy();
    if (mcpConfigCall) {
      expect(String(mcpConfigCall[1])).toContain("--stdio");
    }
  });

  test("should create MCP config with SSE transport and custom port/host", async () => {
    // Create a mock file system with initial empty state
    const mockFS = createMockFileSystem();
    
    // Set up mock file system
    const mockFileSystem: FileSystem = {
      existsSync: mockFS.existsSync,
      mkdirSync: mockFS.mkdirSync,
      writeFileSync: mockFS.writeFileSync,
    };

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

    // Find the MCP config call
    const mcpConfigCall = mockFS.writeFileSync.mock.calls.find(
      call => String(call[0]) === path.join(repoPath, ".cursor", "mcp.json")
    );
    
    // Verify the MCP config was created and has the expected content
    expect(mcpConfigCall).toBeTruthy();
    if (mcpConfigCall) {
      const mcpConfigContent = String(mcpConfigCall[1]);
      expect(mcpConfigContent).toContain("--sse");
      expect(mcpConfigContent).toContain("8080");
      expect(mcpConfigContent).toContain("localhost");
    }
  });

  test("should create MCP config with HTTP Stream transport", async () => {
    // Create a mock file system with initial empty state
    const mockFS = createMockFileSystem();
    
    // Set up mock file system
    const mockFileSystem: FileSystem = {
      existsSync: mockFS.existsSync,
      mkdirSync: mockFS.mkdirSync,
      writeFileSync: mockFS.writeFileSync,
    };

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

    // Find the MCP config call
    const mcpConfigCall = mockFS.writeFileSync.mock.calls.find(
      call => String(call[0]) === path.join(repoPath, ".cursor", "mcp.json")
    );
    
    // Verify the MCP config was created and has the expected transport
    expect(mcpConfigCall).toBeTruthy();
    if (mcpConfigCall) {
      expect(String(mcpConfigCall[1])).toContain("--http-stream");
    }
  });

  test("should throw error for unimplemented backend", async () => {
    // Create a mock file system with initial empty state
    const mockFS = createMockFileSystem();
    
    // Set up mock file system
    const mockFileSystem: FileSystem = {
      existsSync: mockFS.existsSync,
      mkdirSync: mockFS.mkdirSync,
      writeFileSync: mockFS.writeFileSync,
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
    // Create a mock file system with tasks.md already existing
    const mockFS = createMockFileSystem({
      [path.join(repoPath, "process", "tasks.md")]: "Existing content"
    });
    
    // Set up mock file system
    const mockFileSystem: FileSystem = {
      existsSync: mockFS.existsSync,
      mkdirSync: mockFS.mkdirSync,
      writeFileSync: mockFS.writeFileSync,
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
    // Create a mock file system with initial empty state
    const mockFS = createMockFileSystem();
    
    // Set up mock file system
    const mockFileSystem: FileSystem = {
      existsSync: mockFS.existsSync,
      mkdirSync: mockFS.mkdirSync,
      writeFileSync: mockFS.writeFileSync,
    };

    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "cursor",
      },
      mockFileSystem
    );

    // Check that parent directories were created
    expect(mockFS.mkdirSync).toHaveBeenCalledWith(
      path.join(repoPath, "process", "tasks"), 
      { recursive: true }
    );
  });

  test("should only configure MCP when mcpOnly is true", async () => {
    // Create a mock file system
    const mockFS = createMockFileSystem();
    
    // Set up mock file system
    const mockFileSystem: FileSystem = {
      existsSync: mockFS.existsSync,
      mkdirSync: mockFS.mkdirSync,
      writeFileSync: mockFS.writeFileSync,
    };

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
    const tasksFileCalls = mockFS.writeFileSync.mock.calls.filter(
      (args) => String(args[0]).includes("tasks.md")
    );
    expect(tasksFileCalls.length).toBe(0);

    // Should create MCP config
    const mcpConfigCalls = mockFS.writeFileSync.mock.calls.filter(
      (args) => String(args[0]).includes("mcp.json")
    );
    expect(mcpConfigCalls.length).toBe(1);
  });

  test("should overwrite existing files when overwrite is true", async () => {
    // Create a mock file system with files already existing
    const mockFS = createMockFileSystem({
      [path.join(repoPath, "process", "tasks.md")]: "Existing content",
      [path.join(repoPath, ".cursor", "rules", "minsky-workflow.mdc")]: "Existing rule"
    });
    
    // Set up mock file system
    const mockFileSystem: FileSystem = {
      existsSync: mockFS.existsSync,
      mkdirSync: mockFS.mkdirSync,
      writeFileSync: mockFS.writeFileSync,
    };

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
    const tasksFileCall = mockFS.writeFileSync.mock.calls.find(
      call => String(call[0]) === path.join(repoPath, "process", "tasks.md")
    );
    
    expect(tasksFileCall).toBeTruthy();
    if (tasksFileCall) {
      expect(String(tasksFileCall[1])).toContain("# Minsky Tasks");
    }
  });
});
