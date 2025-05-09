import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { join, resolve } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import type { SessionRecord } from "../../domain/session";

// Path to the CLI entry point
const CLI = resolve(process.cwd(), "src/cli.ts");

// Test directory - make unique for this file
const TEST_DIR = "/tmp/minsky-session-get-test-" + Math.random().toString(36).substring(7);

interface TestSessionRecord extends SessionRecord {
  branch?: string;
  taskId?: string;
}

function setupSessionDb(sessions: TestSessionRecord[]) {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(join(TEST_DIR, "minsky"), { recursive: true });
  writeFileSync(
    join(TEST_DIR, "minsky", "session-db.json"),
    JSON.stringify(sessions, null, 2)
  );
}

// Helper to run a CLI command with the right environment
function runCliCommand(args: string[], env: Record<string, string> = {}) {
  const testEnv = {
    ...process.env,
    ...env,
    XDG_STATE_HOME: TEST_DIR // Ensure XDG_STATE_HOME points to our unique TEST_DIR
  };
  return spawnSync("bun", ["run", CLI, ...args], { 
    encoding: "utf-8",
    env: testEnv
  });
}

describe("minsky session get CLI", () => {
  beforeEach(() => {
    // Setup is now partly in setupSessionDb to ensure it runs before each DB write
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("prints session details for existing session", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "123" } as TestSessionRecord
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
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "123" } as TestSessionRecord
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
    expect(stderr.trim()).toContain("Session \"nonexistent\" not found."); 
    expect(stdout).toBe("");
  });

  test("can look up a session by task ID", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "#T123" } as TestSessionRecord
    ]);
    const { stdout, stderr } = runCliCommand(["session", "get", "--task", "T123"]);
    expect(stderr).toBe("");
    expect(stdout).toContain("Session: foo");
    expect(stdout).toContain("Task ID: #T123");
  });

  test("prints JSON output for --task", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "#T123" } as TestSessionRecord
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
    expect(stderr.trim()).toContain("No session found for task ID \"#nonexistent-task\".");
    expect(stdout).toBe("");
  });

  test("prints null for --json if no session for task ID", () => {
    setupSessionDb([]);
    const { stdout, stderr } = runCliCommand(["session", "get", "--task", "nonexistent-task", "--json"]);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toBeNull();
  });

  test("errors if both session and --task are provided", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "#T123" } as TestSessionRecord
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
    // Check if stderr contains either of the expected messages
    const trimmedStderr = stderr.trim();
    const conditionMet = trimmedStderr.includes("You must provide either a session name or --task") || 
                         trimmedStderr.includes("Not in a session workspace");
    expect(conditionMet).toBe(true);
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
