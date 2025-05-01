import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { GitService } from './git';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { mock } from "bun:test";
import { promises as fs } from "fs";
import { SessionDB } from "./session";

function run(cmd: string, cwd: string) {
  try {
    execSync(cmd, { cwd, stdio: 'pipe' });
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
  beforeEach(() => {
    // Set up mock execAsync globally
    (global as any).execAsync = mock(async (cmd) => {
      // Simulate git remote show origin for default branch detection
      if (cmd.includes("git remote show origin")) {
        return { stdout: "HEAD branch: main", stderr: "" };
      }
      // Default response
      return { stdout: "", stderr: "" };
    });
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
    const mockExecAsync = (global as any).execAsync;
    expect(mockExecAsync).toHaveBeenCalledWith("git remote show origin", { cwd: "/path/to/repo" });
  });
}); 
