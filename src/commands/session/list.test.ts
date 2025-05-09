import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

// Create a unique test directory for each test run
const TEST_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
const TEST_DIR = `/tmp/minsky-list-test-${TEST_ID}`;
const SESSION_DB_PATH = join(TEST_DIR, "minsky", "session-db.json");

const CLI = "src/cli.ts";

// Helper to setup session DB
function setupSessionDb(sessions: Array<{ session: string; repoUrl: string; repoName?: string; branch: string; createdAt: string }>) {
  mkdirSync(join(TEST_DIR, "minsky"), { recursive: true });
  writeFileSync(SESSION_DB_PATH, JSON.stringify(sessions.map(session => ({
    ...session,
    // Ensure repoName is always set for consistency
    repoName: session.repoName || session.repoUrl.replace(/[^\w-]/g, "_")
  })), null, 2));
}

describe("minsky session list CLI", () => {
  beforeEach(() => {
    // Clean up any existing test directories
    rmSync(TEST_DIR, { recursive: true, force: true });
  });
  
  afterEach(() => {
    // Clean up test directories
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("prints human output when sessions exist", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", repoName: "repo", branch: "main", createdAt: "2024-01-01" },
      { session: "bar", repoUrl: "https://repo2", repoName: "repo2", branch: "", createdAt: "2024-01-02" }
    ]);
    const { stdout } = spawnSync("bun", ["run", CLI, "session", "list"], { 
      encoding: "utf-8", 
      env: { ...process.env, XDG_STATE_HOME: TEST_DIR },
      stdio: ["inherit", "pipe", "pipe"]
    });
    expect(stdout).toContain("Session: foo");
    expect(stdout).toContain("Session: bar");
  });

  test("prints JSON output with --json", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", repoName: "repo", branch: "main", createdAt: "2024-01-01" }
    ]);
    const { stdout } = spawnSync("bun", ["run", CLI, "session", "list", "--json"], { 
      encoding: "utf-8", 
      env: { ...process.env, XDG_STATE_HOME: TEST_DIR },
      stdio: ["inherit", "pipe", "pipe"]
    });
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].session).toBe("foo");
  });

  test("prints [] for --json when no sessions", () => {
    setupSessionDb([]);
    const { stdout } = spawnSync("bun", ["run", CLI, "session", "list", "--json"], { 
      encoding: "utf-8", 
      env: { ...process.env, XDG_STATE_HOME: TEST_DIR },
      stdio: ["inherit", "pipe", "pipe"]
    });
    expect(stdout.trim()).toBe("[]");
  });

  test("prints human message when no sessions", () => {
    setupSessionDb([]);
    const { stdout } = spawnSync("bun", ["run", CLI, "session", "list"], { 
      encoding: "utf-8", 
      env: { ...process.env, XDG_STATE_HOME: TEST_DIR },
      stdio: ["inherit", "pipe", "pipe"]
    });
    expect(stdout).toContain("No sessions found.");
  });
}); 
