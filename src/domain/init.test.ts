import { describe, test, expect } from "bun:test";
import { initializeProject, initializeProjectWithFS } from "./init";
import fs from "fs";
import path from "path";

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

  const repoPath = "/test/repo";
  
  // Create tracked mock functions
  const mockExistsSync = trackCalls<boolean>();
  const mockMkdirSync = trackCalls();
  const mockWriteFileSync = trackCalls();
  
  // Set up mock file system
  const mockFileSystem = {
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    writeFileSync: mockWriteFileSync
  };

  // Reset mocks before each test
  test("should create directories and files for tasks.md backend and cursor rule format", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;
    
    await initializeProjectWithFS(
      {
        repoPath,
        backend: "tasks.md",
        ruleFormat: "cursor"
      },
      mockFileSystem
    );

    // Should check if directories/files exist
    const existsCalls = mockExistsSync.calls.map(args => args[0]);
    expect(existsCalls).toContain(path.join(repoPath, "process", "tasks"));
    expect(existsCalls).toContain(path.join(repoPath, "process", "tasks.md"));
    expect(existsCalls).toContain(path.join(repoPath, ".cursor", "rules"));
    expect(existsCalls).toContain(path.join(repoPath, ".cursor", "rules", "minsky-workflow.mdc"));
    expect(existsCalls).toContain(path.join(repoPath, ".cursor", "rules", "index.mdc"));

    // Should create directories
    const mkdirCalls = mockMkdirSync.calls.map(args => args[0]);
    expect(mkdirCalls).toContain(path.join(repoPath, "process", "tasks"));
    expect(mkdirCalls).toContain(path.join(repoPath, ".cursor", "rules"));

    // Should create files
    const writeFilesCheck = mockWriteFileSync.calls.some(args => 
      args[0] === path.join(repoPath, "process", "tasks.md") && 
      String(args[1]).includes("# Minsky Tasks")
    );
    expect(writeFilesCheck).toBe(true);
    
    const writeRuleCheck = mockWriteFileSync.calls.some(args => 
      args[0] === path.join(repoPath, ".cursor", "rules", "minsky-workflow.mdc") && 
      String(args[1]).includes("# Minsky Workflow")
    );
    expect(writeRuleCheck).toBe(true);
    
    const writeIndexCheck = mockWriteFileSync.calls.some(args => 
      args[0] === path.join(repoPath, ".cursor", "rules", "index.mdc") && 
      String(args[1]).includes("# Minsky Rules Index")
    );
    expect(writeIndexCheck).toBe(true);
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
        ruleFormat: "generic"
      },
      mockFileSystem
    );

    // Should check directories/files
    const existsCalls = mockExistsSync.calls.map(args => args[0]);
    expect(existsCalls).toContain(path.join(repoPath, ".ai", "rules"));
    expect(existsCalls).toContain(path.join(repoPath, ".ai", "rules", "minsky-workflow.mdc"));
    expect(existsCalls).toContain(path.join(repoPath, ".ai", "rules", "index.mdc"));

    // Should create directories
    const mkdirCalls = mockMkdirSync.calls.map(args => args[0]);
    expect(mkdirCalls).toContain(path.join(repoPath, ".ai", "rules"));

    // Should create files
    const writeRuleCheck = mockWriteFileSync.calls.some(args => 
      args[0] === path.join(repoPath, ".ai", "rules", "minsky-workflow.mdc") && 
      String(args[1]).includes("# Minsky Workflow")
    );
    expect(writeRuleCheck).toBe(true);
    
    const writeIndexCheck = mockWriteFileSync.calls.some(args => 
      args[0] === path.join(repoPath, ".ai", "rules", "index.mdc") && 
      String(args[1]).includes("# Minsky Rules Index")
    );
    expect(writeIndexCheck).toBe(true);
  });

  test("should throw error for unimplemented backend", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    mockExistsSync.returnValue = false;
    
    try {
      await initializeProjectWithFS(
        {
          repoPath,
          backend: "tasks.csv",
          ruleFormat: "cursor"
        },
        mockFileSystem
      );
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(String(error)).toContain("The tasks.csv backend is not implemented yet.");
    }
  });

  test("should throw error if file already exists", async () => {
    // Reset mocks for this test
    mockExistsSync.calls.length = 0;
    mockMkdirSync.calls.length = 0;
    mockWriteFileSync.calls.length = 0;
    
    // Mock file exists
    mockExistsSync.returnValue = true;

    try {
      await initializeProjectWithFS(
        {
          repoPath,
          backend: "tasks.md",
          ruleFormat: "cursor"
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
        ruleFormat: "cursor"
      },
      mockFileSystem
    );

    // Should create directories
    const mkdirCalls = mockMkdirSync.calls.map(args => args[0]);
    expect(mkdirCalls).toContain(path.join(repoPath, "process", "tasks"));
    expect(mkdirCalls).toContain(path.join(repoPath, ".cursor", "rules"));
  });
}); 
