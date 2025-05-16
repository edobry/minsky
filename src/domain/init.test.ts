import { describe, test, expect } from "bun:test";
import { initializeProject, initializeProjectWithFS } from "./init";
import type { FileSystem } from "./init";
import fs from "fs";
import path from "path";
import { createMockFileSystem, setupTestMocks } from "../utils/test-utils/mocking";

// Set up automatic mock cleanup
setupTestMocks();

// Use a temp directory under the session workspace for all test file operations
const sessionTempDir = path.join(Bun.env.SESSION_WORKSPACE || process.env.SESSION_WORKSPACE || "/Users/edobry/.local/state/minsky/git/local/minsky/sessions/task#077", "test-tmp");

describe("initializeProject", () => {
<<<<<<< HEAD
  // Test utility to track function calls
  const trackCalls = <T = any>() => {
    const calls: any[] = [];
    const fn = (...args: any[]): T => {
      calls.push(args);
      return fn.returnValue as T;
    };
    fn.calls = calls;
    fn.returnValue = undefined as unknown as T;
    return fn;
  };

  // Create tracked mock functions
  const mockExistsSync = trackCalls<boolean>();
  const mockMkdirSync = trackCalls();
  const mockWriteFileSync = trackCalls();

  // Set up mock file system
  const mockFileSystem = {
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    writeFileSync: mockWriteFileSync,
  };

  // Reset mocks before each test
  test("should create directories and files for tasks.md backend and cursor rule format", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
=======
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
>>>>>>> origin/main
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
<<<<<<< HEAD
    expect(mcpRuleCheck).toBe(true);

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
    }
=======
>>>>>>> origin/main
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

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
<<<<<<< HEAD
    expect(mcpRuleCheck).toBe(true);

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
=======
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
>>>>>>> origin/main
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

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
<<<<<<< HEAD
    expect(mcpRuleCheck).toBe(false);

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
    }
=======
    expect(mcpRuleCalls.length).toBe(0);
>>>>>>> origin/main
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

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
<<<<<<< HEAD

    expect(mcpConfig).toBeDefined();
    if (mcpConfig) {
      const configContent = String(mcpConfig[1]);
      const parsedConfig = JSON.parse(configContent);

      expect(parsedConfig.mcpServers).toBeDefined();
      expect(parsedConfig.mcpServers["minsky-server"]).toBeDefined();
      expect(parsedConfig.mcpServers["minsky-server"].args).toContain("--stdio");
      expect(parsedConfig.mcpServers["minsky-server"].args.includes("--sse")).toBe(false);
      expect(parsedConfig.mcpServers["minsky-server"].args.includes("--http-stream")).toBe(false);
    }

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
=======
    
    expect(mcpConfigCall).toBeTruthy();
    if (mcpConfigCall) {
      expect(String(mcpConfigCall[1])).toContain("--stdio");
>>>>>>> origin/main
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

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
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

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
    }
  });

  test("should throw error for unimplemented backend", async () => {
<<<<<<< HEAD
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
=======
    // Create a mock file system with initial empty state
    const mockFS = createMockFileSystem();
    
    // Set up mock file system
    const mockFileSystem: FileSystem = {
      existsSync: mockFS.existsSync,
      mkdirSync: mockFS.mkdirSync,
      writeFileSync: mockFS.writeFileSync,
    };
    
    // Test that it throws an error for unimplemented backend
>>>>>>> origin/main
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

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
    }
  });

  test("should throw error if file already exists", async () => {
<<<<<<< HEAD
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;

    // Mock file exists
    mockExistsSync.returnValue = true;

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
=======
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
>>>>>>> origin/main
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

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
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

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "cursor",
      },
      mockFileSystem
    );

<<<<<<< HEAD
    // Should create directories
    const mkdirCalls = mockMkdirSync.calls.map((args) => args[0]);
    expect(mkdirCalls).toContain(path.join(repoPath, "process", "tasks"));
    expect(mkdirCalls).toContain(path.join(repoPath, ".cursor", "rules"));

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
    }
=======
    // Check that parent directories were created
    expect(mockFS.mkdirSync).toHaveBeenCalledWith(
      path.join(repoPath, "process", "tasks"), 
      { recursive: true }
    );
>>>>>>> origin/main
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

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
<<<<<<< HEAD
    expect(mcpConfigCheck).toBe(true);

    // Should create MCP usage rule
    const mcpRuleCheck = mockWriteFileSync.calls.some(
      (args) => args[0] === path.join(repoPath, ".cursor", "rules", "mcp-usage.mdc")
    );
    expect(mcpRuleCheck).toBe(true);

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
    }
=======
    expect(mcpConfigCalls.length).toBe(1);
>>>>>>> origin/main
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

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
<<<<<<< HEAD
    expect(mcpConfigCheck).toBe(true);

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
    }
  });

  test("should only configure MCP and overwrite existing files when both options are true", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;

    // Mock that files already exist
    mockExistsSync.returnValue = true;

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

    // Should not create tasks.md
    const tasksFileCheck = mockWriteFileSync.calls.some(
      (args) => args[0] === path.join(repoPath, "process", "tasks.md")
    );
    expect(tasksFileCheck).toBe(false);

    // Should create MCP config despite it already existing
    const mcpConfigCheck = mockWriteFileSync.calls.some(
      (args) => args[0] === path.join(repoPath, ".cursor", "mcp.json")
    );
    expect(mcpConfigCheck).toBe(true);

    // Should create MCP usage rule despite it already existing
    const mcpRuleCheck = mockWriteFileSync.calls.some(
      (args) => args[0] === path.join(repoPath, ".cursor", "rules", "mcp-usage.mdc")
    );
    expect(mcpRuleCheck).toBe(true);
=======
    
    expect(tasksFileCall).toBeTruthy();
    if (tasksFileCall) {
      expect(String(tasksFileCall[1])).toContain("# Minsky Tasks");
    }
>>>>>>> origin/main
  });
});
