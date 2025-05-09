import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { writeFileSync, rmSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const CLI = "src/cli.ts";
const TEST_DIR = "/tmp/minsky-test";
const SESSION_DB_PATH = join(TEST_DIR, "minsky", "session-db.json");
const GIT_DIR = join(TEST_DIR, "minsky", "git");

function setupSessionDb(sessions: Array<{ session: string; repoUrl: string; repoName: string; branch: string; createdAt: string; taskId?: string }>) {
  // Create the session DB directory
  mkdirSync(join(TEST_DIR, "minsky"), { recursive: true });
  
  // Create the session DB file
  writeFileSync(SESSION_DB_PATH, JSON.stringify(sessions, null, 2));
  
  // Create repository directories for each session
  sessions.forEach(session => {
    const sessionDir = join(GIT_DIR, session.repoName, session.session);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "test-file.txt"), "test content");
  });
}

describe("minsky session delete CLI", () => {
  beforeEach(() => {
    // Clean up any existing test directories
    rmSync(TEST_DIR, { recursive: true, force: true });
  });
  
  afterEach(() => {
    // Clean up test directories
    rmSync(TEST_DIR, { recursive: true, force: true });
  });
  
  it("deletes session when it exists", () => {
    setupSessionDb([
      { 
        session: "test-session", 
        repoUrl: "https://github.com/test/repo", 
        repoName: "test/repo", 
        branch: "main", 
        createdAt: "2024-01-01" 
      }
    ]);
    
    const sessionDir = join(GIT_DIR, "test/repo", "test-session");
    
    // Run with --force to skip confirmation prompt
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "delete", "test-session", "--force"], { 
      encoding: "utf-8", 
      env: { 
        ...process.env, 
        XDG_STATE_HOME: TEST_DIR 
      } 
    });
    
    // Check for success message
    expect(stdout).toContain("successfully deleted");
    expect(stderr).toBe("");
    
    // Check that the session was removed from the database
    const sessions = JSON.parse(String(spawnSync("bun", ["run", CLI, "session", "list", "--json"], {
      encoding: "utf-8",
      env: { 
        ...process.env, 
        XDG_STATE_HOME: TEST_DIR 
      }
    }).stdout));
    
    expect(sessions.length).toBe(0);
    
    // Check that the session directory was removed
    expect(existsSync(sessionDir)).toBe(false);
  });
  
  it("outputs JSON format with --json flag", () => {
    setupSessionDb([
      { 
        session: "test-session", 
        repoUrl: "https://github.com/test/repo", 
        repoName: "test/repo", 
        branch: "main", 
        createdAt: "2024-01-01" 
      }
    ]);
    
    // Run with --force and --json
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "delete", "test-session", "--force", "--json"], { 
      encoding: "utf-8", 
      env: { 
        ...process.env, 
        XDG_STATE_HOME: TEST_DIR 
      } 
    });
    
    // Check JSON output format
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain("successfully deleted");
    expect(result.repoDeleted).toBe(true);
    expect(result.recordDeleted).toBe(true);
    expect(stderr).toBe("");
  });
  
  it("handles non-existent sessions with appropriate error", () => {
    setupSessionDb([]);
    
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "delete", "non-existent-session"], { 
      encoding: "utf-8", 
      env: { 
        ...process.env, 
        XDG_STATE_HOME: TEST_DIR 
      } 
    });
    
    expect(stdout).toBe("");
    expect(stderr).toContain("Session 'non-existent-session' not found");
  });
  
  it("handles non-existent sessions with JSON output", () => {
    setupSessionDb([]);
    
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "delete", "non-existent-session", "--json"], { 
      encoding: "utf-8", 
      env: { 
        ...process.env, 
        XDG_STATE_HOME: TEST_DIR 
      } 
    });
    
    const result = JSON.parse(stdout);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    expect(stderr).toBe("");
  });

  it("deletes session by task ID when it exists", () => {
    setupSessionDb([
      {
        session: "task-session",
        repoUrl: "https://github.com/test/repo",
        repoName: "test/repo",
        branch: "main",
        createdAt: "2024-01-01",
        taskId: "123"
      }
    ]);

    const sessionDir = join(GIT_DIR, "test/repo", "task-session");

    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "delete", "--task", "123", "--force"], {
      encoding: "utf-8",
      env: { ...process.env, XDG_STATE_HOME: TEST_DIR }
    });

    expect(stdout).toContain("Session 'task-session' successfully deleted");
    expect(stderr).toBe("");

    const sessions = JSON.parse(String(spawnSync("bun", ["run", CLI, "session", "list", "--json"], {
      encoding: "utf-8",
      env: { ...process.env, XDG_STATE_HOME: TEST_DIR }
    }).stdout));
    expect(sessions.length).toBe(0);
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("deletes session by task ID with JSON output", () => {
    setupSessionDb([
      {
        session: "task-session-json",
        repoUrl: "https://github.com/test/repo",
        repoName: "test/repo",
        branch: "main",
        createdAt: "2024-01-01",
        taskId: "456"
      }
    ]);

    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "delete", "--task", "456", "--force", "--json"], {
      encoding: "utf-8",
      env: { ...process.env, XDG_STATE_HOME: TEST_DIR }
    });

    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.message).toContain("Session 'task-session-json' successfully deleted");
    expect(result.repoDeleted).toBe(true);
    expect(result.recordDeleted).toBe(true);
    expect(stderr).toBe("");
  });

  it("handles non-existent session for task ID with appropriate error", () => {
    setupSessionDb([]); // No sessions, so no session for any task ID

    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "delete", "--task", "789"], {
      encoding: "utf-8",
      env: { ...process.env, XDG_STATE_HOME: TEST_DIR }
    });

    expect(stdout).toBe("");
    expect(stderr).toContain("No session found for task ID '789'.");
  });

  it("handles non-existent session for task ID with JSON output", () => {
    setupSessionDb([]);

    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "delete", "--task", "012", "--json"], {
      encoding: "utf-8",
      env: { ...process.env, XDG_STATE_HOME: TEST_DIR }
    });

    const result = JSON.parse(stdout);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No session found for task ID '012'.");
    expect(stderr).toBe("");
  });
  
  it("handles invalid task ID format", () => {
    setupSessionDb([]);
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "delete", "--task", "invalid-id"], {
      encoding: "utf-8",
      env: { ...process.env, XDG_STATE_HOME: TEST_DIR }
    });
    expect(stdout).toBe("");
    expect(stderr).toContain("Invalid task ID format: 'invalid-id'. Task ID should be a number.");
  });

  it("handles invalid task ID format with JSON output", () => {
    setupSessionDb([]);
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "delete", "--task", "invalid-id-json", "--json"], {
      encoding: "utf-8",
      env: { ...process.env, XDG_STATE_HOME: TEST_DIR }
    });
    const result = JSON.parse(stdout);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid task ID format: 'invalid-id-json'. Task ID should be a number.");
    expect(stderr).toBe("");
  });

  it("prioritizes task ID when both session name and task ID are provided", () => {
    setupSessionDb([
      {
        session: "session-for-task",
        repoUrl: "https://github.com/test/task-repo",
        repoName: "test/task-repo",
        branch: "main",
        createdAt: "2024-02-01",
        taskId: "777"
      },
      {
        session: "other-session",
        repoUrl: "https://github.com/test/other-repo",
        repoName: "test/other-repo",
        branch: "main",
        createdAt: "2024-02-02"
      }
    ]);

    const sessionForTaskDir = join(GIT_DIR, "test/task-repo", "session-for-task");
    const otherSessionDir = join(GIT_DIR, "test/other-repo", "other-session");

    // Attempt to delete "other-session" by name, but provide task ID for "session-for-task"
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "delete", "other-session", "--task", "777", "--force"], {
      encoding: "utf-8",
      env: { ...process.env, XDG_STATE_HOME: TEST_DIR }
    });

    expect(stdout).toContain("Session 'session-for-task' successfully deleted");
    expect(stderr).toBe("");

    // Check that "session-for-task" was removed from the database and its directory deleted
    const sessions = JSON.parse(String(spawnSync("bun", ["run", CLI, "session", "list", "--json"], {
      encoding: "utf-8",
      env: { ...process.env, XDG_STATE_HOME: TEST_DIR }
    }).stdout));
    
    expect(sessions.length).toBe(1);
    expect(sessions[0].session).toBe("other-session"); // Only "other-session" should remain
    expect(existsSync(sessionForTaskDir)).toBe(false);
    expect(existsSync(otherSessionDir)).toBe(true); // "other-session" directory should still exist
  });
}); 
