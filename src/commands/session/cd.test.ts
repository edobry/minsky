import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
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
    // Create both legacy path and new path with sessions subdirectory
    const legacyPath = join(GIT_DIR, repoName, session.session);
    const newPath = join(GIT_DIR, repoName, "sessions", session.session);
    
    // For test variety, use the new path for some sessions and legacy for others
    if (session.session.includes("new")) {
      mkdirSync(newPath, { recursive: true });
    } else {
      mkdirSync(legacyPath, { recursive: true });
    }
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
  
  it("returns the correct path for a session with legacy path structure", () => {
    // Setup a session with repoName field in legacy structure
    setupSessionDb([
      { 
        session: "test-session", 
        repoUrl: "https://github.com/test/repo", 
        repoName: "test/repo", 
        branch: "main", 
        createdAt: "2024-01-01" 
      }
    ]);
    
    // The expected correct path should include the repo name in the structure
    const expectedPath = join(GIT_DIR, "test/repo", "test-session");
    
    // Run the command
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "dir", "test-session"], { 
      encoding: "utf-8", 
      env: { 
        ...process.env, 
        XDG_STATE_HOME: TEST_DIR 
      } 
    });
    
    // The command should return the correct path
    expect(stdout.trim()).toBe(expectedPath);
    expect(stderr).toBe("");
    
    // Verify the directory exists
    expect(existsSync(expectedPath)).toBe(true);
  });
  
  it("returns the correct path for a session with new sessions subdirectory", () => {
    // Setup a session with repoName field in new structure
    setupSessionDb([
      { 
        session: "test-session-new", 
        repoUrl: "https://github.com/test/repo", 
        repoName: "test/repo", 
        branch: "main", 
        createdAt: "2024-01-01" 
      }
    ]);
    
    // The expected correct path should include the sessions subdirectory
    const expectedPath = join(GIT_DIR, "test/repo", "sessions", "test-session-new");
    
    // Run the command
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "dir", "test-session-new"], { 
      encoding: "utf-8", 
      env: { 
        ...process.env, 
        XDG_STATE_HOME: TEST_DIR 
      } 
    });
    
    // The command should return the correct path
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
    
    // The expected correct path should include the repo name in the structure
    const expectedPath = join(GIT_DIR, "repo", "task#008");
    
    // Run the command
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "dir", "task#008"], { 
      encoding: "utf-8", 
      env: { 
        ...process.env, 
        XDG_STATE_HOME: TEST_DIR 
      } 
    });
    
    // The command should return the correct path
    expect(stdout.trim()).toBe(expectedPath);
    expect(stderr).toBe("");
    
    // Verify the directory exists
    expect(existsSync(expectedPath)).toBe(true);
  });
  
  it("finds a session by task ID using --task option", () => {
    // Setup a session associated with a task
    setupSessionDb([
      { 
        session: "task#009", 
        repoUrl: "file:///Users/test/Projects/repo", 
        repoName: "repo", 
        branch: "task#009", 
        createdAt: "2024-01-01",
        taskId: "#009"
      }
    ]);
    
    // The expected correct path should include the repo name in the structure
    const expectedPath = join(GIT_DIR, "repo", "task#009");
    
    // Run the command with --task option
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "dir", "--task", "009"], { 
      encoding: "utf-8", 
      env: { 
        ...process.env, 
        XDG_STATE_HOME: TEST_DIR 
      } 
    });
    
    // The command should return the correct path
    expect(stdout.trim()).toBe(expectedPath);
    expect(stderr).toBe("");
    
    // Verify the directory exists
    expect(existsSync(expectedPath)).toBe(true);
  });
  
  it("returns an error for non-existent sessions", () => {
    // Run the command with a non-existent session
    const { stdout, stderr, status } = spawnSync("bun", ["run", CLI, "session", "dir", "non-existent-session"], { 
      encoding: "utf-8", 
      env: { 
        ...process.env, 
        XDG_STATE_HOME: TEST_DIR 
      } 
    });
    
    // The command should return an error
    expect(status).not.toBe(0);
    expect(stderr).toContain("not found");
    expect(stdout).toBe("");
  });
  
  it("returns an error for non-existent task IDs with --task", () => {
    // Run the command with a non-existent task ID
    const { stdout, stderr, status } = spawnSync("bun", ["run", CLI, "session", "dir", "--task", "999"], { 
      encoding: "utf-8", 
      env: { 
        ...process.env, 
        XDG_STATE_HOME: TEST_DIR 
      } 
    });
    
    // The command should return an error
    expect(status).not.toBe(0);
    expect(stderr).toContain("No session found for task ID");
    expect(stdout).toBe("");
  });
  
  it("returns an error when both session and --task are provided", () => {
    // Run the command with both a session name and --task
    const { stdout, stderr, status } = spawnSync("bun", ["run", CLI, "session", "dir", "test-session", "--task", "009"], { 
      encoding: "utf-8", 
      env: { 
        ...process.env, 
        XDG_STATE_HOME: TEST_DIR 
      } 
    });
    
    // The command should return an error
    expect(status).not.toBe(0);
    expect(stderr).toContain("Provide either a session name or --task, not both");
    expect(stdout).toBe("");
  });
  
  it("returns an error when neither session nor --task are provided", () => {
    // Run the command with neither a session name nor --task
    const { stdout, stderr, status } = spawnSync("bun", ["run", CLI, "session", "dir"], { 
      encoding: "utf-8", 
      env: { 
        ...process.env, 
        XDG_STATE_HOME: TEST_DIR 
      } 
    });
    
    // The command should return an error
    expect(status).not.toBe(0);
    expect(stderr).toContain("You must provide either a session name or --task");
    expect(stdout).toBe("");
  });
}); 
