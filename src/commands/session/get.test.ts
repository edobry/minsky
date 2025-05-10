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

// Create a unique test directory for this test file
const TEST_DIR = createUniqueTestDir("minsky-session-get-test");
let testEnv: MinskyTestEnv;
let minskyDir: string;
let sessionDbPath: string;
let gitDir: string;

interface TestSessionRecord extends SessionRecord {
  branch?: string;
  taskId?: string;
}

function setupSessionDb(sessions: Array<{ session: string; repoUrl: string; repoName?: string; branch?: string; createdAt: string; taskId?: string }>) {
  try {
    // Setup the test environment
    testEnv = setupMinskyTestEnv(TEST_DIR);
    sessionDbPath = testEnv.sessionDbPath;
    minskyDir = testEnv.minskyDir;
    gitDir = testEnv.gitDir;
    
    // Ensure parent directories exist
    const sessionDbDir = dirname(sessionDbPath);
    if (!existsSync(sessionDbDir)) {
      mkdirSync(sessionDbDir, { recursive: true });
    }
    
    // Create the minsky directory structure
    if (!existsSync(minskyDir)) {
      mkdirSync(minskyDir, { recursive: true });
    }
    
    // Ensure git directory exists
    if (!existsSync(gitDir)) {
      mkdirSync(gitDir, { recursive: true });
    }
    
    // Verify directories were created
    if (!existsSync(sessionDbDir) || !existsSync(minskyDir) || !existsSync(gitDir)) {
      throw new Error(`Failed to create directories: sessionDbDir=${existsSync(sessionDbDir)}, minskyDir=${existsSync(minskyDir)}, gitDir=${existsSync(gitDir)}`);
    }
    
    // Write the session database with better error handling
    try {
      writeFileSync(
        sessionDbPath,
        JSON.stringify(sessions, null, 2),
        { encoding: "utf8" }
      );
      
      // Verify the file was created
      if (!existsSync(sessionDbPath)) {
        throw new Error(`Failed to create session DB at ${sessionDbPath}`);
      }
      
      // Read it back to verify it's valid
      const content = readFileSync(sessionDbPath, "utf8");
      JSON.parse(content); // Verify valid JSON
      console.log(`Successfully created and verified session DB at ${sessionDbPath}`);
    } catch (error) {
      console.error(`Error writing session DB: ${error}`);
      throw error;
    }
    
    // Create directory structure for session repositories
    for (const session of sessions) {
      const repoName = session.repoName || session.repoUrl.replace(/[^\w-]/g, "_");
      const sessionDir = join(gitDir, repoName, session.session);
      
      // Create repo directory
      const repoDir = join(gitDir, repoName);
      if (!existsSync(repoDir)) {
        mkdirSync(repoDir, { recursive: true });
      }
      
      // Create session directory
      if (!existsSync(sessionDir)) {
        mkdirSync(sessionDir, { recursive: true });
      }
      
      // Verify directory was created
      if (!existsSync(sessionDir)) {
        throw new Error(`Failed to create session directory at ${sessionDir}`);
      }
    }
    
    console.log(`Test setup: Created session DB at ${sessionDbPath} with ${sessions.length} sessions`);
    console.log(`Test directory exists: ${existsSync(TEST_DIR)}`);
    console.log(`Minsky directory exists: ${existsSync(minskyDir)}`);
    console.log(`SessionDB directory exists: ${existsSync(sessionDbDir)}`);
    console.log(`SessionDB file exists: ${existsSync(sessionDbPath)}`);
    console.log(`SessionDB content: ${readFileSync(sessionDbPath, "utf8")}`);
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

  test("prints session details for existing session", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "123", repoName: "repo" } as TestSessionRecord
    ]);
    const { stdout, stderr } = runCliCommand(["session", "get", "foo"]);
    expect(stderr).toBe("");
    expect(stdout).toContain("Session: foo");
    expect(stdout).toContain("Repo: https://repo");
    expect(stdout).toContain("Branch: main");
    expect(stdout).toContain("Task ID: 123");
  });

  test("prints JSON output with --json", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "123", repoName: "repo" } as TestSessionRecord
    ]);
    const { stdout, stderr } = runCliCommand(["session", "get", "foo", "--json"]);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed.session).toBe("foo");
    expect(parsed.repoUrl).toBe("https://repo");
    expect(parsed.branch).toBe("main");
    expect(parsed.taskId).toBe("123");
  });

  test("prints null for --json when session not found", () => {
    setupSessionDb([]); // Empty DB
    const { stdout, stderr } = runCliCommand(["session", "get", "nonexistent", "--json"]);
    expect(stderr).toBe(""); // Command should not error, just return null
    expect(JSON.parse(stdout)).toBeNull();
  });

  test("prints error for non-existent session", () => {
    setupSessionDb([]); // Empty DB
    const { stdout, stderr, status } = runCliCommand(["session", "get", "nonexistent"]);
    expect(status !== 0).toBe(true); 
    expect(stderr).toContain("Session \"nonexistent\" not found."); 
    expect(stdout).toBe("");
  });

  test("can look up a session by task ID", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "#T123", repoName: "repo" } as TestSessionRecord
    ]);
    const { stdout, stderr } = runCliCommand(["session", "get", "--task", "T123"]);
    expect(stderr).toBe("");
    expect(stdout).toContain("Session: foo");
    expect(stdout).toContain("Task ID: #T123");
  });

  test("prints JSON output for --task", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "#T123", repoName: "repo" } as TestSessionRecord
    ]);
    const { stdout, stderr } = runCliCommand(["session", "get", "--task", "T123", "--json"]);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed.session).toBe("foo");
    expect(parsed.taskId).toBe("#T123");
  });

  test("prints error if no session for task ID", () => {
    setupSessionDb([]);
    const { stdout, stderr, status } = runCliCommand(["session", "get", "--task", "nonexistent-task"]);
    expect(status !== 0).toBe(true); 
    expect(stderr).toContain("No session found for task ID \"#nonexistent-task\".");
    expect(stdout).toBe("");
  });

  test("prints null for --json if no session for task ID", () => {
    setupSessionDb([]);
    const { stdout, stderr } = runCliCommand(["session", "get", "--task", "nonexistent-task", "--json"]);
    expect(stderr).toBe(""); // Just returns null in JSON mode, no error
    expect(JSON.parse(stdout)).toBeNull();
  });

  test("errors if both session and --task are provided", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "#T123", repoName: "repo" } as TestSessionRecord
    ]);
    const { stdout, stderr, status } = runCliCommand(["session", "get", "foo", "--task", "T123"]);
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
