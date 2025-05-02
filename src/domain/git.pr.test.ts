import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from "bun:test";
import { GitService } from "./git";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { promises as fs } from "fs";
import { SessionDB } from "./session";
import * as execModule from "../utils/exec";

// Define the type for exec result
interface ExecResult {
  stdout: string;
  stderr: string;
}

function run(cmd: string, cwd: string) {
  try {
    execSync(cmd, { cwd, stdio: "pipe" });
  } catch (error) {
    console.error(`Command failed: ${cmd}`);
    console.error(`Working directory: ${cwd}`);
    if (error instanceof Error) {
      console.error(error.message);
    }
    throw error;
  }
}

describe("GitService PR base branch detection", () => {
  // Set up test environment
  let execAsyncMock: ReturnType<typeof mock<(cmd: string, options?: any) => Promise<ExecResult>>>;
  
  beforeEach(() => {
    // Create a mock for execAsync that properly returns a promise with expected stdout
    execAsyncMock = mock((cmd: string, options?: any) => {
      // Simulate git remote show origin for default branch detection
      if (cmd.includes("git remote show origin")) {
        return Promise.resolve({ stdout: "HEAD branch: main", stderr: "" });
      }
      
      // Handle git push command
      if (cmd.includes("git push")) {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      
      // Default response
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    
    // Mock the execAsync function from the module
    mock.module("../utils/exec", () => ({
      execAsync: execAsyncMock
    }));
  });

  it("should generate PR diff against main branch", async () => {
    // Create GitService
    const git = new GitService();
    
    // Call PR method
    await git.pr({
      repoPath: "/path/to/repo",
      branch: "feature/test"
    });
    
    // Verify git commands were called correctly
    expect(execAsyncMock).toHaveBeenCalledWith("git remote show origin", { cwd: "/path/to/repo" });
    expect(execAsyncMock).toHaveBeenCalledWith("git push -u origin feature/test", { cwd: "/path/to/repo" });
  });
}); 
