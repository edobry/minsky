import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { join, resolve, dirname } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
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

// Create a unique test directory for this test file
const TEST_DIR = createUniqueTestDir("minsky-session-dir-test");
let testEnv: MinskyTestEnv;
let minskyDir: string;
let gitDir: string;
let sessionDbPath: string;

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
  // Setup the Minsky test environment
  testEnv = setupMinskyTestEnv(TEST_DIR);
  minskyDir = testEnv.minskyDir;
  gitDir = testEnv.gitDir;
  sessionDbPath = testEnv.sessionDbPath;
  
  try {
    // Ensure minsky directory exists
    if (!existsSync(minskyDir)) {
      mkdirSync(minskyDir, { recursive: true });
    }
    
    // Ensure git directory exists
    if (!existsSync(gitDir)) {
      mkdirSync(gitDir, { recursive: true });
    }
    
    // Ensure parent directory of sessionDbPath exists
    const sessionDbDir = dirname(sessionDbPath);
    if (!existsSync(sessionDbDir)) {
      mkdirSync(sessionDbDir, { recursive: true });
    }
    
    // Write the session database
    writeFileSync(
      sessionDbPath,
      JSON.stringify(sessions, null, 2),
      { encoding: "utf8" }
    );
    
    // Verify session DB was created
    if (!existsSync(sessionDbPath)) {
      throw new Error(`Failed to create session DB at ${sessionDbPath}`);
    }
    
    // Create session repo directories
    for (const session of sessions) {
      const repoName = session.repoName || session.repoUrl.replace(/[^\w-]/g, "_");
      // Create both legacy path and new path with sessions subdirectory
      const legacyPath = join(gitDir, repoName, session.session);
      const newPath = join(gitDir, repoName, "sessions", session.session);
      
      // For test variety, use the new path for some sessions and legacy for others
      if (session.session.includes("new")) {
        // Ensure parent directory exists
        const parentDir = join(gitDir, repoName, "sessions");
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }
        
        mkdirSync(newPath, { recursive: true });
        console.log(`Created session directory at: ${newPath}`);
        
        // Verify directory was created
        if (!existsSync(newPath)) {
          throw new Error(`Failed to create directory at ${newPath}`);
        }
      } else {
        // Ensure parent directory exists
        const parentDir = join(gitDir, repoName);
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }
        
        mkdirSync(legacyPath, { recursive: true });
        console.log(`Created session directory at: ${legacyPath}`);
        
        // Verify directory was created
        if (!existsSync(legacyPath)) {
          throw new Error(`Failed to create directory at ${legacyPath}`);
        }
      }
    }
    
    // Log for debugging
    console.log(`Test setup: Created session DB at ${sessionDbPath} with ${sessions.length} sessions`);
    console.log(`XDG_STATE_HOME will be set to: ${TEST_DIR}`);
    console.log(`SessionDB file exists: ${existsSync(sessionDbPath)}`);
  } catch (error) {
    console.error(`Error in setupSessionDb: ${error}`);
    throw error;
  }
}

// Helper to run a CLI command with the right environment
function runCliCommand(args: string[], additionalEnv: Record<string, string> = {}) {
  const env = {
    ...createTestEnv(TEST_DIR),
    ...additionalEnv
  };
  
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
    
    console.log(`Expected path: ${expectedPath}`);
    console.log(`Directory exists: ${existsSync(expectedPath)}`);
    
    // Run the command with explicit XDG_STATE_HOME
    const { stdout, stderr } = runCliCommand(["session", "dir", "test-session"]);
    
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
    
    console.log(`Expected path: ${expectedPath}`);
    console.log(`Directory exists: ${existsSync(expectedPath)}`);
    
    // Run the command
    const { stdout, stderr } = runCliCommand(["session", "dir", "test-session-new"]);
    
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
    
    console.log(`Expected path: ${expectedPath}`);
    console.log(`Directory exists: ${existsSync(expectedPath)}`);
    
    // Run the command
    const { stdout, stderr } = runCliCommand(["session", "dir", "task#008"]);
    
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
    
    console.log(`Expected path: ${expectedPath}`);
    console.log(`Directory exists: ${existsSync(expectedPath)}`);
    
    // Run the command with --task option
    const { stdout, stderr } = runCliCommand(["session", "dir", "--task", "009"]);
    
    // The command should return the correct path
    expect(stdout.trim()).toBe(expectedPath);
    expect(stderr).toBe("");
    
    // Verify the directory exists
    expect(existsSync(expectedPath)).toBe(true);
  });
  
  test("returns an error for non-existent sessions", () => {
    // Run the command with a non-existent session
    const { stdout, stderr, status } = runCliCommand(["session", "dir", "non-existent-session"]);
    
    // The command should return an error
    expect(status !== 0).toBe(true);
    expect(stderr).toContain("not found");
    expect(stdout).toBe("");
  });
  
  test("returns an error for non-existent task IDs with --task", () => {
    // Run the command with a non-existent task ID
    const { stdout, stderr, status } = runCliCommand(["session", "dir", "--task", "999"]);
    
    // The command should return an error
    expect(status !== 0).toBe(true);
    expect(stderr).toContain("No session found for task ID");
    expect(stdout).toBe("");
  });
  
  test("returns an error when both session and --task are provided", () => {
    // Run the command with both a session name and --task
    const { stdout, stderr, status } = runCliCommand(["session", "dir", "test-session", "--task", "009"]);
    
    // The command should return an error
    expect(status !== 0).toBe(true);
    expect(stderr).toContain("Provide either a session name or --task, not both");
    expect(stdout).toBe("");
  });
  
  test("returns an error when neither session nor --task are provided", () => {
    // Run the command with neither a session name nor --task
    const { stdout, stderr, status } = runCliCommand(["session", "dir"]);
    
    // The command should return an error
    expect(status !== 0).toBe(true);
    expect(stderr).toContain("Not in a session workspace");
    expect(stdout).toBe("");
  });
  
  test("returns an error when not in a session workspace and using --ignore-workspace", () => {
    // Run the command with --ignore-workspace
    const { stdout, stderr, status } = runCliCommand(["session", "dir", "--ignore-workspace"]);
    
    // The command should return an error
    expect(status !== 0).toBe(true);
    expect(stderr).toContain("You must provide either a session name or --task");
    expect(stdout).toBe("");
  });
}); 
