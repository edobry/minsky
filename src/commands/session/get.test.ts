import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { SessionDB } from "../../domain/session";
import { get } from "./get";

const CLI = "src/cli.ts";
const SESSION_DB_PATH = join(process.env.XDG_STATE_HOME || "/tmp", "minsky", "session-db.json");

function setupSessionDb(sessions: Array<{ session: string; repoUrl: string; branch: string; createdAt: string; taskId?: string }>) {
  mkdirSync(join(process.env.XDG_STATE_HOME || "/tmp", "minsky"), { recursive: true });
  writeFileSync(SESSION_DB_PATH, JSON.stringify(sessions, null, 2));
}

describe("minsky session get CLI", () => {
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
  });

  it("prints human output when session exists", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "123" }
    ]);
    const { stdout } = spawnSync("bun", ["run", CLI, "session", "get", "foo"], { encoding: "utf-8", env: { ...process.env, XDG_STATE_HOME: "/tmp" } });
    expect(stdout).toContain("Session: foo");
    expect(stdout).toContain("Repo: https://repo");
    expect(stdout).toContain("Branch: main");
    expect(stdout).toContain("Created: 2024-01-01");
    expect(stdout).toContain("Task ID: 123");
  });

  it("prints JSON output with --json", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "123" }
    ]);
    const { stdout } = spawnSync("bun", ["run", CLI, "session", "get", "foo", "--json"], { encoding: "utf-8", env: { ...process.env, XDG_STATE_HOME: "/tmp" } });
    const parsed = JSON.parse(stdout);
    expect(parsed.session).toBe("foo");
    expect(parsed.repoUrl).toBe("https://repo");
    expect(parsed.branch).toBe("main");
    expect(parsed.createdAt).toBe("2024-01-01");
    expect(parsed.taskId).toBe("123");
  });

  it("prints null for --json when session not found", () => {
    setupSessionDb([]);
    const { stdout } = spawnSync("bun", ["run", CLI, "session", "get", "notfound", "--json"], { encoding: "utf-8", env: { ...process.env, XDG_STATE_HOME: "/tmp" } });
    expect(stdout.trim()).toBe("null");
  });

  it("prints human error when session not found", () => {
    setupSessionDb([]);
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "get", "notfound"], { encoding: "utf-8", env: { ...process.env, XDG_STATE_HOME: "/tmp" } });
    expect(stdout).toBe("");
    expect(stderr || "").toContain("Session 'notfound' not found.");
  });

  it("can look up a session by task ID", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "#T123" }
    ]);
    const { stdout } = spawnSync("bun", ["run", CLI, "session", "get", "--task", "T123"], { encoding: "utf-8", env: { ...process.env, XDG_STATE_HOME: "/tmp" } });
    expect(stdout).toContain("Session: foo");
    expect(stdout).toContain("Task ID: #T123");
  });

  it("prints JSON output for --task", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "#T123" }
    ]);
    const { stdout } = spawnSync("bun", ["run", CLI, "session", "get", "--task", "T123", "--json"], { encoding: "utf-8", env: { ...process.env, XDG_STATE_HOME: "/tmp" } });
    const parsed = JSON.parse(stdout);
    expect(parsed.session).toBe("foo");
    expect(parsed.taskId).toBe("#T123");
  });

  it("prints error if no session for task ID", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "#T123" }
    ]);
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "get", "--task", "T999"], { encoding: "utf-8", env: { ...process.env, XDG_STATE_HOME: "/tmp" } });
    expect(stdout).toBe("");
    expect(stderr || "").toContain("No session found for task ID '#T999'.");
  });

  it("prints null for --json if no session for task ID", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "#T123" }
    ]);
    const { stdout } = spawnSync("bun", ["run", CLI, "session", "get", "--task", "T999", "--json"], { encoding: "utf-8", env: { ...process.env, XDG_STATE_HOME: "/tmp" } });
    expect(stdout.trim()).toBe("null");
  });

  it("errors if both session and --task are provided", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "#T123" }
    ]);
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "get", "foo", "--task", "T123"], { encoding: "utf-8", env: { ...process.env, XDG_STATE_HOME: "/tmp" } });
    expect(stdout).toBe("");
    expect(stderr || "").toContain("Provide either a session name or --task, not both.");
  });

  it("errors if neither session nor --task is provided", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01", taskId: "#T123" }
    ]);
    const { stdout, stderr } = spawnSync("bun", ["run", CLI, "session", "get"], { encoding: "utf-8", env: { ...process.env, XDG_STATE_HOME: "/tmp" } });
    expect(stdout).toBe("");
    expect(stderr || "").toContain("You must provide either a session name or --task.");
  });

  it("returns an error when neither session nor --task are provided", () => {
    // Run the command with neither a session name nor --task
    const { stdout, stderr, status } = spawnSync("bun", ["run", CLI, "session", "get"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        XDG_STATE_HOME: "/tmp"
      }
    });
    
    expect(status).not.toBe(0);
    expect(stderr).toContain("Not in a session workspace");
  });
  
  it("returns an error when not in a session workspace and using --ignore-workspace", () => {
    // Run the command with --ignore-workspace
    const { stdout, stderr, status } = spawnSync("bun", ["run", CLI, "session", "get", "--ignore-workspace"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        XDG_STATE_HOME: "/tmp"
      }
    });
    
    expect(status).not.toBe(0);
    expect(stderr).toContain("You must provide either a session name or --task");
  });

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
  });
}); 
