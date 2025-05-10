import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { join, resolve, dirname } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { SessionDB } from "../../domain/session.ts";
import type { SessionRecord } from "../../domain/session.ts";

// Path to the CLI entry point - use absolute path to avoid path resolution issues
// Make sure the CLI path is correct by resolving it from the current working directory
const CLI = resolve(process.cwd(), "src/cli.ts");
// console.log(`CLI path: ${CLI}`); // Reduce noise
// console.log(`CLI exists: ${existsSync(CLI)}`); // Reduce noise

// Test directory
// Make TEST_DIR unique to this file to avoid collisions if tests run in parallel
const TEST_DIR = "/tmp/minsky-session-cd-test-" + Math.random().toString(36).substring(7);
const MINSKY_DIR = join(TEST_DIR, "minsky");
const GIT_DIR = join(MINSKY_DIR, "git");
const SESSION_DB_PATH = join(MINSKY_DIR, "session-db.json");

// Helper to setup session DB
// Define the interface with all the properties we need
interface TestSessionRecord {
  session: string;
  repoUrl: string;
  repoName?: string;
  branch?: string;
  createdAt: string;
  taskId?: string;
  [key: string]: any; // Allow for any additional properties
}

function setupSessionDb(sessions: TestSessionRecord[]) {
  try {
    // Create directories with careful error handling
    const minskyDir = join(TEST_DIR, "minsky");
    const gitDir = join(minskyDir, "git");
    const SESSION_DB_PATH = join(minskyDir, "session-db.json");

    // Create parent directories first
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(minskyDir, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    
    // Write session DB with careful error handling
    try {
      writeFileSync(SESSION_DB_PATH, JSON.stringify(sessions, null, 2), { encoding: "utf8" });
      if (!existsSync(SESSION_DB_PATH)) {
        throw new Error(`Session DB file not created at ${SESSION_DB_PATH}`);
      }
      
      // Verify file is valid by reading it back
      const content = readFileSync(SESSION_DB_PATH, "utf8");
      JSON.parse(content); // Should not throw
    } catch (error) {
      console.error(`Error writing session DB: ${error}`);
      throw error;
    }

    // Create session repo directories
    for (const session of sessions) {
      const repoName = session.repoName || session.repoUrl.replace(/[^\w-]/g, "_");
      // Create both legacy path and new path with sessions subdirectory
      const legacyPath = join(gitDir, repoName, session.session);
      const newPath = join(gitDir, repoName, "sessions", session.session);

      // For test variety, use the new path for some sessions and legacy for others
      if (session.session.includes("new")) {
        mkdirSync(dirname(newPath), { recursive: true });
        mkdirSync(newPath, { recursive: true });
      } else {
        mkdirSync(dirname(legacyPath), { recursive: true });
        mkdirSync(legacyPath, { recursive: true });
      }
    }

    console.log(`Test setup: Created session DB at ${SESSION_DB_PATH} with ${sessions.length} sessions`);
    console.log(`XDG_STATE_HOME will be set to: ${TEST_DIR}`);
    console.log(`SessionDB file exists: ${existsSync(SESSION_DB_PATH)}`);
    console.log(`SessionDB content: ${readFileSync(SESSION_DB_PATH, "utf8")}`);
  } catch (error) {
    console.error(`Error in setupSessionDb: ${error}`);
    throw error;
  }
}

// Helper to run a CLI command with the right environment
function runCliCommand(args: string[], env: Record<string, string> = {}) {
  try {
    // Set up environment with explicit XDG_STATE_HOME
    const testEnv = {
      ...process.env,
      ...env,
      XDG_STATE_HOME: env.XDG_STATE_HOME || TEST_DIR // Ensure XDG_STATE_HOME points to our unique TEST_DIR for this test file
    };
    
    // Run CLI command
    const result = spawnSync("bun", ["run", CLI, ...args], { 
      encoding: "utf-8",
      env: testEnv,
      stdio: ["inherit", "pipe", "pipe"] // Configure stdio to pipe stdout and stderr
    });
    
    // Log output for debugging
    console.log("Command stdout:", result.stdout);
    console.log("Command stderr:", result.stderr);
    
    return result;
  } catch (error) {
    console.error(`Error running CLI command: ${error}`);
    throw error;
  }
}

describe("minsky session dir CLI", () => {
  beforeEach(() => {
    // Clean up any existing test directories
    rmSync(TEST_DIR, { recursive: true, force: true });
    // console.log("Setting up test environment..."); // Reduce noise
  });
  
  afterEach(() => {
    // Clean up test directories
    rmSync(TEST_DIR, { recursive: true, force: true });
  });
  
  test("returns the correct path for a session with legacy path structure", () => {
    // Setup a session with repoName field in legacy structure
    const sessions = [{
      session: "test-session", 
      repoUrl: "https://github.com/test/repo", 
      repoName: "test/repo", 
      branch: "main", 
      createdAt: "2024-01-01"
    }];
    
    setupSessionDb(sessions);
    
    // The expected correct path should include the repo name in the structure
    const expectedPath = join(GIT_DIR, "test/repo", "test-session");
    
    // Run the command with explicit XDG_STATE_HOME
    const result = runCliCommand(["session", "dir", "test-session"]);
    const { stdout, stderr } = result;
    
    console.log("Command stdout:", stdout);
    console.log("Command stderr:", stderr);
    
    // The command should return the correct path
    expect(stdout.trim()).toBe(expectedPath);
    expect(stderr).toBe("");
    
    // Verify the directory exists
    expect(existsSync(expectedPath)).toBe(true);
  });
  
  test("returns the correct path for a session with new sessions subdirectory", () => {
    // Setup a session with repoName field in new structure
    const sessions = [{
      session: "test-session-new", 
      repoUrl: "https://github.com/test/repo", 
      repoName: "test/repo", 
      branch: "main", 
      createdAt: "2024-01-01"
    }];
    
    setupSessionDb(sessions);
    
    // The expected correct path should include the sessions subdirectory
    const expectedPath = join(GIT_DIR, "test/repo", "sessions", "test-session-new");
    
    // Run the command with explicit XDG_STATE_HOME
    const result = runCliCommand(["session", "dir", "test-session-new"]);
    const { stdout, stderr } = result;
    
    console.log("Command stdout:", stdout);
    console.log("Command stderr:", stderr);
    
    // The command should return the correct path
    expect(stdout.trim()).toBe(expectedPath);
    expect(stderr).toBe("");
    
    // Verify the directory exists
    expect(existsSync(expectedPath)).toBe(true);
  });
  
  test("handles sessions with task IDs correctly", () => {
    // Setup a session associated with a task
    const sessions = [{
      session: "task#008", 
      repoUrl: "file:///Users/test/Projects/repo", 
      repoName: "repo", 
      branch: "task#008", 
      createdAt: "2024-01-01",
      taskId: "#008"
    }];
    
    setupSessionDb(sessions);
    
    // The expected correct path should include the repo name in the structure
    const expectedPath = join(GIT_DIR, "repo", "task#008");
    
    // Run the command with explicit XDG_STATE_HOME
    const result = runCliCommand(["session", "dir", "task#008"]);
    const { stdout, stderr } = result;
    
    console.log("Command stdout:", stdout);
    console.log("Command stderr:", stderr);
    
    // The command should return the correct path
    expect(stdout.trim()).toBe(expectedPath);
    expect(stderr).toBe("");
    
    // Verify the directory exists
    expect(existsSync(expectedPath)).toBe(true);
  });
  
  test("finds a session by task ID using --task option", () => {
    // Setup a session associated with a task
    const sessions = [{
      session: "task#009", 
      repoUrl: "file:///Users/test/Projects/repo", 
      repoName: "repo", 
      branch: "task#009", 
      createdAt: "2024-01-01",
      taskId: "#009"
    }];
    
    setupSessionDb(sessions);
    
    // The expected correct path should include the repo name in the structure
    const expectedPath = join(GIT_DIR, "repo", "task#009");
    
    // Run the command with --task option and explicit XDG_STATE_HOME
    const result = runCliCommand(["session", "dir", "--task", "009"]);
    const { stdout, stderr } = result;
    
    console.log("Command stdout:", stdout);
    console.log("Command stderr:", stderr);
    
    // The command should return the correct path
    expect(stdout.trim()).toBe(expectedPath);
    expect(stderr).toBe("");
    
    // Verify the directory exists
    expect(existsSync(expectedPath)).toBe(true);
  });
  
  test("returns an error for non-existent sessions", () => {
    // Run the command with a non-existent session
    const result = runCliCommand(["session", "dir", "non-existent-session"]);
    const { stdout, stderr, status } = result;
    
    console.log("Command stdout:", stdout);
    console.log("Command stderr:", stderr);
    
    // The command should return an error
    expect(status !== 0).toBe(true);
    expect(stderr.includes("not found")).toBe(true);
    expect(stdout).toBe("");
  });
  
  test("returns an error for non-existent task IDs with --task", () => {
    // Run the command with a non-existent task ID
    const result = runCliCommand(["session", "dir", "--task", "999"]);
    const { stdout, stderr, status } = result;
    
    console.log("Command stdout:", stdout);
    console.log("Command stderr:", stderr);
    
    // The command should return an error
    expect(status !== 0).toBe(true);
    expect(stderr.includes("No session found for task ID")).toBe(true);
    expect(stdout).toBe("");
  });
  
  test("returns an error when both session and --task are provided", () => {
    // Run the command with both a session name and --task
    const result = runCliCommand(["session", "dir", "test-session", "--task", "009"]);
    const { stdout, stderr, status } = result;
    
    console.log("Command stdout:", stdout);
    console.log("Command stderr:", stderr);
    
    // The command should return an error
    expect(status !== 0).toBe(true);
    expect(stderr.includes("Provide either a session name or --task, not both")).toBe(true);
    expect(stdout).toBe("");
  });
  
  test("returns an error when neither session nor --task are provided", () => {
    // Run the command with neither a session name nor --task
    const result = runCliCommand(["session", "dir"]);
    const { stdout, stderr, status } = result;
    
    console.log("Command stdout:", stdout);
    console.log("Command stderr:", stderr);
    
    // The command should return an error
    expect(status !== 0).toBe(true);
    expect(stderr.includes("Not in a session workspace")).toBe(true);
    expect(stdout).toBe("");
  });
  
  test("returns an error when not in a session workspace and using --ignore-workspace", () => {
    // Run the command with --ignore-workspace
    const result = runCliCommand(["session", "dir", "--ignore-workspace"]);
    const { stdout, stderr, status } = result;
    
    console.log("Command stdout:", stdout);
    console.log("Command stderr:", stderr);
    
    // The command should return an error
    expect(status !== 0).toBe(true);
    expect(stderr.includes("You must provide either a session name or --task")).toBe(true);
    expect(stdout).toBe("");
  });

  // The following test would require complex mocking of the getCurrentSession function
  // This is a placeholder test description for what should be tested
  // A more complete integration test would simulate a real session workspace environment
  // TODO: auto-detects the current session when in a session workspace
}); 
