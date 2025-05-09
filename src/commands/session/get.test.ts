import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { join, resolve } from "path";
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
const TEST_DIR = createUniqueTestDir("minsky-session-get-test");
let testEnv: MinskyTestEnv;
let sessionDbPath: string;

interface TestSessionRecord extends SessionRecord {
  branch?: string;
  taskId?: string;
}

function setupSessionDb(sessions: TestSessionRecord[]) {
  // Setup the Minsky test environment
  testEnv = setupMinskyTestEnv(TEST_DIR);
  sessionDbPath = testEnv.sessionDbPath;
  
  // Write the session database
  writeFileSync(sessionDbPath, JSON.stringify(sessions, null, 2));
  
  // Log for debugging
  console.log(`Test setup: Created session DB at ${sessionDbPath} with ${sessions.length} sessions`);
  console.log(`XDG_STATE_HOME will be set to: ${TEST_DIR}`);
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
    // Check if stderr contains the expected message
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
}); 
