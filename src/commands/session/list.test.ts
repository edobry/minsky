import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { writeFileSync, rmSync, mkdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

// Path to the CLI entry point
const CLI = resolve(process.cwd(), "src/cli.ts");

// Test directory - make unique for this file
const TEST_DIR = "/tmp/minsky-session-list-test-" + Math.random().toString(36).substring(7);
const SESSION_DB_DIR = join(TEST_DIR, "minsky");
const SESSION_DB_PATH = join(SESSION_DB_DIR, "session-db.json");

function setupSessionDb(sessions: Array<{ session: string; repoUrl: string; branch: string; createdAt: string; taskId?: string }>) {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(SESSION_DB_DIR, { recursive: true });
  writeFileSync(SESSION_DB_PATH, JSON.stringify(sessions, null, 2));
}

// Helper to run a CLI command with the right environment
function runCliCommand(args: string[]) {
  return spawnSync("bun", ["run", CLI, ...args], { 
    encoding: "utf-8",
    env: {
      ...process.env,
      XDG_STATE_HOME: TEST_DIR // Ensure XDG_STATE_HOME points to our unique TEST_DIR
    }
  });
}

describe("minsky session list CLI", () => {
  beforeEach(() => {
    // Setup is handled by setupSessionDb before each relevant test section
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("prints human output when sessions exist", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01" },
      { session: "bar", repoUrl: "https://repo2", branch: "", createdAt: "2024-01-02" }
    ]);
    
    const { stdout, stderr } = runCliCommand(["session", "list"]);
    expect(stderr).toBe("");
    expect(stdout).toContain("Session: foo");
    expect(stdout).toContain("Session: bar");
  });

  test("prints JSON output with --json", () => {
    setupSessionDb([
      { session: "foo", repoUrl: "https://repo", branch: "main", createdAt: "2024-01-01" }
    ]);
    
    const { stdout, stderr } = runCliCommand(["session", "list", "--json"]);
    expect(stderr).toBe("");
    
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].session).toBe("foo");
  });

  test("prints [] for --json when no sessions", () => {
    setupSessionDb([]);
    
    const { stdout, stderr } = runCliCommand(["session", "list", "--json"]);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("[]");
  });

  test("prints human message when no sessions", () => {
    setupSessionDb([]);
    
    const { stdout, stderr } = runCliCommand(["session", "list"]);
    expect(stderr).toBe("");
    expect(stdout).toContain("No sessions found.");
  });
}); 
