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
}); 
