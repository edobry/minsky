import { describe, it, expect, afterEach, mock } from "bun:test";
import { writeFileSync, rmSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const CLI = "src/cli.ts";
const SESSION_DB_PATH = join(process.env.XDG_STATE_HOME || "/tmp", "minsky", "session-db.json");

function setupSessionDb(sessions: Array<{ session: string; repoUrl: string; repoName: string; branch?: string; createdAt: string; taskId?: string; repoPath?: string }>) {
  mkdirSync(join(process.env.XDG_STATE_HOME || "/tmp", "minsky"), { recursive: true });
  writeFileSync(SESSION_DB_PATH, JSON.stringify(sessions, null, 2));
}

// Mock the prompt module to automatically respond "y" to confirmation prompts
mock.module("bun-promptx", () => ({
  prompt: () => Promise.resolve("y")
}));

describe("minsky session delete CLI", () => {
  afterEach(() => {
    rmSync(SESSION_DB_PATH, { force: true });
  });

  it("deletes session when it exists", () => {
    // Create session directory for test
    const sessionDir = join(process.env.XDG_STATE_HOME || "/tmp", "minsky", "git", "test-repo", "sessions", "test-session");
    mkdirSync(join(sessionDir, ".."), { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    
    // Set up test data - note: in real implementation, the CLI removes from DB only, not the directory itself
    setupSessionDb([
      { 
        session: "test-session", 
        repoUrl: "https://github.com/test/repo", 
        repoName: "test-repo", 
        branch: "main", 
        createdAt: "2024-01-01",
        repoPath: sessionDir
      }
    ]);
    
    const { stdout } = spawnSync("bun", ["run", CLI, "session", "delete", "test-session", "--json", "--force"], { 
      encoding: "utf-8", 
      env: { ...process.env, XDG_STATE_HOME: "/tmp" }
    });
    
    // Verify it succeeded - output should be JSON result
    const result = JSON.parse(stdout.trim());
    expect(result.success).toBe(true);
    
    // Verify session was removed from DB
    const listResult = spawnSync("bun", ["run", CLI, "session", "list", "--json"], {
      encoding: "utf-8",
      env: { ...process.env, XDG_STATE_HOME: "/tmp" }
    });
    const sessions = JSON.parse(listResult.stdout);
    
    expect(sessions.length).toBe(0);
    
    // The implementation now actually removes the directory as well, contrary to the comment
    expect(existsSync(sessionDir)).toBe(false);
  });
  
  it("outputs JSON format with --json flag", () => {
    setupSessionDb([
      { 
        session: "test-session", 
        repoUrl: "https://repo", 
        repoName: "repo", 
        branch: "main", 
        createdAt: "2024-01-01" 
      }
    ]);
    
    const { stdout } = spawnSync("bun", ["run", CLI, "session", "delete", "test-session", "--json", "--force"], { 
      encoding: "utf-8", 
      env: { ...process.env, XDG_STATE_HOME: "/tmp" }
    });
    
    const result = JSON.parse(stdout.trim());
    expect(result.success).toBe(true);
  });
  
  it("handles non-existent sessions with appropriate error", () => {
    setupSessionDb([]);
    
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "delete", "nonexistent"], { 
      encoding: "utf-8", 
      env: { ...process.env, XDG_STATE_HOME: "/tmp" }
    });
    
    expect(stdout).toBe("");
    expect(stderr).toContain("Session 'nonexistent' not found");
  });
  
  it("handles non-existent sessions with JSON output", () => {
    setupSessionDb([]);
    
    const { stdout } = spawnSync("bun", ["run", CLI, "session", "delete", "nonexistent", "--json"], { 
      encoding: "utf-8", 
      env: { ...process.env, XDG_STATE_HOME: "/tmp" }
    });
    
    const result = JSON.parse(stdout.trim());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Session 'nonexistent' not found");
  });
}); 
