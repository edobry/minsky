import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { join, resolve, dirname } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import type { SessionRecord } from "../../domain/session.ts";
import { 
  createUniqueTestDir, 
  cleanupTestDir, 
  setupMinskyTestEnv, 
  createTestEnv, 
  standardSpawnOptions 
} from "../../utils/test-helpers.ts";
import type { MinskyTestEnv } from "../../utils/test-helpers.ts";

// Path to the CLI entry point
const CLI = resolve(process.cwd(), "src/cli.ts");

// Create a unique test directory
const TEST_DIR = createUniqueTestDir("minsky-session-dir-test");
let testEnv: MinskyTestEnv;
let minskyDir: string;
let gitDir: string;
let sessionDbPath: string;

// Type for a test session record with branch and taskId properties
interface TestSessionRecord {
  session: string;
  repoUrl: string;
  repoName: string;
  createdAt: string;
  branch?: string;
  taskId?: string;
}

function setupSessionDb(sessions: TestSessionRecord[]) {
  try {
    // Setup the Minsky test environment
    testEnv = setupMinskyTestEnv(TEST_DIR);
    minskyDir = testEnv.minskyDir;
    gitDir = testEnv.gitDir;
    sessionDbPath = testEnv.sessionDbPath;
    
    // Ensure directories exist
    const sessionDbDir = dirname(sessionDbPath);
    mkdirSync(sessionDbDir, { recursive: true });
    mkdirSync(gitDir, { recursive: true });

    // Write the session database with proper error handling
    try {
      writeFileSync(sessionDbPath, JSON.stringify(sessions, null, 2), { encoding: "utf8" });
      if (!existsSync(sessionDbPath)) {
        throw new Error(`Session DB file not created at ${sessionDbPath}`);
      }
      
      // Read it back to verify it's valid
      const content = readFileSync(sessionDbPath, "utf8");
      JSON.parse(content); // Verify valid JSON
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
        console.log(`Created session directory at: ${newPath}`);
      } else {
        mkdirSync(dirname(legacyPath), { recursive: true });
        mkdirSync(legacyPath, { recursive: true });
        console.log(`Created session directory at: ${legacyPath}`);
      }
    }

    console.log(`Test setup: Created session DB at ${sessionDbPath} with ${sessions.length} sessions`);
    console.log(`XDG_STATE_HOME will be set to: ${TEST_DIR}`);
    console.log(`SessionDB file exists: ${existsSync(sessionDbPath)}`);
    console.log(`SessionDB content: ${readFileSync(sessionDbPath, "utf8")}`);
  } catch (error) {
    console.error(`Error in setupSessionDb: ${error}`);
    throw error;
  }
}

// Helper to run CLI command
function runCliCommand(args: string[], additionalEnv: Record<string, string> = {}) {
  const env = createTestEnv(TEST_DIR, additionalEnv);
  const options = {
    ...standardSpawnOptions(),
    env
  };
  
  const result = spawnSync("bun", ["run", CLI, ...args], options);
  
  // Log output for debugging
  console.log(`Command stdout: ${result.stdout}`);
  console.log(`Command stderr: ${result.stderr}`);
  
  return {
    stdout: result.stdout as string,
    stderr: result.stderr as string,
    status: result.status
  };
}

describe("minsky session dir CLI", () => {
  beforeEach(() => {
    // Clean up any existing test directories
    cleanupTestDir(TEST_DIR);
  });
  
  afterEach(() => {
    // Clean up test directories
    cleanupTestDir(TEST_DIR);
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
    const expectedPath = join(gitDir, "test/repo", "test-session");
    
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
    const expectedPath = join(gitDir, "test/repo", "sessions", "test-session-new");
    
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
    const expectedPath = join(gitDir, "repo", "task#008");
    
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
    const expectedPath = join(gitDir, "repo", "task#009");
    
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
}); 
