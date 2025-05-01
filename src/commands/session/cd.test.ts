import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync, execSync } from "child_process";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { SessionDB } from "../../domain/session";
import type { SessionRecord } from "../../domain/session";

// Path to the CLI entry point
const CLI = "src/cli.ts";

// Test directory
const TEST_DIR = "/tmp/minsky-session-dir-test";
const GIT_DIR = join(TEST_DIR, "minsky", "git");

// Helper to setup session DB
function setupSessionDb(sessions: SessionRecord[]) {
  // Create directories
  mkdirSync(join(TEST_DIR, "minsky"), { recursive: true });
  
  // Write session DB
  writeFileSync(
    join(TEST_DIR, "minsky", "session-db.json"),
    JSON.stringify(sessions, null, 2)
  );
  
  // Create session repo directories
  for (const session of sessions) {
    const repoName = session.repoName || session.repoUrl.replace(/[^\w-]/g, "_");
    const sessionPath = join(GIT_DIR, repoName, "sessions", session.session);
    mkdirSync(sessionPath, { recursive: true });
  }
}

describe("minsky session dir CLI", () => {
  beforeEach(() => {
    // Clean up any existing test directories
    rmSync(TEST_DIR, { recursive: true, force: true });
  });
  
  afterEach(() => {
    // Clean up test directories
    rmSync(TEST_DIR, { recursive: true, force: true });
  });
  
  it("returns the correct path for a session with repo name", () => {
    // Setup a session with repoName field
    setupSessionDb([
      { 
        session: "test-session", 
        repoUrl: "https://github.com/test/repo", 
        repoName: "test/repo", 
        branch: "main", 
        createdAt: "2024-01-01" 
      }
    ]);
    
    // The expected correct path should include the repo name and sessions subdirectory
    const expectedPath = join(GIT_DIR, "test/repo", "sessions", "test-session");
    
    // Run the command
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "dir", "test-session"], { 
      encoding: "utf-8", 
      env: { 
        ...process.env, 
        XDG_STATE_HOME: TEST_DIR 
      } 
    });
    
    expect(stdout.trim()).toBe(expectedPath);
    expect(stderr).toBe("");
    
    // Verify the directory exists
    expect(existsSync(expectedPath)).toBe(true);
  });
  
  it("handles sessions with task IDs correctly", () => {
    // Setup a session associated with a task
    setupSessionDb([
      { 
        session: "task#008", 
        repoUrl: "file:///Users/test/Projects/repo", 
        repoName: "repo", 
        branch: "task#008", 
        createdAt: "2024-01-01",
        taskId: "#008"
      }
    ]);
    
    // The expected correct path should include the repo name and sessions subdirectory
    const expectedPath = join(GIT_DIR, "repo", "sessions", "task#008");
    
    // Run the command
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "dir", "task#008"], { 
      encoding: "utf-8", 
      env: { 
        ...process.env, 
        XDG_STATE_HOME: TEST_DIR 
      } 
    });
    
    expect(stdout.trim()).toBe(expectedPath);
    expect(stderr).toBe("");
    
    // Verify the directory exists
    expect(existsSync(expectedPath)).toBe(true);
  });
}); 
