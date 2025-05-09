
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
=======
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { SessionDB } from "../../domain/session";
import { get } from "./get";
>>>>>>> origin/main

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
<<<<<<< HEAD
  beforeEach(() => {
    // Clean up any existing test directories
    cleanupTestDir(TEST_DIR);
  });

  afterEach(() => {
    cleanupTestDir(TEST_DIR);
=======
  let mockSessionDB: any;
  let originalSessionDB: any;
  let mockConsoleLog: any;
  let originalConsoleLog: any;

  beforeEach(() => {
    // Save original console.log
    originalConsoleLog = console.log;
    mockConsoleLog = mock(() => {});
    console.log = mockConsoleLog;

    // Save original SessionDB
    originalSessionDB = global.SessionDB;

    // Create mock SessionDB
    mockSessionDB = {
      getSession: mock(() => Promise.resolve({
        session: "test-session",
        repoUrl: "https://github.com/test/repo",
        repoName: "test/repo",
        createdAt: "2023-01-01T00:00:00.000Z"
      })),
      getSessionByTaskId: mock(() => Promise.resolve({
        session: "task-session",
        repoUrl: "https://github.com/test/repo",
        repoName: "test/repo",
        createdAt: "2023-01-01T00:00:00.000Z",
        taskId: "#123"
      }))
    };
    global.SessionDB = mock(() => mockSessionDB);
  });

  afterEach(() => {
    // Restore console.log
    console.log = originalConsoleLog;
    // Restore SessionDB
    global.SessionDB = originalSessionDB;
    rmSync(SESSION_DB_PATH, { force: true });
>>>>>>> origin/main
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
<<<<<<< HEAD
=======
    expect(stderr || "").toContain("Session 'notfound' not found.");
>>>>>>> origin/main
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
<<<<<<< HEAD
=======
    expect(stderr || "").toContain("No session found for task ID '#T999'.");
>>>>>>> origin/main
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

<<<<<<< HEAD
  test("errors if neither session nor --task is provided and not in workspace", () => {
    setupSessionDb([]);
    const { stdout, stderr, status } = runCliCommand(["session", "get"], { MINSKY_IGNORE_WORKSPACE: "true" }); // Mock not being in a workspace
    expect(status !== 0).toBe(true);
    // Check if stderr contains the expected message
=======
  test("errors if neither session nor --task is provided", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "#T123" }
    ]);
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "get"], { encoding: "utf-8", env: { ...process.env, XDG_STATE_HOME: "/tmp" } });
    expect(stdout).toBe("");
    expect(stderr || "").toContain("You must provide either a session name or --task.");
  });

  test("returns an error when neither session nor --task are provided", () => {
    // Run the command with neither a session name nor --task
    const { stdout, stderr, status } = spawnSync("bun", ["run", CLI, "session", "get"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        XDG_STATE_HOME: "/tmp"
      }
    });
    
    expect(status).not.toBe(0);
>>>>>>> origin/main
    expect(stderr).toContain("Not in a session workspace");
    expect(stdout).toBe("");
  });

<<<<<<< HEAD
  test("returns an error when not in a session workspace and using --ignore-workspace and no args", () => {
    setupSessionDb([]);
    const { stdout, stderr, status } = runCliCommand(["session", "get", "--ignore-workspace"]);
    expect(status !== 0).toBe(true);
    expect(stderr).toContain("You must provide either a session name or --task");
    expect(stdout).toBe("");
=======
  // The following test would require complex mocking of the getCurrentSession function
  // This is a placeholder test description for what should be tested
  // A more complete integration test would simulate a real session workspace environment
  // it.todo("auto-detects the current session when in a session workspace");
  
  // The following test would check the JSON output format for the auto-detected session
  // it.todo("correctly formats JSON output for auto-detected session");

  it("should get session by name", async () => {
    await get({ session: "test-session" });
    expect(mockSessionDB.getSession).toHaveBeenCalledWith("test-session");
    expect(mockConsoleLog).toHaveBeenCalled();
  });

  it("should get session by task ID", async () => {
    await get({ task: "123" });
    expect(mockSessionDB.getSessionByTaskId).toHaveBeenCalledWith("123");
    expect(mockConsoleLog).toHaveBeenCalled();
  });

  it("should handle task ID with # prefix", async () => {
    await get({ task: "#123" });
    expect(mockSessionDB.getSessionByTaskId).toHaveBeenCalledWith("#123");
    expect(mockConsoleLog).toHaveBeenCalled();
  });

  it("should return error if both session and task are provided", async () => {
    await expect(get({ session: "test-session", task: "123" })).rejects.toThrow();
  });

  it("should return error if session is not found", async () => {
    mockSessionDB.getSession = mock(() => Promise.resolve(null));
    await expect(get({ session: "non-existent" })).rejects.toThrow();
  });

  it("should return error if task session is not found", async () => {
    mockSessionDB.getSessionByTaskId = mock(() => Promise.resolve(null));
    await expect(get({ task: "999" })).rejects.toThrow();
  });

  it("should output JSON if requested", async () => {
    await get({ session: "test-session", json: true });
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringMatching(/^\{.*\}$/));
  });

  it("should output JSON for task session if requested", async () => {
    await get({ task: "123", json: true });
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringMatching(/^\{.*\}$/));
>>>>>>> origin/main
  });
}); 
