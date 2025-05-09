import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { join, dirname } from "path";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { 
  createUniqueTestDir, 
  cleanupTestDir, 
  setupMinskyTestEnv, 
  createTestEnv, 
  standardSpawnOptions 
} from "../../utils/test-helpers.ts";
import type { MinskyTestEnv } from "../../utils/test-helpers.ts";

// Path to the CLI entry point
const CLI = join(Bun.env.PWD || ".", "src/cli.ts");

// Create a unique test directory for this test file
const TEST_DIR = createUniqueTestDir("minsky-session-get-test");
let testEnv: MinskyTestEnv;
let sessionDbPath: string;

// Helper to setup session DB
function setupSessionDb(sessions: Array<{ session: string; repoUrl: string; repoName?: string; branch?: string; createdAt: string; taskId?: string }>) {
  // Setup the test environment
  testEnv = setupMinskyTestEnv(TEST_DIR);
  sessionDbPath = testEnv.sessionDbPath;
  
  try {
    // Create the minsky directory structure
    const minskyDir = join(TEST_DIR, "minsky");
    if (!existsSync(minskyDir)) {
      mkdirSync(minskyDir, { recursive: true });
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
    
    // Verify the file was written and exists
    if (!existsSync(sessionDbPath)) {
      throw new Error(`Failed to create session DB at ${sessionDbPath}`);
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

describe("minsky session get CLI", () => {
  beforeEach(() => {
    // Clean up any existing test directories
    cleanupTestDir(TEST_DIR);
  });
  
  afterEach(() => {
    cleanupTestDir(TEST_DIR);
  });

  test("returns session info in human format by default", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", repoName: "repo", branch: "main", createdAt: "2024-01-01" }
    ]);
    
    const { stdout, stderr } = runCliCommand(["session", "get", "foo"]);
    expect(stderr).toBe("");
    expect(stdout).toContain("Session: foo");
    expect(stdout).toContain("Repository: https://repo");
  });

  test("returns session info in JSON format with --json", () => {
    setupSessionDb([
      { session: "bar", repoUrl: "https://repo2", repoName: "repo2", branch: "feature", createdAt: "2024-01-02" }
    ]);
    
    const { stdout, stderr } = runCliCommand(["session", "get", "bar", "--json"]);
    expect(stderr).toBe("");
    
    const parsed = JSON.parse(stdout);
    expect(parsed.session).toBe("bar");
    expect(parsed.repoUrl).toBe("https://repo2");
  });

  test("finds a session by task ID using --task option", () => {
    setupSessionDb([
      { session: "task#123", repoUrl: "https://repo", repoName: "repo", branch: "feature", createdAt: "2024-01-01", taskId: "#123" }
    ]);
    
    const { stdout, stderr } = runCliCommand(["session", "get", "--task", "123"]);
    expect(stderr).toBe("");
    expect(stdout).toContain("Session: task#123");
    expect(stdout).toContain("Task ID: #123");
  });

  test("errors when session doesn't exist", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", repoName: "repo", branch: "main", createdAt: "2024-01-01" }
    ]);
    
    const { stdout, stderr, status } = runCliCommand(["session", "get", "nonexistent"]);
    expect(status !== 0).toBe(true);
    expect(stderr).toContain("Session \"nonexistent\" not found."); 
    expect(stdout).toBe("");
  });

  test("errors when task ID doesn't exist", () => {
    setupSessionDb([
      { session: "task#123", repoUrl: "https://repo", repoName: "repo", branch: "feature", createdAt: "2024-01-01", taskId: "#123" }
    ]);
    
    const { stdout, stderr, status } = runCliCommand(["session", "get", "--task", "nonexistent-task"]);
    expect(status !== 0).toBe(true);
    expect(stderr).toContain("No session found for task ID \"#nonexistent-task\".");
    expect(stdout).toBe("");
  });

  test("errors if both session and --task are provided", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", repoName: "repo", branch: "main", createdAt: "2024-01-01" },
      { session: "task#123", repoUrl: "https://repo", repoName: "repo", branch: "feature", createdAt: "2024-01-01", taskId: "#123" }
    ]);
    
    const { stdout, stderr, status } = runCliCommand(["session", "get", "foo", "--task", "123"]);
    expect(status !== 0).toBe(true);
    expect(stderr).toContain("Provide either a session name or --task, not both");
    expect(stdout).toBe("");
  });

  test("errors if neither session nor --task is provided and not in workspace", () => {
    setupSessionDb([]);
    const { stdout, stderr, status } = runCliCommand(["session", "get"], { MINSKY_IGNORE_WORKSPACE: "true" }); // Mock not being in a workspace
    expect(status !== 0).toBe(true);
    expect(stderr).toContain("Not in a session workspace");
    expect(stdout).toBe("");
  });

  test("returns an error when not in a session workspace and using --ignore-workspace and no args", () => {
    setupSessionDb([]);
    const { stdout, stderr, status } = runCliCommand(["session", "get", "--ignore-workspace"]);
    expect(status !== 0).toBe(true);
    expect(stderr).toContain("You must provide either a session name or --task");
    expect(stdout).toBe("");
  });

  // The following test would require complex mocking of the getCurrentSession function
  // This is a placeholder test description for what should be tested
  // A more complete integration test would simulate a real session workspace environment
  // TODO: auto-detects the current session when in a session workspace
}); 
