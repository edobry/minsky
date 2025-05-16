import { describe, test, expect } from "bun:test";
import { initializeProject, initializeProjectWithFS } from "./init";
import fs from "fs";
import path from "path";

// Use a temp directory under the session workspace for all test file operations
const sessionTempDir = path.join(Bun.env.SESSION_WORKSPACE || process.env.SESSION_WORKSPACE || "/Users/edobry/.local/state/minsky/git/local/minsky/sessions/task#077", "test-tmp");

describe("initializeProject", () => {
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
    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "cursor",
      },
      mockFileSystem
    );

    // Should check if directories/files exist
    const existsCalls = mockExistsSync.calls.map((args) => args[0]);
    expect(existsCalls).toContain(path.join(repoPath, "process", "tasks"));
    expect(existsCalls).toContain(path.join(repoPath, "process", "tasks.md"));
    expect(existsCalls).toContain(path.join(repoPath, ".cursor", "rules"));
    expect(existsCalls).toContain(path.join(repoPath, ".cursor", "rules", "minsky-workflow.mdc"));
    expect(existsCalls).toContain(path.join(repoPath, ".cursor", "rules", "index.mdc"));

    // Should create directories
    const mkdirCalls = mockMkdirSync.calls.map((args) => args[0]);
    expect(mkdirCalls).toContain(path.join(repoPath, "process", "tasks"));
    expect(mkdirCalls).toContain(path.join(repoPath, ".cursor", "rules"));

    // Should create files
    const writeFilesCheck = mockWriteFileSync.calls.some(
      (args) =>
        args[0] === path.join(repoPath, "process", "tasks.md") &&
        String(args[1]).includes("# Minsky Tasks")
    );
    expect(writeFilesCheck).toBe(true);

    const writeRuleCheck = mockWriteFileSync.calls.some(
      (args) =>
        args[0] === path.join(repoPath, ".cursor", "rules", "minsky-workflow.mdc") &&
        String(args[1]).includes("# Minsky Workflow")
    );
    expect(writeRuleCheck).toBe(true);

    const writeIndexCheck = mockWriteFileSync.calls.some(
      (args) =>
        args[0] === path.join(repoPath, ".cursor", "rules", "index.mdc") &&
        String(args[1]).includes("# Minsky Rules Index")
    );
    expect(writeIndexCheck).toBe(true);

    // Should create MCP config by default
    const mcpConfigCheck = mockWriteFileSync.calls.some(
      (args) =>
        args[0] === path.join(repoPath, ".cursor", "mcp.json") &&
        String(args[1]).includes("mcpServers")
    );
    expect(mcpConfigCheck).toBe(true);

    // Should create MCP usage rule
    const mcpRuleCheck = mockWriteFileSync.calls.some(
      (args) =>
        args[0] === path.join(repoPath, ".cursor", "rules", "mcp-usage.mdc") &&
        String(args[1]).includes("# MCP Usage")
    );
    expect(mcpRuleCheck).toBe(true);

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
    }
  });

  test("should create directories and files for tasks.md backend and generic rule format", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
    }
  });

  test("should create project without MCP configuration when disabled", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;

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

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
    }
  });

  test("should create MCP config with stdio transport by default", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;

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

    // Check the MCP config content
    const mcpConfig = mockWriteFileSync.calls.find(
      (args) => args[0] === path.join(repoPath, ".cursor", "mcp.json")
    );

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
    }
  });

  test("should create MCP config with SSE transport and custom port/host", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "cursor",
        mcp: {
          enabled: true,
          transport: "sse",
          port: 9000,
          host: "127.0.0.1",
        },
      },
      mockFileSystem
    );

    // Check the MCP config content
    const mcpConfig = mockWriteFileSync.calls.find(
      (args) => args[0] === path.join(repoPath, ".cursor", "mcp.json")
    );

    expect(mcpConfig).toBeDefined();
    if (mcpConfig) {
      const configContent = String(mcpConfig[1]);
      const parsedConfig = JSON.parse(configContent);

      expect(parsedConfig.mcpServers).toBeDefined();
      expect(parsedConfig.mcpServers["minsky-server"]).toBeDefined();
      expect(parsedConfig.mcpServers["minsky-server"].args).toContain("--sse");
      expect(parsedConfig.mcpServers["minsky-server"].args).toContain("--port");
      expect(parsedConfig.mcpServers["minsky-server"].args).toContain("9000");
      expect(parsedConfig.mcpServers["minsky-server"].args).toContain("--host");
      expect(parsedConfig.mcpServers["minsky-server"].args).toContain("127.0.0.1");
    }

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
    }
  });

  test("should create MCP config with HTTP Stream transport", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "cursor",
        mcp: {
          enabled: true,
          transport: "httpStream",
          port: 8888,
        },
      },
      mockFileSystem
    );

    // Check the MCP config content
    const mcpConfig = mockWriteFileSync.calls.find(
      (args) => args[0] === path.join(repoPath, ".cursor", "mcp.json")
    );

    expect(mcpConfig).toBeDefined();
    if (mcpConfig) {
      const configContent = String(mcpConfig[1]);
      const parsedConfig = JSON.parse(configContent);

      expect(parsedConfig.mcpServers).toBeDefined();
      expect(parsedConfig.mcpServers["minsky-server"]).toBeDefined();
      expect(parsedConfig.mcpServers["minsky-server"].args).toContain("--http-stream");
      expect(parsedConfig.mcpServers["minsky-server"].args).toContain("--port");
      expect(parsedConfig.mcpServers["minsky-server"].args).toContain("8888");
    }

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
    }
  });

  test("should throw error for unimplemented backend", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await initializeProjectWithFS(
        {
          repoPath,
          backend: "tasks.csv",
          ruleFormat: "cursor",
        },
        mockFileSystem
      );
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(String(error)).toContain("The tasks.csv backend is not implemented yet.");
    }

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
    }
  });

  test("should throw error if file already exists", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;

    // Mock file exists
    mockExistsSync.returnValue = true;

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;

    const repoPath = path.join(sessionTempDir, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "cursor",
      },
      mockFileSystem
    );

    // Should create directories
    const mkdirCalls = mockMkdirSync.calls.map((args) => args[0]);
    expect(mkdirCalls).toContain(path.join(repoPath, "process", "tasks"));
    expect(mkdirCalls).toContain(path.join(repoPath, ".cursor", "rules"));

    // Clean up the directory after the test
    if (fs.existsSync(repoPath)) {
      fs.rmdirSync(repoPath, { recursive: true });
    }
  });

  test("should only configure MCP when mcpOnly is true", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;

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
    const tasksFileCheck = mockWriteFileSync.calls.some(
      (args) => args[0] === path.join(repoPath, "process", "tasks.md")
    );
    expect(tasksFileCheck).toBe(false);

    // Should not create minsky-workflow.mdc
    const workflowRuleCheck = mockWriteFileSync.calls.some(
      (args) => args[0] === path.join(repoPath, ".cursor", "rules", "minsky-workflow.mdc")
    );
    expect(workflowRuleCheck).toBe(false);

    // Should create MCP config
    const mcpConfigCheck = mockWriteFileSync.calls.some(
      (args) => args[0] === path.join(repoPath, ".cursor", "mcp.json")
    );
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
  });

  test("should overwrite existing files when overwrite is true", async () => {
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
        overwrite: true,
      },
      mockFileSystem
    );

    // Should create all files despite them already existing
    expect(mockWriteFileSync.calls.length).toBeGreaterThan(0);

    // Check for MCP config specifically
    const mcpConfigCheck = mockWriteFileSync.calls.some(
      (args) => args[0] === path.join(repoPath, ".cursor", "mcp.json")
    );
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
  });
});
